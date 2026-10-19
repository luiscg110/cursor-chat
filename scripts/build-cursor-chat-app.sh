#!/usr/bin/env bash
# Compile the native CursorChat.app launcher (WKWebView + Dock icon + open indicator).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/launcher/CursorChat.swift"
OUT="$ROOT/apps/CursorChat.app/Contents/MacOS/CursorChat"
APP="$ROOT/apps/CursorChat.app"
ICON_SRC="$ROOT/apps/launcher/AppIcon.icns"
ICON_PNG="$ROOT/apps/launcher/AppIcon.png"
RES="$APP/Contents/Resources"

mkdir -p "$(dirname "$OUT")" "$RES"

# Rebuild .icns from master PNG when present (keeps Dock icon in sync).
if [[ -f "$ICON_PNG" ]] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
  echo "[build] generating AppIcon.icns…"
  WORK="$(mktemp -d)"
  ICONSET="$WORK/AppIcon.iconset"
  mkdir -p "$ICONSET"
  sips -s format png -z 1024 1024 "$ICON_PNG" --out "$WORK/master.png" >/dev/null
  for spec in \
    "16:icon_16x16.png" \
    "32:icon_16x16@2x.png" \
    "32:icon_32x32.png" \
    "64:icon_32x32@2x.png" \
    "128:icon_128x128.png" \
    "256:icon_128x128@2x.png" \
    "256:icon_256x256.png" \
    "512:icon_256x256@2x.png" \
    "512:icon_512x512.png" \
    "1024:icon_512x512@2x.png"
  do
    size="${spec%%:*}"
    name="${spec##*:}"
    sips -s format png -z "$size" "$size" "$WORK/master.png" --out "$ICONSET/$name" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$ICON_SRC"
  rm -rf "$WORK"
fi

if [[ ! -f "$ICON_SRC" ]]; then
  echo "[build] missing $ICON_SRC — Dock will use a generic icon" >&2
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>CursorChat</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
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
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
PLIST

echo APPLXXXX > "$APP/Contents/PkgInfo"

if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$RES/AppIcon.icns"
fi

echo "[build] compiling CursorChat launcher…"
swiftc -O \
  -o "$OUT" \
  "$SRC" \
  -framework AppKit \
  -framework WebKit

chmod +x "$OUT"
xattr -cr "$APP" 2>/dev/null || true
codesign --force --sign - --deep "$APP" 2>/dev/null || codesign --force --sign - "$OUT"

# Refresh Launch Services so Dock picks up the new icon
if command -v lsregister >/dev/null 2>&1; then
  lsregister -f "$APP" 2>/dev/null || true
elif [[ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
fi

echo "[build] ok → $OUT"
file "$OUT"
ls -la "$RES/AppIcon.icns" 2>/dev/null || true
