#!/usr/bin/env bash
# Manage the PERV Flask app (gunicorn) without root / systemd.
#
# Usage:
#   ./serve.sh start    # start gunicorn in background
#   ./serve.sh stop     # stop it
#   ./serve.sh restart
#   ./serve.sh status
#   ./serve.sh log      # tail logs
#
# Configurable via env vars:
#   PERV_HOST  default 127.0.0.1   (use 0.0.0.0 if firewall opens the port)
#   PERV_PORT  default 5000
#   PERV_WORKERS default 2
#   PERV_THREADS default 8   (threads per worker; bigwig Range reads are I/O
#                             bound, so threads add concurrency much cheaper
#                             than extra workers. Tune against shared-disk IOPS.)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

HOST="${PERV_HOST:-127.0.0.1}"
PORT="${PERV_PORT:-5000}"
WORKERS="${PERV_WORKERS:-2}"
THREADS="${PERV_THREADS:-8}"
PID_FILE="$DIR/.perv.pid"
LOG_FILE="$DIR/perv.log"
VENV_PY="$DIR/.venv/bin/python"
GUNICORN="$DIR/.venv/bin/gunicorn"

if [[ ! -x "$GUNICORN" ]]; then
  echo "gunicorn not found at $GUNICORN" >&2
  echo "Run: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt" >&2
  exit 1
fi

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

cmd_start() {
  if is_running; then
    echo "Already running (pid $(cat "$PID_FILE"))."
    return 0
  fi
  echo "Starting gunicorn on ${HOST}:${PORT} with ${WORKERS} workers x ${THREADS} threads..."
  nohup "$GUNICORN" -w "$WORKERS" --threads "$THREADS" -b "${HOST}:${PORT}" \
    --access-logfile "$LOG_FILE" --error-logfile "$LOG_FILE" \
    app:app >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  sleep 1
  if is_running; then
    echo "Started (pid $(cat "$PID_FILE")). Logs: $LOG_FILE"
  else
    echo "Failed to start. See $LOG_FILE." >&2
    exit 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "Not running."
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  echo "Stopping gunicorn (pid $pid)..."
  kill "$pid" || true
  for _ in $(seq 1 20); do
    sleep 0.2
    kill -0 "$pid" 2>/dev/null || break
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "Force killing..."
    kill -9 "$pid" || true
  fi
  rm -f "$PID_FILE"
  echo "Stopped."
}

cmd_status() {
  if is_running; then
    echo "running (pid $(cat "$PID_FILE")) on ${HOST}:${PORT}"
  else
    echo "stopped"
    return 1
  fi
}

cmd_log() {
  tail -n 80 -f "$LOG_FILE"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop || true; cmd_start ;;
  status) cmd_status ;;
  log) cmd_log ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|log}" >&2
    exit 2
    ;;
esac
