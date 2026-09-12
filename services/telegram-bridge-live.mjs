/**
 * Telegram -> DSH: каждое новое сообщение клиента доезжает в его клиентскую
 * сессию. Сессия для незнакомого чата создаётся тем же инструментом, что и
 * остальные клиентские сессии; в существующую сообщение кладётся как обычное
 * сообщение переписки (ход модели по нему не открывается - отвечает владелец).
 *
 * Ничего не отправляет в Telegram: только читает ledger.
 *
 * Доставка durable: курсор журнала двигается вместе с приёмом сообщения в
 * очередь state.pending, доставка повторяется с backoff, после исчерпания
 * попыток сообщение уходит в карантин с текстом и тревогой. Сбой доставки
 * больше не теряет входящее.
 *
 * @module telegram-bridge
 */
import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dueItems, emptyState, ingest, normalizeState, onDelivered, onFailed } from './bridge-queue.mjs'
import lifecycle from './lifecycle-gate.cjs'

export const name = 'telegram-bridge'
export const inject = ['typert', 'sessions', 'tools']

const WORKSPACE = '/Users/nodo/Documents/ChatGPT/NODO Workspace'
const DEFAULTS = {
  journal: `${WORKSPACE}/.private/journal-bridge-v1/raw-journal`,
  helper: '/Users/nodo/.dsh/profiles/web/telegram-bridge-fetch.py',
  maker: '/Users/nodo/.dsh/plugins/telegram-bridge/make_session.py',
  sender: '/Users/nodo/.dsh/plugins/telegram-bridge/send_message.py',
  prompter: '/Users/nodo/.dsh/plugins/telegram-bridge/prompt_session.py',
  config: '/Users/nodo/.dsh/plugins/telegram-bridge/bridge-config.json',
  registry: '/Users/nodo/.dsh/plugins/telegram-bridge/chat-sessions.json',
  python: '/usr/bin/python3',
  state: '/Users/nodo/.dsh/plugins/telegram-bridge/state.json',
  intervalMs: 1500,
  ownerId: 0,
  limit: 200,
  maxPending: 500,
  heartbeatMs: 20000,
  fetchAlertMs: 300000,
  autoCapPerHour: 20,
}

/** Метка служебного сообщения моста: по ней отличаем авто-черновик от команды владельца. */
const AUTO_MARK = '[мост]'

function readState(path) {
  try {
    return { state: normalizeState(JSON.parse(readFileSync(path, 'utf8'))), note: '' }
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: emptyState(), note: '' }
    try {
      return { state: normalizeState(JSON.parse(readFileSync(`${path}.bak`, 'utf8'))), note: 'state-from-backup' }
    } catch {
      return { state: emptyState(), note: 'state-reset' }
    }
  }
}

