#!/usr/bin/env bash
# WorkBuddy 引擎桥的环境安装：建独立 venv 并装 CodeBuddy Agent SDK
# 用法：bash modules/workbuddy-agent/setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"
PY="${WB_PYTHON:-}"
supports_sdk() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}
if [ -z "$PY" ]; then
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    candidate_path="$(command -v "$candidate" || true)"
    if [ -n "$candidate_path" ] && supports_sdk "$candidate_path"; then
      PY="$candidate_path"
      break
    fi
  done
fi
if [ -z "$PY" ] || ! supports_sdk "$PY"; then
  echo "需要 Python 3.10+；Mac 自带的 Python 可能太旧。安装新版本后重试，或设置 WB_PYTHON 指向它。" >&2
  exit 1
fi
if [ -x "$VENV/bin/python" ] && ! supports_sdk "$VENV/bin/python"; then
  echo "现有 $VENV 使用旧版 Python；请先将这个虚拟环境移到备份目录，再重新运行安装。" >&2
  exit 1
fi

if [ ! -x "$VENV/bin/python" ]; then
  echo "==> 建 venv: $VENV"
  "$PY" -m venv "$VENV"
fi

echo "==> 装/更新 codebuddy-agent-sdk"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$HERE/requirements.txt"

echo "==> 完成"
"$VENV/bin/python" -c "import codebuddy_agent_sdk as s; print('SDK', getattr(s,'__version__','?'))"
echo
echo "网关侧指向它即可："
echo "  export WORKBUDDY_QQ_WB_PYTHON=\"$VENV/bin/python\""
