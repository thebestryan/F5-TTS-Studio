from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from importlib.resources import files
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

from f5_tts.api import F5TTS
from f5_tts.device_utils import get_default_device
from f5_tts.infer.utils_infer import infer_batch_process, preprocess_ref_audio_text, transcribe
from f5_tts.model.utils import seed_everything

STUDIO_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("F5_STUDIO_DATA", STUDIO_DIR / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
JOBS_DIR = DATA_DIR / "jobs"
STATIC_DIR = STUDIO_DIR / "static"

for path in (DATA_DIR, UPLOAD_DIR, JOBS_DIR):
    path.mkdir(parents=True, exist_ok=True)

FFMPEG = os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE_BINARY") or shutil.which("ffprobe") or "ffprobe"

TARGET_SR = 24000
MAX_SEED = 2**31 - 1

DEFAULT_SETTINGS: dict = {
    "nfe_step": 32,
    "cfg_strength": 2.0,
    "sway_sampling_coef": -1.0,
    "speed": 1.0,
    "seed": -1,
    "target_rms": 0.1,
    "max_chars": 160,
    "pause_ms": 250,
    "paragraph_pause_ms": 700,
    "crossfade_ms": 0,
    "trim_silence": True,
    "emphasis_slowdown": 0.94,
    "emphasis_gain_db": 1.5,
    "post_speed": 1.0,
    "post_pitch": 0.0,
    "normalize_loudness": True,
    "auto_assemble": True,
    "export_format": "wav",
}

LIMITS: dict = {
    "nfe_step": (4, 64),
    "cfg_strength": (0.0, 6.0),
    "sway_sampling_coef": (-3.0, 3.0),
    "speed": (0.5, 2.0),
    "seed": (-1, MAX_SEED),
    "target_rms": (0.01, 0.5),
    "max_chars": (60, 500),
    "pause_ms": (0, 10000),
    "paragraph_pause_ms": (0, 10000),
    "crossfade_ms": (0, 1000),
    "emphasis_slowdown": (0.75, 1.05),
    "emphasis_gain_db": (-6.0, 8.0),
    "post_speed": (0.5, 2.0),
    "post_pitch": (-12.0, 12.0),
}

LOG_LIMIT = 80

DEVICE_ALIASES = {
    "auto": None,
    "default": None,
    "gpu": "cuda",
    "rocm": "cuda",  # PyTorch exposes ROCm through the CUDA device namespace
    "hip": "cuda",
}


def resolve_device(override: str | None) -> str | None:
    """Map a user-facing device name to a PyTorch device string.

    ``rocm`` and ``hip`` are aliases for ``cuda`` because PyTorch's ROCm build
    reports AMD GPUs through the CUDA API. ``auto``/empty means let F5-TTS pick.
    """
    if not override:
        return None
    value = override.strip().lower()
    if not value:
        return None
    return DEVICE_ALIASES.get(value, value)


def torch_backend(device: str | None) -> str:
    """Human-readable accelerator backend for a PyTorch device string."""
    if not device:
        return "auto"
    kind = device.split(":")[0].lower()
    if kind == "cuda":
        return "rocm" if getattr(torch.version, "hip", None) else "cuda"
    return kind


def _current_device() -> str:
    try:
        return get_default_device()
    except Exception:
        return "cpu"


def _now() -> float:
    return time.time()


def _iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or _now()))


def coerce_settings(raw: dict | None) -> dict:
    settings = dict(DEFAULT_SETTINGS)
    if raw:
        for key, value in raw.items():
            if key in settings and value is not None:
                settings[key] = value
    for key, (low, high) in LIMITS.items():
        if key not in settings:
            continue
        try:
            numeric = float(settings[key])
        except (TypeError, ValueError):
            settings[key] = DEFAULT_SETTINGS[key]
            continue
        if key in ("nfe_step", "pause_ms", "paragraph_pause_ms", "crossfade_ms", "seed", "max_chars"):
            numeric = int(round(numeric))
        settings[key] = max(low, min(high, numeric))
    for key in ("trim_silence", "normalize_loudness", "auto_assemble"):
        settings[key] = bool(settings[key])
    if settings["export_format"] not in ("wav", "mp3"):
        settings["export_format"] = "wav"
    return settings


def clean_filename(name: str, fallback: str = "speech") -> str:
    stem = re.sub(r"[^\w\-. ]+", "", name or "").strip(" .")
    stem = re.sub(r"\s+", " ", stem)[:70]
    return stem or fallback


def script_title(script: str) -> str:
    text = _apply_emphasis_markup(script or "")
    text = PAUSE_RE.sub(" ", text)
    text = text.replace(EMPH_OPEN, "").replace(EMPH_CLOSE, "")
    first = next((line.strip() for line in text.splitlines() if line.strip()), "Untitled speech")
    first = re.sub(r"[*#>`]+", "", first)
    return clean_filename(first, "Untitled speech")[:60]


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    return mono, int(sr)


def write_audio(path: Path, samples: np.ndarray, sr: int = TARGET_SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.asarray(samples, dtype=np.float32), sr, subtype="PCM_16")


