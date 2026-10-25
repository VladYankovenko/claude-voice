#!/usr/bin/env node
'use strict'

// Manual check, no Claude session involved:
//   node scripts/say.js "проверка связи"
//   CLAUDE_VOICE_ENGINE=system node scripts/say.js "через say"

const { option } = require('./common')
const engine = require('./tts')

const text = process.argv.slice(2).join(' ').trim()
if (!text) {
  console.error('usage: node scripts/say.js <text>')
  process.exit(2)
}

console.error(`engine: ${engine.name}`)
engine.speak(text, {
  voice: option('voice', 'default'),
  onChunk: () => {},
}).then(
  result => {
    console.error(JSON.stringify(result))
    process.exit(0)
  },
  err => {
    console.error(err.message)
    process.exit(1)
  },
)
