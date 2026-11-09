# F5-TTS Studio

A local, browser-based studio for [F5-TTS](https://github.com/SWivid/F5-TTS) built for long-form speech.

It wraps the official F5-TTS inference stack with a FastAPI backend and a custom single-page UI. No frontend build step.

## Features

- Reference voice upload with waveform selection, trim, duration warning, and optional Whisper auto-transcription.
- Long-script chunking at sentence/paragraph boundaries, with editable chunks, per-chunk pause, emphasis, mute, play, and regenerate.
- Sequential batch generation with live progress, ETA, cancellation, per-chunk takes, and persistent sessions.
- Native F5-TTS controls: NFE steps (draft/balanced/quality presets), CFG strength, sway sampling, generation speed, seed, target RMS, reference processing.
- Post-processing controls: speed (time-stretch), pitch (semitones, formant preserved), loudness normalization, silence trimming, crossfade, emphasis gain.
- Final mix assembly and WAV/MP3 export, plus raw (pre-post) download.
- Sessions survive server restarts; generated chunks and finals are saved on disk.

## Requirements

- Linux or Windows. The `*.sh` scripts are Linux-only; on Windows use the PowerShell scripts. On Linux use `bash studio/install.sh`; on Windows use `.\studio\install.ps1`.
- `ffmpeg` on `PATH` with the `rubberband` and `loudnorm` filters. On Debian/Ubuntu: `sudo apt install ffmpeg`.
- Python 3.11 is provisioned automatically by `uv`.
- An AMD (ROCm) GPU is optional but strongly recommended on Linux. ROCm is Linux-only. CPU generation is slow: roughly 1–3 minutes per 10 seconds of audio at 24–32 steps. Draft mode (16 NFE) is much faster.

## Install

### Linux

```bash
cd /path/to/F5-TTS
bash studio/install.sh            # auto-detect GPU (ROCm / CUDA / CPU)
bash studio/install.sh --rocm     # force AMD Radeon via ROCm 7.2
bash studio/install.sh --rocm 6.2 # older RDNA1/2/3 GPUs
bash studio/install.sh --cpu      # CPU-only
bash studio/install.sh --recreate # rebuild .venv from scratch
```

`install.sh` auto-detects the GPU: `/dev/kfd`, `/opt/rocm`, or `rocm-smi` selects ROCm; `nvidia-smi` keeps the default PyPI (CUDA) wheels; otherwise it installs CPU-only wheels. The default PyPI `torch` on Linux is the CUDA build and pulls in the `nvidia-*` runtime packages plus `triton`, so pass `--rocm` or `--cpu` on a machine without an NVIDIA GPU. Use `--recreate` to switch backends cleanly; the old `.venv` is moved to `.venv.bak.<timestamp>`, never deleted.

### Windows

```powershell
cd S:\ai\F5-TTS
.\studio\install.ps1
```

Either installer creates `.venv` (Python 3.11), installs F5-TTS editable, and adds FastAPI/Uvicorn. If `.venv` already exists from another platform or backend, `install.sh` moves it aside to `.venv.bak.<timestamp>` and creates a fresh Linux environment rather than deleting it. The installer sets `UV_LINK_MODE=copy` so `uv` does not warn about hardlinks when the checkout and the `uv` cache are on different filesystems.

For `--rocm`, `install.sh` queries the ROCm wheel index and installs the newest `torch`/`torchaudio` version published for both packages (torchaudio usually lags torch), so it keeps working as the index changes. Set `F5_TTS_TORCH_VERSION` to pin an exact version instead.

The first model load downloads the F5-TTS v1 Base checkpoint and Vocos vocoder from Hugging Face (about 1.5 GB). Auto-transcription additionally downloads Whisper (`openai/whisper-large-v3-turbo`).

## Run

### Linux

```bash
bash studio/run.sh
```

or start detached with `bash studio/start.sh` and stop it with `bash studio/stop.sh`. Open <http://127.0.0.1:7862>.

### Windows

```powershell
.\studio\run.ps1
```

or double-click `studio\run.bat`. Open <http://127.0.0.1:7862>.

### Background start/stop

From bash (Linux):

```bash
bash studio/start.sh
bash studio/stop.sh
```

`start.sh` launches the server detached, writes `studio/data/studio.pid`, and logs to `studio/data/studio.out.log` and `studio/data/studio.err.log`. It is verbose by default: it prints the interpreter and log paths, tails the server log while waiting for the port, detects an early crash (instead of waiting out the timeout), and dumps the last log lines on failure. Pass `-q`/`--quiet` to silence progress, and set `F5_START_TIMEOUT` to change the wait (default 90s). `stop.sh` kills the recorded process and also frees port 7862 if the PID file is missing or stale (for example when the server was started from another terminal). This is the fallback for terminals that leave the server running after they close.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `F5_TTS_MODEL` | `F5TTS_v1_Base` | Checkpoint/config name passed to `F5TTS` |
| `F5_TTS_DEVICE` | auto | `auto`, `cpu`, `cuda`, `rocm`, `mps`, `xpu`, `npu`. `rocm`/`hip` map to `cuda` (PyTorch exposes ROCm through the CUDA API) |
| `F5_STUDIO_DATA` | `studio/data` | Uploads, jobs, finals |
| `FFMPEG_BINARY` | `ffmpeg` on PATH | FFmpeg executable |
| `F5_TTS_ROCM_VERSION` | `7.2` | ROCm wheel version for `install.sh --rocm` |
| `F5_TTS_TORCH_VERSION` | auto | Pin an exact torch version for `install.sh --rocm` (otherwise the newest matching pair is used) |

Device selection: leave `F5_TTS_DEVICE` unset to auto-detect. On a ROCm PyTorch build the studio uses the Radeon GPU automatically; set `F5_TTS_DEVICE=rocm` to force it, or `F5_TTS_DEVICE=cpu` to force CPU. The device chip in the header shows the active backend and GPU.

## Workflow

1. **Voice reference** – Load 4–12 seconds of clean single-speaker audio. Type the exact transcript or use Auto-transcribe. F5-TTS internally clips longer references to 12 seconds; use the waveform selection and Trim to choose the best line.
2. **Script** – Paste the full speech. Blank lines are paragraph breaks. Build chunks, review the split, then Generate all. Chunk size is measured in characters (including spaces and punctuation), not words.
3. **Master** – Tune engine settings before generating, pacing at build time, and post-processing at assembly. Assemble final and download.

### Markup

| Syntax | Effect |
| --- | --- |
| `[pause=1.5s]`, `[pause=750ms]`, `[pause]` | Pause after the preceding sentence. Default is 1 s. |
| `<break time="2s"/>` | Same as a pause tag. |
| `*words*`, `**words**`, `<emph>words</emph>` | Mark the chunk as emphasized: slower native delivery and extra gain at assembly. |

Chunk-level pause overrides are editable in each chunk card.

### Controls that require regeneration

NFE, CFG, sway, generation speed, seed, target RMS and emphasis slowdown are baked into a take. Changing them only affects new or regenerated chunks; use **Regenerate all** to apply them to an existing session.

Master speed, pitch, loudness, gap/crossfade, trimming and emphasis gain are applied at assembly time and only need **Reassemble final**.

## How it works

- `studio/engine.py` loads the model once, splits scripts, runs `infer_batch_process` one chunk at a time on a background thread, persists jobs, stitches audio, and runs FFmpeg Rubber Band + loudnorm.
- `studio/app.py` exposes the REST API and serves the UI.
- `studio/static/` contains the HTML/CSS/JS UI.
- `studio/data/uploads/` stores converted reference WAVs; `studio/data/jobs/<id>/` stores `job.json`, `reference.wav`, `chunk_*.wav`, `final_raw.wav`, `final.wav`, `final.mp3`.

Chunks are generated sequentially under a single inference lock. After generation, chunks are trimmed, optionally emphasized, joined with per-chunk gaps or crossfades, then post-processed. The final signature detects when chunks or master settings changed since the last assembly.

The UI polls a compact `/status` endpoint during long runs and refreshes the full session only when needed. Chunk editing is locked while a run is active so the generated text cannot change underneath the model.

The backend avoids `torchaudio.load`, which can fail when TorchCodec cannot find a shared FFmpeg build. Reference audio is decoded by FFmpeg/pydub and loaded with SoundFile instead.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Model/device status |
| GET | `/api/config` | Defaults, limits, markup |
| POST | `/api/references` | Upload reference audio (multipart `file`) |
| GET | `/api/references` | List references with peaks |
| GET | `/api/references/{id}/audio` | Reference WAV |
| POST | `/api/references/{id}/trim` | Trim to `{start, end}` seconds |
| POST | `/api/references/{id}/transcribe` | Whisper transcription |
| POST | `/api/jobs` | Create a chunked session |
| GET | `/api/jobs` | Session list |
| GET | `/api/jobs/{id}` | Full session |
| GET | `/api/jobs/{id}/status` | Compact status for polling |
| PATCH | `/api/jobs/{id}` | Update settings/ref text/title |
| PATCH | `/api/jobs/{id}/chunks/{cid}` | Edit chunk text, pause, emphasis, enabled |
| POST | `/api/jobs/{id}/generate` | Generate pending/all/specific chunks |
| POST | `/api/jobs/{id}/cancel` | Stop after current chunk |
| POST | `/api/jobs/{id}/assemble` | Stitch and post-process |
| GET | `/api/jobs/{id}/chunks/{cid}/audio` | Chunk WAV |
| GET | `/api/jobs/{id}/final` | Final audio (`format`, `raw`, `download`) |
| DELETE | `/api/jobs/{id}` | Delete session |

The server binds only to `127.0.0.1` and has no authentication. Do not expose it to a network.

## Notes

- F5-TTS is English/Chinese-centric. Other languages are limited by the base model and its tokenizer.
- For very long scripts, generation time dominates. Use smaller `Chunk size`, draft NFE, and the per-chunk workflow to iterate.
- Emphasis is an approximation: F5 has no native emphasis token. The studio marks the chunk, slows native delivery slightly, and adds gain at assembly.
- Pitch/speed post-processing requires FFmpeg's `rubberband` filter; without it assembly with pitch/speed changes will fail.
- ROCm: RDNA 3.5 / RDNA 4 GPUs (Radeon 8050S/8060S, RX 9060/9070) need ROCm 7.x; ROCm 6.x causes `HIP error: invalid device function`. For GPUs not officially supported by the installed ROCm version, set `HSA_OVERRIDE_GFX_VERSION` before launching (for example `HSA_OVERRIDE_GFX_VERSION=11.0.0 bash studio/run.sh`).
