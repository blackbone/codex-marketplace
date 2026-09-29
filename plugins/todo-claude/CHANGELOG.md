# Changelog

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
