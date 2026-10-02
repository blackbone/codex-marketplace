# Changelog

## Dependency history and task graph

- Keep each task's dependency list when it closes: completion and
  cancellation write `blockers` to its history record, reopen restores them,
  and records closed before this read the task body's `## Dependencies`
  section. Dashboards show completed blockers instead of dropping them.
- Draw the task graph: **Graph** in the web dashboard, and **Graph** in the
  Claude Code pane (an SVG DAG on the desktop, a dependency list in the
  terminal) with active tasks and everything they depend on, the whole
  history, or one task's chain in focus.

## Editable, verified model profiles

- Edit model profiles in the dashboard settings (Claude Code pane and web):
  add, rename, remove, and choose model, effort, and description. A profile
  used by open tasks cannot be removed.
- Validate each profile's model and effort against the Claude CLI model list
  (the SDK `initialize` response, no model request), cached in
  `.todo/claude-models.json`; settings refuse a model outside the list.
- Refuse to start the runner (`start-blocked` with `profileProblems`) while any
  profile is invalid; the dashboard shows the problems with
  **Fix profiles** and **Start runner**.
- Save settings from the Claude Code pane without a running runner.

## Native dashboard mod

- Add a Claude Code mod (`mod/`, loaded through `hooks/hooks.json` `modules`)
  that draws the ToDo dashboard in a native pane (`/todo-dashboard`): the task
  table with every web column, header sorting, the web filter syntax with
  status and profile chips, pagination, task files, chat with reply, steer and
  continue, per-task and runner logs, and the settings form. Desktop also shows
  status tiles, a progress bar and worker lanes.
- Add a status-line summary, an attention band above the prompt, and toasts
  when a task fails, waits for input, or completes.
- Add `scripts/mod-api.mjs`, the mod's backend: reads reuse the web dashboard
  functions; task actions and settings writes go through the running dashboard.
- Cover the pane with `claude plugin test` (`mod/dashboard.test.tsx`) on the
  terminal and desktop surfaces.

## Sonnet and Opus profiles

- Built-in profiles use only Claude Sonnet 5.5 (`mini` low, `fast` medium,
  `standard` high, `medium` xhigh) and Opus 5.5 (`proven` medium, `advanced`
  high, `expert` xhigh, `ultra` max). Haiku and Fable remain selectable for
  custom profiles.
- `model_profiles` recognizes saved former Claude built-ins and offers their
  Sonnet and Opus replacements instead of keeping Haiku or Fable.

## Model effort availability

- Match the Codex fork's profile update guard: do not recommend a built-in
  profile at a lower effort when its declared effort is unavailable.
- Keep Claude model mappings unchanged; Sol 6.1 and Astra changes belong to the
  Codex executor.

## Claude Code fork

- Fork ToDo for Claude Code with the same `.todo/` state, tasks, pipelines,
  routing rules, MCP tools, dashboard, and profile names as the Codex plugin.
- Run background workers and pipeline agent steps through `claude -p` in
  stream-json mode with one Claude session per task, structured results,
  token usage, steering, and Codex sandbox modes mapped to Claude Code
  permission modes.
- Built-in profiles use Claude Haiku 4.5, Sonnet 5.5, Opus 5.5, and Fable 5.1;
  profiles are stored under `models.claude`.
- Claim repositories per host and resolve interactive run ownership from the
  Claude Code session hooks.
- Recognize the runner of a Windows repository opened through an 8.3 short
  path, so `runner_stop` no longer refuses it as unverified.
