'use strict'

// UserPromptSubmit: the person is typing again, so whatever this session is
// speaking is already stale. Other sessions keep their own playback.

const { parseInput, projectOf, readStdin, sendTo } = require('./common')

readStdin().then(raw => {
  const e = parseInput(raw)
  sendTo({
    op: 'cancel',
    session: e.session_id || 'unknown',
    project: projectOf(e),
  }).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 300).unref()
})
