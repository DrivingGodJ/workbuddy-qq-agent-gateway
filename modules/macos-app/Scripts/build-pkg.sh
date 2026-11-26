#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$APP_PKG_DIR/../.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
APP_BUNDLE="$DIST_DIR/WorkBuddyQQGateway.app"
PKG_PATH="$DIST_DIR/WorkBuddyQQGateway-Installer.pkg"
SIGN_IDENTITY=""
NOTARIZE_PROFILE=""
VERSION="0.3.3"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --sign-identity)
      SIGN_IDENTITY="${2:-}"
      shift 2
      ;;
    --notarize-profile)
      NOTARIZE_PROFILE="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-0.3.3}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--sign-identity 'Developer ID Installer: ...'] [--notarize-profile <profile>] [--version 0.3.3]" >&2
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

PAYLOAD_ROOT="$STAGE_DIR/payload"
RESOURCES_DIR="$STAGE_DIR/resources"
SCRIPTS_DIR="$STAGE_DIR/scripts"
COMP_PKG="$STAGE_DIR/WorkBuddyQQGateway-component.pkg"
COMP_PLIST="$STAGE_DIR/component.plist"
DIST_XML="$STAGE_DIR/distribution.xml"

mkdir -p "$PAYLOAD_ROOT/Applications" "$RESOURCES_DIR" "$SCRIPTS_DIR"
cp -R "$APP_BUNDLE" "$PAYLOAD_ROOT/Applications/WorkBuddyQQGateway.app"

cat > "$SCRIPTS_DIR/postinstall" <<'ZSH'
#!/bin/zsh
APP_PATH="/Applications/WorkBuddyQQGateway.app"
if [ -d "$APP_PATH" ]; then
  /usr/bin/touch "$APP_PATH" || true
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_PATH" >/dev/null 2>&1 || true
fi
exit 0
ZSH
chmod 755 "$SCRIPTS_DIR/postinstall"

# Disable relocation so macOS Installer always installs into /Applications/WorkBuddyQQGateway.app
/usr/bin/pkgbuild --analyze --root "$PAYLOAD_ROOT" "$COMP_PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" "$COMP_PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :0:BundleIsRelocatable bool false" "$COMP_PLIST"

/usr/bin/pkgbuild \
  --root "$PAYLOAD_ROOT" \
  --component-plist "$COMP_PLIST" \
  --scripts "$SCRIPTS_DIR" \
  --identifier "local.workbuddy.qq-agent-gateway.pkg" \
  --version "$VERSION" \
  --install-location "/" \
  "$COMP_PKG" >/dev/null

cat > "$RESOURCES_DIR/welcome.html" <<'HTML'
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;line-height:1.6;padding:12px;}</style></head>
<body>
<h2>欢迎安装 WorkBuddy QQ Gateway</h2>
<p>本安装程序将把 <strong>WorkBuddy QQ Gateway.app</strong> 安装至您的「应用程序」目录（<code>/Applications</code>）。</p>
<ul>
  <li><strong>已有部署无损接管</strong>：若本机已存在运行中的 WorkBuddy QQ Gateway 部署，首次打开 App 将自动进入无损接管模式，绝不重置或删除现有容器、会话与表情库。</li>
  <li><strong>人格导入导出</strong>：支持在「设置 → 人格与全局模型」中导出或导入人格备份文件（兼容 <code>.laodai-persona.json</code>）。</li>
  <li><strong>局域网广播控制面板</strong>：可在「设置 → 局域网面板」中开启独立密码登录网页，方便同局域网设备调整参数。</li>
</ul>
</body>
</html>
HTML

cat > "$RESOURCES_DIR/conclusion.html" <<'HTML'
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;line-height:1.6;padding:12px;}</style></head>
<body>
<h2>安装完成</h2>
<p>您现在可以从「应用程序」或启动台打开 <strong>WorkBuddy QQ Gateway</strong>。</p>
<p>若是首次全新安装，打开后将自动进入 6 步图形化引导向导；若要导入之前备份的人格，请打开 <strong>设置 (⌘,) → 人格与全局模型 → 从文件导入人格…</strong>。</p>
</body>
</html>
HTML

cat > "$DIST_XML" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>WorkBuddy QQ Gateway</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <os-version-min>14.0</os-version-min>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <choices-outline>
    <line choice="default">
      <line choice="local.workbuddy.qq-agent-gateway.pkg"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="local.workbuddy.qq-agent-gateway.pkg" visible="false">
    <pkg-ref id="local.workbuddy.qq-agent-gateway.pkg"/>
  </choice>
  <pkg-ref id="local.workbuddy.qq-agent-gateway.pkg" version="$VERSION" onConclusion="none">WorkBuddyQQGateway-component.pkg</pkg-ref>
</installer-gui-script>
XML

rm -f "$PKG_PATH"
if [ -n "$SIGN_IDENTITY" ]; then
  /usr/bin/productbuild \
    --distribution "$DIST_XML" \
    --resources "$RESOURCES_DIR" \
    --package-path "$STAGE_DIR" \
    --sign "$SIGN_IDENTITY" \
    "$PKG_PATH" >/dev/null
else
  /usr/bin/productbuild \
    --distribution "$DIST_XML" \
    --resources "$RESOURCES_DIR" \
    --package-path "$STAGE_DIR" \
    "$PKG_PATH" >/dev/null
fi

if [ -n "$NOTARIZE_PROFILE" ]; then
  echo "==> Submitting PKG for notarization (profile: $NOTARIZE_PROFILE)..."
  /usr/bin/xcrun notarytool submit "$PKG_PATH" --keychain-profile "$NOTARIZE_PROFILE" --wait
  /usr/bin/xcrun stapler staple "$PKG_PATH"
fi

echo "==> Created Installer PKG: $PKG_PATH"
