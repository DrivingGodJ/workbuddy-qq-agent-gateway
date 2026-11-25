#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_PKG_DIR/../.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
APP_NAME="WorkBuddyQQGateway.app"
APP_BUNDLE="$DIST_DIR/$APP_NAME"

MODE="dev"
NODE_BIN=""
PYTHON_VENV=""
SIGN_IDENTITY="-"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dev)
      MODE="dev"
      shift
      ;;
    --bundle-runtime)
      MODE="bundle"
      shift
      ;;
    --node-bin)
      NODE_BIN="${2:-}"
      shift 2
      ;;
    --python-venv)
      PYTHON_VENV="${2:-}"
      shift 2
      ;;
    --sign-identity)
      SIGN_IDENTITY="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dev | --bundle-runtime] [--node-bin /path/to/node] [--python-venv /path/to/.venv] [--sign-identity -|'Developer ID Application: ...']" >&2
      exit 1
      ;;
  esac
done

echo "==> Generating AppIcon.icns (if needed)..."
ICNS_PATH="$APP_PKG_DIR/Resources/AppIcon.icns"
if [ ! -f "$ICNS_PATH" ]; then
  /usr/bin/swift "$SCRIPT_DIR/generate-icon.swift" "$ICNS_PATH"
fi

# CLT MacOSX27.2.sdk omits libSwiftUIMacros.dylib for @State; fall back to MacOSX26.5.sdk if available.
if [ -z "${SDKROOT:-}" ] && [ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk" ]; then
  export SDKROOT="/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk"
fi

echo "==> Building WorkBuddyQQGateway (release)..."
cd "$APP_PKG_DIR"
swift build -c release
BIN_PATH="$(swift build -c release --show-bin-path)/WorkBuddyQQGateway"
if [ ! -x "$BIN_PATH" ]; then
  echo "Built binary missing at $BIN_PATH" >&2
  exit 1
fi

echo "==> Assembling $APP_BUNDLE ($MODE mode)..."
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources/gateway"

cp "$APP_PKG_DIR/Resources/Info.plist" "$APP_BUNDLE/Contents/Info.plist"
cp "$ICNS_PATH" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
cp "$SCRIPT_DIR/uninstall.command" "$APP_BUNDLE/Contents/Resources/uninstall.command"
chmod 755 "$APP_BUNDLE/Contents/Resources/uninstall.command"
cp "$BIN_PATH" "$APP_BUNDLE/Contents/MacOS/WorkBuddyQQGateway"
chmod 755 "$APP_BUNDLE/Contents/MacOS/WorkBuddyQQGateway"

# Bundle gateway source & public templates (read-only inside .app; runtime data writes to Application Support)
GW_DEST="$APP_BUNDLE/Contents/Resources/gateway"
cp "$REPO_ROOT/package.json" "$GW_DEST/"
cp -R "$REPO_ROOT/src" "$GW_DEST/"
cp -R "$REPO_ROOT/persona" "$GW_DEST/"
cp -R "$REPO_ROOT/scripts" "$GW_DEST/"
mkdir -p "$GW_DEST/modules/workbuddy-agent" "$GW_DEST/modules/web-console" "$GW_DEST/modules/system-control" "$GW_DEST/config"
cp "$REPO_ROOT/modules/workbuddy-agent/bridge.py" "$REPO_ROOT/modules/workbuddy-agent/qq-mcp-stdio.mjs" "$GW_DEST/modules/workbuddy-agent/"
cp -R "$REPO_ROOT/modules/web-console/public" "$GW_DEST/modules/web-console/"
cp -R "$REPO_ROOT/modules/system-control/"* "$GW_DEST/modules/system-control/"
cp "$REPO_ROOT/modules/"*.command "$GW_DEST/modules/"
cp "$REPO_ROOT/config/"*.example "$GW_DEST/config/"

if [ "$MODE" = "bundle" ]; then
  mkdir -p "$APP_BUNDLE/Contents/Resources/runtime"
  if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node || true)"
  fi
  if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
    if /usr/bin/otool -L "$NODE_BIN" 2>/dev/null | grep -q "/opt/homebrew/\|/usr/local/"; then
      echo "Warning: $NODE_BIN links dynamically against Homebrew libraries; for cross-Mac distribution pass --node-bin pointing to an official standalone arm64 Node tarball binary." >&2
    fi
    echo "==> Embedding Node.js binary from $NODE_BIN..."
    cp -L "$NODE_BIN" "$APP_BUNDLE/Contents/Resources/runtime/node"
    chmod 755 "$APP_BUNDLE/Contents/Resources/runtime/node"
  else
    echo "Warning: --bundle-runtime set but no Node.js binary found." >&2
  fi

  if [ -n "$PYTHON_VENV" ] && [ -d "$PYTHON_VENV" ]; then
    echo "==> Embedding Python runtime from $PYTHON_VENV..."
    cp -R "$PYTHON_VENV" "$APP_BUNDLE/Contents/Resources/runtime/python"
  fi
fi

echo "==> Signing $APP_BUNDLE (identity: $SIGN_IDENTITY)..."
if [ "$SIGN_IDENTITY" = "-" ]; then
  /usr/bin/codesign --force --deep --sign - "$APP_BUNDLE"
else
  /usr/bin/codesign --force --deep --options runtime --entitlements "$APP_PKG_DIR/Resources/Entitlements.plist" --sign "$SIGN_IDENTITY" "$APP_BUNDLE"
fi

/usr/bin/plutil -lint "$APP_BUNDLE/Contents/Info.plist" >/dev/null
/usr/bin/codesign --verify --deep --strict "$APP_BUNDLE"
echo "==> Done: $APP_BUNDLE"
