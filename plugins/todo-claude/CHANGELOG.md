# Changelog

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
