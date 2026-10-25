'use strict'

// Notification: speak the events that matter when you are away from the
// screen. Priority items jump the shared queue and interrupt another session.

const { parseInput, projectOf, readStdin, sendTo } = require('./common')
const { phrase, resolveLanguage } = require('./lang')

const KEYS = {
  permission_prompt: 'permission',
  idle_prompt: 'idle',
  agent_completed: 'agentDoneBare',
  agent_needs_input: 'agentNeedsInput',
  elicitation_dialog: 'elicitation',
}

readStdin().then(raw => {
  const e = parseInput(raw)
  const key = KEYS[e.notification_type]
  const text = key
    ? phrase(key, {}, resolveLanguage({ transcriptPath: e.transcript_path }))
    : ''
  const done = text
    ? sendTo({
        op: 'say',
        priority: true,
        text,
        session: e.session_id || 'unknown',
        project: projectOf(e),
      })
    : Promise.resolve(false)
  done.finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 300).unref()
})