/** Запись состояния атомарная: сначала временный файл, потом rename. */
function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  try {
    // Связки чат -> сессия: выигрывает более свежая запись (сборщик сессий пишет свой at).
    const fresh = readState(path).state
    const merged = { ...(fresh.chats ?? {}) }
    for (const [chat, value] of Object.entries(state.chats ?? {})) {
      const known = merged[chat]
      if (known === undefined || Number(value?.at ?? 0) >= Number(known?.at ?? 0)) merged[chat] = value
    }
    state.chats = merged
  } catch { /* текущий файл не читается: пишем как есть */ }
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 1)}\n`)
  try {
    if (existsSync(path)) copyFileSync(path, `${path}.bak`)
  } catch { /* резервная копия не критична */ }
  renameSync(temporary, path)
  lifecycle.fsyncFile(path)
}

/** Run one helper to completion without blocking the Host event loop. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    // Never terminate a sender with an unknown network outcome during shutdown.
    // A stalled helper keeps lifecycle drain pending and updater must abort/wait.
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`exit ${String(code)}: ${err.trim().slice(0, 300)}`))
      try {
        resolve(JSON.parse(out))
      } catch (error) {
        reject(new Error(`helper output is not JSON: ${String(error)}`))
      }
    })
  })
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config }
  const alertsPath = `${dirname(options.state)}/alerts.json`
  const alertsLog = `${dirname(options.state)}/alerts.jsonl`
  const { state, note } = readState(options.state)
  const instanceId = randomUUID()
  const ownerPath = `${dirname(options.state)}/owner.json`
  let busy = false
  let dirty = false
  let lastWrite = 0
  let lastFetchAlert = 0
  const gate = lifecycle.createGate('telegram-bridge', { flush: () => { save(true, true) } })

  /** Один активный экземпляр моста: иначе каждое сообщение доезжает дважды. */
  function readOwner() {
    try {
      const value = JSON.parse(readFileSync(ownerPath, 'utf8'))
      return typeof value?.id === 'string' && Number.isFinite(value.at) ? value : undefined
    } catch {
      return undefined
    }
  }
  function isOwner() {
    const owner = readOwner()
    if (owner === undefined || Date.now() - owner.at > 15000) {
      writeFileSync(ownerPath, JSON.stringify({ id: instanceId, at: Date.now(), pid: process.pid }))
      return true
    }
    if (owner.id !== instanceId) return false
    writeFileSync(ownerPath, JSON.stringify({ id: instanceId, at: Date.now(), pid: process.pid }))
    return true
  }

  const trace = (text) => {
    try {
      mkdirSync(dirname(options.state), { recursive: true })
      appendFileSync(`${dirname(options.state)}/bridge.log`, `${new Date().toISOString()} ${text}\n`)
    } catch { /* диагностика не должна ломать мост */ }
  }
  const log = (text) => { trace(text); ctx.logger?.info?.(text) }
  const warn = (text) => { trace(text); ctx.logger?.warn?.(text) }

  /** Тревога: строка в alerts.jsonl и последние 50 в alerts.json для наблюдателя. */
  function alert(kind, payload = {}) {
    const record = { at: new Date().toISOString(), kind, ...payload }
    try {
      mkdirSync(dirname(options.state), { recursive: true })
      appendFileSync(alertsLog, `${JSON.stringify(record)}\n`)
      let kept = []
      try { kept = JSON.parse(readFileSync(alertsPath, 'utf8')) } catch { kept = [] }
      writeFileSync(alertsPath, `${JSON.stringify([record, ...kept].slice(0, 50), null, 1)}\n`)
    } catch { /* тревога не должна ломать мост */ }
    warn(`тревога ${kind}: ${JSON.stringify(payload).slice(0, 300)}`)
  }

  function save(force = false, strict = false) {
    const now = Date.now()
    if (!force && !dirty && now - lastWrite < options.heartbeatMs) return
    try {
      state.at = now
      writeState(options.state, state)
      dirty = false
      lastWrite = now
    } catch (error) {
      if (strict) throw error
      warn(`состояние не сохранено: ${String(error)}`)
    }
  }

  /**
   * Канонический адрес сессии чата. Реестр пишут make_session и register_session,
   * мост его не перезаписывает, поэтому он главнее состояния.
   */
  function registryChats() {
    try {
      const value = JSON.parse(readFileSync(options.registry, 'utf8'))
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  async function sessionFor(message) {
    const chat = String(message.chat_id)
    const registered = registryChats()[chat]
    if (registered?.session) {
      if (state.chats[chat]?.session !== registered.session) {
        state.chats[chat] = { session: registered.session, title: registered.title || state.chats[chat]?.title || chat }
        dirty = true
        save(true)
        log(`сессия чата ${chat} взята из реестра: ${registered.session}`)
      }
      return { session: registered.session, created: false }
    }
    const known = state.chats[chat]
    if (known?.session !== undefined) return { session: known.session, created: false }
    const args = [options.maker, '--root', options.journal, '--chat', chat,
      '--owner-id', String(options.ownerId)]
    const made = await run(options.python, args)
    const created = (made.sessions ?? [])[0]
    if (created?.session === undefined) throw new Error(`сессия не создана: ${created?.adopted?.error ?? 'нет ответа'}`)
    state.chats[chat] = { session: created.session, title: created.title }
    dirty = true
    save(true)
    log(`создана сессия ${created.session} для «${created.title}» (${chat})`)
    return { session: created.session, created: true }
  }

  /** Идёт ли ход: пока идёт, дописывать сообщения нельзя - ломается порядок tool_calls. */
  function sessionBusy(session) {
    const log = session?.log
    if (!Array.isArray(log)) return false
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const type = log[index]?.type
      if (type === 'turn/end') return false
      if (type === 'turn/start') return true
    }
    return false
  }

  /** Сессия по идентификатору: сначала память harness, потом реестр агентов. */
  async function sessionOf(sessionId) {
    let session = ctx.sessions?.get?.(sessionId)
    if (session !== undefined) return session
    const lookup = ctx.typert.lookups.get('agent')
    const resolved = lookup === undefined ? undefined : await lookup.resolve(sessionId)
    return resolved?.session ?? resolved
  }

  async function deliver(message) {
    const { session: sessionId, created } = await sessionFor(message)
    // Новая сессия собирается из журнала вместе с этим сообщением: отдельно
    // его дописывать не нужно, иначе в переписке будет дубль.
    if (created) return sessionId
    let session = ctx.sessions?.get?.(sessionId)
    if (session === undefined) {
      const lookup = ctx.typert.lookups.get('agent')
      const resolved = lookup === undefined ? undefined : await lookup.resolve(sessionId)
      session = resolved?.session ?? resolved
    }
    if (session === undefined || typeof session.append !== 'function') throw new Error('сессия недоступна для записи')
    if (sessionBusy(session)) {
      // Ход ещё идёт: сообщение останется в очереди до его конца, иначе harness
      // получит user-сообщение между tool_calls и их результатами и запрос упадёт.
      const busy = new Error('ход ещё идёт, сообщение отложено')
      busy.busy = true
      throw busy
    }
    session.append('user/message', {
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user', rpcId: randomUUID(), clientTimeZone: 'Europe/Moscow' },
      role: 'user',
      id: randomUUID(),
    }, { surfaceOp: 'append' })
    trace(`доставлено: чат ${message.chat_id} -> ${sessionId}: ${JSON.stringify(message.text).slice(0, 60)}`)
    return sessionId
  }

  /** Настройки режима: читаются на каждом ходу, переключаются без перезапуска. */
  function bridgeConfig() {
    try {
      const value = JSON.parse(readFileSync(options.config, 'utf8'))
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  /** Текст служебного сообщения, по которому агент готовит черновик. */
  function autoTriggerText(item) {
    return `${AUTO_MARK} Новое сообщение от клиента «${item.title}»: ${item.text}\n`
      + 'Подготовь черновик ответа по правилам NODO Workspace и покажи его владельцу. Не отправляй: отправка только по его команде.'
  }

  /**
   * Круглосуточный авто-черновик: после доставки входящего просим harness
   * запустить ход модели в этой же сессии. Ключ идемпотентности - update_id,
   * поэтому повтор запроса не создаёт второй ход.
   */
  async function autoDraft(item, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const config = bridgeConfig()
    if (config.autoDraft === false) return
    // Чаты, где авто-черновик не нужен (служебные ленты и каналы уведомлений).
    const excluded = (config.autoDraftExclude ?? []).map((value) => String(value))
    if (excluded.includes(String(item.chat_id))) return
    const cap = Number(config.autoCapPerHour ?? options.autoCapPerHour) || 0
    const now = Date.now()
    const chats = { ...(state.autoAt ?? {}) }
    const recent = (chats[String(item.chat_id)] ?? []).filter((stamp) => now - Number(stamp) < 3600000)
    chats[String(item.chat_id)] = recent
    if (cap > 0 && recent.length >= cap) {
      const firstTime = recent.length === cap
      recent.push(now)
      state.autoAt = chats
      dirty = true
      if (firstTime) alert('auto-capped', { chat_id: item.chat_id, title: item.title, cap })
      return
    }
    if (sessionBusy(await sessionOf(sessionId))) return
    recent.push(now)
    state.autoAt = chats
    dirty = true
    try {
      const answer = await run(options.python, [options.prompter, '--session', sessionId,
        '--request-id', `bridge-${item.update_id}`, '--text', autoTriggerText(item),
        ...(options.harnessHost ? ['--host', String(options.harnessHost)] : [])])
      if (answer.ok !== true) {
        alert('auto-failed', { chat_id: item.chat_id, title: item.title, update_id: item.update_id,
                               error: String(answer.error ?? 'нет ответа').slice(0, 200) })
        return
      }
      state.autoDone = { ...(state.autoDone ?? {}), [String(item.update_id)]: now }
      const done = state.autoDone
      const keys = Object.keys(done)
      if (keys.length > 500) for (const key of keys.slice(0, keys.length - 500)) delete done[key]
      trace(`авто-черновик: чат ${item.chat_id} -> ${sessionId}`)
    } catch (error) {
      alert('auto-failed', { chat_id: item.chat_id, update_id: item.update_id, error: String(error).slice(0, 200) })
    }
  }

  /** Разносит очередь: сбой одной переписки не блокирует остальные. */
  async function drain(now) {
    const blocked = new Set()
    for (const item of dueItems(state, now)) {
      const chat = String(item.chat_id)
      if (blocked.has(chat)) continue
      try {
        const sessionId = await deliver(item)
        onDelivered(state, item.update_id)
        state.delivered += 1
        dirty = true
        await autoDraft(item, sessionId)
      } catch (error) {
        blocked.add(chat)
        if (error?.busy === true) continue
        const outcome = onFailed(state, item.update_id, String(error), Date.now())
        dirty = true
        if (outcome.quarantined) {
          alert('undelivered', {
            chat_id: item.chat_id, title: item.title, update_id: item.update_id,
            attempts: outcome.attempts, text: item.text, error: String(error).slice(0, 200),
          })
        } else if (outcome.attempts === 1) {
          alert('delivery-retry', {
            chat_id: item.chat_id, title: item.title, update_id: item.update_id,
            error: String(error).slice(0, 200),
          })
        }
      }
    }
  }

  /** Последнее сообщение владельца или служебное сообщение моста в сессии. */
  function lastUserMessage(session) {
    const log = session?.log
    if (!Array.isArray(log)) return undefined
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const event = log[index]
      if (event?.type !== 'user/message') continue
      const content = event.data?.content
      if (!Array.isArray(content)) return undefined
      return content.filter((part) => part?.type === 'text').map((part) => part.text).join(' ')
    }
    return undefined
  }

  /** Имя сессии из её журнала: по нему находим чат, если связки нет. */
  function sessionTitle(session) {
    const log = session?.log
    if (!Array.isArray(log)) return undefined
    for (let index = log.length - 1; index >= 0; index -= 1) {
      if (log[index]?.type === 'session/title') return log[index].data?.title
    }
    return undefined
  }

  /** Чат клиента, к которому привязана сессия: отвечать можно только в него. */
  function chatForSession(sessionId) {
    if (sessionId === undefined) return undefined
    const fromMemory = Object.entries(state.chats).find(([, value]) => value?.session === sessionId)
    if (fromMemory !== undefined) return Number(fromMemory[0])
    const registered = Object.entries(registryChats()).find(([, value]) => value?.session === sessionId)
    if (registered !== undefined) return Number(registered[0])
    const fresh = readState(options.state).state
    const found = Object.entries(fresh.chats).find(([, value]) => value?.session === sessionId)
    if (found !== undefined) return Number(found[0])
    // Сессию мог создать кто угодно: если её имя однозначно совпадает с именем
    // известного чата, считаем это тем же клиентом.
    const title = sessionTitle(ctx.sessions?.get?.(sessionId))
    if (!title) return undefined
    const candidates = [...new Set([...Object.entries(state.chats), ...Object.entries(fresh.chats),
      ...Object.entries(registryChats())])]
      .filter(([, value]) => value?.title === title)
    const chats = [...new Set(candidates.map(([chat]) => chat))]
    return chats.length === 1 ? Number(chats[0]) : undefined
  }

  // В профиле NODO инструмент telegram_reply уже регистрирует расширение RC
  // (deepseek-harness-rc-extension), поэтому здесь он не регистрируется - иначе
  // загрузка профиля падает с "tool telegram_reply is already registered".
  if (process.env.NODO_BRIDGE_REGISTER_REPLY === '1') ctx.tools.register(defineTool({
    name: 'telegram_reply',
    description: 'Отправить ответ клиенту в Telegram в тот чат, к которому привязана эта сессия. '
      + 'Вызывай, когда владелец сказал, что ответить клиенту. В аргументе - только текст ответа, без служебных пометок.',
    parameters: {
      text: { type: 'string', required: true, description: 'Текст ответа клиенту.' },
      repeat: {
        type: 'boolean',
        description: 'Отправить тот же текст повторно, даже если он уже уходил этому клиенту. '
          + 'Только по явной команде владельца повторить сообщение, по своей инициативе не ставить.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat_id: { type: 'number', required: true },
          message_id: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            required: true,
          },
          readback: { type: 'json', required: true },
          note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Отправлено в Telegram: чат ${value.chat_id}, message_id ${value.message_id}, readback ${value.readback}`
          + (value.note ? `\n${value.note}` : ''),
      }],
    },
    async execute(args, exec) { return gate.run(async () => {
      const sessionId = exec.agent?.session?.id
      const chat = chatForSession(sessionId)
      if (chat === undefined) throw new Error('эта сессия не привязана к чату клиента: отвечать некому')
      const config = bridgeConfig()
      if (config.autoSend !== true && lastUserMessage(ctx.sessions?.get?.(sessionId))?.startsWith(AUTO_MARK)) {
        throw new Error('это авто-черновик, а не команда владельца: отправка только после его слова в этой сессии')
      }
      const answer = await run(options.python, [options.sender, '--chat', String(chat), '--text', String(args.text ?? ''),
        ...(args.repeat === true ? ['--force'] : [])])
      if (answer.ok !== true) {
        const hint = answer.outcome === 'unknown'
          ? 'Исход отправки неизвестен: автоматически не повторяй - сначала проверь чат в Telegram, повтор только по явной команде владельца.'
          : 'Текст не ушёл: отправку можно повторить.'
        throw new Error(`${String(answer.error ?? 'отправка не удалась')}. ${hint}`)
      }
      let note = null
      if (answer.deduplicated === true) {
        note = `Повторно не отправлялось: этот же текст уже ушёл этому клиенту ${answer.previous_seconds ?? '?'} с назад (message_id ${answer.message_id}).`
      } else if (answer.readback !== true) {
        note = 'Telegram вернул сообщение, но подтверждение адресата и текста не сошлось - проверь чат.'
      }
      trace(`ответ: чат ${chat} -> message_id ${answer.message_id} readback=${answer.readback}`
        + `${answer.deduplicated === true ? ' (повтор отклонён)' : ''}`)
      return { chat_id: answer.chat_id, message_id: answer.message_id, readback: answer.readback, note }
    }) },
  }))

  async function tick() {
    if (busy) return
    if (!isOwner()) return
    busy = true
    try {
      const found = await run(options.python, [options.helper, '--root', options.journal, '--after', String(state.cursor),
        '--owner-id', String(options.ownerId), '--limit', String(options.limit)])
      const now = Date.now()
      const taken = ingest(state, found.messages ?? [], now, { maxPending: options.maxPending })
      if (taken.added > 0) dirty = true
      if (taken.capped === true) alert('backlog', { pending: state.pending.length, newest: taken.newest })
      await drain(now)
    } catch (error) {
      const now = Date.now()
      if (now - lastFetchAlert > options.fetchAlertMs) {
        lastFetchAlert = now
        alert('fetch-failed', { error: String(error).slice(0, 200), cursor: state.cursor })
      } else {
        warn(`чтение журнала: ${String(error)}`)
      }
    } finally {
      save()
      busy = false
    }
  }


  const runTick = () => gate.run(tick).catch(error => { if (error.code !== 'NODO_PAUSED') warn('bridge tick failed') })
  const timer = setInterval(runTick, options.intervalMs)
  timer.unref?.()
  ctx.effect(() => () => { clearInterval(timer); return gate.pause() })
  log(`telegram-bridge v10: слежу за ${options.journal}; очередь ${state.pending.length}, курсор ${state.cursor};`
    + ` авто-черновик ${bridgeConfig().autoDraft === false ? 'выключен' : 'включён'}`)
  if (note === 'state-reset') alert('state-reset', { state: options.state })
  if (note === 'state-from-backup') alert('state-from-backup', { state: options.state })
  void runTick()
  // Legacy selftest.txt can send a real message at startup. Never consume it.
}
