#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT_APP="/Applications/WorkBuddyQQGateway.app"

cd "$PROJECT_DIR"

"$PROJECT_DIR/modules/chat-hub-start.command"

if [ -d "$CLIENT_APP" ]; then
  echo "Opening WorkBuddy QQ Gateway..."
  /usr/bin/open -a "$CLIENT_APP"
else
  echo "Client app is not installed yet: $CLIENT_APP"
fi

echo ""
echo "QQ recovery runs in a separate launchd job. Configure your existing SnowLuma runtime before enabling it."
