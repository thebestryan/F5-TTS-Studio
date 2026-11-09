#!/usr/bin/env bash
# Create the Python environment and install F5-TTS plus studio dependencies on Linux.
# Run from anywhere; paths resolve from this script.
#
# Usage:
#   bash studio/install.sh                 # auto-detect GPU (ROCm / CUDA / CPU)
#   bash studio/install.sh --rocm          # AMD ROCm 7.2 wheels
#   bash studio/install.sh --rocm 6.2      # AMD ROCm 6.2 wheels
#   bash studio/install.sh --cpu           # CPU-only wheels
#   bash studio/install.sh --recreate      # rebuild .venv from scratch
#
# Overrides: F5_TTS_PYTHON (default 3.11), F5_TTS_ROCM_VERSION (7.2),
#            F5_TTS_TORCH_VERSION.
set -euo pipefail

# The uv cache is often on a different filesystem than this checkout, so
# hardlinking is unavailable. Default to copy to avoid the warning; override
# by exporting UV_LINK_MODE before running.
export UV_LINK_MODE="${UV_LINK_MODE:-copy}"

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$STUDIO_DIR")"
VENV="$ROOT_DIR/.venv"
PYTHON_VERSION="${F5_TTS_PYTHON:-3.11}"
BACKEND="auto"
ROCM_VERSION="${F5_TTS_ROCM_VERSION:-7.2}"
TORCH_VERSION="${F5_TTS_TORCH_VERSION:-}"
RECREATE=0

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --rocm)
      BACKEND="rocm"
      shift
      if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then ROCM_VERSION="$1"; shift; fi
      ;;
    --cpu) BACKEND="cpu"; shift ;;
    --recreate) RECREATE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

find_uv() {
  if command -v uv >/dev/null 2>&1; then command -v uv; return; fi
  for candidate in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" "/usr/local/bin/uv"; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  return 1
}

UV="$(find_uv || true)"
if [ -z "$UV" ]; then
  echo "uv was not found. Install it first:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

if [ "$BACKEND" = "auto" ]; then
  if [ -e /dev/kfd ] || [ -d /opt/rocm ] || command -v rocm-smi >/dev/null 2>&1; then
    echo "Detected AMD ROCm; selecting the ROCm backend."
    BACKEND="rocm"
  elif command -v nvidia-smi >/dev/null 2>&1; then
    echo "Detected NVIDIA CUDA; using the default PyPI PyTorch build."
  else
    echo "No GPU detected; installing CPU-only PyTorch."
    BACKEND="cpu"
  fi
fi

cd "$ROOT_DIR"
if [ "$RECREATE" = 1 ] && [ -e "$VENV" ]; then
  backup="$VENV.bak.$(date +%s)"
  echo "Recreating .venv (moved existing to $backup)"
  mv "$VENV" "$backup"
fi
if [ ! -x "$VENV/bin/python" ]; then
  if [ -e "$VENV" ]; then
    backup="$VENV.bak.$(date +%s)"
    echo "Existing .venv is not a Linux environment; moving it to $backup"
    mv "$VENV" "$backup"
  fi
  "$UV" venv --python "$PYTHON_VERSION" "$VENV"
fi
PY="$VENV/bin/python"

# Highest torch/torchaudio version that the ROCm wheel index publishes for both
# packages (torchaudio usually lags torch, so the intersection is what installs).
rocm_torch_version() {
  local base="https://download.pytorch.org/whl/rocm${ROCM_VERSION}"
  local esc="${ROCM_VERSION//./\\.}"
  local tv av
  tv="$(curl -fsSL "$base/torch/" 2>/dev/null \
    | grep -oE "torch-[0-9]+\.[0-9]+\.[0-9]+(%2B|\+)rocm${esc}" \
    | sed -E 's/torch-([0-9.]+).*/\1/' | sort -u || true)"
  av="$(curl -fsSL "$base/torchaudio/" 2>/dev/null \
    | grep -oE "torchaudio-[0-9]+\.[0-9]+\.[0-9]+(%2B|\+)rocm${esc}" \
    | sed -E 's/torchaudio-([0-9.]+).*/\1/' | sort -u || true)"
  [ -n "$tv" ] && [ -n "$av" ] || return 1
  comm -12 <(printf '%s\n' "$tv") <(printf '%s\n' "$av") | sort -V | tail -n1
}

install_torch() {
  case "$BACKEND" in
    rocm)
      local ver="$TORCH_VERSION"
      if [ -z "$ver" ]; then
        ver="$(rocm_torch_version || true)"
      fi
      if [ -n "$ver" ]; then
        echo "Installing PyTorch $ver for ROCm $ROCM_VERSION ..."
        "$UV" pip install --python "$PY" \
          "torch==${ver}+rocm${ROCM_VERSION}" "torchaudio==${ver}+rocm${ROCM_VERSION}" \
          --extra-index-url "https://download.pytorch.org/whl/rocm${ROCM_VERSION}"
      else
        echo "Could not resolve a matching torch/torchaudio version for ROCm $ROCM_VERSION." >&2
        echo "Installing the latest from the ROCm index; set F5_TTS_TORCH_VERSION to pin one." >&2
        "$UV" pip install --python "$PY" torch torchaudio \
          --extra-index-url "https://download.pytorch.org/whl/rocm${ROCM_VERSION}"
      fi
      ;;
    cpu)
      echo "Installing CPU-only PyTorch ..."
      "$UV" pip install --python "$PY" torch torchaudio --index-url https://download.pytorch.org/whl/cpu
      ;;
    auto)
      echo "Using the default PyPI PyTorch build (CUDA on Linux). Pass --rocm or --cpu to choose."
      ;;
  esac
}

install_torch

"$UV" pip install --python "$PY" -e "$ROOT_DIR"
"$UV" pip install --python "$PY" "fastapi>=0.115" "uvicorn[standard]>=0.30" "python-multipart>=0.0.9"

# torchcodec only ships CUDA wheels and fails to load on ROCm/CPU builds (missing libnvrtc);
# transformers falls back to ffmpeg, so remove it to keep transcription working.
"$UV" pip uninstall --python "$PY" torchcodec 2>/dev/null || true

"$PY" - <<'PY'
import torch
backend = "rocm" if getattr(torch.version, "hip", None) else ("cuda" if torch.cuda.is_available() else "cpu")
print(f"torch {torch.__version__} · backend {backend} · accelerator available: {torch.cuda.is_available()}")
PY

echo
echo "Installed. Start the studio with:"
echo "  bash studio/run.sh          # foreground"
echo "  bash studio/start.sh        # background (PID file + logs)"
if [ "$BACKEND" = "rocm" ]; then
  echo "ROCm backend is auto-selected on startup. Override with F5_TTS_DEVICE=rocm or F5_TTS_DEVICE=cpu."
fi
