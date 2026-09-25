# Рабочая версия владельца vs репозиторий (2026-09-25)

## Что где лежит
- **Рабочее дерево владельца:** `~/NODO` — git-репозиторий (origin — локальная папка
  `~/Documents/Codex/2026-09-12/nfr/work/nodo-dev`), ветка `main`, версия **1.4.39**, 309 коммитов,
  последний 2026-09-18. Плюс ~115 незакоммиченных изменений (правки в `lib/`, `dsh-plugin.mjs`,
  `extension/client.js`, `main.cjs`, много новых заметок в `docs/`, папка `dev/`).
- **Установленная программа:** `~/Applications/NODO.app` → `NODO-versions/1.4.39`. Её код — между
  последним коммитом `~/NODO` и незакоммиченными правками (часть файлов в рабочем дереве уже новее).
- **Публичный репозиторий:** `origin/main` = экспорт приватного коммита `ea8b1e4` (release 1.4.0) без
  приватных частей. После него в `~/NODO` ещё **264 коммита** (183 файла, +23.5 тыс. строк).
- **Ветка `claude/nodo-hsrness-audit-gdh38c`:** 1.4.0 + исправления этапа 0/1 (24 файла кода, ~600 строк).

## Чего нет в репозитории
- `remote-relay/` (relay для Remote, 7 файлов, в т.ч. Cloudflare worker), `release-host/` (каталог релизов).
- `services/`: оригинальный `lifecycle-gate.cjs` (наш восстановленный отличается на ~47 строк), а также
  `telegram-bridge-live.mjs`, `sessions-observer.mjs`, `bridge-queue.mjs`, `calendar-watch.mjs`,
  `compaction-trigger.mjs`, `effort-router.mjs`, `tool-result-cap.mjs`, `periodic-gate.py`,
  `bridge-watch-*.py`.
- `lib/`: 34 новых модуля — «бесплатный контур» (`free-*`), экономия (`economy`, `session-economy`,
  `pricing`, `answer-limit`, `step-discipline`), восстановление провайдера (`provider-recovery`,
  `provider-transport`), клиентские сессии (`client-card`, `client-swap`, `bridge-inbound`), обновления
  (`update-attempts/cache/policy`), `workspace-paths`, `project-boot/discovery`, `read-only`,
  `resume-queue`, `session-log/status`, `judgment`, `remote-health/voice`, `instance-config` и др.
- `scripts/`: 33 скрипта — релизный конвейер (`release-package`, `publish-public`, `export-public`,
  `release-secret-gate`, `secret-leak-audit`), dev-утилиты (`nodo-dev/state/logs/switch/repeat`),
  аудиты экономии, `start-current-nodo.command`, `telegram-read.py`, `vk-factoscope-runner.sh`.
- `tests/`: 40 тестов к этим модулям; `rescue/WatchdogScope.swift`; `config/reaper.patch.yml`,
  `config/instance.local.json`.
- В общих файлах большие расхождения: `extension/client.js` (~1600 строк диффа), `dsh-plugin.mjs` (~760),
  `main.cjs` (~610), `remote-web/*`, `lib/environment.cjs`, `lib/links.cjs`, `lib/tasks.cjs`, `lib/cost-meter.cjs`.

## Что из исправлений ветки в рабочей версии ещё НЕТ (проверено grep)
Автоперезапуск/UTF-8 Codex, дедлайн и `Cancelled` задач, атомарная запись с fsync, `costRows` в
cost-meter, опечатка `sourcesCache` (в 1.4.39 всё ещё есть одно вхождение). То есть исправления ветки
актуальны и для 1.4.39.

## Живые находки на этом Mac
- NODO DEV собирается и стартует (`ready`), профиль и порты отдельные (4280-4283).
- DeepSeek в DEV: задача ушла, но все 5 повторов упали с `TRANSPORT` — `api.deepseek.com` с этого Mac
  сейчас не открывается вообще (DNS отдаёт 198.18.x.x — это адрес VPN Happ в режиме TUN, соединение
  висит). OpenAI и GitHub доступны. Это сеть, не код NODO.
- В `NODO DEV/tmp` скопилось 144 папки `nodo-*` от прошлых запусков — подтверждает пункт ROADMAP
  «чистка data/tmp при выходе».

## Предлагаемый план объединения (ждёт решения владельца)
**Вариант A (рекомендую): база — рабочая версия.**
1. Закоммитить незакоммиченные правки в `~/NODO` (отдельным коммитом «snapshot 2026-09-25»), ничего не удаляя.
2. Завести в `~/NODO` ветку `merge/audit-fixes` и перенести туда исправления этой ветки по одному
   (cherry-pick с ручной доводкой — код сильно разошёлся), каждый с тестом; `services/lifecycle-gate.cjs`
   НЕ переносить — остаётся оригинал.
3. Прогнать тесты рабочего дерева и собрать DEV.
4. Публичный репозиторий обновить через штатный `scripts/publish-public.cjs` (он сам вырезает приватное),
   дальше разработку вести от 1.4.39+.

**Вариант B: база — публичный репозиторий.** Переносить 264 коммита и приватные части в публичное дерево
вручную. Дольше и рискованнее, приватное легко утечёт в публичный репозиторий. Не рекомендую.

**Вариант C: ничего не объединять сейчас.** Продолжать ROADMAP в публичной ветке, а слить позже. Минус:
разрыв будет расти, и часть работы (экономия, восстановление провайдера) придётся делать повторно.
