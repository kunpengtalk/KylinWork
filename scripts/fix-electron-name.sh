#!/bin/bash
# 开发态把 Electron 壳的应用名改成 KylinWork：
# macOS 菜单栏左上角和「关于」面板显示的名字来自
# node_modules/electron/dist/Electron.app/Contents/Info.plist 的 CFBundleName，
# 运行时改不了，只能改 plist。npm install / 升级 electron 会把它冲回 "Electron"，
# 所以挂在 postinstall 上每次自动修一遍。
set -euo pipefail
cd "$(dirname "$0")/.."

PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
[ -f "$PLIST" ] || { echo "[fix-electron-name] 未找到 ${PLIST}，跳过"; exit 0; }

if command -v /usr/libexec/PlistBuddy >/dev/null; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName KylinWork" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleName string KylinWork" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName KylinWork" "$PLIST" 2>/dev/null || true
fi

# 改了 plist 要重做 ad-hoc 签名，否则 macOS 可能拒绝启动
if command -v codesign >/dev/null; then
  codesign --force --deep --sign - node_modules/electron/dist/Electron.app >/dev/null 2>&1 || true
fi

echo "[fix-electron-name] Electron 壳已改名 KylinWork"
