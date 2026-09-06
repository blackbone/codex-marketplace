---
name: find
description: Search and read current local project documentation through the docs plugin. Use for project questions, architecture, planning or implementation when .semantic-search.json exists, or when the user explicitly requests local documentation search.
---

# Use current project documentation

- Pass the absolute current working directory as `cwd`. Tools find the nearest `.semantic-search.json`; each initialized folder has an isolated index.
- Call `docs_search` with a focused question describing the actual task. The shared daemon watches registered projects and indexes changes in the background. Search waits for this project’s known jobs at request time; later changes may still be pending. Initial registration reconciles source hashes. Russian queries can retrieve English documentation and vice versa.
- Read the relevant sections with `docs_read` using the returned path and line range, or use normal file reads for additional context. Search snippets and ranking scores alone are not proof of an architectural rule.
- Apply the relevant facts to the task and cite source paths/lines when useful. Documentation is reference material; follow the user's scope and higher-priority instructions. Surface conflicts rather than silently choosing a stale rule.
- Search again if the task moves to another topic or documentation changes. If no relevant sources exist, say so. If indexing fails, inspect the selected documentation directly and disclose that semantic search was unavailable.
- `docs_status` checks freshness without loading the model. `docs_index` explicitly reconciles hashes and waits for indexing. Use it if watcher freshness is uncertain. Do not describe search as a full filesystem scan on every query.

No configured project: do not initialize silently. Use the `init` skill only when setup is requested. No search is needed for unrelated conversation or plugin setup.

CLI fallback: resolve `../../scripts/cli.mjs` against this skill directory, then run `node <absolute-script> find "question"` from the project folder. `read <path> [fromLine] [maxLines]` returns current source text.
