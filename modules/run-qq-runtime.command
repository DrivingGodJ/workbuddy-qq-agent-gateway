#!/bin/zsh
set -euo pipefail

PROJECT_DIR="${WORKBUDDY_QQ_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${WORKBUDDY_QQ_ENV_FILE:-$PROJECT_DIR/config/qq-only.env}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
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
COLIMA_PROFILE="${WORKBUDDY_QQ_COLIMA_PROFILE:-snowluma}"
SNOWLUMA_CONTAINER="${WORKBUDDY_QQ_SNOWLUMA_CONTAINER:-snowluma}"
COLIMA_BIN="${WORKBUDDY_QQ_COLIMA_PATH:-/opt/homebrew/bin/colima}"
DOCKER_BIN="${WORKBUDDY_QQ_DOCKER_PATH:-/opt/homebrew/bin/docker}"
DOCKER_CONTEXT="${WORKBUDDY_QQ_DOCKER_CONTEXT:-colima-snowluma}"
NODE_BIN="${WORKBUDDY_QQ_NODE_PATH:-/opt/homebrew/bin/node}"
if [[ ! "$COLIMA_PROFILE" =~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' ]]; then
  echo "Invalid Colima profile; refusing runtime recovery." >&2
  exit 1
fi
for required_bin in "$COLIMA_BIN" "$DOCKER_BIN" "$NODE_BIN"; do
  if [ ! -x "$required_bin" ]; then
    echo "QQ runtime executable missing: $required_bin; Hub remains independent." >&2
    exit 1
  fi
done
if ! "$NODE_BIN" "$PROJECT_DIR/scripts/colima-status-probe.mjs" "$COLIMA_BIN" "$COLIMA_PROFILE"; then
  if ! "$NODE_BIN" "$PROJECT_DIR/scripts/colima-stale-state.mjs" "$HOME/.colima/_lima/colima-$COLIMA_PROFILE"; then
    echo "Colima state is active or uncertain; QQ recovery will retry on the next launchd interval." >&2
    exit 1
  fi
  "$COLIMA_BIN" start --profile "$COLIMA_PROFILE"
fi
if ! "$DOCKER_BIN" --context "$DOCKER_CONTEXT" inspect "$SNOWLUMA_CONTAINER" >/dev/null 2>&1; then
  echo "SnowLuma container not installed; will retry, never recreate it or delete login data." >&2
  exit 1
fi
if [ "$("$DOCKER_BIN" --context "$DOCKER_CONTEXT" inspect -f '{{.State.Running}}' "$SNOWLUMA_CONTAINER")" != "true" ]; then
  "$DOCKER_BIN" --context "$DOCKER_CONTEXT" start "$SNOWLUMA_CONTAINER" >/dev/null
  echo "QQ runtime recovered; existing SnowLuma container started."
fi
