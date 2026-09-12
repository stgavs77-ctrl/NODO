#!/bin/bash
# Автономный запуск агента паблика «Фактоскоп».
# Запускается launchd-агентом com.nodo-optional.vk-factoscope (18:20 MSK ежедневно).
# Что делает: проверяет NODO и CDP, поднимает NODO если он закрыт, запускает
# headless-сессию DSH с заданием из скилла, пишет лог, при сбое кладёт уведомление.
#
# Ручной запуск: bash ~/.dsh/vk-factoscope-runner.sh
# Пробный прогон без модели: bash ~/.dsh/vk-factoscope-runner.sh --dry-run

set -uo pipefail

ROOT="$HOME/.dsh"
SKILL="$ROOT/skills/vk-factoscope"
WORK="$HOME/Downloads/vk-factoscope-post"
LOGDIR="$WORK/logs"
DSH_HOME_DIR="$HOME/Library/Application Support/NODO/dsh"
NODO_APP="$HOME/Applications/NODO.app"
DSH_BIN="$NODO_APP/Contents/Resources/project/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js"
NODE="$NODO_APP/Contents/Resources/project/runtime/node"
LOCK="$WORK/.runner.lock"
LOCK_OWNED=0
MAX_SECONDS=2700
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

mkdir -p "$LOGDIR"
STAMP="$(date '+%Y-%m-%d_%H%M%S')"
LOG="$LOGDIR/run-$STAMP.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*" | tee -a "$LOG"; }

note() {
  # Уведомление владельцу: macOS-баннер + строка в логе. Само по себе не критично.
  /usr/bin/osascript -e "display notification \"$1\" with title \"Фактоскоп\"" >/dev/null 2>&1 || true
}

finish() {
  [ "$LOCK_OWNED" = 1 ] && rmdir "$LOCK" 2>/dev/null
  log "завершено"
}
trap finish EXIT

# 1. защита от наложений
if ! mkdir "$LOCK" 2>/dev/null; then
  log "уже выполняется другой запуск - выход"
  exit 0
fi
LOCK_OWNED=1
log "старт запуска, лог: $LOG"

# 2. NODO и точка отладки
if ! curl -s -m 5 -o /dev/null "http://127.0.0.1:4182/json/version"; then
  log "NODO не отвечает на CDP - пробую открыть приложение"
  /bin/zsh "$NODO_APP/Contents/Resources/project/scripts/start-current-nodo.command" >/dev/null 2>&1 || log "открыть NODO не удалось"
  for i in $(seq 1 30); do
    sleep 5
    curl -s -m 5 -o /dev/null "http://127.0.0.1:4182/json/version" && break
  done
fi
if ! curl -s -m 5 -o /dev/null "http://127.0.0.1:4182/json/version"; then
  log "BLOCKED: CDP NODO недоступен, работа не начата"
  note "CDP NODO недоступен, публикации не будет"
  printf '%s BLOCKED: CDP NODO недоступен\n' "$(date '+%Y-%m-%d %H:%M %Z')" >> "$WORK/BLOCKED.txt"
  exit 1
fi
log "NODO на связи"

# 3. ключ модели
if [ ! -s "$ROOT/deepseek-api-key" ]; then
  log "BLOCKED: нет файла ключа $ROOT/deepseek-api-key"
  note "нет ключа модели, публикации не будет"
  exit 1
fi
export DEEPSEEK_API_KEY="$(cat "$ROOT/deepseek-api-key")"
export DSH_HOME="$DSH_HOME_DIR"

if [ "$DRY" = "1" ]; then
  log "DRY-RUN: проверки пройдены, модель не запускаю"
  exit 0
fi

# 4. задание агенту (режим зависит от часа запуска: утро - только замер и заготовка)
MODE="evening"
[ "$(date '+%H')" -lt 12 ] && MODE="morning"
TODAY="$(date '+%Y-%m-%d')"
TASK="$(sed -e "s/__DATE__/$TODAY/" -e "s/__MODE__/$MODE/" "$SKILL/agent-task.md")" || { log "BLOCKED: нет файла задания"; exit 1; }

cd "$WORK" || exit 1
log "режим $MODE, запускаю headless-сессию (лимит $((MAX_SECONDS / 60)) минут)"

"$NODE" "$DSH_BIN" --profile headless "$TASK" > "$LOG.out" 2> "$LOG.err" &
PID=$!
ELAPSED=0
while kill -0 "$PID" 2>/dev/null; do
  sleep 10
  ELAPSED=$((ELAPSED + 10))
  if [ "$ELAPSED" -ge "$MAX_SECONDS" ]; then
    log "лимит времени исчерпан - останавливаю сессию"
    # Do not kill a turn whose writes/sends have no confirmed drain.
    # Continue waiting; the installer sees this owned runner and refuses takeover.
    note "сессия Фактоскопа не уложилась в лимит"
    MAX_SECONDS=$((MAX_SECONDS + 2700))
  fi
done
wait "$PID"
CODE=$?
log "сессия завершилась, код $CODE"
log "ответ: $(tail -c 600 "$LOG.out" | tr '\n' ' ')"
[ -s "$LOG.err" ] && log "stderr хвост: $(tail -c 400 "$LOG.err" | tr '\n' ' ')"

# 5. уведомление о блокировке
if grep -qiE 'BLOCKED|капч|captcha|подтверд|MISSING_CREDENTIAL' "$LOG.out" "$LOG.err" 2>/dev/null; then
  note "нужна проверка: возможная блокировка VK"
fi

# 6. чистка старых логов (держим 60 прогонов)
ls -1t "$LOGDIR"/run-*.log* 2>/dev/null | tail -n +61 | xargs -r rm -f
exit 0
