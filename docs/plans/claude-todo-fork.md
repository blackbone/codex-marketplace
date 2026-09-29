# План: Claude-форк ToDo и Claude-маркетплейс

Статус: реализовано (этапы 1–4). Отличия от первоначального плана:

- исполнитель Claude сделан модулем `scripts/app-server-client.mjs` с тем же интерфейсом, что у клиента Codex app-server, поэтому демон и пайплайны в обоих форках почти совпадают;
- `workspace-write` отображается на `acceptEdits` плюс песочницу Claude Code с `failIfUnavailable` и пустым строгим списком сетевых доменов, а не на `bypassPermissions`: так правки через Edit/Write тоже ограничены worktree, и воркер работает под root;
- владелец интерактивной задачи определяется по родительскому PID: хуки записывают `session_id`/`prompt_id` в каталог данных плагина, а MCP-сервер той же сессии читает их по `process.ppid`;
- тесты форка, работающие с фейковым Codex app-server, заменены тестами исполнителя с фейковым `claude` и сквозными прогонами демона и пайплайна.

## Цель

- Маркетплейс `blackbone` устанавливается в Claude Code:
  `/plugin marketplace add blackbone/codex-marketplace` → `/plugin install todo@blackbone`.
- Под именем `todo` в Claude-каталоге ставится форк `plugins/todo-claude/`. Он работает с тем же состоянием репозитория:
  `.todo/config.json`, задачи, пайплайны, правила маршрутизации, ledger и дашборд. Задачи выполняет через Claude CLI и модели Claude.
- Codex-плагин `plugins/todo/` продолжает работать как раньше.
- С одним репозиторием в каждый момент работает **только один хост**. Хост закрепляется за репозиторием («host claim»).
  Закрепление и ограничение работы реализуются **в обоих форках**.
- Форк Claude «подхватывает» репозиторий, уже активированный Codex-версией: задачи, конфиг и история остаются на месте.

## Решения (согласованы)

| Вопрос | Решение |
|---|---|
| Имя | Каталог `plugins/todo-claude`, имя в манифесте и Claude-каталоге — `todo`. Правило в `AGENTS.md` меняется |
| Одновременная работа Codex и Claude | Запрещена; хост закрепляется за репозиторием |
| Синхронизация форков | Без автоматической сверки; при каждом изменении ToDo — ручной агентный проход по функциональности второго форка. Правило записано в `AGENTS.md`; `CLAUDE.md` импортирует его (`@AGENTS.md`) |
| Передача хоста | Автоматическая: репозиторий свободен, если PID из `.todo/daemon.json` не жив |
| Права воркеров Claude | Аналоги режимов песочницы Codex (раздел 3) |
| Профили моделей | Те же имена, что в Codex, с моделями Claude (раздел 3) |
| Версии | Каждый форк поднимает свою версию |

## Структура

```text
.agents/plugins/marketplace.json   Codex-каталог (без изменений: todo → ./plugins/todo)
.claude-plugin/marketplace.json    Claude-каталог (todo → ./plugins/todo-claude)
plugins/todo/                      Codex-форк (правки только для host claim)
plugins/todo-claude/               Claude-форк
  .claude-plugin/plugin.json       name "todo", displayName "ToDo"
  .mcp.json                        node ${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs
  hooks/hooks.json                 exec-форма, ${CLAUDE_PLUGIN_ROOT}
  skills/                          те же 17 skills, тексты под Claude
  scripts/                         копия рантайма с Claude-исполнителем
  assets/screenshots/, README.md, CHANGELOG.md
```

Правка `AGENTS.md` уже сделана: исключение для хостовых форков `plugins/<name>-<host>/`, раздел «Host forks»
(правки вносятся в оба форка, после них — агентный проход, host claim не ослаблять), валидаторы обоих хостов.

## 1. Host claim — в обоих форках

Состояние в `.todo/config.json`:

```json
{ "host": { "id": "claude", "claimedAt": "…", "pluginVersion": "…" } }
```

- Если поле `host` отсутствует, репозиторий считается закреплённым за `codex` (устаревшие репозитории).
- Каждый форк знает свой `HOST_ID` (константа в `lib.mjs`): `codex` или `claude`.

Поведение при чужом хосте (одинаковое в обоих форках):

| Точка | Поведение |
|---|---|
| Хуки `session-context.mjs` | Если демон чужого хоста жив, вместо политики маршрутизации внедряется короткое сообщение: «репозиторий занят <host> (PID <pid>); ToDo здесь выключен». Если не жив — хост забирается автоматически (ниже) |
| MCP | Изменяющие инструменты (`task_*`, `repo_init`, `runner_start`, `supervisor_bind` и т.д.) отказывают с кодом `HOST_MISMATCH`. Читающие (`todo_status`, `task_list`, `task_get`) работают |
| Демон | `ensureDaemon()` не запускается; живой демон чужого хоста не трогает. Сейчас из-за перезапуска по отпечатку рантайма они вытесняли бы друг друга |
| `daemon.json` | Хранит `host`; `manifestOwnsTodoDaemon()` проверяет свой манифест (`.codex-plugin` или `.claude-plugin`) и совпадение хоста |
| Claims задач | В claim пишется `host`; `readClaim` и восстановление claims игнорируют чужой хост |

