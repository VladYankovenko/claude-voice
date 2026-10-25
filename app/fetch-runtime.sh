#!/usr/bin/env bash
# Downloads a relocatable CPython for Apple Silicon into Resources/python.
# The app uses it to create its own environment, so the machine needs no
# Xcode Command Line Tools and no Homebrew Python.
set -euo pipefail

cd "$(dirname "$0")"
DEST="Resources/python"
[ -x "$DEST/bin/python3" ] && { echo "runtime already present"; exit 0; }

URL="$(/usr/bin/python3 - <<'PY'
import json, urllib.request
release = json.load(urllib.request.urlopen(
    "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest", timeout=60))
for asset in release["assets"]:
    name = asset["name"]
    if (name.startswith("cpython-3.12")
            and "aarch64-apple-darwin" in name
            and name.endswith("-install_only.tar.gz")):
        print(asset["browser_download_url"])
        break
PY
)"

[ -n "$URL" ] || { echo "could not resolve a python-build-standalone asset" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading $URL"
curl -fL --progress-bar -o "$TMP/python.tar.gz" "$URL"
mkdir -p "$TMP/unpack"
tar -xzf "$TMP/python.tar.gz" -C "$TMP/unpack"

rm -rf "$DEST"
mv "$TMP/unpack/python" "$DEST"
"$DEST/bin/python3" -c "import sys; print('runtime', sys.version.split()[0], sys.platform)"
