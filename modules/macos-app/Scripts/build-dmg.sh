#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_PKG_DIR/../.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
APP_BUNDLE="$DIST_DIR/WorkBuddyQQGateway.app"
DMG_PATH="$DIST_DIR/WorkBuddyQQGateway.dmg"
NOTARIZE_PROFILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --notarize-profile)
      NOTARIZE_PROFILE="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ ! -d "$APP_BUNDLE" ]; then
  echo "App bundle missing at $APP_BUNDLE; running build-app.sh --dev first..."
  "$SCRIPT_DIR/build-app.sh" --dev
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

cp -R "$APP_BUNDLE" "$STAGE_DIR/WorkBuddyQQGateway.app"
ln -s /Applications "$STAGE_DIR/Applications"
if [ -f "$SCRIPT_DIR/uninstall.command" ]; then
  cp "$SCRIPT_DIR/uninstall.command" "$STAGE_DIR/卸载 WorkBuddy QQ Gateway.command"
  chmod 755 "$STAGE_DIR/卸载 WorkBuddy QQ Gateway.command"
fi

rm -f "$DMG_PATH"
/usr/bin/hdiutil create \
  -volname "WorkBuddy QQ Gateway" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

if [ -n "$NOTARIZE_PROFILE" ]; then
  echo "==> Submitting DMG for notarization (profile: $NOTARIZE_PROFILE)..."
  /usr/bin/xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARIZE_PROFILE" --wait
  /usr/bin/xcrun stapler staple "$DMG_PATH"
fi

echo "==> Created DMG: $DMG_PATH"
