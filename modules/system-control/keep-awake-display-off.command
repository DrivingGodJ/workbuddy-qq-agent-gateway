#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PID_FILE="$PROJECT_DIR/data/keep-awake.pid"
LOG_FILE="$PROJECT_DIR/runtime/logs/keep-awake.log"

mkdir -p "$PROJECT_DIR/data" "$PROJECT_DIR/runtime/logs"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
    COMMAND_NAME="$(ps -p "$OLD_PID" -o comm= 2>/dev/null || true)"
    if [[ "$COMMAND_NAME" == *caffeinate* ]]; then
      echo "WorkBuddy QQ keep-awake is already running. pid=$OLD_PID"
    else
      rm -f "$PID_FILE"
    fi
  else
    rm -f "$PID_FILE"
  fi
fi

if [ ! -f "$PID_FILE" ]; then
  echo "Starting keep-awake guard..."
  /usr/bin/nohup /usr/bin/caffeinate -dimsu >"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  echo "keep-awake guard started. pid=$(cat "$PID_FILE")"
fi

echo "Turning display off. Background apps will keep running."
/usr/bin/pmset displaysleepnow
