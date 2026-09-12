/**
 * Логика очереди доставки входящих Telegram-сообщений в клиентские сессии.
 *
 * Чистые функции без ввода-вывода: их проверяет bridge-queue.test.mjs, мост
 * только применяет результат. Смысл: ни одно принятое сообщение клиента не
 * теряется из-за сбоя доставки. Курсор журнала двигается сразу (сообщение
 * лежит и в очереди, и в самом журнале), а доставка повторяется с backoff;
 * после исчерпания попыток сообщение уходит в карантин с текстом и тревогой.
 *
 * @module bridge-queue
 */

export const RETRY_DELAYS_MS = [15000, 60000, 300000, 900000]
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1
export const MAX_TEXT = 4000
export const MAX_QUARANTINE_TEXT = 1000
export const MAX_PENDING = 500
export const MAX_QUARANTINE = 200

export function emptyState() {
  return { cursor: 0, chats: {}, pending: [], quarantine: [], delivered: 0, failed: 0, at: 0 }
}

/** Приводит прочитанное состояние к известной форме, не теряя старых полей. */
export function normalizeState(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const state = { ...emptyState(), ...raw }
  state.cursor = Number(state.cursor) || 0
  state.chats = state.chats && typeof state.chats === 'object' ? state.chats : {}
  state.pending = Array.isArray(state.pending) ? state.pending.filter((item) => item && item.update_id) : []
  state.quarantine = Array.isArray(state.quarantine) ? state.quarantine.filter((item) => item && item.update_id) : []
  state.delivered = Number(state.delivered) || 0
  state.failed = Number(state.failed) || 0
  state.at = Number(state.at) || 0
  return state
}

function known(state, updateId) {
  const key = Number(updateId)
  return state.pending.some((item) => Number(item.update_id) === key)
    || state.quarantine.some((item) => Number(item.update_id) === key)
}

/**
 * Кладёт новые сообщения в очередь и двигает курсор. Если очередь уже
 * заполнена, курсор не двигается и сообщения остаются в журнале до разноса.
 */
export function ingest(state, messages, now, options = {}) {
  const maxPending = Number(options.maxPending) || MAX_PENDING
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.update_id && m.text) : []
  // Порядок источника не важен: раскладываем по update_id, чтобы курсор шёл
  // монотонно и ни одно сообщение не было пропущено.
  list.sort((a, b) => Number(a.update_id) - Number(b.update_id))
  const newest = list.reduce((max, m) => Math.max(max, Number(m.update_id) || 0), 0)
  let added = 0
  // Курсор двигается только по сообщениям, которые уже учтены: пройденные
  // (<= курсора) и лежащие в очереди повторно не берём, даже если источник
  // отдал их снова.
  let accounted = state.cursor
  for (const message of list) {
    const updateId = Number(message.update_id)
    if (updateId <= accounted) continue
    if (known(state, updateId)) {
      accounted = Math.max(accounted, updateId)
      continue
    }
    if (state.pending.length >= maxPending) {
      state.cursor = Math.max(state.cursor, accounted)
      return { added, capped: true, newest }
    }
    state.pending.push({
      update_id: updateId,
      chat_id: Number(message.chat_id),
      title: String(message.title ?? message.chat_id),
      text: String(message.text).slice(0, MAX_TEXT),
      attach: String(message.attach ?? ''),
      at: Number(message.at) || Math.round(now / 1000),
      attempts: 0,
      nextAt: now,
      lastError: '',
    })
    accounted = Math.max(accounted, updateId)
    added += 1
  }
  state.cursor = Math.max(state.cursor, accounted)
  return { added, capped: false, newest }
}

/** Элементы очереди, которым пора на доставку: по возрастанию update_id. */
export function dueItems(state, now) {
  return state.pending
    .filter((item) => Number(item.nextAt) <= now)
    .sort((a, b) => Number(a.update_id) - Number(b.update_id))
}

/** Доставлено: убрать из очереди. Возвращает убранный элемент. */
export function onDelivered(state, updateId) {
  const key = Number(updateId)
  const at = state.pending.findIndex((item) => Number(item.update_id) === key)
  if (at === -1) return undefined
  const [item] = state.pending.splice(at, 1)
  return item
}

/**
 * Доставка не удалась: попытка, backoff, после MAX_ATTEMPTS - карантин
 * (текст сохраняется, чтобы сообщение можно было вернуть руками).
 */
export function onFailed(state, updateId, error, now) {
  const key = Number(updateId)
  const item = state.pending.find((row) => Number(row.update_id) === key)
  if (item === undefined) return { attempts: 0, quarantined: false, nextAt: now }
  item.attempts = Number(item.attempts) + 1
  item.lastError = String(error ?? '').slice(0, 300)
  if (item.attempts >= MAX_ATTEMPTS) {
    const at = state.pending.indexOf(item)
    state.pending.splice(at, 1)
    state.quarantine.push({ ...item, text: String(item.text).slice(0, MAX_QUARANTINE_TEXT), quarantinedAt: now })
    while (state.quarantine.length > MAX_QUARANTINE) state.quarantine.shift()
    state.failed += 1
    return { attempts: item.attempts, quarantined: true, nextAt: now }
  }
  item.nextAt = now + RETRY_DELAYS_MS[Math.min(item.attempts, RETRY_DELAYS_MS.length) - 1]
  return { attempts: item.attempts, quarantined: false, nextAt: item.nextAt }
}

/** Сводка для сторожа и наблюдателя. */
export function summarize(state, now) {
  const ages = state.pending.map((item) => Math.max(0, Math.round(now / 1000 - Number(item.at || 0))))
  return {
    cursor: state.cursor,
    pending: state.pending.length,
    oldestPendingSeconds: ages.length > 0 ? Math.max(...ages) : 0,
    quarantine: state.quarantine.length,
    delivered: state.delivered,
    failed: state.failed,
    heartbeatAgeSeconds: state.at ? Math.max(0, Math.round((now - Number(state.at)) / 1000)) : null,
  }
}
