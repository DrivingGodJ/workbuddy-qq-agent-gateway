#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.workbuddy.qq-agent-gateway.chat-hub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
QQ_LABEL="local.workbuddy.qq-agent-gateway.qq-runtime"
QQ_PLIST="$HOME/Library/LaunchAgents/$QQ_LABEL.plist"
PORT="3789"
USER_DOMAIN="gui/$(id -u)"

cd "$PROJECT_DIR" || exit 1

"$PROJECT_DIR/modules/install-launchd-plist.command"

start_qq_runtime() {
  if ! launchctl print "$USER_DOMAIN/$QQ_LABEL" >/dev/null 2>&1; then
    launchctl bootstrap "$USER_DOMAIN" "$QQ_PLIST"
  fi
}

if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "WorkBuddy QQ Agent Gateway is already running:"
  echo "http://localhost:$PORT"
  start_qq_runtime || echo "QQ background recovery could not be loaded; Hub remains online." >&2
  exit 0
fi

launchctl bootout "$USER_DOMAIN/$LABEL" >/dev/null 2>&1 || true
for _ in {1..5}; do
  if ! launchctl print "$USER_DOMAIN/$LABEL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! launchctl bootstrap "$USER_DOMAIN" "$PLIST"; then
  sleep 1
  launchctl bootstrap "$USER_DOMAIN" "$PLIST"
fi

for _ in {1..30}; do
  if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "WorkBuddy QQ Agent Gateway started:"
    echo "http://localhost:$PORT"
    start_qq_runtime || echo "QQ background recovery could not be loaded; Hub remains online." >&2
    exit 0
  fi
  sleep 1
done

echo "WorkBuddy QQ Agent Gateway did not start. Check:"
echo "$PROJECT_DIR/runtime/logs/chat-hub.err.log"
exit 1
