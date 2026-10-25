#!/usr/bin/env bash
# Captures docs/panel-dark.png and docs/panel-light.png from the preview window.
#
# Needs the Screen Recording permission for the terminal (or the app running
# this script): System Settings -> Privacy & Security -> Screen & System Audio
# Recording. Without it screencapture fails with "could not create image".
set -euo pipefail

cd "$(dirname "$0")/.."
APP="build/Claude Voice.app"
BIN="$APP/Contents/MacOS/VoiceBriefBar"

[ -x "$BIN" ] || ./build.sh

capture() {
  local mode="$1" output="$2"
  "$BIN" --preview $mode >/dev/null 2>&1 &
  sleep 5

  local id
  id="$(swift tools/window-id.swift | awk '{print $1}' | head -1)"
  if [ -z "${id:-}" ]; then
    echo "no preview window found" >&2
    pkill -f 'VoiceBriefBar --preview' 2>/dev/null || true
    exit 1
  fi

  screencapture -x -o -l"$id" "$output"
  pkill -f 'VoiceBriefBar --preview' 2>/dev/null || true
  sleep 1
  echo "saved $output"
}

mkdir -p ../docs
capture "" ../docs/panel-dark.png
capture "--light" ../docs/panel-light.png
