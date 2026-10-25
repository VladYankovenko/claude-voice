'use strict'

// Adapter for the mlx-audio server (OpenAI-shaped speech endpoint):
//
//   POST {ttsUrl}/v1/audio/speech
//   {"model":"mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16",
//    "input":"...", "response_format":"pcm", "stream":true,
//    "lang_code":"russian"}
//   -> chunked audio/pcm: 24000 Hz, mono, s16le, end of stream = EOF
//
// Server rules that shape this file:
// - the text field is `input`, not `text`;
// - `response_format` defaults to mp3 (needs ffmpeg), so `pcm` is always sent;
// - `lang_code` defaults to "a"; Russian is `russian`, not `ru`;
// - streaming and voice cloning are serialized server-side, so this client
//   stays single-flight (the daemon already queues phrases);
// - `ref_audio` is an absolute path on the server's machine, `ref_text` is
//   mandatory for a stable clone and is re-encoded on every request.
//
// Overrides: CLAUDE_VOICE_TTS_PATH, CLAUDE_VOICE_MODEL, CLAUDE_VOICE_LANG,
// CLAUDE_VOICE_REF_AUDIO, CLAUDE_VOICE_REF_TEXT, CLAUDE_VOICE_SPEED,
// CLAUDE_VOICE_MAX_TOKENS, CLAUDE_VOICE_STREAM_INTERVAL.

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const { option } = require('../common')
const { resolveLanguage } = require('../lang')
const { presetOf } = require('../models')
const player = require('../player')

const ASSETS = path.join(__dirname, '..', '..', 'assets')
const BUNDLED_AUDIO = path.join(ASSETS, 'default-voice.wav')
const BUNDLED_TEXT = path.join(ASSETS, 'default-voice.txt')
const DEFAULT_PRESET = '1.7-base'

function bundledText() {
  try { return fs.readFileSync(BUNDLED_TEXT, 'utf8').trim() } catch { return '' }
}

// Read on every phrase: the settings file can change while the daemon lives, so
// a model or voice switch applies without restarting any Claude session.
function current() {
  const configuredAudio = process.env.CLAUDE_VOICE_REF_AUDIO || option('refAudio', 'none')
  const configuredText = process.env.CLAUDE_VOICE_REF_TEXT || option('refText', 'none')
  // A base model without a reference invents a speaker per request; the bundled
  // recording keeps the default voice stable.
  const refAudio = configuredAudio && configuredAudio !== 'none'
    ? configuredAudio
    : (fs.existsSync(BUNDLED_AUDIO) ? BUNDLED_AUDIO : '')
  const preset = presetOf(process.env.CLAUDE_VOICE_PRESET || option('modelPreset', DEFAULT_PRESET))

  return {
    base: option('ttsUrl', 'http://127.0.0.1:8011').replace(/\/+$/, ''),
    pathname: process.env.CLAUDE_VOICE_TTS_PATH || '/v1/audio/speech',
    presetId: preset.id,
    model: process.env.CLAUDE_VOICE_MODEL || preset.id,
    refAudio,
    refText: refAudio === BUNDLED_AUDIO
      ? bundledText()
      : (configuredText === 'none' ? '' : configuredText),
    fixedLang: process.env.CLAUDE_VOICE_LANG || '',
    speed: Number(process.env.CLAUDE_VOICE_SPEED || 0) || undefined,
    maxTokens: Number(process.env.CLAUDE_VOICE_MAX_TOKENS || 0) || undefined,
    interval: Number(process.env.CLAUDE_VOICE_STREAM_INTERVAL || 0.5),
    timeout: Number(process.env.CLAUDE_VOICE_TTS_TIMEOUT || 60000),
  }
}

// Part of the cache key: the same words in another voice or model must not
// reuse a clip.
function cacheTag() {
  const settings = current()
  return `${settings.presetId}|${settings.model}|${settings.refAudio}`
}

function body(text, settings) {
  return JSON.stringify({
    model: settings.model,
    input: text,
    response_format: 'pcm',
    stream: true,
    lang_code: settings.fixedLang || resolveLanguage({ text }),
    ref_audio: settings.refAudio || undefined,
    ref_text: settings.refAudio ? settings.refText : undefined,
    speed: settings.speed,
    max_tokens: settings.maxTokens,
    streaming_interval: settings.interval,
  })
}

async function fail(res) {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 500)
  } catch {}
  throw new Error(`tts ${res.status} ${res.statusText} ${detail}`.trim())
}

async function* stream(text, opts = {}) {
  const settings = current()
  const res = await fetch(new URL(settings.pathname, settings.base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body(text, settings),
    signal: AbortSignal.timeout(settings.timeout),
  })
  if (!res.ok) await fail(res)
  if (!res.body) throw new Error('tts answered with no body')

  const type = (res.headers.get('content-type') || '').toLowerCase()
  const reader = res.body.getReader()

  if (type.includes('text/event-stream')) {
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let payload
          try { payload = JSON.parse(data) } catch { payload = { audio: data } }
          const base64 = payload.audio || payload.audio_base64 || payload.data
          if (base64) yield Buffer.from(base64, 'base64')
        }
      }
    }
    return
  }

  // Raw PCM is streamed straight to the player; anything else (wav/mp3, when
  // someone overrides response_format) is collected and handed to afplay.
  const isPcm = type.includes('pcm') || type.includes('octet-stream')
  if (!isPcm) {
    const parts = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(Buffer.from(value))
    }
    const ext = type.includes('mpeg') || type.includes('mp3') ? 'mp3'
      : type.includes('wav') ? 'wav' : 'audio'
    const file = path.join(os.tmpdir(), `claude-voice-${process.pid}-${Date.now()}.${ext}`)
    fs.writeFileSync(file, Buffer.concat(parts))
    try {
      await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn('afplay', [file], { stdio: 'ignore' })
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`afplay exited ${code}`)))
      })
    } finally {
      try { fs.unlinkSync(file) } catch {}
    }
    return
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    yield Buffer.from(value)
  }
}

async function speak(text, opts) {
  let attempts = 0
  for (;;) {
    attempts += 1
    let played = 0
    try {
      await player.playStream(stream(text, opts), chunk => {
        played += chunk.length
        if (opts.onChunk) opts.onChunk(chunk)
      })
      // An empty answer is a failed synthesis, not a silent phrase: let the
      // retry above run instead of reporting a zero-second clip.
      if (played === 0) throw new Error('tts produced no audio')
      return { seconds: played / 2 / player.SAMPLE_RATE, attempts }
    } catch (err) {
      // A stop is deliberate (barge-in, another project preempting): retrying it
      // would replay the phrase the person just cancelled.
      const stopped = /stopped$/.test(String(err && err.message))
      // A stream that dies before the first byte reaches the player is safe to
      // retry; one that dies after it is not, since the phrase is half spoken.
      if (stopped || played > 0 || attempts >= 2) throw err
    }
  }
}

async function playFile(file) {
  return player.playFile(file)
}

module.exports = { speak, playFile, stream, cacheTag }
