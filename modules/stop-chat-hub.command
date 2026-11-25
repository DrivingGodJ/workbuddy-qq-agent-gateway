#!/bin/zsh
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="local.workbuddy.qq-agent-gateway.chat-hub"
PORT="3789"
USER_DOMAIN="gui/$(id -u)"

launchctl bootout "$USER_DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "$USER_DOMAIN/local.workbuddy.qq-agent-gateway.qq-runtime" >/dev/null 2>&1 || true

pid=$(lsof -tiTCP:$PORT -sTCP:LISTEN)

if [ -z "$pid" ]; then
  echo "WorkBuddy QQ Agent Gateway is not running."
  exit 0
fi

kill -TERM $pid
echo "Stopped WorkBuddy QQ Agent Gateway on port $PORT."
