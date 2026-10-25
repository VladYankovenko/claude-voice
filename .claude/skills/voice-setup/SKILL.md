---
name: voice-setup
description: Install, configure, or troubleshoot the voice-brief plugin — local Qwen voice narration for Claude Code. Use when the user wants voice output set up, hears nothing, wants a different model or voice, or wants to clone a voice from a recording.
---

# Voice setup

You are helping one person install and configure voice-brief: Claude Code speaks
one short line per assistant message through a local Qwen3-TTS server on Apple
Silicon.

Rules for this conversation:

- Speak the user's language. Plain words, short sentences. Explain a term the
  first time you use it.
- Ask one question at a time and wait for the answer.
- Never delete the person's files. Ask before stopping any process that is not
  voice-brief's own.
- Say how long an operation takes before you start it. Downloads are gigabytes.

## 1. Check the machine first

Run these, silently, before asking anything:

```bash
uname -m                          # must be arm64
sw_vers -productVersion
python3 --version
node --version
command -v ffmpeg; command -v play; command -v sox
df -h "$HOME" | tail -1
```

- Not `arm64` or not macOS: stop. Qwen on MLX needs an Apple Silicon Mac; there is
  no fallback.
- Missing `python3`, `node`, `ffmpeg`: explain that these three are required and
  offer the Homebrew line (`brew install ffmpeg sox`); Xcode Command Line Tools
  cover python3. Do not install anything without a yes.
- Less than 6 GB free: warn before downloading. A model is 2.3 GB (0.6B) or
  4.3 GB (1.7B).

Also find the repository. If `./installer/install.sh` exists you are in it;
otherwise:

```bash
claude plugin marketplace list | grep voice-brief-local
```

That prints `Source: Folder (<path>)` — use that path. If neither works, ask the
person for the folder where they cloned the repository.

## 2. Ask what they want

Ask in this order, one question per message.

**Model** — explain the trade-off in one line each:

| choice | what it means |
|---|---|
| `0.6-base` | fast, 2.3 GB, about 4 GB of RAM |
| `1.7-base` | best quality, 4.3 GB, about 10 GB of RAM peak |

Both clone a voice from a recording, and both ship with the same stable default
voice, so the model choice is only about speed versus quality.

**Voice** — the plugin already has a fixed default voice. Ask whether they want
to keep it or clone their own from a recording.

**Recording** — if they choose a clone, ask for an audio or video file, or offer
to record 10 seconds from the microphone. Say the requirements plainly: 3–10
seconds, one person speaking, no music, same language as the answers they want
to hear. If they pick the microphone, macOS will ask for microphone permission
once.

## 3. Install

Explain what will happen, in this order and with rough times:

1. creates a private Python environment (~1 minute),
2. downloads the model (2.3 or 4.3 GB),
3. starts the local server and loads the model (10–20 seconds),
4. builds the voice reference if they asked for a clone,
5. installs and configures the plugin.

Then run, with the repository path and their answers:

```bash
cd <repo>
./installer/install.sh --yes --preset <preset>
# or, with a clone:
./installer/install.sh --yes --preset <preset> \
  --clone <absolute path to the file> --name <short name>
```

Use an absolute path for `--clone`. Give the command a long timeout; model
downloads can take several minutes. Show the tail of the output as it runs.

If the transcript step fails (message mentions `no transcript` or whisper), do
not treat the install as failed: the voice reference is saved, but Qwen needs
the exact words. Ask the person to paste the words they hear in the clip, then
run:

```bash
node cli/voice-setup.js --file <file> --name <name> \
  --ref-text "<their words>" --apply
```

## 4. Verify, then hand over

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8011/v1/models   # 200
claude plugin list | grep voice-brief                                     # enabled
```

Then speak one test phrase on their machine:

```bash
node scripts/say.js "Проверка связи"
```

It prints `{"seconds": ..., "attempts": 1}` when it worked. If it prints an
error, go to troubleshooting before telling them anything is done.

Finish with three short points:

1. Restart Claude Code, then any answer will speak one short line aloud.
2. The line is hidden from the screen; it is written by the model in the
   language of the conversation.
3. The server stops two minutes after the last session closes and starts again
   on the next one; the first phrase after a pause takes a few seconds longer.

## Troubleshooting

| symptom | check | fix |
|---|---|---|
| silence | `node scripts/say.js "тест"` | works = plugin side; broken = server side |
| server down | `curl 127.0.0.1:8011/v1/models` | `python -m mlx_audio.server --host 127.0.0.1 --port 8011` from the venv |
| port busy | `lsof -nP -iTCP:8011 -sTCP:LISTEN` | another server is running; stop it or set another port |
| plugin off | `claude plugin list` | `claude plugin enable voice-brief` |
| no speech in a session | logs | `~/.claude/plugins/data/voice-brief-voice-brief-local/daemon.log` |
| voice sounds wrong | the bundled default | clone your own with `cli/voice-setup.js` |
| clone sounds noisy | source recording | pick a cleaner 3–10 s segment, no music |
| plugin missing after install | `claude plugin list` | `claude plugin install voice-brief --marketplace <repo> --scope user` |

## Changing things later

- Model preset, reference path, language, autostart: `/plugin configure voice-brief`.
- New voice clone: `node cli/voice-setup.js --file <audio> --name <name> --apply`.
- Turn narration off: `/plugin disable voice-brief` for this machine, or set
  `autostart=0` to keep the plugin but stop it from launching the server.
