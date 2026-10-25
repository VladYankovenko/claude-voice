#!/usr/bin/env node
'use strict'

// Build a clean voice reference from a file or the microphone.
//
//   node cli/voice-setup.js --file sample.wav --name narrator
//   node cli/voice-setup.js --mic 12 --name me
//   node cli/voice-setup.js --file sample.mp4 --start 69.9 --duration 8.8 --apply
//
// Pipeline: highpass/lowpass -> spectral denoise (afftdn) -> silence trim ->
// loudness normalisation -> 24 kHz mono PCM -> whisper transcript.
// Both files land in ~/Library/Application Support/voice-brief/refs/<name>/.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const APP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'voice-brief')
const WHISPER_MODELS = [
  'mlx-community/whisper-large-v3-turbo-asr-fp16',
  'mlx-community/whisper-small-mlx',
]

function parseArgs(argv) {
  const out = {
    file: '',
    mic: 0,
    micDevice: ':0',
    name: 'default',
    start: 0,
    duration: 8,
    port: 8011,
    denoise: true,
    apply: false,
    refText: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    switch (arg) {
      case '--file': out.file = next(); break
      case '--mic': out.mic = Number(next()) || 0; break
      case '--mic-device': out.micDevice = next(); break
      case '--name': out.name = next(); break
      case '--start': out.start = Number(next()) || 0; break
      case '--duration': out.duration = Number(next()) || 8; break
      case '--port': out.port = Number(next()) || 8011; break
      case '--ref-text': out.refText = next(); break
      case '--allow-empty-ref-text': out.allowEmpty = true; break
      case '--no-denoise': out.denoise = false; break
      case '--apply': out.apply = true; break
      case '--help': out.help = true; break
      default: throw new Error(`unknown argument ${arg}`)
    }
  }
  return out
}

function run(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    input: options.input,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split('\n').slice(-3).join(' ')
    throw new Error(`${argv[0]} failed (${result.status}): ${detail}`)
  }
  return result.stdout
}

function probeDuration(file) {
  const out = run([
    'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ])
  return Number(out.trim())
}

function recordMic(seconds, device) {
  const file = path.join(os.tmpdir(), `voice-brief-mic-${Date.now()}.wav`)
  console.error(`recording ${seconds}s from ${device} ...`)
  run([
    'ffmpeg', '-y', '-v', 'error',
    '-f', 'avfoundation', '-i', device,
    '-t', String(seconds), '-ac', '1', '-ar', '48000', file,
  ])
  return file
}

function clean(input, output, args, sourceDuration) {
  const filters = [
    'highpass=f=80',
    'lowpass=f=8000',
  ]
  if (args.denoise) filters.push('afftdn=nf=-25')
  filters.push(
    'silenceremove=start_periods=1:start_threshold=-45dB:' +
    'stop_periods=-1:stop_threshold=-45dB:stop_duration=0.3',
    'loudnorm=I=-18:TP=-2',
  )

  const trim = Math.min(args.duration, Math.max(1, Math.floor(sourceDuration - args.start)))
  run([
    'ffmpeg', '-y', '-v', 'error',
    '-ss', String(args.start), '-t', String(trim), '-i', input,
    '-af', filters.join(','),
    '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output,
  ])
}

async function transcribe(file, port) {
  for (const model of WHISPER_MODELS) {
    try {
      const body = new FormData()
      body.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), path.basename(file))
      body.append('model', model)
      body.append('language', 'ru')
      const res = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(300000),
      })
      if (!res.ok) continue
      const data = await res.json()
      const text = String(data.text || '').trim()
      if (text) return text
    } catch {
      // try the next model
    }
  }
  return ''
}

function applyToPlugin(values) {
  const result = spawnSync(
    'claude',
    ['plugin', 'configure', 'voice-brief@voice-brief-local', '--values-stdin'],
    { input: JSON.stringify(values), encoding: 'utf8' },
  )
  if (result.status !== 0) {
    console.error('could not update the plugin config; paste this instead:')
    console.error(JSON.stringify(values, null, 2))
    return false
  }
  console.error('plugin config updated')
  return true
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`usage: node cli/voice-setup.js --file <audio> [options]
       node cli/voice-setup.js --mic <seconds> [options]

  --file <path>        source audio or video
  --mic <seconds>      record from the microphone instead
  --mic-device <dev>   avfoundation device, default ":0"
  --start <s>          start offset in the source, default 0
  --duration <s>       seconds to keep, default 8 (3-10 recommended)
  --name <slug>        reference name, default "default"
  --no-denoise         skip spectral denoise
  --ref-text <text>    skip transcription and use this text
  --allow-empty-ref-text  keep going when transcription is unavailable
  --apply              write refAudio/refText into the plugin config
  --port <n>           TTS server port, default 8011`)
    return
  }

  const name = args.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'default'
  const dir = path.join(APP_DIR, 'refs', name)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, 'ref.wav')

  let source = args.file
  if (args.mic > 0) source = recordMic(args.mic, args.micDevice)
  if (!source) throw new Error('pass --file <audio> or --mic <seconds>')
  if (!fs.existsSync(source)) throw new Error(`no such file: ${source}`)

  const sourceDuration = probeDuration(source)
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new Error('cannot read the source duration')
  }

  clean(source, target, args, sourceDuration)

  const duration = probeDuration(target)
  if (duration < 3) console.error(`warning: reference is only ${duration.toFixed(1)}s, 3-10s is better`)
  if (duration > 10.5) console.error(`warning: reference is ${duration.toFixed(1)}s, prefer 3-10s`)

  const text = args.refText || await transcribe(target, args.port)

  console.log(`reference: ${target} (${duration.toFixed(2)}s)`)

  if (!text && !args.allowEmpty) {
    console.error('no transcript: the TTS server has no whisper model loaded, or it is not running.')
    console.error('  the reference wav is ready, but ref_text is required for a stable clone.')
    console.error('  options:')
    console.error('    --ref-text "<exact words spoken in the clip>"')
    console.error('    start the server (it downloads whisper on first transcription) and re-run')
    console.error('    --allow-empty-ref-text  to save it anyway')
    process.exit(2)
  }

  const textFile = path.join(dir, 'ref.txt')
  fs.writeFileSync(textFile, text + '\n', 'utf8')
  console.log(`text:      ${text || '<empty>'}`)

  const values = { refAudio: target, refText: text }
  fs.mkdirSync(APP_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(APP_DIR, 'refs', `${name}.json`),
    JSON.stringify(values, null, 2) + '\n',
    'utf8',
  )

  if (args.apply) applyToPlugin(values)
  else console.log(`apply with: node cli/voice-setup.js --file ${source} --name ${name} --apply`)
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
