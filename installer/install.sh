#!/usr/bin/env bash
# One-command setup for voice-brief on Apple Silicon.
#
#   ./installer/install.sh [--preset 0.6-custom] [--voice ryan] [--clone sample.wav] [--yes]
#
# Creates an isolated Python environment, downloads the Qwen model, starts the
# server and installs the Claude Code plugin.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install the Command Line Tools: xcode-select --install" >&2
  exit 1
fi

exec python3 "$ROOT/installer/bootstrap.py" --repo "$ROOT" "$@"
