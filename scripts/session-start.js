'use strict'

const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const { dataDir, option, parseInput, readStdin, sendTo, socketPath } = require('./common')

function alive(socket) {
  return new Promise(resolve => {
    const sock = net.createConnection(socket)
    const settle = ok => {
      sock.destroy()
      resolve(ok)
    }
    sock.on('connect', () => settle(true))
    sock.on('error', () => settle(false))
    setTimeout(() => settle(false), 300).unref()
  })
}

async function serverUp(base) {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/v1/models`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok
  } catch {
    return false
  }
}

// A second session starting while the server is still loading the model would
// spawn a twin and fight over the port, so respect a live pid.
function serverPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir(), 'tts-server.pid'), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function watchdogPidFile() {
  return path.join(dataDir(), 'watchdog.pid')
}

function ensureWatchdog(serverPid, pidFile) {
  if (!Number.isInteger(serverPid) || serverPid <= 0) return

  const own = watchdogPidFile()
  try {
    const running = Number(fs.readFileSync(own, 'utf8').trim())
    if (running > 0) {
      process.kill(running, 0)
      return
    }
  } catch {}

  const child = spawn(process.execPath, [
    path.join(__dirname, 'watchdog.js'),
    String(serverPid),
    socketPath(),
    pidFile || '',
    own,
  ], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  try { fs.writeFileSync(own, String(child.pid)) } catch {}
}

// A server started by the installer has its pid here rather than in the
// plugin's own data directory.
function existingServer() {
  const candidates = [
    path.join(dataDir(), 'tts-server.pid'),
    path.join(os.homedir(), 'Library', 'Application Support', 'voice-brief', 'server.pid'),
  ]
  for (const file of candidates) {
    try {
      const pid = Number(fs.readFileSync(file, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0)
        return { pid, file }
      }
    } catch {}
  }
  return null
}

function startServer(base) {
  if (option('autostart', '1') === '0') return
  if (serverPid()) return

  const candidates = [
    process.env.CLAUDE_VOICE_SERVER_PYTHON,
    path.join(os.homedir(), 'Library', 'Application Support', 'voice-brief', 'venv', 'bin', 'python'),
  ].filter(Boolean)
  const python = candidates.find(candidate => fs.existsSync(candidate))
  if (!python) return

  const url = new URL(base)
  const log = fs.openSync(path.join(dataDir(), 'tts-server.log'), 'a')
  const child = spawn(python, [
    '-m', 'mlx_audio.server',
    '--host', url.hostname,
    '--port', url.port || '8011',
  ], {
    cwd: path.dirname(path.dirname(python)),
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()

  const pidFile = path.join(dataDir(), 'tts-server.pid')
  try {
    fs.writeFileSync(pidFile, String(child.pid))
  } catch {}

  // The daemon already stops the server when it exits; the watchdog covers the
  // case where the daemon is killed outright.
  ensureWatchdog(child.pid, pidFile)
}

readStdin().then(async raw => {
  const { session_id: sessionId } = parseInput(raw)
  const socket = socketPath()
  if (!(await alive(socket))) {
    dataDir()
    const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()

    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (await alive(socket)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  if (sessionId) await sendTo({ op: 'hello', session: sessionId, pid: process.ppid })

  // Autostart only makes sense for a server on this machine: a remote ttsUrl
  // is somebody else's process.
  const base = option('ttsUrl', 'http://127.0.0.1:8011')
  try {
    const host = new URL(base).hostname
    if (host === '127.0.0.1' || host === 'localhost') {
      if (await serverUp(base)) {
        const found = existingServer()
        if (found) ensureWatchdog(found.pid, found.file)
      } else {
        startServer(base)
      }
    }
  } catch {}

  process.exit(0)
})
