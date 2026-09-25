# NODO — рабочие правила для агентов (Claude Code, Codex)

NODO («nodo harness») — локальная macOS-оболочка (Electron) для работы с бизнес-проектами через
AI-агентов. Основная модель — **DeepSeek** (runtime DeepSeek Harness, DSH). Второй runtime — **Codex**
(Codex CLI app-server). Автор и владелец — Stanislav Galitskiy (GitHub `stgavs77-ctrl`).

**Перед началом любой работы прочитай:**
1. `docs/project/STATE.md` — текущее состояние, журнал сессий, что сделано и что дальше.
2. `docs/project/ROADMAP.md` — этапы и чек-листы (источник правды по приоритетам).
3. `docs/project/DECISIONS.md` — принятые решения и ограничения от владельца.
4. `docs/project/AUDIT-2026-09.md` — полный аудит с `file:line`, если задача связана с находкой.

**В конце сессии обнови** `docs/project/STATE.md` (журнал + «следующий шаг») и отметь пункты в
`ROADMAP.md`. Это единственная «память» между сессиями — облачные сессии эфемерны.

## Текущие рамки (от владельца, 2026-09-24)
- Провайдеры: только **DeepSeek** и **Codex**. Интеграцию Claude пока **не делать**.
- Задачи безопасности (CDP-порт, keyring для Codex, токены в логах, relay и т.п.) пока **не делать** —
  они собраны в этапе «Безопасность» в ROADMAP и ждут отдельного решения.
- Ничего не публиковать/не релизить без явной просьбы. Ветка разработки задаётся в задаче сессии.

## Карта кода
| Путь | Что это |
| --- | --- |
| `main.cjs` | Electron main: окно, запуск DSH и Codex, IPC `rc:call` (switch по методам), обновления |
| `preload.cjs` | Мост `window.rc` только для доверенных `http://127.0.0.1:{4180,4280,4380}` |
| `dsh-plugin.mjs` | Плагин внутри процесса DSH: супервизор, project runtime, lifecycle, инструменты |
| `extension/client.js` | UI NODO поверх клиента DSH (React через `h()`, вручную минифицирован, 78 КБ) |
| `lib/tasks.cjs` | Задачи DeepSeek (опрос `inspect`) и Codex (JSON-RPC, инструменты `rc_*`) |
| `lib/codex.cjs` | Адаптер Codex app-server (stdio JSON-RPC, автоперезапуск) |
| `lib/supervisor*.cjs` | Защита от зацикливания/застоя агента, классификация сообщений |
| `lib/context-engine.cjs`, `context-modes.cjs`, `project-runtime.cjs`, `project-brain.cjs` | Smart Context, режимы Economy/Balanced/Full, память проекта |
| `lib/cost-meter.cjs`, `usage.cjs`, `balance.cjs` | Учёт токенов и денег (сейчас только цены DeepSeek) |
| `lib/auto-router.cjs` | Выбор DeepSeek/Codex для запроса |
| `lib/updater*.cjs`, `release-signature.cjs`, `rescue/` | Подписанные обновления, откат, Rescue-приложение |
| `lib/remote-*.cjs`, `remote-web/` | Encrypted Remote (телефон через relay) |
| `services/lifecycle-gate.cjs` | Gate приостановки фоновых сервисов (восстановлен по контракту тестов) |
| `patches/`, `scripts/prepare-patches.cjs` | Точные по хэшу патчи DSH `0.1.5-rc.1` |
| `runtime-seed/`, `tools-seed/` | Закреплённые зависимости runtime (ставятся `npm run bootstrap`) |

Приватные части, которых **нет** в публичном репозитории: `services/telegram-bridge-live.mjs`,
`services/sessions-observer.mjs`, `scripts/start-current-nodo.command`, `scripts/export-public.cjs`,
`~/.dsh/plugins/telegram-bridge`. Не пытайся их выдумать; тесты, которым они нужны, пропускаются.

## Команды
```sh
npm test                 # node --test tests/*.test.cjs (на Linux часть тестов падает — см. ниже)
npm run inventory:check  # проверка sha256 в source-inventory.json
npm run inventory        # пересчитать source-inventory.json после правок исходников
npm run bootstrap        # только macOS arm64: runtime/, vendor/ (сеть, pinned-зависимости)
npm run build:dev        # build/NODO DEV.app с изолированным профилем
```
Ожидаемые падения на Linux/без runtime (не баги кода): тесты, которым нужен `runtime/node_modules`
(dev-isolation, feature-settings, remote-relay-host, remote-mobile, optional-services, tools-patches),
Swift/macOS (backup-scope, quit-electron-lifecycle, updater-cold-integration), `miniflare`
(remote-cloudflare). Три теста cost-meter зависят от времени суток — это известный баг (ROADMAP, этап 1).
Перед коммитом сравнивай список падений до/после своих правок — новых быть не должно.

## Стиль кода
- CommonJS (`.cjs`), без сборки и без зависимостей в корне. Код плотный, длинные строки — при правках
  сохраняй стиль окружающего кода, не переформатируй файлы целиком (дифф должен оставаться читаемым).
- Правки строк лучше делать точечной заменой уникального фрагмента; после правки — `node --check`.
- Любой исправленный баг — с регрессионным тестом в `tests/*.test.cjs` (`node:test`).
- После изменения исходников, перечисленных в `source-inventory.json`, запускай `npm run inventory`.
- Комментарии и коммиты — на английском; документация проекта в `docs/project/` — на русском.
