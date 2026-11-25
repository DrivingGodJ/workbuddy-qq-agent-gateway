#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PID_FILE="$PROJECT_DIR/data/keep-awake.pid"
BRIGHTNESS_FILE="$PROJECT_DIR/data/previous-brightness.txt"
LOG_FILE="$PROJECT_DIR/runtime/logs/keep-awake.log"
BACKLIGHT="$PROJECT_DIR/modules/system-control/bin/workbuddy-qq-backlight"

mkdir -p "$PROJECT_DIR/data" "$PROJECT_DIR/runtime/logs"

if [ ! -x "$BACKLIGHT" ]; then
  echo "找不到 WorkBuddy QQ 背光工具：$BACKLIGHT"
  exit 1
fi

if ! "$BACKLIGHT" list | grep -q "builtin=yes"; then
  echo "没有找到在线的 MacBook 内置屏。"
  echo "如果现在是合盖状态，或者 macOS 只启用了外接显示器，系统不会暴露内置屏背光给脚本控制。"
  "$BACKLIGHT" list || true
  exit 2
fi

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
  echo "启动防休眠守护..."
  /usr/bin/nohup /usr/bin/caffeinate -dimsu >"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  echo "防休眠守护已启动。pid=$(cat "$PID_FILE")"
fi

if [ ! -f "$BRIGHTNESS_FILE" ]; then
  CURRENT="$("$BACKLIGHT" get 2>/dev/null || true)"
  if [ -z "$CURRENT" ]; then
    CURRENT="0.7"
  fi
  printf '%s\n' "$CURRENT" > "$BRIGHTNESS_FILE"
  echo "已保存原内置屏亮度：$CURRENT"
else
  echo "已存在原内置屏亮度记录：$(cat "$BRIGHTNESS_FILE")"
fi

echo "正在把内置屏亮度设为 0，并保持桌面会话醒着。"
"$BACKLIGHT" set 0
