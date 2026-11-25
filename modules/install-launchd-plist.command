#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$PROJECT_DIR/config/local.workbuddy.qq-agent-gateway.chat-hub.plist.example"
TARGET="$PROJECT_DIR/config/local.workbuddy.qq-agent-gateway.chat-hub.plist"
LABEL="local.workbuddy.qq-agent-gateway.chat-hub"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
RUNNER_DIR="${WORKBUDDY_QQ_LAUNCHER_DIR:-$HOME/.workbuddy-qq-gateway}"
RUNNER_PATH="$RUNNER_DIR/run-qq-only.command"

mkdir -p "$RUNNER_DIR"
mkdir -p "$LAUNCH_AGENTS_DIR"
cp -X "$PROJECT_DIR/modules/run-qq-only.command" "$RUNNER_PATH"
chmod 755 "$RUNNER_PATH"

sed -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" -e "s#__RUNNER_PATH__#$RUNNER_PATH#g" "$TEMPLATE" > "$TARGET"
chmod 600 "$TARGET"
plutil -lint "$TARGET" >/dev/null
cp -f "$TARGET" "$INSTALLED_PLIST"
chmod 600 "$INSTALLED_PLIST"
echo "Installed $INSTALLED_PLIST"

QQ_LABEL="local.workbuddy.qq-agent-gateway.qq-runtime"
QQ_RUNNER_PATH="$RUNNER_DIR/run-qq-runtime.command"
QQ_TARGET="$PROJECT_DIR/config/$QQ_LABEL.plist"
QQ_INSTALLED_PLIST="$LAUNCH_AGENTS_DIR/$QQ_LABEL.plist"
cp -X "$PROJECT_DIR/modules/run-qq-runtime.command" "$QQ_RUNNER_PATH"
chmod 755 "$QQ_RUNNER_PATH"
sed -e "s#__PROJECT_DIR__#$PROJECT_DIR#g" -e "s#__RUNNER_PATH__#$QQ_RUNNER_PATH#g" \
  "$PROJECT_DIR/config/$QQ_LABEL.plist.example" > "$QQ_TARGET"
chmod 600 "$QQ_TARGET"
plutil -lint "$QQ_TARGET" >/dev/null
cp -f "$QQ_TARGET" "$QQ_INSTALLED_PLIST"
chmod 600 "$QQ_INSTALLED_PLIST"
echo "Installed $QQ_INSTALLED_PLIST"
