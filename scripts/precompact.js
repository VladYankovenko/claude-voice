'use strict'

// PreCompact: the context is about to be compressed. Priority, so it is heard
// even when another session is in the middle of a phrase.

const { parseInput, projectOf, readStdin, sendTo } = require('./common')
const { phrase, resolveLanguage } = require('./lang')

readStdin().then(raw => {
  const e = parseInput(raw)
  sendTo({
    op: 'say',
    priority: true,
    text: phrase('context', {}, resolveLanguage({ transcriptPath: e.transcript_path })),
    session: e.session_id || 'unknown',
    project: projectOf(e),
  }).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 300).unref()
})
