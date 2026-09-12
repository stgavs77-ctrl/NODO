/**
 * Наблюдатель за клиентскими сессиями: раз в N секунд снимает состояние
 * каждой клиентской сессии (по карте чат -> сессия из состояния моста),
 * пишет сводку в board.json и board.md и копит тревоги в alerts.json.
 *
 * Только чтение: логи сессий и кэш проекций читаются, ничего не отправляется.
 * @module sessions-observer
 */
import zlib from 'node:zlib'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import lifecycle from './lifecycle-gate.cjs'

export const name = 'sessions-observer'
export const inject = ['tools', 'typert']

const HOME = '/Users/nodo'
const DEFAULTS = {
  bridgeState: `${HOME}/.dsh/plugins/telegram-bridge/state.json`,
  bridgeAlerts: `${HOME}/.dsh/plugins/telegram-bridge/alerts.json`,
  bridgeWatch: `${HOME}/.dsh/plugins/telegram-bridge/watch.json`,
  sessionsRoot: `${process.env.DSH_HOME || `${HOME}/.dsh`}/sessions`,
  projections: `${process.env.DSH_HOME || `${HOME}/.dsh`}/storages/session_projcache/sessions`,
  outDir: `${HOME}/.dsh/plugins/sessions-observer`,
  intervalMs: 15000,
  stuckMinutes: 7,
  controllerSession: 'session-d0946a25-eed9-4adb-be22-8250d6150d8e',
  healLog: `${HOME}/.dsh/plugins/telegram-bridge/heal.log`,
  wakeController: true,
  maxWakesPerHour: 4,
}

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Последние строки лога: разбираем последние zstd-кадры и берём хвост. */
function tailEvents(path, frames = 12, lines = 60) {
  const raw = readFileSync(path)
  const starts = []
  for (let at = raw.indexOf(FRAME_MAGIC); at !== -1; at = raw.indexOf(FRAME_MAGIC, at + 1)) starts.push(at)
  const out = []
  for (let index = Math.max(0, starts.length - frames); index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : raw.length
    try {
      out.push(...zlib.zstdDecompressSync(raw.subarray(from, to)).toString('utf8').split('\n'))
    } catch { /* повреждённый кадр пропускаем */ }
  }
  const clean = out.filter((line) => line.trim() !== '')
  return clean.slice(-lines).map((line) => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

function clientSessions(statePath) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    return Object.entries(state.chats ?? {}).map(([chat, value]) => ({
      chat: Number(chat), title: value?.title ?? String(chat), session: value?.session,
    })).filter((row) => typeof row.session === 'string')
  } catch {
    return []
  }
}

function sessionDir(root, sessionId) {
  for (const project of readdirSync(root)) {
    const path = join(root, project, sessionId)
    try {
      if (statSync(path).isDirectory()) return path
    } catch { /* нет такой сессии в этом проекте */ }
  }
  return undefined
}

function pressure(sessionId, projections) {
  try {
    const cached = JSON.parse(readFileSync(join(projections, `${sessionId}.json`), 'utf8'))
    const rows = cached?.record?.rows ?? {}
    const value = rows.contextPressure?.val ?? {}
    const window = Number(value.contextWindow) || 0
    const used = Number(value.pressureTokens) || 0
    return window > 0 ? Math.round((used / window) * 100) : undefined
  } catch {
    return undefined
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ').trim()
}

function analyse(sessionId, options) {
  const dir = sessionDir(options.sessionsRoot, sessionId)
  if (dir === undefined) return { session: sessionId, missing: true }
  const log = join(dir, 'session.v3.jsonl.zstd')
  let events = []
  let modified = 0
  try {
    events = tailEvents(log)
    modified = statSync(log).mtimeMs
  } catch { /* лог ещё не создан */ }

  let running = false
  let compactions = 0
  let errors = 0
  let lastClient = ''
  let lastAssistant = ''
  let lastEvent = ''
  let lastError = ''
  for (const event of events) {
    lastEvent = event.type ?? lastEvent
    if (event.type === 'turn/start') running = true
    if (event.type === 'turn/end') running = false
    if (typeof event.type === 'string' && event.type.startsWith('compaction/')) compactions += 1
    if (typeof event.type === 'string' && event.type.includes('error')) errors += 1
    // упавший ход: turn/end с причиной error (например разъехавшийся порядок tool_calls)
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      errors += 1
      lastError = String(event.data.reason.error?.message ?? 'ошибка хода').slice(0, 200)
    }
    if (event.type === 'user/message') {
      const text = textOf(event.data?.content)
      if (text !== '') lastClient = text.slice(0, 200)
    }
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') lastAssistant = text.slice(0, 200)
    }
  }
  return { session: sessionId, modified, running, compactions, errors, lastError, lastClient, lastAssistant, lastEvent,
           pressure: pressure(sessionId, options.projections) }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** Состояние моста и сторожа: очередь входящих, карантин, пульс, тревоги. */
