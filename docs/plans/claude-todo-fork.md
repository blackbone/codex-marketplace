# План: Claude-форк ToDo и Claude-маркетплейс

Статус: черновик для обсуждения.

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
| Синхронизация форков | Без автоматической сверки; при каждом изменении ToDo — ручной агентный проход по функциональности второго форка |

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

Правка `AGENTS.md`: «имя записи в каталоге = имя в манифесте; каталог пакета совпадает с именем, кроме хостовых форков
`plugins/<name>-<host>/`, которые указываются в каталоге этого хоста».

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
| Хуки `session-context.mjs` | Вместо политики маршрутизации внедряется короткое сообщение: «репозиторий закреплён за <host>; ToDo здесь выключен, передать репозиторий можно через `todo:init`» |
| MCP | Изменяющие инструменты (`task_*`, `repo_init`, `runner_start`, `supervisor_bind` и т.д.) отказывают с кодом `HOST_MISMATCH`. Читающие (`todo_status`, `task_list`, `task_get`) работают |
| Демон | `ensureDaemon()` не запускается; живой демон чужого хоста не трогает. Сейчас из-за перезапуска по отпечатку рантайма они вытесняли бы друг друга |
| `daemon.json` | Хранит `host`; `manifestOwnsTodoDaemon()` проверяет свой манифест (`.codex-plugin` или `.claude-plugin`) и совпадение хоста |
| Claims задач | В claim пишется `host`; `readClaim` и восстановление claims игнорируют чужой хост |

Передача хоста (подхват): `repo_init` с `takeover: true` или отдельный инструмент `host_claim` / `host_release`.

- **Предусловия:**
  - нет живого демона или его удалось остановить через существующий `.daemon-stop.json` с ожиданием дренажа;
  - нет активных claims `running`/`interactive`;
  - merge queue пуста.
- **Действия:**
  - записывается `host`;
  - у всех задач `codexThread.state` помечается как `foreign`: повтор или reopen начинают новую сессию у нового хоста, без resume;
  - заново формируются профили моделей (раздел 3).
- **Без предусловий** инструмент возвращает список блокирующих задач. Принудительный вариант не делаем.

Тесты в обоих форках:
- отказ при чужом хосте (MCP и хуки);
- демон не стартует и не вытесняет чужой;
- подхват codex → claude и обратно;
- устаревший репозиторий без `host`.

## 2. Claude-форк: хост-интеграция

- **Манифест** `.claude-plugin/plugin.json`: `name: "todo"`, `version` (своя линейка, например `0.1.0+claude.<ts>`), `description`, `author`, `repository`, `license`.
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
| `codexCommand`, `codexSandbox` | `claudeCommand` (по умолчанию `claude`), `permissionMode` (`acceptEdits`/`dontAsk`), `allowedTools`; sandbox — через настройки Claude. Описать в README как поведение, чувствительное к безопасности |
| Каталог моделей из `codex` | статический каталог Claude (Opus/Sonnet/Haiku), проверка в preflight |
| Профили GPT | те же имена профилей (`mini`, `fast`, `medium`, `standard`, `advanced`, `expert`, `ultra`); модели и effort Claude |
| Usage app-server | usage из `result`-события stream-json (input, output, cache read/write tokens, стоимость, число ходов) → `execution-stats.mjs`, attempt ledger |
| Классификация ошибок | rate limit, overload, auth, превышение max-turns → `usage-recovery.mjs` |
| `codex-command` в preflight | `claude-command`: версия CLI, аутентификация, доступность модели |

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

## Открытые вопросы

1. Передача хоста: только явная (`todo:init` / `host_claim`) или автоматическая, когда репозиторий свободен (нет демона и claims)?
2. Версии форков: общая линейка или раздельные (`+codex.*` / `+claude.*`)?
3. Права воркеров Claude по умолчанию: `acceptEdits` плюс белый список инструментов или `bypassPermissions` внутри worktree?
