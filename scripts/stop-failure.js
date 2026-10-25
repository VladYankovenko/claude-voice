'use strict'

// StopFailure: the turn died on an API error, so there is no <say> line to
// speak. Without this the session goes silent exactly when something broke.

const { parseInput, projectOf, readStdin, sendTo } = require('./common')
const { phrase, resolveLanguage } = require('./lang')

readStdin().then(raw => {
  const e = parseInput(raw)
  sendTo({
    op: 'say',
    priority: true,
    text: phrase('apiError', {}, resolveLanguage({ transcriptPath: e.transcript_path })),
    session: e.session_id || 'unknown',
    project: projectOf(e),
  }).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 300).unref()
})
