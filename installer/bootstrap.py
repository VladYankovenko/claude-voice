#!/usr/bin/env python3
"""Set up voice-brief on Apple Silicon: venv, model, server, plugin config."""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

APP_DIR = Path.home() / "Library" / "Application Support" / "voice-brief"
VENV_DIR = APP_DIR / "venv"
LOG_FILE = APP_DIR / "server.log"
PID_FILE = APP_DIR / "server.pid"
CONFIG_FILE = APP_DIR / "config.json"

# The bare package has no server: uvicorn, fastapi and python-multipart live in
# the "server" extra, transcription needs "stt", and some TTS models need "tts".
PIP_PACKAGE = "mlx-audio[server,stt,tts]"
PIP_FALLBACK = ("mlx-audio[server,stt,tts] "
                "@ git+https://github.com/Blaizzy/mlx-audio")


def say(message):
    print(message, flush=True)


def fail(message):
    print(f"error: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def run(argv, **kwargs):
    say("  $ " + " ".join(str(a) for a in argv))
    return subprocess.run(argv, check=True, **kwargs)


def load_presets(repo):
    with open(repo / "installer" / "models.json", encoding="utf-8") as handle:
        return json.load(handle)


def pick(options, default, prompt, assume_yes):
    if assume_yes:
        return default
    listed = ", ".join(options)
    answer = input(f"{prompt} [{listed}] (default {default}): ").strip()
    if not answer:
        return default
    if answer not in options:
        say(f"  unknown value {answer!r}, using {default}")
        return default
    return answer


def ensure_venv(repo, reuse):
    if reuse:
        venv = Path(reuse).expanduser().resolve()
        if not (venv / "bin" / "python").exists():
            fail(f"{venv} is not a Python environment")
        say(f"using existing environment: {venv}")
        return venv

    APP_DIR.mkdir(parents=True, exist_ok=True)
    if not (VENV_DIR / "bin" / "python").exists():
        say("creating Python environment")
        run([sys.executable, "-m", "venv", str(VENV_DIR)])
    say("installing mlx-audio")
    python = VENV_DIR / "bin" / "python"
    run([python, "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
    try:
        run([python, "-m", "pip", "install", "--quiet", "--upgrade", PIP_PACKAGE])
    except subprocess.CalledProcessError:
        say("  PyPI package unavailable, installing from GitHub")
        run([python, "-m", "pip", "install", "--quiet", "--upgrade", PIP_FALLBACK])
    return VENV_DIR


def download_model(venv, preset_id):
    say(f"downloading {preset_id} (this is the big step)")
    code = (
        "from huggingface_hub import snapshot_download;"
        f"snapshot_download({preset_id!r})"
    )
    run([venv / "bin" / "python", "-c", code])


def log_tail(path, lines=20):
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except Exception:
        return ""


def server_up(port, timeout=1.5):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=timeout):
            return True
    except Exception:
        return False


def start_server(venv, port):
    if server_up(port):
        say(f"server already running on :{port}")
        return
    say(f"starting server on :{port}")
    APP_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_FILE, "ab")
    child = subprocess.Popen(
        [str(venv / "bin" / "python"), "-m", "mlx_audio.server",
         "--host", "127.0.0.1", "--port", str(port)],
        stdout=log, stderr=log, stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    PID_FILE.write_text(str(child.pid), encoding="utf-8")

    deadline = time.time() + 90
    while time.time() < deadline:
        if server_up(port):
            return
        if child.poll() is not None:
            say(log_tail(LOG_FILE))
            fail(f"server exited; see {LOG_FILE}")
        time.sleep(1)
    say(log_tail(LOG_FILE))
    fail(f"server did not start in 90s; see {LOG_FILE}")


def preload(port, preset_id):
    say("loading the model into memory")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/models?model_name={urllib.parse.quote(preset_id)}",
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=900).read()
    except Exception as exc:
        say(f"  preload skipped: {exc}")


def clone_reference(repo, source, name, port, apply_config):
    node = shutil.which("node")
    if not node:
        say("node not found: skipping clone setup, run cli/voice-setup.js later")
        return None, None
    script = repo / "cli" / "voice-setup.js"
    argv = [node, str(script), "--file", source, "--name", name,
            "--port", str(port)]
    if apply_config:
        argv.append("--apply")
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.stdout:
        say(result.stdout.strip())
    if result.returncode != 0:
        say(result.stderr.strip() or "clone setup failed")
        return None, None
    return APP_DIR / "refs" / name / "ref.wav", APP_DIR / "refs" / name / "ref.txt"


def configure_plugin(repo, values):
    claude = shutil.which("claude")
    if not claude:
        say("claude CLI not found in PATH, configure the plugin later:")
        say("  claude plugin configure voice-brief@voice-brief-local --values-stdin")
        say(json.dumps(values, ensure_ascii=False))
        return

    say("registering the local marketplace")
    subprocess.run([claude, "plugin", "marketplace", "add", str(repo)],
                   capture_output=True, text=True)
    say("installing the plugin")
    subprocess.run([claude, "plugin", "install", "voice-brief@voice-brief-local",
                    "--scope", "user", "-y"], capture_output=True, text=True)
    subprocess.run([claude, "plugin", "enable", "voice-brief"], capture_output=True, text=True)

    say("writing plugin settings")
    result = subprocess.run(
        [claude, "plugin", "configure", "voice-brief@voice-brief-local", "--values-stdin"],
        input=json.dumps(values, ensure_ascii=False),
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        say(result.stderr.strip() or result.stdout.strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--preset")
    parser.add_argument("--clone", help="audio file to clone the voice from")
    parser.add_argument("--name", default="default", help="reference name")
    parser.add_argument("--port", default="8011")
    parser.add_argument("--venv", help="reuse an existing Python environment")
    parser.add_argument("--skip-model", action="store_true")
    parser.add_argument("--no-plugin", action="store_true")
    parser.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    if sys.platform != "darwin":
        fail("voice-brief is macOS only: MLX runs on Apple Silicon")
    if platform.machine() != "arm64":
        fail(f"Apple Silicon required, this machine is {platform.machine()}")

    repo = args.repo.resolve()
    manifest = load_presets(repo)
    presets = manifest["presets"]

    preset_name = args.preset or pick(
        list(presets), manifest["default"],
        "Which model preset?", args.yes)
    preset = presets[preset_name]

    voice = "default"

    say("")
    say(f"preset  {preset_name}  ({preset['id']}, ~{preset['sizeGb']} GB)")
    say(f"voice   {voice}")
    say("")

    venv = ensure_venv(repo, args.venv)

    if not args.skip_model:
        download_model(venv, preset["id"])

    start_server(venv, args.port)
    preload(args.port, preset["id"])

    ref_audio, ref_text = None, None
    if args.clone:
        ref_audio, ref_text = clone_reference(
            repo, args.clone, args.name, args.port, apply_config=False)
        if ref_audio is None:
            say("clone setup failed; falling back to the default voice")
        elif not ref_text.exists() or not ref_text.read_text(encoding="utf-8").strip():
            say("the reference has no transcript, so it is not used;")
            say("  set refText by hand later, or pass --ref-text to voice-setup")
            ref_audio, ref_text = None, None
        else:
            voice = "default"
            say(f"reference ready: {ref_audio}")

    values = {
        "engine": "mlx",
        "ttsUrl": f"http://127.0.0.1:{args.port}",
        "sampleRate": "24000",
        "modelPreset": preset_name,
        "autostart": "1",
        "refAudio": str(ref_audio) if ref_audio else "none",
        "refText": ref_text.read_text(encoding="utf-8").strip() if ref_text else "none",
        "language": "auto",
        "announceProject": "1",
    }

    APP_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(values, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")

    if not args.no_plugin:
        configure_plugin(repo, values)

    say("")
    say("done.")
    say(f"  settings   {CONFIG_FILE}")
    say(f"  server log {LOG_FILE}")
    say("Restart Claude Code, then say something to hear it.")
    if not ref_audio:
        say("  tip: clone a voice later with  node cli/voice-setup.js --file <wav> --apply")


if __name__ == "__main__":
    main()
