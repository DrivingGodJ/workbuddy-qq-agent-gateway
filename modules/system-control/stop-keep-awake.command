#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PID_FILE="$PROJECT_DIR/data/keep-awake.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No WorkBuddy QQ keep-awake guard pid file found."
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
rm -f "$PID_FILE"

if [ -z "$PID" ]; then
  echo "Empty pid file removed."
  exit 0
fi

if kill -0 "$PID" >/dev/null 2>&1; then
  kill "$PID"
  echo "Stopped keep-awake guard. pid=$PID"
else
  echo "keep-awake guard was not running. pid=$PID"
fi
