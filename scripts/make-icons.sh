#!/bin/bash
# 从 build/logo.png 生成三样东西：
#   build/icon.icns  macOS 应用图标（iconutil 打包的 iconset）
#   build/icon.ico   Windows 应用图标（多分辨率，含 16/24/32/48/64/128/256）
#   build/icon.png   1024 的通用图，README 和网页 favicon 用
# 源文件是设计给的位图 build/logo.png（没有 SVG 源，别再从 icon.svg 渲染，
# 那样会把真正的品牌 logo 覆盖掉）。
# 只在 macOS 上跑（iconutil 是 macOS 自带）。图标产物已提交进仓库，
# 所以 Windows/Linux 上打包不需要重跑这个脚本。
set -euo pipefail
cd "$(dirname "$0")/.."
command -v magick >/dev/null || { echo "缺 ImageMagick：brew install imagemagick"; exit 1; }
[ -f build/logo.png ] || { echo "缺源图 build/logo.png"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

magick build/logo.png -resize 1024x1024 "$TMP/icon.png"
cp "$TMP/icon.png" build/icon.png
cp "$TMP/icon.png" public/icon.png   # 网页 favicon 和「关于」页用同一张

SET="$TMP/icon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  magick "$TMP/icon.png" -resize ${s}x${s}      "$SET/icon_${s}x${s}.png"
  magick "$TMP/icon.png" -resize $((s*2))x$((s*2)) "$SET/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$SET" -o build/icon.icns

magick "$TMP/icon.png" -define icon:auto-resize=256,128,64,48,32,24,16 build/icon.ico

echo "生成完毕："
ls -la build/icon.icns build/icon.ico build/icon.png public/icon.png