function bridgeStatus(options) {
  const state = readJson(options.bridgeState, {}) ?? {}
  const watch = readJson(options.bridgeWatch, {}) ?? {}
  const pending = Array.isArray(state.pending) ? state.pending : []
  const quarantine = Array.isArray(state.quarantine) ? state.quarantine : []
  const ages = pending.map((item) => Math.max(0, Math.round(Date.now() / 1000 - Number(item.at || 0))))
  return {
    cursor: state.cursor ?? 0,
    pending: pending.length,
    oldestPendingMinutes: ages.length > 0 ? Math.round(Math.max(...ages) / 60) : 0,
    quarantine: quarantine.length,
    delivered: state.delivered ?? 0,
    failed: state.failed ?? 0,
    heartbeatMinutes: state.at ? Math.round((Date.now() - Number(state.at)) / 60000) : undefined,
    bridgeAlerts: readJson(options.bridgeAlerts, []) ?? [],
    watch: {
      ok: watch.ok,
      at: watch.at,
      alerts: watch.alerts ?? [],
      receiverHeartbeatSeconds: watch.receiver_heartbeat_age_seconds,
      receiverFailures: watch.receiver_failures,
      receiverOffset: watch.receiver_offset,
    },
  }
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  const boardPath = join(options.outDir, 'board.json')
  const alertsPath = join(options.outDir, 'alerts.json')
  const seen = new Set()
  const gate = lifecycle.createGate('sessions-observer', { flush: () => {
    lifecycle.fsyncFile(boardPath)
    lifecycle.fsyncFile(alertsPath)
  } })

  const log = (text) => ctx.logger?.info?.(`sessions-observer: ${text}`)

  function scan() {
    const rows = []
    const alerts = []
    for (const client of clientSessions(options.bridgeState)) {
      const state = analyse(client.session, options)
      const idleMinutes = state.modified ? Math.round((Date.now() - state.modified) / 60000) : undefined
      const row = { ...client, ...state, idleMinutes }
      rows.push(row)
      if (state.missing) {
        alerts.push({ kind: 'session-missing', chat: client.chat, title: client.title, session: client.session })
      } else if (state.running && (idleMinutes ?? 0) >= options.stuckMinutes) {
        alerts.push({ kind: 'stuck', chat: client.chat, title: client.title, session: client.session, idleMinutes })
      } else if (state.errors > 0) {
        alerts.push({ kind: 'errors', chat: client.chat, title: client.title, session: client.session,
                      errors: state.errors, error: state.lastError })
      }
    }
    const bridge = bridgeStatus(options)
    if (bridge.quarantine > 0) {
      alerts.push({ kind: 'bridge-quarantine', title: 'мост', count: bridge.quarantine, session: 'bridge' })
    }
    if (bridge.heartbeatMinutes !== undefined && bridge.heartbeatMinutes >= 5) {
      alerts.push({ kind: 'bridge-stalled', title: 'мост', minutes: bridge.heartbeatMinutes, session: 'bridge' })
    }
    for (const item of bridge.watch.alerts ?? []) {
      alerts.push({ kind: `watch-${item.kind}`, title: 'сторож', session: 'watch', detail: item })
    }
    const fresh = alerts.filter((alert) => {
      const key = alert.session === 'bridge' || alert.session === 'watch'
        ? `${alert.kind}:${JSON.stringify(alert.detail ?? alert.count ?? '')}`
        : `${alert.kind}:${alert.session}:${alert.errors ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    let previous = []
    try { previous = JSON.parse(readFileSync(alertsPath, 'utf8')) } catch { previous = [] }
    // В файле держим только текущие тревоги: иначе вылеченная тревога висит в
    // сводке вечно. История остаётся в alerts-history.jsonl.
    const current = alerts.slice(0, 50)
    if (fresh.length > 0) {
      try {
        appendFileSync(join(options.outDir, 'alerts-history.jsonl'),
          `${JSON.stringify({ at: new Date().toISOString(), alerts: fresh })}\n`)
      } catch { /* история не критична */ }
    }
    mkdirSync(options.outDir, { recursive: true })
    writeFileSync(boardPath, `${JSON.stringify({ at: new Date().toISOString(), sessions: rows, bridge }, null, 1)}\n`)
    writeFileSync(alertsPath, `${JSON.stringify(current, null, 1)}\n`)
    return { rows, fresh, bridge, previous }
  }

  ctx.tools.register(defineTool({
    name: 'client_sessions_board',
    description: 'Сводка по клиентским сессиям: кто активен, кто ждёт, у кого ошибки, сколько занято '
      + 'контекста. Читает файл наблюдателя, ничего не меняет.',
    parameters: {
      limit: { type: 'integer', description: 'Сколько сессий показать, по умолчанию все.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute(args) {
      let board
      try {
        board = JSON.parse(readFileSync(boardPath, 'utf8'))
      } catch {
        return Promise.resolve({ text: 'Наблюдатель ещё не собрал сводку.' })
      }
      const rows = (board.sessions ?? []).slice(0, Number(args.limit) || undefined)
      const lines = rows.map((row) => {
        const state = row.missing ? 'сессии нет на диске' : (row.running ? 'работает' : 'ждёт')
        return `${row.title} (${row.chat}): ${state}, простой ${row.idleMinutes ?? '?'} мин, `
          + `контекст ${row.pressure ?? '?'} %, сжатий ${row.compactions ?? 0}, ошибок ${row.errors ?? 0}`
          + (row.lastClient ? `\n    клиент: ${row.lastClient.slice(0, 120)}` : '')
          + (row.lastAssistant ? `\n    агент: ${row.lastAssistant.slice(0, 120)}` : '')
      })
      let alerts = []
      try { alerts = JSON.parse(readFileSync(alertsPath, 'utf8')) } catch { alerts = [] }
      const bridge = board.bridge
      const bridgeLine = bridge === undefined ? '' : `\nМост: очередь ${bridge.pending}`
        + ` (старейшее ${bridge.oldestPendingMinutes} мин), карантин ${bridge.quarantine}`
        + `, доставлено ${bridge.delivered}, сбоев ${bridge.failed}`
        + `, пульс ${bridge.heartbeatMinutes ?? '?'} мин назад`
        + `, курсор ${bridge.cursor}`
        + (bridge.watch?.ok === false ? `\nСторож: ${(bridge.watch.alerts ?? []).map((a) => a.kind).join(', ')}` : '\nСторож: ок')
      const head = `Клиентских сессий: ${(board.sessions ?? []).length}, сводка от ${board.at}.${bridgeLine}`
      const alertText = alerts.length > 0
        ? `\n\nТревоги:\n${alerts.slice(0, 10).map((a) => `- ${a.kind}: ${a.title ?? a.session}${a.idleMinutes ? `, простой ${a.idleMinutes} мин` : ''}${a.minutes ? `, пульс ${a.minutes} мин` : ''}`).join('\n')}`
        : '\n\nТревог нет.'
      return Promise.resolve({ text: `${head}\n${lines.join('\n')}${alertText}` })
    },
  }))

  /** Разбудить сессию-контролёра: она сама разберётся и починит. */
  const wakes = []
  let healOffset = 0
  try { healOffset = statSync(options.healLog).size } catch { healOffset = 0 }

  async function healLines() {
    try {
      const size = statSync(options.healLog).size
      if (size <= healOffset) return []
      const text = readFileSync(options.healLog, 'utf8').slice(healOffset)
      healOffset = size
      return text.split('\n').filter((line) => line.trim() !== '').slice(-3)
    } catch {
      return []
    }
  }

  async function wakeController(text) {
    if (!options.wakeController || !text) return
    const now = Date.now()
    while (wakes.length > 0 && now - wakes[0] > 3600000) wakes.shift()
    if (wakes.length >= options.maxWakesPerHour) return
    const lookup = ctx.typert?.lookups?.get?.('agent')
    if (lookup === undefined) return
    const found = await lookup.resolve(options.controllerSession)
    const agent = found?.agent ?? found
    if (agent === undefined || typeof agent.followup !== 'function') return
    wakes.push(now)
    await agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'sessions-observer', form: 'notice', summary: 'наблюдатель' },
    }))
  }

  const timer = setInterval(() => { void gate.run(async () => {
    try {
      const { rows, fresh } = scan()
      if (fresh.length > 0) log(`тревоги: ${fresh.map((a) => a.kind).join(', ')}`)
      else log(`сессий ${rows.length}`)
      await (async () => {
        const lines = await healLines()
        const summary = []
        if (fresh.length > 0) summary.push(`тревоги: ${fresh.map((a) => `${a.kind}${a.title ? ' (' + a.title + ')' : ''}`).join(', ')}`)
        if (lines.length > 0) summary.push(`сторож: ${lines.join(' | ')}`)
        if (summary.length > 0) {
          await wakeController(`[наблюдатель] ${summary.join('; ')}. Проверь системы клиентских сессий и почини, если нужно.`)
        }
      })()
    } catch (error) {
      ctx.logger?.warn?.(`sessions-observer: ${String(error)}`)
    }
  }).catch(error => { if (error.code !== 'NODO_PAUSED') ctx.logger?.warn?.('observer tick failed') }) }, options.intervalMs)
  timer.unref?.()
  ctx.effect(() => () => { clearInterval(timer); return gate.pause() })
  void gate.run(() => { try {
    const { rows } = scan()
    log(`старт, клиентских сессий ${rows.length}`)
  } catch (error) {
    ctx.logger?.warn?.(`sessions-observer: ${String(error)}`)
  } }).catch(() => {})
}
