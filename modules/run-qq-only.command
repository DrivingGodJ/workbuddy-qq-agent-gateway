#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${WORKBUDDY_QQ_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${WORKBUDDY_QQ_ENV_FILE:-$PROJECT_DIR/config/qq-only.env}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
KEYCHAIN_SERVICE="${WORKBUDDY_QQ_KEYCHAIN_SERVICE:-WorkBuddy QQ Gateway}"

if [ -f "$ENV_FILE" ]; then
  BOOTSTRAP_NODE="${WORKBUDDY_QQ_NODE_PATH:-}"
  if [ -z "$BOOTSTRAP_NODE" ] || [ ! -x "$BOOTSTRAP_NODE" ]; then
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
      if [ -x "$candidate" ]; then BOOTSTRAP_NODE="$candidate"; break; fi
    done
  fi
  if [ -z "$BOOTSTRAP_NODE" ] || [ ! -x "$BOOTSTRAP_NODE" ]; then
    echo "Node.js is required to load the private configuration." >&2
    exit 1
  fi
  RUNTIME_ENV_EXPORTS="$("$BOOTSTRAP_NODE" --env-file="$ENV_FILE" "$PROJECT_DIR/scripts/export-runtime-env.mjs")"
  eval "$RUNTIME_ENV_EXPORTS"
  unset RUNTIME_ENV_EXPORTS
fi

export WORKBUDDY_QQ_DATA_DIR="${WORKBUDDY_QQ_DATA_DIR:-$PROJECT_DIR/runtime/qq-only-data}"
export WORKBUDDY_QQ_QQ_ENABLED="${WORKBUDDY_QQ_QQ_ENABLED:-1}"
export ONEBOT_API_BASE="${ONEBOT_API_BASE:-http://127.0.0.1:3000}"
export WORKBUDDY_QQ_DISABLE_AUTH="${WORKBUDDY_QQ_DISABLE_AUTH:-0}"

read_keychain_secret() {
  /usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null
}

# Keep the stored Hub token available as the SnowLuma callback credential even
# when normal loopback Hub authentication is disabled. It is never requested
# from the panel in that mode.
if [ -z "${WORKBUDDY_QQ_API_TOKEN:-}" ]; then
  export WORKBUDDY_QQ_API_TOKEN="$(read_keychain_secret hub-api-token || true)"
fi
if [ -z "${ONEBOT_ACCESS_TOKEN:-}" ]; then
  export ONEBOT_ACCESS_TOKEN="$(read_keychain_secret onebot-api-token || true)"
fi
if [ "${WORKBUDDY_QQ_HA_ENABLED:-0}" = "1" ] && [ -z "${WORKBUDDY_QQ_HA_TOKEN:-}" ]; then
  export WORKBUDDY_QQ_HA_TOKEN="$(read_keychain_secret home-assistant-api-token || true)"
fi

if [ "$WORKBUDDY_QQ_DISABLE_AUTH" != "1" ] && [ -z "$WORKBUDDY_QQ_API_TOKEN" ]; then
  echo "Hub access credentials are missing from the macOS Keychain." >&2
  echo "Set WORKBUDDY_QQ_DISABLE_AUTH=1 only for a loopback-only Hub." >&2
  exit 1
fi
if [ -z "$ONEBOT_ACCESS_TOKEN" ]; then
  echo "OneBot access credentials are missing from the macOS Keychain." >&2
  echo "Open the SnowLuma setup again before starting the QQ bridge." >&2
  exit 1
fi

NODE_BIN="${WORKBUDDY_QQ_NODE_PATH:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "Node.js was not found. Set WORKBUDDY_QQ_NODE_PATH in $ENV_FILE." >&2
  exit 1
fi

# The panel must not depend on VM/container startup. A separate launchd job
# recovers QQ in the background; the Hub reconnects as soon as OneBot returns.

if ! /usr/bin/curl -fsS --max-time 2 \
  -H "Authorization: Bearer $ONEBOT_ACCESS_TOKEN" \
  "$ONEBOT_API_BASE/get_login_info" >/dev/null 2>&1; then
  echo "SnowLuma OneBot is not ready yet; the Hub will stay online and reconnect when QQ becomes available." >&2
fi

if /usr/sbin/lsof -tiTCP:3789 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 3789 is already in use; refusing to replace an existing process." >&2
  exit 1
fi

cd "$PROJECT_DIR"
exec "$NODE_BIN" src/server.js