def audio_duration(path: Path) -> float:
    try:
        info = sf.info(str(path))
        return float(info.frames / info.samplerate)
    except Exception:
        return 0.0


def peaks_from_audio(samples: np.ndarray, buckets: int = 900) -> list[float]:
    if samples.size == 0:
        return [0.0] * buckets
    if samples.size <= buckets:
        padded = np.zeros(buckets, dtype=np.float32)
        padded[: samples.size] = np.abs(samples)
        return [round(float(v), 4) for v in padded]
    idx = np.linspace(0, samples.size, buckets + 1).astype(np.int64)
    out = []
    for i in range(buckets):
        start, end = idx[i], max(idx[i] + 1, idx[i + 1])
        out.append(round(float(np.max(np.abs(samples[start:end]))), 4))
    return out


def peaks_from_file(path: Path, buckets: int = 900) -> list[float]:
    try:
        info = sf.info(str(path))
        total = info.frames
        if total <= 0:
            return [0.0] * buckets
        if total <= buckets * 4096:
            samples, _ = read_audio(path)
            return peaks_from_audio(samples, buckets)
        per = math.ceil(total / buckets)
        peaks = np.zeros(buckets, dtype=np.float32)
        with sf.SoundFile(str(path)) as handle:
            for i in range(buckets):
                block = handle.read(per, dtype="float32", always_2d=True)
                if block.size == 0:
                    break
                peaks[i] = float(np.max(np.abs(block)))
        return [round(float(v), 4) for v in peaks]
    except Exception:
        return [0.0] * buckets


