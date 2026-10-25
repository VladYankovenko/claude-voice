'use strict'

// Fallback: the platform synthesizer. No cloning, no streaming, but always
// there. Voice names are macOS `say` names, not TTS-server ids: set
// CLAUDE_VOICE_SAY_VOICE (e.g. "Milena") to pick one.

const { spawn } = require('node:child_process')

const player = require('../player')

async function speak(text, opts = {}) {
  const voice = process.env.CLAUDE_VOICE_SAY_VOICE
  const args = []
  if (voice) args.push('-v', voice)
  const rate = process.env.CLAUDE_VOICE_SAY_RATE
  if (rate) args.push('-r', rate)
  args.push(text.slice(0, 4000))

  await new Promise((resolve, reject) => {
    const child = spawn('say', args, { stdio: 'ignore' })
    player.track(child)
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`say exited ${code}`)))
  })

  // `say` plays by itself, so nothing streams and nothing is cached.
  void opts
  return { seconds: null, attempts: 1 }
}

async function playFile(file) {
  return player.playFile(file)
}

module.exports = { speak, playFile }
