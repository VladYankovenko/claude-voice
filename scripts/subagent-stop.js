'use strict'

// SubagentStop: a subagent finished while you were looking elsewhere. Speak
// who finished, not the whole answer: the main thread reports the substance.

const { parseInput, projectOf, readStdin, sendTo } = require('./common')
const { phrase, resolveLanguage } = require('./lang')

readStdin().then(raw => {
  const e = parseInput(raw)
  if (e.stop_hook_active === true) return process.exit(0)

  const language = resolveLanguage({ transcriptPath: e.transcript_path })
  const kind = String(e.agent_type || '').trim()
  const text = kind
    ? phrase('agentDone', { kind }, language)
    : phrase('agentDoneBare', {}, language)

  sendTo({
    op: 'say',
    priority: true,
    text,
    session: e.session_id || 'unknown',
    project: projectOf(e),
  }).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 300).unref()
})