Передача хоста (подхват) — автоматическая, по PID демона:

- **Проверка:** читается `.todo/daemon.json` (`readDaemonState()` в `lib.mjs`), жив ли процесс — существующие `liveDaemon()`
  и `processIsAlive()` в `ensure-daemon.mjs`. Если `host` в конфиге совпадает со своим, ничего не делается.
- **Демон чужого хоста жив** → репозиторий занят: изменяющие инструменты отказывают, в ответе указываются хост и PID.
- **Демон не жив** (файла нет или PID мёртв) → при первом хуке или MCP-вызове форк забирает репозиторий:
  - под существующим `.daemon-start.lock` записывает `host` и стартует свой демон;
  - устаревшие claims чужого хоста снимаются тем же путём, что и сейчас при восстановлении после падения демона;
  - у задач `codexThread.state` помечается как `foreign`: повтор или reopen начинают новую сессию у нового хоста, без resume;
  - задачи в merge queue продолжаются новым демоном: слияние выполняет git, не модель.
- Отдельных инструментов `host_claim` / `host_release` не нужно.

Тесты в обоих форках:
- отказ при чужом хосте (MCP и хуки);
- демон не стартует и не вытесняет чужой;
- подхват codex → claude и обратно при мёртвом PID; отказ при живом PID;
- устаревший репозиторий без `host`.

## 2. Claude-форк: хост-интеграция

- **Манифест** `.claude-plugin/plugin.json`: `name: "todo"`, `version` (своя, поднимается независимо от Codex-форка), `description`, `author`, `repository`, `license`.
- **`.mcp.json`:** `{"todo":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"],"env":{"PLUGIN_ROOT":"${CLAUDE_PLUGIN_ROOT}"}}}`.
- **Хуки:** `SessionStart`, `UserPromptSubmit`, `SubagentStart` → `session-context.mjs`; `Stop` → `interactive-stop.mjs`.
  Exec-форма (`command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/scripts/…"]`) работает и на Windows. Поля `commandWindows` и `additionalContextLimit` убраны.
- **Корень плагина** везде: `CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT || import.meta.url`. Отпечаток рантайма (`runtime-update.mjs`) считается по `.claude-plugin/`.
- **Лимит контекста:** не более 10 000 символов на `additionalContext`. Замерить текущий вывод (Ponytail contour — 5 402 символа
  плюс политика маршрутизации); при превышении разнести между SessionStart и UserPromptSubmit.
- **Владелец интерактивной задачи** (`execution-owner.mjs`): `threadId = session_id`, `turnId = prompt_id`.
  Хук `UserPromptSubmit` пишет `{session_id, prompt_id}` в `.todo/runtime/hosts/<session_id>.json`; skill `run` передаёт
  `${CLAUDE_SESSION_ID}` в `task_run_start`. `interactive-stop.mjs` сверяет `prompt_id`.
- **Skills:** вызовы `$todo:x` заменяются на `/todo:x`, «Codex» — на «Claude Code»; `agents/openai.yaml` удаляются.
  В `routing-policy.mjs` те же правки.
- `desktop-title.mjs` в форке не нужен и удаляется.

## 3. Claude-форк: исполнитель

Заменяемые модули и что в них:

| Codex | Claude-форк |
|---|---|
| `app-server-client.mjs` (JSON-RPC, постоянный thread) | `claude-client.mjs`: `claude -p --output-format stream-json --verbose --json-schema <schema> --model <id>`; первый ход с `--session-id <uuid>`, следующие — `--resume <uuid>` |
| `executionBackend: app-server | exec` | `session` (resume) и `oneshot` (без resume) |
| `codexCommand`, `codexSandbox` | `claudeCommand` (по умолчанию `claude`); `codexSandbox` читается как есть и отображается на аналоги Claude (таблица ниже) |
| Каталог моделей из `codex` | статический каталог Claude (Opus/Sonnet/Haiku), проверка в preflight |
| Профили GPT | те же имена профилей, модели Claude (таблица ниже) |
| Usage app-server | usage из `result`-события stream-json (input, output, cache read/write tokens, стоимость, число ходов) → `execution-stats.mjs`, attempt ledger |
| Классификация ошибок | rate limit, overload, auth, превышение max-turns → `usage-recovery.mjs` |
| `codex-command` в preflight | `claude-command`: версия CLI, аутентификация, доступность модели |

Права воркеров — аналоги режимов Codex (воркер Codex работает с `approvalPolicy: "never"`, т.е. без вопросов):

