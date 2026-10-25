'use strict'

// Language of the person, not of the plugin.
//
// Notification phrases have no text of their own to inspect, so they follow the
// last user message in the transcript; synthesis follows the text it is about
// to speak. `language` in the plugin config overrides both.

const fs = require('node:fs')

const { option } = require('./common')

const ENV_LANGUAGES = {
  ru: 'russian',
  en: 'english',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
  ja: 'japanese',
  ko: 'korean',
  zh: 'chinese',
}

const PHRASES = {
  russian: {
    permission: 'Клод просит разрешение',
    idle: 'Закончил, жду задачу',
    agentDone: 'Агент {kind} закончил',
    agentDoneBare: 'Агент закончил',
    agentNeedsInput: 'Агенту нужен ответ',
    elicitation: 'Нужен твой ответ',
    context: 'Контекст переполняется, сжимаю историю',
    apiError: 'Ошибка API, ответ не пришёл',
  },
  english: {
    permission: 'Claude is asking for permission',
    idle: 'Finished, waiting for your task',
    agentDone: 'Agent {kind} finished',
    agentDoneBare: 'Agent finished',
    agentNeedsInput: 'The agent needs your answer',
    elicitation: 'Your answer is needed',
    context: 'Context is filling up, compacting the history',
    apiError: 'API error, the answer never arrived',
  },
}

function detectScript(text) {
  const source = String(text || '')
  let cyrillic = 0
  let latin = 0
  let han = 0
  let kana = 0
  let hangul = 0

  for (const char of source) {
    const code = char.codePointAt(0)
    if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1
    else if (code >= 0xac00 && code <= 0xd7af) hangul += 1
    else if (code >= 0x3040 && code <= 0x30ff) kana += 1
    else if (code >= 0x4e00 && code <= 0x9fff) han += 1
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1
  }

  const total = cyrillic + latin + han + kana + hangul
  if (total === 0) return null
  if (hangul / total > 0.2) return 'korean'
  if (kana / total > 0.1) return 'japanese'
  if (han / total > 0.2) return 'chinese'
  if (cyrillic / total > 0.2) return 'russian'
  return 'english'
}

function fromEnvironment() {
  const raw = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || ''
  const code = raw.split(/[_.-]/)[0].toLowerCase()
  return ENV_LANGUAGES[code] || null
}

// The transcript is append-only JSONL; the tail is enough for recent prompts.
// Entries with role "user" are not all typed text: tool results and injected
// system reminders are user-role too, and they are usually English. Strip them
// and look further back when a message yields nothing usable.
function cleanUserText(value) {
  return String(value || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/gi, ' ')
    .replace(/<[^>]{1,120}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function recentUserTexts(transcriptPath, limit = 6) {
  if (!transcriptPath) return []
  const texts = []
  try {
    const stat = fs.statSync(transcriptPath)
    const size = Math.min(stat.size, 256 * 1024)
    const fd = fs.openSync(transcriptPath, 'r')
    const buffer = Buffer.alloc(size)
    fs.readSync(fd, buffer, 0, size, stat.size - size)
    fs.closeSync(fd)

    const lines = buffer.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0 && texts.length < limit; i -= 1) {
      const line = lines[i].trim()
      if (!line.startsWith('{')) continue
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      const message = entry && entry.message
      if (!message || message.role !== 'user') continue

      const raw = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
            .filter(block => block && block.type === 'text')
            .map(block => block.text || '')
            .join(' ')
          : ''

      const text = cleanUserText(raw)
      if (text) texts.push(text)
    }
  } catch {}
  return texts
}

function lastUserText(transcriptPath) {
  return recentUserTexts(transcriptPath, 1)[0] || ''
}

function resolveLanguage({ text = '', transcriptPath = '' } = {}) {
  const configured = option('language', 'auto')
  if (configured && configured !== 'auto') return configured

  const own = detectScript(text)
  if (own) return own

  for (const candidate of recentUserTexts(transcriptPath)) {
    const language = detectScript(candidate)
    if (language) return language
  }

  return fromEnvironment() || 'english'
}

function phrase(key, vars = {}, language) {
  const table = PHRASES[language] || PHRASES.english
  const template = table[key] || PHRASES.english[key] || ''
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    name in vars ? String(vars[name]) : whole)
}

module.exports = { detectScript, resolveLanguage, phrase, lastUserText, recentUserTexts }