def run_ffmpeg(args: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    cmd = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def convert_to_wav(source: Path, dest: Path) -> None:
    result = run_ffmpeg(["-i", str(source), "-vn", "-ac", "1", "-ar", str(TARGET_SR), "-c:a", "pcm_s16le", str(dest)])
    if result.returncode != 0 or not dest.exists():
        raise RuntimeError(f"Audio conversion failed: {result.stderr.strip()[:500]}")


def trim_edges(samples: np.ndarray, threshold_db: float = -45.0, keep_ms: int = 40) -> np.ndarray:
    if samples.size == 0:
        return samples
    threshold = 10 ** (threshold_db / 20.0)
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if loud.size == 0:
        return samples
    keep = int(TARGET_SR * keep_ms / 1000)
    start = max(0, int(loud[0]) - keep)
    end = min(samples.size, int(loud[-1]) + keep + 1)
    return samples[start:end]


def stitch(parts: list[tuple[np.ndarray, int]], crossfade_ms: int) -> np.ndarray:
    if not parts:
        return np.zeros(0, dtype=np.float32)
    fade_samples = int(TARGET_SR * crossfade_ms / 1000)
    total = int(parts[0][0].size)
    for i in range(1, len(parts)):
        size = int(parts[i][0].size)
        pause_ms = int(parts[i][1])
        if pause_ms > 0:
            total += int(TARGET_SR * pause_ms / 1000) + size
        elif fade_samples > 0:
            total += size - min(fade_samples, total, size)
        else:
            total += size
    out = np.zeros(max(0, total), dtype=np.float32)
    out[: parts[0][0].size] = parts[0][0]
    offset = int(parts[0][0].size)
    for i in range(1, len(parts)):
        samples, pause_ms = parts[i]
        samples = samples.astype(np.float32, copy=False)
        if pause_ms > 0:
            offset += int(TARGET_SR * pause_ms / 1000)
            out[offset : offset + samples.size] = samples
            offset += samples.size
        elif fade_samples > 0:
            overlap = int(min(fade_samples, offset, samples.size))
            if overlap <= 1:
                out[offset : offset + samples.size] = samples
                offset += samples.size
            else:
                fade_out = np.linspace(1.0, 0.0, overlap, dtype=np.float32)
                fade_in = np.linspace(0.0, 1.0, overlap, dtype=np.float32)
                out[offset - overlap : offset] = out[offset - overlap : offset] * fade_out + samples[:overlap] * fade_in
                out[offset : offset + samples.size - overlap] = samples[overlap:]
                offset += samples.size - overlap
        else:
            out[offset : offset + samples.size] = samples
            offset += samples.size
    return out[:offset]


PAUSE_TOKEN = "\ufdd0"
PAUSE_TOKEN_RE = re.compile(r"\ufdd0(\d+)\ufdd0")
EMPH_OPEN = "\ufdd1"
EMPH_CLOSE = "\ufdd2"
PAUSE_RE = re.compile(
    r"\[\s*(?:pause|break)\s*(?:[=:]\s*)?([0-9]+(?:\.[0-9]+)?)?\s*(ms|s)?\s*\]"
    r"|<\s*break\s+time\s*=\s*[\"']([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?[\"']\s*/?\s*>",
    re.IGNORECASE,
)


def _pause_ms(value: str | None, unit: str | None) -> int:
    if value is None or value == "":
        return 1000
    numeric = float(value)
    if (unit or "").lower() == "ms":
        return int(round(numeric))
    return int(round(numeric * 1000))


def _extract_pauses(text: str) -> tuple[str, int]:
    total = 0

    def repl(match: re.Match) -> str:
        nonlocal total
        ms = _pause_ms(match.group(1) or match.group(3), match.group(2) or match.group(4))
        total += max(0, ms)
        return f" {PAUSE_TOKEN}{max(0, ms)}{PAUSE_TOKEN} "

    return PAUSE_RE.sub(repl, text), total


def _apply_emphasis_markup(text: str) -> str:
    text = re.sub(r"<\s*(?:emph|emphasis)\s*>", EMPH_OPEN, text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*/\s*(?:emph|emphasis)\s*>", EMPH_CLOSE, text, flags=re.IGNORECASE)
    text = re.sub(r"\*\*(.+?)\*\*", lambda m: EMPH_OPEN + m.group(1) + EMPH_CLOSE, text, flags=re.DOTALL)
    text = re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", lambda m: EMPH_OPEN + m.group(1) + EMPH_CLOSE, text, flags=re.DOTALL)
    return text


def _strip_markup(text: str) -> tuple[str, int, bool]:
    pauses = [int(v) for v in PAUSE_TOKEN_RE.findall(text)]
    pause_ms = sum(pauses)
    emphasized = EMPH_OPEN in text or EMPH_CLOSE in text
    cleaned = PAUSE_TOKEN_RE.sub("", text)
    cleaned = cleaned.replace(EMPH_OPEN, "").replace(EMPH_CLOSE, "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned, pause_ms, emphasized


def _split_long(sentence: str, max_chars: int) -> list[str]:
    if len(sentence) <= max_chars:
        return [sentence]
    pieces = [p for p in re.split(r"(?<=[,，、;；:])\s*", sentence) if p.strip()]
    out: list[str] = []
    current = ""
    for piece in pieces:
        if len(piece) > max_chars:
            if current:
                out.append(current.strip())
                current = ""
            words = piece.split(" ")
            buffer = ""
            for word in words:
                candidate = f"{buffer} {word}".strip()
                if len(candidate) <= max_chars:
                    buffer = candidate
                else:
                    if buffer:
                        out.append(buffer)
                    while len(word) > max_chars:
                        out.append(word[:max_chars])
                        word = word[max_chars:]
                    buffer = word
            if buffer:
                current = buffer
            continue
        candidate = f"{current} {piece}".strip() if current else piece
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                out.append(current.strip())
            current = piece
    if current.strip():
        out.append(current.strip())
    return out or [sentence[:max_chars]]


SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…。！？])\s+|(?<=[;；])\s+|\n+")


def split_script(script: str, settings: dict) -> list[dict]:
    max_chars = max(30, int(settings.get("max_chars", 160)))
    default_pause = int(settings.get("pause_ms", 250))
    paragraph_pause = int(settings.get("paragraph_pause_ms", 700))
    text = (script or "").replace("\r\n", "\n").replace("\r", "\n")
    text = _apply_emphasis_markup(text)
    text, _ = _extract_pauses(text)
    paragraphs = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[dict] = []
    current = ""
    current_emph = False
    carry_pause = 0

    def flush(pause_ms: int | None = None) -> None:
        nonlocal current, current_emph
        if not current.strip():
            return
        cleaned, inline_pause, emphasized = _strip_markup(current)
        if not cleaned:
            current = ""
            current_emph = False
            return
        if pause_ms is None:
            pause_ms = inline_pause if inline_pause else default_pause
        chunks.append(
            {
                "text": cleaned,
                "pause_ms": max(0, min(10000, int(pause_ms))),
                "emphasis": bool(emphasized or current_emph),
            }
        )
        current = ""
        current_emph = False

    for p_index, paragraph in enumerate(paragraphs):
        sentences = [s.strip() for s in SENTENCE_SPLIT_RE.split(paragraph) if s and s.strip()]
        for sentence in sentences:
            leading_pause = 0
            while True:
                match = PAUSE_TOKEN_RE.match(sentence)
                if not match:
                    break
                leading_pause += int(match.group(1))
                sentence = sentence[match.end():].strip()
            if leading_pause:
                if current.strip():
                    flush(leading_pause)
                elif chunks:
                    chunks[-1]["pause_ms"] = min(10000, chunks[-1]["pause_ms"] + leading_pause)
                else:
                    carry_pause += leading_pause
            sentence_pause = sum(int(v) for v in PAUSE_TOKEN_RE.findall(sentence))
            has_emph = EMPH_OPEN in sentence or EMPH_CLOSE in sentence
            bare = _strip_markup(sentence)[0]
            if not bare:
                if sentence_pause and chunks:
                    chunks[-1]["pause_ms"] = min(10000, chunks[-1]["pause_ms"] + sentence_pause)
                elif sentence_pause:
                    carry_pause += sentence_pause
                continue
            for piece in _split_long(bare, max_chars):
                candidate = f"{current} {piece}".strip() if current else piece
                if current and len(candidate) > max_chars:
                    flush()
                if not current:
                    current = piece
                    current_emph = has_emph
                else:
                    current += " " + piece
                    current_emph = current_emph or has_emph
                if len(current) >= max_chars:
                    flush(sentence_pause if sentence_pause else None)
            if sentence_pause:
                flush(sentence_pause)
        if current:
            flush(max(paragraph_pause, carry_pause))
            carry_pause = 0
        elif chunks and p_index < len(paragraphs) - 1:
            chunks[-1]["pause_ms"] = min(10000, max(chunks[-1]["pause_ms"], paragraph_pause))
    flush(carry_pause if carry_pause else None)
    if not chunks:
        cleaned = _strip_markup(text)[0]
        if cleaned:
            chunks.append({"text": cleaned, "pause_ms": default_pause, "emphasis": False})
    return chunks


class ReferenceStore:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.RLock()
        self.items: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        for meta_path in self.root.glob("*.json"):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                if meta.get("id") and (self.root / f"{meta['id']}.wav").exists():
                    self.items[meta["id"]] = meta
            except Exception:
                continue

    def list(self) -> list[dict]:
        with self.lock:
            return sorted(self.items.values(), key=lambda item: item.get("created", 0), reverse=True)

    def get(self, ref_id: str) -> dict | None:
        with self.lock:
            return self.items.get(ref_id)

    def add_file(self, source_path: Path, original_name: str) -> dict:
        ref_id = uuid.uuid4().hex[:12]
        dest = self.root / f"{ref_id}.wav"
        convert_to_wav(source_path, dest)
        samples, sr = read_audio(dest)
        meta = {
            "id": ref_id,
            "name": original_name or dest.name,
            "created": _now(),
            "created_iso": _iso(),
            "duration": round(samples.size / sr, 3),
            "sample_rate": sr,
            "peaks": peaks_from_audio(samples),
        }
        (self.root / f"{ref_id}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        with self.lock:
            self.items[ref_id] = meta
        return meta

    def add_wav(self, wav_path: Path, name: str) -> dict:
        return self.add_file(wav_path, name)

    def trim(self, ref_id: str, start: float, end: float) -> dict:
        meta = self.get(ref_id)
        if not meta:
            raise KeyError(ref_id)
        source = self.root / f"{ref_id}.wav"
        new_id = uuid.uuid4().hex[:12]
        dest = self.root / f"{new_id}.wav"
        result = run_ffmpeg(
            ["-ss", f"{max(0.0, start):.3f}", "-to", f"{max(start + 0.05, end):.3f}", "-i", str(source), "-c:a", "pcm_s16le", str(dest)]
        )
        if result.returncode != 0 or not dest.exists():
            raise RuntimeError(result.stderr.strip()[:500] or "Trim failed")
        samples, sr = read_audio(dest)
        new_meta = {
            "id": new_id,
            "name": f"{meta.get('name', 'reference')} (trimmed)",
            "created": _now(),
            "created_iso": _iso(),
            "duration": round(samples.size / sr, 3),
            "sample_rate": sr,
            "peaks": peaks_from_audio(samples),
            "source": ref_id,
        }
        (self.root / f"{new_id}.json").write_text(json.dumps(new_meta, ensure_ascii=False), encoding="utf-8")
        with self.lock:
            self.items[new_id] = new_meta
        return new_meta

    def delete(self, ref_id: str) -> None:
        with self.lock:
            self.items.pop(ref_id, None)
        for suffix in (".wav", ".json"):
            try:
                (self.root / f"{ref_id}{suffix}").unlink()
            except FileNotFoundError:
                pass


class Engine:
    def __init__(self) -> None:
        self.model_name = os.environ.get("F5_TTS_MODEL", "F5TTS_v1_Base")
        self.device_request = (os.environ.get("F5_TTS_DEVICE") or "").strip() or "auto"
        self.device_override = resolve_device(self.device_request)
        self.tts: F5TTS | None = None
        self.status = "idle"
        self.error: str | None = None
        self.loaded_at: float | None = None
        self._load_lock = threading.Lock()
        self._load_done = threading.Event()
        self._thread: threading.Thread | None = None
        self.infer_lock = threading.Lock()
        self.asr_lock = threading.Lock()

    def start_load(self) -> None:
        with self._load_lock:
            if self.tts is not None or (self._thread and self._thread.is_alive()):
                return
            self.status = "loading"
            self._thread = threading.Thread(target=self._load, name="f5-model-load", daemon=True)
            self._thread.start()

    def _load(self) -> None:
        started = time.time()
        try:
            tts = F5TTS(model=self.model_name, device=self.device_override)
            self.tts = tts
            self.status = "ready"
            self.loaded_at = time.time()
            backend = torch_backend(tts.device)
            print(
                f"[engine] model {self.model_name} ready in {self.loaded_at - started:.1f}s on {tts.device} ({backend})",
                flush=True,
            )
        except Exception as exc:
            self.status = "error"
            self.error = f"{type(exc).__name__}: {exc}"
            print(f"[engine] model load failed: {self.error}", flush=True)
        finally:
            self._load_done.set()

    def ensure_loaded(self, timeout: float | None = None) -> F5TTS:
        if self.tts is not None:
            return self.tts
        self.start_load()
        self._load_done.wait(timeout)
        if self.tts is None:
            raise RuntimeError(self.error or "Model is still loading")
        return self.tts

    def health(self) -> dict:
        tts = self.tts
        device = tts.device if tts else (self.device_override or _current_device())
        backend = torch_backend(device)
        gpu = None
        if device.split(":")[0].lower() == "cuda":
            try:
                gpu = torch.cuda.get_device_name(0)
            except Exception:
                gpu = None
        return {
            "status": self.status,
            "model": self.model_name,
            "device": device,
            "device_request": self.device_request,
            "backend": backend,
            "gpu": gpu,
            "torch": torch.__version__,
            "torch_hip": getattr(torch.version, "hip", None),
            "sample_rate": tts.target_sample_rate if tts else TARGET_SR,
            "loaded_at": _iso(self.loaded_at) if self.loaded_at else None,
            "error": self.error,
            "python": sys.version.split()[0],
        }


class JobStore:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.RLock()
        self.jobs: dict[str, dict] = {}
        self.locks: dict[str, threading.RLock] = {}
        self.cancel_events: dict[str, threading.Event] = {}
        self.workers: dict[str, threading.Thread] = {}
        self._load()

    def _job_dir(self, job_id: str) -> Path:
        return self.root / job_id

    def _load(self) -> None:
        for job_path in self.root.glob("*/job.json"):
            try:
                job = json.loads(job_path.read_text(encoding="utf-8"))
                if not job.get("id"):
                    continue
                if job.get("status") in ("generating", "assembling", "queued"):
                    job["status"] = "partial" if any(c.get("status") == "done" for c in job.get("chunks", [])) else "draft"
                if not job.get("title") or "pause" in str(job.get("title", "")).lower():
                    job["title"] = script_title(job.get("script", ""))
                for chunk in job.get("chunks", []):
                    if chunk.get("status") == "generating":
                        chunk["status"] = "pending"
                self.jobs[job["id"]] = job
                self.locks[job["id"]] = threading.RLock()
                self.cancel_events[job["id"]] = threading.Event()
            except Exception:
                continue

    def lock_for(self, job_id: str) -> threading.RLock:
        with self.lock:
            return self.locks.setdefault(job_id, threading.RLock())

    def save(self, job: dict) -> None:
        job["updated"] = _now()
        job["updated_iso"] = _iso(job["updated"])
        job_dir = self._job_dir(job["id"])
        job_dir.mkdir(parents=True, exist_ok=True)
        temp = job_dir / "job.json.tmp"
        temp.write_text(json.dumps(job, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temp, job_dir / "job.json")

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            return self.jobs.get(job_id)

    def list(self) -> list[dict]:
        with self.lock:
            jobs = list(self.jobs.values())
        jobs.sort(key=lambda j: j.get("created", 0), reverse=True)
        return [self.summary(job) for job in jobs]

    def summary(self, job: dict) -> dict:
        chunks = job.get("chunks", [])
        done = sum(1 for c in chunks if c.get("status") == "done")
        return {
            "id": job["id"],
            "title": job.get("title") or "Untitled speech",
            "created": job.get("created"),
            "created_iso": job.get("created_iso"),
            "status": job.get("status"),
            "chunk_count": len(chunks),
            "done": done,
            "duration": (job.get("final") or {}).get("duration"),
            "script_chars": len(job.get("script", "")),
            "reference_id": job.get("reference_id"),
        }

    def add(self, reference: dict, ref_text: str, script: str, settings: dict) -> dict:
        job_id = uuid.uuid4().hex[:12]
        job_dir = self._job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(UPLOAD_DIR / f"{reference['id']}.wav", job_dir / "reference.wav")
        seed = int(settings.get("seed", -1))
        chunks = []
        for index, item in enumerate(split_script(script, settings), start=1):
            chunk_seed = (seed + index) % MAX_SEED if seed >= 0 else random.randint(0, MAX_SEED)
            chunks.append(
                {
                    "id": f"c{index:04d}",
                    "index": index,
                    "text": item["text"],
                    "pause_ms": item["pause_ms"],
                    "emphasis": item["emphasis"],
                    "enabled": True,
                    "status": "pending",
                    "error": None,
                    "seed": chunk_seed,
                    "duration": None,
                    "gen_seconds": None,
                    "audio_version": 0,
                    "generated_at": None,
                    "stale": False,
                }
            )
        title = script_title(script)
        job = {
            "id": job_id,
            "created": _now(),
            "created_iso": _iso(),
            "updated": _now(),
            "updated_iso": _iso(),
            "title": title[:60] or "Untitled speech",
            "reference_id": reference["id"],
            "reference_name": reference.get("name"),
            "reference_duration": reference.get("duration"),
            "reference_sample_rate": reference.get("sample_rate", TARGET_SR),
            "reference_peaks": reference.get("peaks", []),
            "ref_text": ref_text.strip(),
            "script": script,
            "settings": settings,
            "chunks": chunks,
            "status": "draft",
            "progress": {"done": 0, "total": len(chunks), "current": None, "message": "Ready to generate"},
            "final": None,
            "error": None,
            "logs": [],
        }
        with self.lock:
            self.jobs[job_id] = job
            self.locks[job_id] = threading.RLock()
            self.cancel_events[job_id] = threading.Event()
        self.save(job)
        return job

    def delete(self, job_id: str) -> None:
        with self.lock:
            self.jobs.pop(job_id, None)
            event = self.cancel_events.pop(job_id, None)
            self.locks.pop(job_id, None)
            self.workers.pop(job_id, None)
        if event:
            event.set()
        shutil.rmtree(self._job_dir(job_id), ignore_errors=True)

    def log(self, job: dict, message: str, level: str = "info") -> None:
        logs = job.setdefault("logs", [])
        logs.append({"ts": _iso(), "level": level, "message": message})
        del logs[:-LOG_LIMIT]


REFERENCES = ReferenceStore(UPLOAD_DIR)
ENGINE = Engine()
JOBS = JobStore(JOBS_DIR)
ASR_IN_PROGRESS = False


def reference_path(ref_id: str) -> Path:
    return UPLOAD_DIR / f"{ref_id}.wav"


def synthesize_chunk(
    engine: Engine,
    ref_path: Path,
    ref_text: str,
    chunk: dict,
    settings: dict,
    processed: bool = False,
) -> tuple[np.ndarray, int, float]:
    tts = engine.ensure_loaded()
    if processed:
        processed_ref, processed_text = str(ref_path), ref_text
    else:
        processed_ref, processed_text = preprocess_ref_audio_text(
            str(ref_path), ref_text, show_info=lambda *a, **k: None
        )
    samples, sr = sf.read(processed_ref, dtype="float32", always_2d=True)
    audio = torch.from_numpy(np.ascontiguousarray(samples.T))
    speed = float(settings.get("speed", 1.0))
    if chunk.get("emphasis"):
        speed *= float(settings.get("emphasis_slowdown", 0.94))
    seed = int(chunk.get("seed") or 0)
    seed_everything(seed)
    started = time.time()
    result = next(
        infer_batch_process(
            (audio, sr),
            processed_text,
            [chunk["text"]],
            tts.ema_model,
            tts.vocoder,
            mel_spec_type=tts.mel_spec_type,
            progress=None,
            target_rms=float(settings.get("target_rms", 0.1)),
            cross_fade_duration=0.0,
            nfe_step=int(settings.get("nfe_step", 32)),
            cfg_strength=float(settings.get("cfg_strength", 2.0)),
            sway_sampling_coef=float(settings.get("sway_sampling_coef", -1.0)),
            speed=speed,
            fix_duration=None,
            device=tts.device,
        )
    )
    wav, out_sr, _ = result
    if wav is None or len(wav) == 0:
        raise RuntimeError("Model returned empty audio")
    return np.asarray(wav, dtype=np.float32), int(out_sr), time.time() - started


def chunk_audio_path(job_id: str, chunk_id: str) -> Path:
    return JOBS._job_dir(job_id) / f"chunk_{chunk_id}.wav"


def _update_progress(job: dict) -> None:
    chunks = [c for c in job.get("chunks", []) if c.get("enabled", True)]
    done = sum(1 for c in chunks if c.get("status") == "done")
    job["progress"] = {
        "done": done,
        "total": len(chunks),
        "current": job.get("progress", {}).get("current"),
        "message": job.get("progress", {}).get("message", ""),
    }


def run_generation(job_id: str, chunk_ids: list[str] | None = None, new_seed: bool = False) -> None:
    job = JOBS.get(job_id)
    if not job:
        return
    cancel = JOBS.cancel_events.setdefault(job_id, threading.Event())
    lock = JOBS.lock_for(job_id)
    with lock:
        engine_status = ENGINE.status
        job["status"] = "queued"
        job["error"] = None
        _update_progress(job)
        JOBS.log(job, "Generation queued. Waiting for the model." if engine_status != "ready" else "Generation queued.")
        JOBS.save(job)
    with ENGINE.infer_lock:
        if cancel.is_set():
            with lock:
                job["status"] = "cancelled"
                JOBS.log(job, "Generation cancelled before it started.", "warn")
                JOBS.save(job)
            return
        try:
            tts = ENGINE.ensure_loaded()
        except Exception as exc:
            with lock:
                job["status"] = "error"
                job["error"] = str(exc)
                JOBS.log(job, f"Model unavailable: {exc}", "error")
                JOBS.save(job)
            return
        ref_path = JOBS._job_dir(job_id) / "reference.wav"
        with lock:
            job["status"] = "generating"
            job["progress"]["message"] = f"Loading reference voice on {tts.device.upper()}"
            JOBS.log(job, f"Reference voice ready on {tts.device.upper()}.")
            JOBS.save(job)
        try:
            processed_ref, processed_text = preprocess_ref_audio_text(
                str(ref_path), job.get("ref_text", ""), show_info=lambda *a, **k: None
            )
        except Exception as exc:
            with lock:
                job["status"] = "error"
                job["error"] = f"Reference preprocessing failed: {exc}"
                JOBS.log(job, job["error"], "error")
                JOBS.save(job)
            return
        targets = [c for c in job.get("chunks", []) if c.get("enabled", True)]
        if chunk_ids:
            target_ids = set(chunk_ids)
            targets = [c for c in targets if c["id"] in target_ids]
        if new_seed:
            with lock:
                for chunk in targets:
                    chunk["seed"] = random.randint(0, MAX_SEED)
                JOBS.save(job)
        total = len(targets)
        for order, chunk in enumerate(targets, start=1):
            if cancel.is_set():
                break
            if not str(chunk.get("text", "")).strip():
                with lock:
                    chunk["status"] = "error"
                    chunk["error"] = "Chunk text is empty"
                    _update_progress(job)
                    JOBS.log(job, f"Chunk {chunk['index']} skipped: empty text.", "error")
                    JOBS.save(job)
                continue
            with lock:
                chunk["status"] = "generating"
                chunk["error"] = None
                job["progress"]["current"] = chunk["id"]
                job["progress"]["message"] = f"Generating chunk {chunk['index']} ({order} of {total})"
                _update_progress(job)
                JOBS.log(job, f"Chunk {chunk['index']} started ({chunk['seed']}).")
                JOBS.save(job)
            try:
                samples, out_sr, seconds = synthesize_chunk(
                    ENGINE,
                    Path(processed_ref),
                    processed_text,
                    chunk,
                    coerce_settings(job.get("settings")),
                    processed=True,
                )
                if coerce_settings(job.get("settings")).get("trim_silence", True):
                    samples = trim_edges(samples)
                dest = chunk_audio_path(job_id, chunk["id"])
                write_audio(dest, samples, out_sr)
                with lock:
                    chunk["status"] = "done"
                    chunk["duration"] = round(samples.size / out_sr, 3)
                    chunk["gen_seconds"] = round(seconds, 2)
                    chunk["audio_version"] = int(chunk.get("audio_version") or 0) + 1
                    chunk["generated_at"] = _iso()
                    chunk["stale"] = False
                    _update_progress(job)
                    JOBS.log(job, f"Chunk {chunk['index']} done in {seconds:.1f}s.", "success")
                    JOBS.save(job)
            except Exception as exc:
                with lock:
                    chunk["status"] = "error"
                    chunk["error"] = f"{type(exc).__name__}: {exc}"
                    job["error"] = chunk["error"]
                    _update_progress(job)
                    JOBS.log(job, f"Chunk {chunk['index']} failed: {chunk['error']}", "error")
                    JOBS.save(job)
        with lock:
            if cancel.is_set():
                job["status"] = "cancelled"
                job["progress"]["message"] = "Cancelled"
                JOBS.log(job, "Generation cancelled.", "warn")
            else:
                enabled = [c for c in job["chunks"] if c.get("enabled", True)]
                done = sum(1 for c in enabled if c["status"] == "done")
                errored = sum(1 for c in enabled if c["status"] == "error")
                if done == len(enabled) and enabled:
                    job["status"] = "generated"
                    job["progress"]["message"] = "All chunks generated"
                elif done or errored:
                    job["status"] = "partial"
                    job["progress"]["message"] = f"{done}/{len(enabled)} chunks generated"
                else:
                    job["status"] = "error"
                    job["progress"]["message"] = "No chunks generated"
            job["progress"]["current"] = None
            JOBS.save(job)
    if job.get("status") == "generated" and coerce_settings(job.get("settings")).get("auto_assemble", True):
        try:
            assemble_job(job_id)
        except Exception as exc:
            with lock:
                JOBS.log(job, f"Auto-assembly failed: {exc}", "error")
                JOBS.save(job)


def _job_signature(job: dict, settings: dict) -> str:
    payload = {
        "post_speed": settings.get("post_speed"),
        "post_pitch": settings.get("post_pitch"),
        "normalize_loudness": settings.get("normalize_loudness"),
        "trim_silence": settings.get("trim_silence"),
        "crossfade_ms": settings.get("crossfade_ms"),
        "emphasis_gain_db": settings.get("emphasis_gain_db"),
        "chunks": [
            {
                "id": c["id"],
                "v": c.get("audio_version"),
                "pause": c.get("pause_ms"),
                "emph": c.get("emphasis"),
                "enabled": c.get("enabled", True),
                "stale": c.get("stale"),
                "text": c.get("text"),
            }
            for c in job.get("chunks", [])
        ],
    }
    return hashlib.sha1(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def assemble_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise KeyError(job_id)
    lock = JOBS.lock_for(job_id)
    with lock:
        if job.get("status") == "assembling":
            raise RuntimeError("Assembly already running")
        job["status"] = "assembling"
        job["progress"]["message"] = "Stitching chunks"
        JOBS.save(job)
    try:
        settings = coerce_settings(job.get("settings"))
        parts: list[tuple[np.ndarray, int]] = []
        for chunk in job.get("chunks", []):
            if not chunk.get("enabled", True):
                continue
            path = chunk_audio_path(job_id, chunk["id"])
            if not path.exists():
                continue
            samples, sr = read_audio(path)
            if settings.get("trim_silence", True):
                samples = trim_edges(samples)
            gain = float(settings.get("emphasis_gain_db", 0.0)) if chunk.get("emphasis") else 0.0
            if gain:
                samples = samples * (10 ** (gain / 20.0))
            parts.append((samples, int(chunk.get("pause_ms", 0))))
        if not parts:
            raise RuntimeError("No generated audio to assemble")
        raw = stitch(parts, int(settings.get("crossfade_ms", 0)))
        job_dir = JOBS._job_dir(job_id)
        raw_path = job_dir / "final_raw.wav"
        write_audio(raw_path, raw)
        final_path = job_dir / "final.wav"
        filters: list[str] = []
        post_speed = float(settings.get("post_speed", 1.0))
        post_pitch = float(settings.get("post_pitch", 0.0))
        if abs(post_speed - 1.0) > 1e-4 or abs(post_pitch) > 1e-4:
            pitch_factor = 2 ** (post_pitch / 12.0)
            filters.append(
                f"rubberband=tempo={post_speed:.6f}:pitch={pitch_factor:.6f}:formant=preserved:pitchq=quality"
            )
        if settings.get("normalize_loudness", True):
            filters.append("loudnorm=I=-16:TP=-1.5:LRA=11")
        if filters:
            result = run_ffmpeg(
                [
                    "-i",
                    str(raw_path),
                    "-af",
                    ",".join(filters),
                    "-ar",
                    str(TARGET_SR),
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(final_path),
                ]
            )
            if result.returncode != 0 or not final_path.exists():
                raise RuntimeError(result.stderr.strip()[:500] or "Post-processing failed")
        else:
            shutil.copyfile(raw_path, final_path)
        mp3_path = job_dir / "final.mp3"
        result = run_ffmpeg(
            ["-i", str(final_path), "-ar", str(TARGET_SR), "-ac", "1", "-c:a", "libmp3lame", "-b:a", "192k", str(mp3_path)]
        )
        if result.returncode != 0 or not mp3_path.exists():
            mp3_path = None
        duration = audio_duration(final_path)
        signature = _job_signature(job, settings)
        with lock:
            job["final"] = {
                "duration": round(duration, 3),
                "peaks": peaks_from_file(final_path),
                "assembled_at": _iso(),
                "version": int((job.get("final") or {}).get("version", 0)) + 1,
                "signature": signature,
                "has_mp3": bool(mp3_path),
            }
            job["status"] = "done" if job.get("progress", {}).get("done") == job.get("progress", {}).get("total") else "partial"
            job["progress"]["message"] = "Final audio ready"
            job["error"] = None
            JOBS.log(job, f"Assembled {duration:.1f}s of audio.", "success")
            JOBS.save(job)
        return job
    except Exception as exc:
        with lock:
            job["status"] = "partial" if any(c.get("status") == "done" for c in job.get("chunks", [])) else "error"
            job["error"] = str(exc)
            job["progress"]["message"] = "Assembly failed"
            JOBS.log(job, f"Assembly failed: {exc}", "error")
            JOBS.save(job)
        raise


def start_generation(job_id: str, chunk_ids: list[str] | None = None, new_seed: bool = False) -> bool:
    job = JOBS.get(job_id)
    if not job:
        raise KeyError(job_id)
    with JOBS.lock:
        worker = JOBS.workers.get(job_id)
        if worker and worker.is_alive():
            raise RuntimeError("Generation is already running for this job")
        JOBS.cancel_events[job_id] = threading.Event()
        thread = threading.Thread(
            target=run_generation,
            args=(job_id, chunk_ids, new_seed),
            name=f"f5-generate-{job_id}",
            daemon=True,
        )
        JOBS.workers[job_id] = thread
        thread.start()
    return True


def cancel_generation(job_id: str) -> None:
    event = JOBS.cancel_events.get(job_id)
    if event:
        event.set()


def transcribe_reference(ref_id: str, language: str | None) -> dict:
    global ASR_IN_PROGRESS
    ref = REFERENCES.get(ref_id)
    if not ref:
        raise KeyError(ref_id)
    with ENGINE.asr_lock:
        ASR_IN_PROGRESS = True
        try:
            text = transcribe(str(reference_path(ref_id)), language or None)
        finally:
            ASR_IN_PROGRESS = False
    return {"text": text.strip(), "language": language or "auto"}


def job_to_public(job: dict) -> dict:
    data = json.loads(json.dumps(job, ensure_ascii=False))
    chunks = data.get("chunks", [])
    done = sum(1 for c in chunks if c.get("status") == "done")
    data["progress"]["done"] = done
    data["progress"]["total"] = sum(1 for c in chunks if c.get("enabled", True))
    data["has_audio"] = any(chunk_audio_path(job["id"], c["id"]).exists() for c in chunks)
    if data.get("final") and data["final"].get("signature"):
        data["final"]["stale"] = data["final"]["signature"] != _job_signature(job, coerce_settings(job.get("settings")))
    return data