| `codexSandbox` | Claude-воркер |
|---|---|
| `read-only` | `--permission-mode dontAsk`, `--allowedTools` только читающие (Read, Grep, Glob, читающий Bash) |
| `workspace-write` (по умолчанию) | `--permission-mode bypassPermissions` плюс песочница Claude (`--settings` с `sandbox.enabled: true`): запись только в worktree задачи, сеть выключена |
| `danger-full-access` | `--permission-mode bypassPermissions` без песочницы |

Описать в README как поведение, чувствительное к безопасности. Доступность песочницы проверяется в preflight; без неё
`workspace-write` отказывает, а не расширяет права молча.

Профили — те же имена и роли, модели Claude (аналоги по уровню: Luna → Haiku, Sol → Sonnet, 5.6 Sol max → Opus, Astra → Fable):

| Профиль | Codex | Claude |
|---|---|---|
| `mini` | gpt-6-luna, low | `claude-haiku-4-5` |
| `fast` | gpt-6-luna, medium | `claude-haiku-4-5` |
| `standard` | gpt-6-sol, low | `claude-sonnet-5-5`, low |
| `medium` | gpt-6-sol, medium | `claude-sonnet-5-5`, medium |
| `proven` | gpt-6-sol, high | `claude-sonnet-5-5`, high |
| `advanced` | gpt-5.6-sol, max | `claude-opus-5-5`, max |
| `expert` | gpt-6-astra, xhigh | `claude-fable-5-1`, xhigh |
| `ultra` | gpt-6-astra, max | `claude-fable-5-1`, max |

Haiku 4.5 не поддерживает effort: `mini` и `fast` осознанно остаются на одной модели (решение согласовано), effort для них
не передаётся. Флаг effort в `claude -p` проверить при реализации.

- **Поле `metadata.codexThread`** в задаче не переименовывается (общий формат состояния). Добавляется `host`, по нему определяется, чей это поток.
- **Конфиг моделей:** блок `models` в `.todo/config.json` становится хост-зависимым: `models.codex` и `models.claude`.
  Корневой `models` читается как `models.codex` — это обратная совместимость, и правка нужна в обоих форках.
- **Пайплайны:** agent-шаги (`pipeline.mjs`) вызывают `claude-client` через тот же интерфейс шага; YAML-схема не меняется.
  `command` в шагах остаётся профилем, а не ID модели.

## 4. Маркетплейс, CI, документация

- `.claude-plugin/marketplace.json`: `name: "blackbone"`, `owner`, `plugins: [{ name: "todo", source: "./plugins/todo-claude", … }]`.
- `tests/marketplace.test.mjs`:
  - проверки Claude-каталога;
  - имя в манифесте `todo-claude` равно `todo`;
  - в Claude-хуках и `.mcp.json` нет `$PLUGIN_ROOT` и относительных путей.
- `package.json`: скрипты `test:todo-claude:*` по образцу существующих `test:*` для форка.
- `.github/workflows/test.yml`: `claude plugin validate --strict .` и `… plugins/todo-claude`, плюс Windows-задача для форка.
- README корня: таблица плагинов с колонкой хоста, установка для Claude.
- `docs/ARCHITECTURE.md`: хосты, форки, host claim.
- `plugins/todo-claude/README.md`: установка, host claim и передача хоста, модели, права и песочница, ограничения.
- Скриншоты форка: дашборд общий, можно переиспользовать и добавить скриншот передачи хоста.
- Codex-форк: поднять версию и добавить запись в CHANGELOG за правки host claim.

## Этапы (PR)

1. **Host claim в Codex-форке** плюс `models.codex` с обратной совместимостью. Небольшой, изолированный PR, безопасный для текущих пользователей.
2. **Каркас Claude-форка:** копия пакета, манифест, каталог, хуки, MCP, skills, host claim, интерактивный `run`.
   После него в Claude работают маршрутизация, создание задач, дашборд и интерактивное выполнение.
3. **Claude-исполнитель:** демон, повторы, usage, модели, preflight.
4. **Пайплайны, merge repair, Windows CI, документация**, итоговый агентный проход сверки функциональности обоих форков.

## Проверка

- `make test`; валидатор Codex для `plugins/todo`; `claude plugin validate --strict` для корня и `plugins/todo-claude`.
- Живой сценарий в тестовом репозитории:
  1. Codex-ToDo активирует репозиторий и создаёт задачу.
  2. Claude-ToDo видит чужой хост: хук сообщает об этом, `task_create` отказывает.
  3. Claude выполняет передачу хоста: Codex-демон дренируется, `host` меняется на `claude`.
  4. `/todo:route` → `task_preflight` → `task_batch_create` → демон выполняет задачу через `claude -p` → merge queue.
  5. `/todo:run` интерактивно; Stop освобождает claim.
  6. Codex-ToDo теперь видит чужой хост и отказывает.
- Результат живого прогона (запись экрана или скриншоты дашборда) приложить к PR этапов 2–3.
