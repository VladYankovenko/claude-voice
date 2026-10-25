'use strict'

// One speaker for the whole user.
//
// Every Claude session posts here over the same unix socket, so two sessions
// cannot talk over each other: the queue is global and playback is serial.
// Items carry their session and project; a phrase from another project than the
// last one heard is prefixed with the project name, and a priority phrase from
// another session preempts whatever is playing.

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const { dataDir, option, pidPath, socketPath } = require('./common')
const player = require('./player')
const engine = require('./tts')

const dir = dataDir()
const socket = socketPath()
const pidFile = pidPath()
const cacheDir = path.join(dir, 'cache', 'pcm')
const logFile = path.join(dir, 'daemon.log')

fs.mkdirSync(cacheDir, { recursive: true })
try { fs.unlinkSync(socket) } catch {}
fs.writeFileSync(pidFile, String(process.pid))

function log(...parts) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${parts.join(' ')}\n`)
  } catch {}
}

const MAX_QUEUE = 6
const IDLE_MS = Number(process.env.CLAUDE_VOICE_IDLE_MS || 30 * 60 * 1000)
// How long the machine stays without a Claude session before the TTS server is
// stopped. Two minutes by default: long enough to survive a restart.
const SERVER_IDLE_MS = Number(process.env.CLAUDE_VOICE_SERVER_IDLE_MS || 2 * 60 * 1000)
// How often to check that the processes behind registered sessions are alive.
const PRUNE_MS = Number(process.env.CLAUDE_VOICE_PRUNE_MS || 60 * 1000)
// A session that never reports a pid is dropped after this long.
const MAX_SESSION_MS = 12 * 60 * 60 * 1000
const ANNOUNCE = option('announceProject', '1') !== '0'

const queue = []
const tails = new Map()
let busy = false
let busySince = 0
let current = null
let lastProject = null
let lastActivity = Date.now()
const sessions = new Map()
let hasSession = false
let stopTimer = null

function label(item) {
  const isSwitch = lastProject !== null && item.project !== lastProject
  return isSwitch ? `${item.project}: ${item.text}` : item.text
}

function enqueue(item) {
  const text = String(item?.text || '').replace(/\s+/g, ' ').trim()
  if (text.length < 3) return

  const entry = {
    text,
    session: item.session || 'unknown',
    project: item.project || 'session',
    priority: item.priority === true,
  }

  const queuedForSession = queue.filter(q => q.session === entry.session)
  if (entry.priority && current && current.session !== entry.session) {
    // Another project needs to be heard now: stop this one, keep the queue.
    player.stop()
    log('preempt', entry.project, 'over', current.project)
    queue.unshift(entry)
  } else if (entry.priority) {
    queue.unshift(entry)
  } else {
    if (queuedForSession.length >= 4) {
      const oldest = queue.findIndex(q => q.session === entry.session)
      if (oldest >= 0) queue.splice(oldest, 1)
    }
    if (queue.length >= MAX_QUEUE && queue.length > queuedForSession.length) {
      queue.shift()
    }
    queue.push(entry)
  }

  lastActivity = Date.now()
  void pump()
}

function cancelSession(session) {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].session === session) queue.splice(i, 1)
  }
  if (current && current.session === session) {
    player.stop()
    log('cancel', session)
  }
  lastActivity = Date.now()
}

async function pump() {
  if (busy) return
  busy = true
  busySince = Date.now()
  try {
    while (queue.length) {
      const item = queue.shift()
      current = item
      try {
        await speak(label(item), item)
      } catch (err) {
        log('speak:', item.project, err && err.message)
      }
      lastProject = item.project
      current = null
      lastActivity = Date.now()
    }
  } finally {
    busy = false
    current = null
  }
}

async function speak(text, item) {
  const tag = typeof engine.cacheTag === 'function' ? engine.cacheTag() : (engine.cacheTag || '')
  const key = crypto.createHash('sha1')
    .update(`${engine.name}|${tag}|${text}`)
    .digest('hex')
  const cached = path.join(cacheDir, `${key}.pcm`)

  if (fs.existsSync(cached)) {
    await engine.playFile(cached)
    return
  }

  const chunks = []
  const result = await engine.speak(text, {
    onChunk: buf => chunks.push(buf),
  })
  if (chunks.length) {
    try { fs.writeFileSync(cached, Buffer.concat(chunks)) } catch {}
  }
  if (result) {
    log(
      `said ${item.project} ${text.length}ch -> ${result.seconds ?? '?'}s,`,
      `attempts ${result.attempts ?? 1}`,
    )
  }
}

function hello(session, pid) {
  if (!session) return
  sessions.set(session, { pid: Number(pid) || 0, at: Date.now() })
  hasSession = true
  lastActivity = Date.now()
  if (stopTimer) {
    clearTimeout(stopTimer)
    stopTimer = null
    log('stop cancelled')
  }
}

function bye(session) {
  if (session) sessions.delete(session)
  lastActivity = Date.now()
  if (sessions.size === 0) scheduleStop()
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A Claude that was killed leaves no SessionEnd behind. Its hook process shares
// the CLI's pid, so the daemon can notice the process is gone and treat the
// session as closed.
function pruneSessions() {
  const now = Date.now()

  // A playback that outlives this long is wedged, not speaking. Reset it so the
  // queue keeps moving instead of going silent until the next restart.
  if (busy && busySince > 0 && now - busySince > 2 * 60 * 1000) {
    log('stuck playback, resetting')
    player.stop()
    busy = false
    busySince = 0
  }

  let removed = 0

  for (const [session, entry] of sessions) {
    const dead = entry.pid > 0 && !isAlive(entry.pid)
    const stale = now - entry.at > MAX_SESSION_MS
    if (dead || stale) {
      sessions.delete(session)
      removed += 1
    }
  }

  if (removed) {
    log('pruned', removed, 'session(s)')
    if (sessions.size === 0) scheduleStop()
  }
}

function scheduleStop() {
  if (stopTimer) return
  stopTimer = setTimeout(() => {
    stopTimer = null
    if (sessions.size > 0) return
    stopServer()
    log('idle exit')
    shutdown()
  }, SERVER_IDLE_MS)
}

// Only a server this plugin started is stopped: the pid must be alive and its
// command line must be the mlx-audio server, so a hand-started one survives.
function stopServer() {
  const candidates = [
    path.join(dir, 'tts-server.pid'),
    path.join(os.homedir(), 'Library', 'Application Support', 'voice-brief', 'server.pid'),
  ]

  for (const file of candidates) {
    let pid = 0
    try {
      pid = Number(fs.readFileSync(file, 'utf8').trim())
    } catch {
      continue
    }
    if (!Number.isInteger(pid) || pid <= 0) continue

    let command = ''
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    } catch {
      continue
    }
    if (!command.includes('mlx_audio.server')) continue

    try {
      process.kill(pid, 'SIGTERM')
      log('stopped tts server', pid)
    } catch {}
    try { fs.unlinkSync(file) } catch {}
  }
}

function handle(event) {
  if (event.op === 'hello') return hello(event.session, event.pid)
  if (event.op === 'bye') return bye(event.session)
  if (event.op === 'cancel') return cancelSession(event.session || 'unknown')
  if (event.op === 'say') return enqueue(event)

  const session = event.session || 'unknown'
  const id = `${session}|${event.message_id || 'unknown'}`
  const buf = (tails.get(id) || '') + (event.delta || '')
  const say = /<say>([\s\S]*?)<\/say>/g
  let rest = buf
  let match
  while ((match = say.exec(buf))) {
    enqueue({ text: match[1], session, project: event.project })
    rest = rest.replace(match[0], '')
  }

  if (event.final) tails.delete(id)
  else tails.set(id, rest.slice(-200))
}

const server = net.createServer(conn => {
  let raw = ''
  conn.setEncoding('utf8')
  conn.on('data', chunk => { raw += chunk })
  conn.on('error', () => {})
  conn.on('end', () => {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        handle(JSON.parse(line))
      } catch {
        // a torn line: ignore
      }
    }
  })
})

server.on('error', err => {
  if (err.code === 'EADDRINUSE') process.exit(0)
  log('server:', err.message)
  process.exit(1)
})

server.listen(socket, () => log('listening', socket, 'pid', process.pid))

// A daemon started by hand never hears a session; it still exits eventually.
const fallback = setInterval(() => {
  if (hasSession || busy || queue.length) return
  if (Date.now() - lastActivity < IDLE_MS) return
  stopServer()
  log('idle exit')
  shutdown()
}, 60 * 1000)
fallback.unref()

const prune = setInterval(pruneSessions, PRUNE_MS)
prune.unref()

function shutdown() {
  if (stopTimer) clearTimeout(stopTimer)
  // The daemon going away is the last thing that would have stopped the
  // server, so do it here as well: a server left behind holds gigabytes.
  stopServer()
  try { fs.unlinkSync(socket) } catch {}
  try { fs.unlinkSync(pidFile) } catch {}
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// One bad phrase must not take the speaker down and leave every session mute.
process.on('uncaughtException', err => log('uncaught:', err && err.message))
process.on('unhandledRejection', err => log('unhandled:', err && err.message))
