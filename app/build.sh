#!/usr/bin/env bash
# Builds "Claude Voice.app" and build/ClaudeVoice.dmg
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"

./fetch-runtime.sh

swift build -c release --arch arm64
BIN="$(swift build -c release --arch arm64 --show-bin-path)/VoiceBriefBar"

APP="build/Claude Voice.app"
rm -rf build/ClaudeVoice.dmg
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/VoiceBriefBar"
cp Resources/Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Everything the app needs to install the plugin and talk to the server.
PAYLOAD="build/plugin-payload"
rm -rf "$PAYLOAD"
mkdir -p "$PAYLOAD"
for dir in .claude-plugin hooks output-styles scripts assets; do
  cp -R "$ROOT/$dir" "$PAYLOAD/"
done
cp "$ROOT/LICENSE" "$PAYLOAD/" 2>/dev/null || true

cp -R Resources/python "$APP/Contents/Resources/python"
cp -R "$PAYLOAD" "$APP/Contents/Resources/plugin"

# Ad-hoc signature: enough to run locally and to open from a DMG on the same
# machine. Distribution to others needs a Developer ID and notarisation.
codesign --force --deep --sign - "$APP"

STAGE="build/dmg"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "Claude Voice" -srcfolder "$STAGE" -ov -format UDZO \
  "build/ClaudeVoice.dmg" >/dev/null

echo "app: $PWD/$APP"
echo "dmg: $PWD/build/ClaudeVoice.dmg"
echo "repo: $ROOT"
