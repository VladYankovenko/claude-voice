'use strict'

// Keeps the TTS server from outliving the speaker.
//
// The daemon stops the server when the last session leaves and on SIGTERM, but
// a killed daemon cannot. This process watches the daemon's socket and stops
// the server when nobody has been listening for three checks in a row.

const fs = require('node:fs')
const net = require('node:net')

const serverPid = Number(process.argv[2])
const socket = process.argv[3]
const pidFile = process.argv[4]
const ownPidFile = process.argv[5]
const INTERVAL_MS = Number(process.env.CLAUDE_VOICE_WATCHDOG_MS || 30 * 1000)

if (!Number.isInteger(serverPid) || serverPid <= 0 || !socket) process.exit(0)

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function reachable() {
  return new Promise(resolve => {
    const sock = net.createConnection(socket)
    const settle = ok => {
      sock.destroy()
      resolve(ok)
    }
    sock.on('connect', () => settle(true))
    sock.on('error', () => settle(false))
    setTimeout(() => settle(false), 1000).unref()
  })
}

function cleanup() {
  if (!ownPidFile) return
  try { fs.unlinkSync(ownPidFile) } catch {}
}

function stop() {
  try {
    const command = require('node:child_process')
      .execFileSync('ps', ['-p', String(serverPid), '-o', 'command='], { encoding: 'utf8' })
    if (!command.includes('mlx_audio.server')) return
  } catch {
    return
  }
  try { process.kill(serverPid, 'SIGTERM') } catch {}
  if (pidFile) {
    try { fs.unlinkSync(pidFile) } catch {}
  }
}

let misses = 0

process.on('exit', cleanup)
process.on('SIGTERM', () => { cleanup(); process.exit(0) })
process.on('SIGINT', () => { cleanup(); process.exit(0) })

async function tick() {
  if (!alive(serverPid)) process.exit(0)


  if (await reachable()) {
    misses = 0
    return
  }

  misses += 1
  if (misses < 3) return

  stop()
  cleanup()
  process.exit(0)
}

// Keep the process alive: the interval is the whole reason it exists.
setInterval(() => { void tick() }, INTERVAL_MS)
void tick()
