'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

function dataDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), '.cache', 'claude-voice')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// One speaker for the whole user: every session talks to the same daemon so
// two sessions cannot play over each other.
function socketPath() {
  return path.join(dataDir(), 'speaker.sock')
}

function pidPath() {
  return path.join(dataDir(), 'speaker.pid')
}

function readStdin() {
  return new Promise(resolve => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { raw += chunk })
    process.stdin.on('end', () => resolve(raw))
    process.stdin.on('error', () => resolve(raw))
  })
}

function parseInput(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// Settings come from the environment the CLI exported, then from the settings
// file on disk, so a running daemon sees a change without a session restart.
function option(key, fallback) {
  return require('./settings').option(key, fallback)
}

// A short name for the session in the spoken prefix: the folder the session
// runs in, which is usually the project.
function projectOf(input) {
  const cwd = input && typeof input.cwd === 'string' && input.cwd
    ? input.cwd
    : process.cwd()
  const base = path.basename(cwd.replace(/[\\/]+$/, ''))
  return base || 'session'
}

let revived = false

// The speaker can die (a crash, a manual kill, a machine that slept). Hooks run
// as fresh processes on every event, so spawning it here brings audio back
// without restarting any Claude session.
function reviveSpeaker() {
  if (revived) return
  revived = true
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
  } catch {}
}

// One-shot message to the shared speaker. Never throws: hooks must not fail
// because the daemon is down.
function sendTo(payload, timeoutMs = 300) {
  return new Promise(resolve => {
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const sock = net.createConnection(socketPath())
      sock.on('error', () => { reviveSpeaker(); done(false) })
      sock.on('connect', () => sock.end(JSON.stringify(payload) + '\n'))
      sock.on('close', () => done(true))
      setTimeout(() => {
        try { sock.destroy() } catch {}
        done(false)
      }, timeoutMs).unref()
    } catch {
      done(false)
    }
  })
}

module.exports = {
  dataDir,
  socketPath,
  pidPath,
  readStdin,
  parseInput,
  option,
  projectOf,
  sendTo,
}
