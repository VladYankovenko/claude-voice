'use strict'

// Plugin options as they stand on disk right now.
//
// The CLI exports CLAUDE_PLUGIN_OPTION_* into each hook process, but a running
// session keeps the values it started with. Reading settings.json here lets a
// long-lived daemon pick up a model, voice or language change without waiting
// for every session to restart.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const PLUGIN_ID = 'voice-brief@voice-brief-local'

let cache = { mtimeMs: -1, values: {} }

function stored() {
  try {
    const stat = fs.statSync(SETTINGS)
    if (stat.mtimeMs !== cache.mtimeMs) {
      const json = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))
      const options = json?.pluginConfigs?.[PLUGIN_ID]?.options
      cache = { mtimeMs: stat.mtimeMs, values: options && typeof options === 'object' ? options : {} }
    }
    return cache.values
  } catch {
    return {}
  }
}

function option(key, fallback) {
  const upper = key.toUpperCase()
  const snake = upper.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()

  // The settings file wins: it is what the app and `claude plugin configure`
  // write, while the environment of a running daemon was frozen at its start.
  const value = stored()[key]
  if (value !== undefined && value !== null && value !== '') return String(value)

  const env = process.env[`CLAUDE_PLUGIN_OPTION_${upper}`] ||
    process.env[`CLAUDE_PLUGIN_OPTION_${snake}`] ||
    process.env[`CLAUDE_VOICE_${upper}`]
  if (env !== undefined && env !== '') return env

  return fallback
}

module.exports = { option, stored, SETTINGS, PLUGIN_ID }
