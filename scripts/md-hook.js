'use strict'

// MessageDisplay hook. Must return in single-digit milliseconds: the CLI holds
// each streamed batch until this exits, and the batch times out at 10s.

const fs = require('node:fs')

const { parseInput, projectOf, readStdin, sendTo } = require('./common')

const SAY = /<say>([\s\S]*?)<\/say>/g

// Hide the spoken line from the screen: strip whole tags, then an open tag that
// runs to the end of the batch, then a tag cut in half by the batch boundary.
function stripSpoken(text) {
  return text
    .replace(SAY, '')
    .replace(/<say>[\s\S]*$/, '')
    .replace(/<\/?s(a(y)?)?$/, '')
}

readStdin().then(raw => {
  const e = parseInput(raw)
  const delta = typeof e.delta === 'string' ? e.delta : ''

  if (delta) {
    void sendTo({
      session: e.session_id || 'unknown',
      project: projectOf(e),
      message_id: e.message_id,
      index: e.index,
      final: e.final === true,
      delta,
    })
  }

  // Final batches may carry an empty delta; then there is nothing to display.
  if (delta) {
    fs.writeSync(1, JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'MessageDisplay',
        displayContent: stripSpoken(delta),
      },
    }))
  }

  setTimeout(() => process.exit(0), 50).unref()
})
