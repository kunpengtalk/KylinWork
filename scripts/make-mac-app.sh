#!/bin/bash
# 生成 macOS 启动器：~/Applications/KylinWork.app
# 双击即启动 KylinWork（跑的永远是本仓库的最新代码，改完代码重开 App 就生效，无需重新生成）。
# 重复运行本脚本 = 重新生成（比如仓库挪了位置之后）。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_BIN="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON_BIN" ] || { echo "❌ 找不到 Electron，请先在仓库目录跑 npm install"; exit 1; }

APP="$HOME/Applications/KylinWork.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 从 Finder 启动时 PATH 只有系统目录，agent 要用的 node/npx/brew 工具全都找不到——把当前 node 的位置烤进去
NODE_DIR="$(dirname "$(command -v node || echo /usr/local/bin/node)")"

cat > "$APP/Contents/MacOS/KylinWork" <<EOF
#!/bin/bash
export PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$ELECTRON_BIN" "$REPO" >> "\$HOME/Library/Logs/KylinWork.log" 2>&1
EOF
chmod +x "$APP/Contents/MacOS/KylinWork"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>KylinWork</string>
  <key>CFBundleDisplayName</key><string>KylinWork</string>
  <key>CFBundleExecutable</key><string>KylinWork</string>
  <key>CFBundleIdentifier</key><string>com.kylinwork.launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>KylinWork 登录回调</string>
      <key>CFBundleURLSchemes</key>
      <array><string>kylinwork</string></array>
    </dict>
  </array>
</dict></plist>
EOF

# 图标：借用 Electron 自带的 icns（本地启动器够用；想换自己的图标，替换 Resources/app.icns 即可）
ICNS="$REPO/node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns"
[ -f "$ICNS" ] && cp "$ICNS" "$APP/Contents/Resources/app.icns"

# Finder/Dock 缓存过旧版本的话 touch 一下让它重读
touch "$APP"
echo "✅ 已生成 $APP"
echo "   双击即启动；日志在 ~/Library/Logs/KylinWork.log；仓库挪位置后重跑本脚本"
