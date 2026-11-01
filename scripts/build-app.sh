#!/bin/bash
# Builds dist/Workfloor.app and dist/Workfloor-<version>.dmg: a native window around the Workfloor
# server, with its own copy of node. Needs Xcode (or its command line tools). Run: npm run app
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT=dist
APP="$OUT/Workfloor.app"
RES="$APP/Contents/Resources"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$RES/app"

echo "› Compiling the window"
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/Workfloor" mac/Workfloor.swift -framework Cocoa -framework WebKit

echo "› Copying the server and node $(node -v)"
cp -R server.js package.json README.md public mcp workfloor.config.example.json "$RES/app/"
mkdir -p "$RES/app/mac" && cp mac/ptyrun.py "$RES/app/mac/"
cp "$(command -v node)" "$RES/node"

echo "› Drawing the icon"
swiftc -O -o "$WORK/render-icon" mac/render-icon.swift
"$WORK/render-icon" mac/AppIcon.svg "$WORK/AppIcon.svg.png" 1024
mkdir "$WORK/AppIcon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/AppIcon.svg.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/AppIcon.svg.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns -o "$RES/AppIcon.icns" "$WORK/AppIcon.iconset"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Workfloor</string>
  <key>CFBundleDisplayName</key><string>Workfloor</string>
  <key>CFBundleIdentifier</key><string>local.workfloor.app</string>
  <key>CFBundleExecutable</key><string>Workfloor</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSAppleEventsUsageDescription</key><string>Workfloor asks Finder to empty the Trash and Terminal to open a task's session, only when you tap those buttons.</string>
</dict>
</plist>
PLIST
# The PATH you build with (nvm, bun, ...) so tasks find npx and friends when the app opens from Finder.
plutil -insert WorkfloorPath -string "$PATH" "$APP/Contents/Info.plist"

echo "› Signing (ad hoc, for this Mac)"
codesign --force --sign - "$APP"

echo "› Packing the disk image"
mkdir "$WORK/dmg"
cp -R "$APP" "$WORK/dmg/"
ln -s /Applications "$WORK/dmg/Applications"
# hdiutil sometimes sizes the image too small from -srcfolder ("No space left on device"); give it room.
SIZE_MB=$(( $(du -sm "$WORK/dmg" | cut -f1) + 60 ))
hdiutil create -volname "Workfloor" -srcfolder "$WORK/dmg" -size "${SIZE_MB}m" -ov -format UDZO "$OUT/Workfloor-$VERSION.dmg" >/dev/null

echo "✓ $OUT/Workfloor-$VERSION.dmg ($(du -h "$OUT/Workfloor-$VERSION.dmg" | cut -f1))"
