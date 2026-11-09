from __future__ import annotations

import shutil
import tempfile
import threading
import traceback
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.gzip import GZipMiddleware

import engine
from engine import (
    DEFAULT_SETTINGS,
    ENGINE,
    JOBS,
    LIMITS,
    REFERENCES,
    TARGET_SR,
    assemble_job,
    cancel_generation,
    chunk_audio_path,
    clean_filename,
    coerce_settings,
    job_to_public,
    peaks_from_file,
    reference_path,
    run_ffmpeg,
    start_generation,
    transcribe_reference,
    _job_signature,
)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    ENGINE.start_load()
    print("[studio] F5-TTS Studio starting on http://127.0.0.1:7862", flush=True)
    yield


app = FastAPI(title="F5-TTS Studio", version="1.0.0", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=1024)
ASR_BUSY = threading.Lock()


class TrimRequest(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)


class TranscribeRequest(BaseModel):
    language: str | None = None


class JobCreateRequest(BaseModel):
    reference_id: str
    ref_text: str = ""
    script: str
    settings: dict = Field(default_factory=dict)


class JobPatchRequest(BaseModel):
    settings: dict | None = None
    ref_text: str | None = None
    title: str | None = None


class ChunkPatchRequest(BaseModel):
    text: str | None = None
    pause_ms: int | None = None
    emphasis: bool | None = None
    enabled: bool | None = None


class GenerateRequest(BaseModel):
    chunk_ids: list[str] | None = None
    only_pending: bool = True
    new_seed: bool = False


def _no_store(path: Path, media_type: str, filename: str | None = None) -> FileResponse:
    headers = {"Cache-Control": "no-store, max-age=0"}
    return FileResponse(str(path), media_type=media_type, filename=filename, headers=headers)


def _get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get("/api/health")
def health() -> dict:
    data = ENGINE.health()
    data["ffmpeg"] = bool(shutil.which(engine.FFMPEG) or Path(engine.FFMPEG).exists())
    data["asr_busy"] = ASR_BUSY.locked()
    data["jobs"] = len(JOBS.jobs)
    return data


@app.get("/api/config")
def config() -> dict:
    return {
        "defaults": DEFAULT_SETTINGS,
        "limits": LIMITS,
        "target_sample_rate": TARGET_SR,
        "reference_limit_seconds": 12,
        "markup": {
            "pause": ["[pause]", "[pause=1.5s]", "[pause=750ms]", '<break time="2s"/>'],
            "emphasis": ["*emphasized text*", "**emphasized text**", "<emph>emphasized text</emph>"],
        },
    }


@app.get("/api/references")
def list_references() -> list[dict]:
    return [_public_ref(item, True) for item in REFERENCES.list()]


def _public_ref(meta: dict, include_peaks: bool = True) -> dict:
    data = {k: v for k, v in meta.items() if k != "peaks" or include_peaks}
    if include_peaks:
        data["audio_url"] = f"/api/references/{meta['id']}/audio"
    return data


@app.post("/api/references")
def create_reference(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "reference.wav").suffix or ".wav"
    if suffix.lower() not in {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm", ".mp4", ".wma"}:
        raise HTTPException(status_code=400, detail=f"Unsupported audio type: {suffix}")
    tmp_dir = engine.DATA_DIR / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=tmp_dir)
    temp_path = Path(handle.name)
    try:
        with handle:
            shutil.copyfileobj(file.file, handle)
        if temp_path.stat().st_size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        if temp_path.stat().st_size > 500 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Audio file is larger than 500 MB")
        meta = REFERENCES.add_file(temp_path, file.filename or "reference")
        return _public_ref(meta)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode audio: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)


