#!/usr/bin/env bash
# Start the F5-TTS Studio server in the foreground at http://127.0.0.1:7862
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$STUDIO_DIR")"

if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PY="$ROOT_DIR/.venv/bin/python"
else
  echo "Linux Python environment not found. Run studio/install.sh first." >&2
  exit 1
fi

cd "$STUDIO_DIR"
echo "F5-TTS Studio -> http://127.0.0.1:7862"
exec "$PY" app.py
