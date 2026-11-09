#!/usr/bin/env bash
# Start F5-TTS Studio in the background (Linux/macOS) and write a PID file.
#
# Verbose by default: prints configuration, tails the server log while waiting,
# detects an early crash, and dumps the logs on failure. Pass -q/--quiet to
# suppress progress output.
set -u

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$STUDIO_DIR")"
DATA_DIR="$STUDIO_DIR/data"
PID_FILE="$DATA_DIR/studio.pid"
OUT_LOG="$DATA_DIR/studio.out.log"
ERR_LOG="$DATA_DIR/studio.err.log"
PORT=7862
WAIT_SECONDS="${F5_START_TIMEOUT:-90}"

VERBOSE=1
case "${1:-}" in
  -q|--quiet) VERBOSE=0 ;;
  -h|--help)
    echo "Usage: bash studio/start.sh [-q|--quiet]"
    echo "Starts F5-TTS Studio in the background on http://127.0.0.1:$PORT."
    echo "  F5_START_TIMEOUT  seconds to wait for startup (default $WAIT_SECONDS)"
    exit 0
    ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

log() { [ "$VERBOSE" = 1 ] && echo "[start] $*" || true; }

tail_last() {
  [ -f "$1" ] || return 0
  local last
  last="$(tail -n 1 "$1" 2>/dev/null)"
  [ -n "$last" ] && echo "        ${last%$'\r'}"
}

show_logs() {
  for f in "$OUT_LOG" "$ERR_LOG"; do
    if [ -s "$f" ]; then
      echo "--- ${f##*/} (last 25 lines) ---" >&2
      tail -n 25 "$f" >&2
    fi
  done
}

mkdir -p "$DATA_DIR"

if [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PY="$ROOT_DIR/.venv/bin/python"
else
  echo "Linux Python environment not found. Run studio/install.sh first." >&2
  exit 1
fi

port_open() {
  "$PY" -c "import socket,sys; s=socket.socket(); s.settimeout(0.4); sys.exit(0 if s.connect_ex(('127.0.0.1',$PORT))==0 else 1)" 2>/dev/null
}

log "python: $PY"
log "studio: $STUDIO_DIR"
log "port:   $PORT"
log "logs:   $OUT_LOG"
log "        $ERR_LOG"

if port_open; then
  echo "F5-TTS Studio is already running at http://127.0.0.1:$PORT"
  exit 0
fi

cd "$STUDIO_DIR" || exit 1

log "Launching server ..."
nohup "$PY" app.py </dev/null >"$OUT_LOG" 2>"$ERR_LOG" &
echo $! > "$PID_FILE"

elapsed=0
while [ "$elapsed" -lt "$WAIT_SECONDS" ]; do
  if port_open; then
    echo "F5-TTS Studio started at http://127.0.0.1:$PORT"
    echo "Logs: $OUT_LOG and $ERR_LOG"
    exit 0
  fi
  if [ -f "$PID_FILE" ]; then
    pid="$(tr -d '[:space:]' < "$PID_FILE")"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "Server process exited during startup (pid $pid)." >&2
      show_logs
      echo "Run 'bash studio/run.sh' to see the full output live." >&2
      rm -f "$PID_FILE"
      exit 1
    fi
  fi
  if [ "$VERBOSE" = 1 ] && [ $((elapsed % 5)) -eq 0 ]; then
    log "waiting for port $PORT (${elapsed}s/${WAIT_SECONDS}s) ..."
    tail_last "$OUT_LOG"
    tail_last "$ERR_LOG"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "Server did not start within ${WAIT_SECONDS}s. See $ERR_LOG" >&2
show_logs
echo "Run 'bash studio/run.sh' to see the full output live." >&2
exit 1
