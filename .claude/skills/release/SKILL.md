---
name: release
description: Build, screenshot and publish a Claude Voice release (DMG + SHA256 + GitHub release). Use when the user asks to cut a release, publish a version, rebuild the DMG, refresh screenshots, or when a release asset has to be replaced.
---

# Release Claude Voice

The product is **Claude Voice**; the repository is `VladYankovenko/claude-voice`.
The plugin id is **`voice-brief`** and must stay that way: plugin names starting
with `claude-` are rejected by the validator, and the id is baked into
`~/.claude/settings.json`, the data folder names and every path in this repo.

Follow the steps in order. Do not skip the smoke test.

## 1. Sanity checks

```bash
gh auth status                      # needs the repo scope
git status --porcelain              # must be empty except intended changes
xcodebuild -version                 # Xcode 26 for macOS 26 / Liquid Glass
uname -m                            # arm64 only
```

If `gh` is not authenticated, stop and ask the person to run
`gh auth login` themselves.

## 2. Bump the version in both places

```bash
VERSION=0.2.0

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" app/Resources/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${VERSION}" app/Resources/Info.plist

python3 - "$VERSION" <<'PY'
import json, pathlib, sys
version = sys.argv[1]
path = pathlib.Path('.claude-plugin/plugin.json')
data = json.loads(path.read_text())
data['version'] = version
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
PY

grep -n "CFBundleShortVersionString" -A1 app/Resources/Info.plist
grep -n '"version"' .claude-plugin/plugin.json
```

The tag is `v${VERSION}` and must match both files.

## 3. Build

```bash
cd app
./fetch-runtime.sh      # downloads the relocatable CPython on a fresh clone
./build.sh              # builds build/Claude Voice.app and build/ClaudeVoice.dmg
```

`build.sh` also copies the plugin payload into
`Claude Voice.app/Contents/Resources/plugin`, so the DMG needs no repository.

Smoke test before anything is published:

```bash
"build/Claude Voice.app/Contents/MacOS/VoiceBriefBar" --selftest
"build/Claude Voice.app/Contents/MacOS/VoiceBriefBar" --models
ls -lh build/ClaudeVoice.dmg
```

`--selftest` prints the bundled python path and whether the venv is ready.
`--models` prints the resolved sizes of both model presets.

## 4. Screenshots (when the UI or docs changed)

```bash
./tools/screenshots.sh      # writes ../docs/panel-dark.png and ../docs/panel-light.png
```

This launches the app in `--preview` mode, finds the window id with
`tools/window-id.swift`, and captures it with `screencapture -l`.

Requires the **Screen Recording** permission for the terminal that runs Claude
(System Settings → Privacy & Security → Screen & System Audio Recording).
Without it `screencapture` fails with `could not create image from rect`.

If you add UI states worth showing (clone chosen, download in progress), extend
`tools/screenshots.sh` with another `--preview` flag rather than editing images.

## 5. Checksum

```bash
cd app
shasum -a 256 build/ClaudeVoice.dmg | tee build/ClaudeVoice.dmg.sha256
```

## 6. Commit and push

This repository keeps a **single commit** history on purpose: amend the root
commit and force-push.

```bash
cd ..
git add -A
git commit --amend --no-edit
git push -f origin main
git log --oneline -1
```

Never commit `app/build/`, `app/.build/` or `app/Resources/python/` — they are
gitignored. Only sources, tools, docs and screenshots go in.

Screenshots must be pushed **before** the release is created: the release notes
reference
`https://raw.githubusercontent.com/VladYankovenko/claude-voice/main/docs/panel-dark.png`.

## 7. Publish the release

```bash
cd app
gh release create "v${VERSION}" \
  build/ClaudeVoice.dmg \
  build/ClaudeVoice.dmg.sha256 \
  --title "Claude Voice ${VERSION}" \
  --notes-file ../docs/release-notes.md \
  --target main
```

Keep the notes in `docs/release-notes.md` (committed) so the next release edits
a file instead of retyping prose. Template:

```markdown
# Claude Voice X.Y.Z

One line about what changed.

<p align="center">
  <img src="https://raw.githubusercontent.com/VladYankovenko/claude-voice/main/docs/panel-light.png" width="380">
  <img src="https://raw.githubusercontent.com/VladYankovenko/claude-voice/main/docs/panel-dark.png" width="380">
</p>

## What changed
- …

## Install
1. Open the DMG, drag **Claude Voice.app** into Applications.
2. First launch: right-click → **Open**, or run
   `xattr -dr com.apple.quarantine "/Applications/Claude Voice.app"`.
3. Menu bar → Start → Download → Install.
4. Restart Claude Code.

Requirements: macOS 26 on Apple Silicon, Claude Code installed, network on first
run, `ffmpeg` only for voice cloning.
```

## 8. Verify

```bash
gh release view "v${VERSION}" --json tagName,url,assets --jq '{tagName,url,assets:[.assets[]|{name,size}]}'
curl -sIL -o /dev/null -w '%{http_code}\n' \
  "https://github.com/VladYankovenko/claude-voice/releases/download/v${VERSION}/ClaudeVoice.dmg"
curl -s -o /dev/null -w '%{http_code}\n' \
  https://raw.githubusercontent.com/VladYankovenko/claude-voice/main/docs/panel-dark.png
```

All three must return 200.

## Report to the person

Give the release URL, asset sizes, the SHA256, and the exact install steps —
including the Gatekeeper note below.

## Known traps

- **Ad-hoc signing.** `codesign --sign -` is enough to run locally, but a DMG
  downloaded on another Mac gets quarantined and macOS offers "Move to Trash".
  Tell the person to run
  `xattr -dr com.apple.quarantine "/Applications/Claude Voice.app"`.
  Real distribution needs a Developer ID certificate, hardened runtime,
  `notarytool` and `stapler` — then no warning appears.
- **Venv must not point inside the .app.** The first implementation created the
  venv from `Claude Voice.app/Contents/Resources/python`, so renaming or moving
  the app broke it. `Runtime.ensureRuntimeCopy()` copies the runtime to
  `~/Library/Application Support/voice-brief/runtime` first, and
  `ensureVenv` repairs a broken venv. If you touch this code, test by renaming
  the app and running `--prepare` again.
- **Plugin id is `voice-brief`.** Renaming it breaks stored config and data
  paths; the validator also rejects `claude-*` names.
- **App/product name is Claude Voice**, bundle id
  `com.vladyankovenko.claude-voice-bar`, DMG `ClaudeVoice.dmg`. Keep the three
  in sync when renaming anything.
- **Screen Recording permission** is per terminal app. If screenshots fail,
  check it before debugging the script.
- **Force-push** rewrites the single commit. Only do it on this repository,
  never on a branch someone else is building on.
- `claude plugin validate .` must pass before publishing; LICENSE lives at the
  repository root.

## Rollback

Wrong notes or assets:

```bash
gh release delete "v${VERSION}" --yes --cleanup-tag
```

Then fix, rebuild, commit, push and create the release again. Never leave a tag
pointing at a commit that no longer exists after an amend.
