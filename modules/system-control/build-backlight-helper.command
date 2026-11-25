#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$PROJECT_DIR/modules/system-control/src/workbuddy-qq-backlight.c"
OUT_DIR="$PROJECT_DIR/modules/system-control/bin"
OUT="$OUT_DIR/workbuddy-qq-backlight"

mkdir -p "$OUT_DIR"

clang -Wall -Wextra -O2 -framework CoreGraphics "$SRC" -o "$OUT"
chmod +x "$OUT"

echo "Built $OUT"
