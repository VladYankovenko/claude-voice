'use strict'

// SessionEnd: the last session leaving starts the server's idle countdown.
// /clear ends the session but keeps the process, so it is not a goodbye.

const { parseInput, readStdin, sendTo } = require('./common')

readStdin().then(raw => {
  const e = parseInput(raw)
  if (e.reason === 'clear') return process.exit(0)
  if (!e.session_id) return process.exit(0)

  sendTo({ op: 'bye', session: e.session_id })
    .finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 300).unref()
})
