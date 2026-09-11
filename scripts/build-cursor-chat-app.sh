#!/usr/bin/env bash
# Compile the native CursorChat.app launcher (WKWebView + Dock association).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/launcher/CursorChat.swift"
OUT="$ROOT/apps/CursorChat.app/Contents/MacOS/CursorChat"
APP="$ROOT/apps/CursorChat.app"

mkdir -p "$(dirname "$OUT")"
mkdir -p "$APP/Contents"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>CursorChat</string>
  <key>CFBundleIdentifier</key>
  <string>com.luiscastro.cursor-chat</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Cursor Chat</string>
  <key>CFBundleDisplayName</key>
  <string>Cursor Chat</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <false/>
</dict>
</plist>
PLIST

echo APPLXXXX > "$APP/Contents/PkgInfo"

echo "[build] compiling CursorChat launcher…"
swiftc -O \
  -o "$OUT" \
  "$SRC" \
  -framework AppKit \
  -framework WebKit

chmod +x "$OUT"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --sign - --deep "$APP" 2>/dev/null || codesign --force --sign - "$OUT"

echo "[build] ok → $OUT"
file "$OUT"
