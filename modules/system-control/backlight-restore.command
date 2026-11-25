#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PID_FILE="$PROJECT_DIR/data/keep-awake.pid"
BRIGHTNESS_FILE="$PROJECT_DIR/data/previous-brightness.txt"
BACKLIGHT="$PROJECT_DIR/modules/system-control/bin/workbuddy-qq-backlight"

if [ -x "$BACKLIGHT" ]; then
  TARGET="0.7"
  if [ -f "$BRIGHTNESS_FILE" ]; then
    TARGET="$(cat "$BRIGHTNESS_FILE" 2>/dev/null || true)"
    rm -f "$BRIGHTNESS_FILE"
  fi
  if [ -z "$TARGET" ]; then
    TARGET="0.7"
  fi
  if "$BACKLIGHT" list | grep -q "builtin=yes"; then
    echo "正在恢复内置屏亮度到 $TARGET"
    "$BACKLIGHT" set "$TARGET"
  else
    echo "没有找到在线的 MacBook 内置屏，已跳过亮度恢复。"
    "$BACKLIGHT" list || true
  fi
else
  echo "找不到 WorkBuddy QQ 背光工具：$BACKLIGHT"
fi

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  rm -f "$PID_FILE"
  if [ -n "$PID" ] && kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID"
    echo "已停止防休眠守护。pid=$PID"
  fi
fi
