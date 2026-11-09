#!/usr/bin/env bash
# Stop F5-TTS Studio started by start.sh, or whatever owns port 7862 (Linux/macOS).
set -u

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$STUDIO_DIR")"
DATA_DIR="$STUDIO_DIR/data"
PID_FILE="$DATA_DIR/studio.pid"
PORT=7862

if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PY="$ROOT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="python3"
else
  PY="python"
fi

port_open() {
  "$PY" -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1',$PORT))==0 else 1)" 2>/dev/null
}

if ! port_open; then
  rm -f "$PID_FILE"
  echo "F5-TTS Studio is not running on port $PORT."
  exit 0
fi

if [ -f "$PID_FILE" ]; then
  PID="$(tr -d '[:space:]' < "$PID_FILE")"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# The PID file can be stale or missing (for example when the server was started
# from another terminal). Fall back to killing whatever listens on the port.
if port_open; then
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
  elif command -v lsof >/dev/null 2>&1; then
    PIDS="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
    if [ -n "$PIDS" ]; then
      kill $PIDS >/dev/null 2>&1 || true
    fi
  fi
fi

for _ in $(seq 1 10); do
  if ! port_open; then
    echo "F5-TTS Studio stopped."
    exit 0
  fi
  sleep 1
done

echo "Port $PORT is still in use. Stop the process manually." >&2
exit 1
