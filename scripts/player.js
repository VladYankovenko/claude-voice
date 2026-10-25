'use strict'

// Raw PCM in, sound out. ffplay streams straight from a pipe, so the first
// audio chunk is heard while the rest is still being synthesized; afplay is the
// fallback and needs the whole clip as a WAV file.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const { option } = require('./common')

const SAMPLE_RATE = Number(option('sampleRate', '24000')) || 24000

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK)
      return true
    } catch {}
  }
  return false
}

const HAS_FFPLAY = onPath('ffplay')
const HAS_SOX = onPath('play')

// Which program plays a stream: sox drains the audio device before exiting,
// ffplay with -autoexit drops its queued tail at EOF. CLAUDE_VOICE_PLAYER
// forces one: sox | ffplay | file (buffer, then afplay).
function playerName() {
  const forced = process.env.CLAUDE_VOICE_PLAYER
  if (forced === 'sox' && HAS_SOX) return 'sox'
  if (forced === 'ffplay' && HAS_FFPLAY) return 'ffplay'
  if (forced === 'file') return 'file'
  if (HAS_SOX) return 'sox'
  if (HAS_FFPLAY) return 'ffplay'
  return 'file'
}

// ffmpeg 9 dropped `-ac` from ffplay; older builds never had `-ch_layout`.
// Probe once, at load, instead of failing a stream.
let channelFlags
function channels() {
  if (channelFlags) return channelFlags
  if (!HAS_FFPLAY) return (channelFlags = ['-ac', '1'])
  const help = spawnSync('ffplay', ['-h'], { encoding: 'utf8', timeout: 3000 })
  const text = `${help.stdout || ''}${help.stderr || ''}`
  channelFlags = text.includes('ch_layout') ? ['-ch_layout', 'mono'] : ['-ac', '1']
  return channelFlags
}

function wav(pcm, rate = SAMPLE_RATE) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)          // PCM
  header.writeUInt16LE(1, 22)          // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)   // byte rate
  header.writeUInt16LE(2, 32)          // block align
  header.writeUInt16LE(16, 34)         // bits
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

let current = null
let currentCancel = null

function track(child, cancel) {
  current = child
  currentCancel = cancel || null
  child.on('close', () => {
    if (current === child) {
      current = null
      currentCancel = null
    }
  })
}

// Stop whatever is on the speakers right now. The cancel callback settles the
// play promise as well: killing the child alone can leave the writer waiting on
// a drain that never comes, which hangs the queue forever.
function stop() {
  const cancel = currentCancel
  const child = current
  current = null
  currentCancel = null
  if (cancel) {
    try { cancel() } catch {}
    return
  }
  if (child) {
    try { child.kill('SIGTERM') } catch {}
  }
}

async function playStream(source, onChunk) {
  const name = playerName()

  if (name === 'file') {
    const chunks = []
    for await (const chunk of source) {
      chunks.push(chunk)
      if (onChunk) onChunk(chunk)
    }
    return playPcm(Buffer.concat(chunks))
  }

  const [command, args] = name === 'sox'
    ? ['play', ['-q', '-t', 'raw', '-r', String(SAMPLE_RATE),
        '-e', 'signed-integer', '-b', '16', '-c', '1', '-']]
    : ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(SAMPLE_RATE), ...channels(), '-i', 'pipe:0']]

  const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] })
  // A preempted phrase leaves a closed stdin behind; without this listener the
  // EPIPE becomes an uncaught exception and takes the whole daemon down.
  child.stdin.on('error', () => {})

  let stopped = false
  let rejectDone = () => {}
  const done = new Promise((resolve, reject) => {
    rejectDone = reject
    child.on('error', reject)
    child.on('close', code => {
      // ffplay quits with 255 when its stdin closes mid-stream; sox with 0
      if (code === 0 || (name === 'ffplay' && code === 255)) resolve()
      else reject(new Error(`${command} exited ${code}`))
    })
  })
  done.catch(() => {})

  track(child, () => {
    stopped = true
    try { child.stdin.destroy() } catch {}
    try { child.kill('SIGTERM') } catch {}
    rejectDone(new Error(`${command} stopped`))
  })

  try {
    for await (const chunk of source) {
      if (stopped) break
      if (onChunk) onChunk(chunk)
      if (!child.stdin.write(chunk)) {
        await new Promise(resolve => {
          const finish = () => {
            child.stdin.off('drain', finish)
            child.stdin.off('error', finish)
            child.off('close', finish)
            resolve()
          }
          child.stdin.once('drain', finish)
          child.stdin.once('error', finish)
          child.once('close', finish)
        })
      }
    }
    if (!stopped) child.stdin.end()
  } catch {
    try { child.stdin.destroy() } catch {}
  }
  return done
}

async function playPcm(pcm) {
  if (!pcm.length) return
  const file = path.join(os.tmpdir(), `claude-voice-${process.pid}-${Date.now()}.wav`)
  fs.writeFileSync(file, wav(pcm))
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('afplay', [file], { stdio: 'ignore' })
      let rejectStop = () => {}
      const playing = new Promise((res, rej) => {
        rejectStop = rej
        child.on('error', rej)
        child.on('close', code => code === 0 ? res() : rej(new Error(`afplay exited ${code}`)))
      })
      playing.catch(() => {})
      track(child, () => {
        try { child.kill('SIGTERM') } catch {}
        rejectStop(new Error('afplay stopped'))
      })
      playing.then(resolve, reject)
    })
  } finally {
    try { fs.unlinkSync(file) } catch {}
  }
}

async function playFile(file) {
  return playPcm(fs.readFileSync(file))
}

module.exports = { playStream, playPcm, playFile, stop, track, SAMPLE_RATE }