@app.get("/api/references/{ref_id}")
def get_reference(ref_id: str) -> dict:
    meta = REFERENCES.get(ref_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Reference not found")
    return _public_ref(meta)


@app.get("/api/references/{ref_id}/audio")
def get_reference_audio(ref_id: str) -> FileResponse:
    if not REFERENCES.get(ref_id):
        raise HTTPException(status_code=404, detail="Reference not found")
    path = reference_path(ref_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Reference audio not found")
    return _no_store(path, "audio/wav")


@app.post("/api/references/{ref_id}/trim")
def trim_reference(ref_id: str, body: TrimRequest) -> dict:
    meta = REFERENCES.get(ref_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Reference not found")
    if body.end <= body.start + 0.1:
        raise HTTPException(status_code=400, detail="End must be after start")
    try:
        trimmed = REFERENCES.trim(ref_id, body.start, body.end)
        return _public_ref(trimmed)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Trim failed: {exc}") from exc


@app.post("/api/references/{ref_id}/transcribe")
def transcribe(ref_id: str, body: TranscribeRequest) -> dict:
    if not REFERENCES.get(ref_id):
        raise HTTPException(status_code=404, detail="Reference not found")
    if not ASR_BUSY.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="A transcription is already running")
    try:
        language = None if not body.language or body.language == "auto" else body.language
        return transcribe_reference(ref_id, language)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        ASR_BUSY.release()


@app.delete("/api/references/{ref_id}")
def delete_reference(ref_id: str) -> dict:
    REFERENCES.delete(ref_id)
    return {"ok": True}


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    return JOBS.list()


@app.post("/api/jobs")
def create_job(body: JobCreateRequest) -> dict:
    reference = REFERENCES.get(body.reference_id)
    if not reference:
        raise HTTPException(status_code=404, detail="Reference not found")
    if not body.script.strip():
        raise HTTPException(status_code=400, detail="Script is empty")
    if not body.ref_text.strip():
        raise HTTPException(
            status_code=400,
            detail="Reference text is required. Use Auto-transcribe in the reference panel if needed.",
        )
    settings = coerce_settings(body.settings)
    job = JOBS.add(reference, body.ref_text, body.script, settings)
    if not job["chunks"]:
        raise HTTPException(status_code=400, detail="Could not split the script into chunks")
    return job_to_public(job)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return job_to_public(_get_job(job_id))


@app.get("/api/jobs/{job_id}/status")
def get_job_status(job_id: str) -> dict:
    job = _get_job(job_id)
    final = job.get("final")
    if final:
        final = dict(final)
        final["stale"] = final.get("signature") != _job_signature(job, coerce_settings(job.get("settings")))
    return {
        "id": job["id"],
        "status": job.get("status"),
        "progress": job.get("progress"),
        "error": job.get("error"),
        "final": final,
        "chunks": [
            {
                "id": c["id"],
                "index": c.get("index"),
                "status": c.get("status"),
                "stale": c.get("stale"),
                "duration": c.get("duration"),
                "gen_seconds": c.get("gen_seconds"),
                "audio_version": c.get("audio_version"),
                "enabled": c.get("enabled", True),
                "error": c.get("error"),
            }
            for c in job.get("chunks", [])
        ],
    }


@app.patch("/api/jobs/{job_id}")
def patch_job(job_id: str, body: JobPatchRequest) -> dict:
    job = _get_job(job_id)
    lock = JOBS.lock_for(job_id)
    with lock:
        if body.settings is not None:
            job["settings"] = coerce_settings({**job.get("settings", {}), **body.settings})
        if body.ref_text is not None:
            job["ref_text"] = body.ref_text.strip()
        if body.title:
            job["title"] = body.title.strip()[:80]
        JOBS.save(job)
    return job_to_public(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    job = _get_job(job_id)
    if job.get("status") in ("generating", "queued", "assembling"):
        raise HTTPException(status_code=409, detail="Cancel generation before deleting this session")
    cancel_generation(job_id)
    JOBS.delete(job_id)
    return {"ok": True}


@app.patch("/api/jobs/{job_id}/chunks/{chunk_id}")
def patch_chunk(job_id: str, chunk_id: str, body: ChunkPatchRequest) -> dict:
    job = _get_job(job_id)
    if job.get("status") in ("queued", "generating", "assembling"):
        raise HTTPException(status_code=409, detail="Wait for the current run to finish or cancel it before editing chunks")
    lock = JOBS.lock_for(job_id)
    with lock:
        chunk = next((c for c in job["chunks"] if c["id"] == chunk_id), None)
        if not chunk:
            raise HTTPException(status_code=404, detail="Chunk not found")
        if body.text is not None:
            text = body.text.strip()
            if text != chunk["text"]:
                chunk["text"] = text
                if chunk.get("status") == "done":
                    chunk["stale"] = True
        if body.pause_ms is not None:
            chunk["pause_ms"] = max(0, min(10000, int(body.pause_ms)))
        if body.emphasis is not None:
            if bool(body.emphasis) != chunk.get("emphasis"):
                chunk["emphasis"] = bool(body.emphasis)
                if chunk.get("status") == "done":
                    chunk["stale"] = True
        if body.enabled is not None:
            chunk["enabled"] = bool(body.enabled)
        if not chunk["text"]:
            chunk["status"] = "pending"
            chunk["stale"] = False
        engine._update_progress(job)
        JOBS.save(job)
    return job_to_public(job)


@app.post("/api/jobs/{job_id}/generate")
def generate(job_id: str, body: GenerateRequest) -> dict:
    job = _get_job(job_id)
    if job.get("status") == "assembling":
        raise HTTPException(status_code=409, detail="Assembly is running")
    chunk_ids = body.chunk_ids
    if not chunk_ids:
        enabled = [c for c in job["chunks"] if c.get("enabled", True)]
        if body.only_pending:
            enabled = [c for c in enabled if c.get("status") != "done" or c.get("stale")]
        if not enabled:
            raise HTTPException(status_code=400, detail="Nothing to generate. All enabled chunks are done.")
        chunk_ids = [c["id"] for c in enabled]
    try:
        start_generation(job_id, chunk_ids=chunk_ids, new_seed=body.new_seed)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return job_to_public(_get_job(job_id))


@app.post("/api/jobs/{job_id}/cancel")
def cancel(job_id: str) -> dict:
    _get_job(job_id)
    cancel_generation(job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/assemble")
def assemble(job_id: str) -> dict:
    job = _get_job(job_id)
    if job.get("status") in ("queued", "generating"):
        raise HTTPException(status_code=409, detail="Wait for generation to finish before assembling")
    try:
        assemble_job(job_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Assembly failed: {exc}") from exc
    return job_to_public(_get_job(job_id))


@app.get("/api/jobs/{job_id}/reference")
def get_job_reference(job_id: str) -> FileResponse:
    _get_job(job_id)
    path = JOBS._job_dir(job_id) / "reference.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Job reference audio not found")
    return _no_store(path, "audio/wav")


@app.get("/api/jobs/{job_id}/chunks/{chunk_id}/audio")
def get_chunk_audio(job_id: str, chunk_id: str) -> FileResponse:
    _get_job(job_id)
    path = chunk_audio_path(job_id, chunk_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Chunk audio not generated yet")
    return _no_store(path, "audio/wav")


@app.get("/api/jobs/{job_id}/final")
def get_final(
    job_id: str,
    format: str = Query(default="wav", pattern="^(wav|mp3)$"),
    raw: bool = False,
    download: bool = False,
) -> FileResponse:
    job = _get_job(job_id)
    job_dir = JOBS._job_dir(job_id)
    if raw:
        path = job_dir / "final_raw.wav"
        media = "audio/wav"
    elif format == "mp3":
        path = job_dir / "final.mp3"
        media = "audio/mpeg"
        if not path.exists() and (job_dir / "final.wav").exists():
            result = run_ffmpeg(
                [
                    "-i",
                    str(job_dir / "final.wav"),
                    "-ar",
                    str(TARGET_SR),
                    "-ac",
                    "1",
                    "-c:a",
                    "libmp3lame",
                    "-b:a",
                    "192k",
                    str(path),
                ]
            )
            if result.returncode != 0:
                raise HTTPException(status_code=500, detail=f"MP3 export failed: {result.stderr[:300]}")
    else:
        path = job_dir / "final.wav"
        media = "audio/wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Final audio not assembled yet")
    stem = clean_filename(job.get("title", "speech"))
    filename = f"{stem}.{path.suffix.lstrip('.')}" if download else None
    return _no_store(path, media, filename)


@app.get("/api/jobs/{job_id}/final/peaks")
def get_final_peaks(job_id: str) -> dict:
    job = _get_job(job_id)
    path = JOBS._job_dir(job_id) / "final.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Final audio not assembled yet")
    return {"peaks": peaks_from_file(path), "duration": job.get("final", {}).get("duration")}


@app.exception_handler(Exception)
def unhandled(request, exc: Exception):
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


app.mount("/static", StaticFiles(directory=str(engine.STATIC_DIR)), name="static")


@app.get("/")
def index() -> FileResponse:
    return _no_store(engine.STATIC_DIR / "index.html", "text/html")


@app.get("/favicon.ico")
def favicon():
    path = engine.STATIC_DIR / "favicon.svg"
    if path.exists():
        return _no_store(path, "image/svg+xml")
    raise HTTPException(status_code=404)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=7862, log_level="info", access_log=False)
