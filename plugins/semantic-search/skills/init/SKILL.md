---
name: init
description: Initialize semantic documentation search in the current folder. Briefly inspect likely documentation folders, ask the user which to use, and create local configuration. Use when the user asks to initialize or configure this plugin for a project.
---

# Initialize local documentation search

1. Use the current working directory as the initialization root. Do not silently change to the Git root or a different project. Pass its absolute path as `cwd` to each tool.
2. Call `repo_inspect`. Look at its bounded list of candidate folders and sample filenames; read a short sample only if needed to understand the layout.
3. Ask one concise question: which folders contain documentation? Suggest the observed candidates. Wait for the user's answer before choosing folders. If the user already explicitly supplied folders, use those without asking again.
4. Call `repo_init` with the selected relative `folders`. It writes only `.semantic-search.json` in the current folder and preserves existing configuration. If configuration already exists, inspect it and change it only when the user's request calls for that change.
5. Call `docs_index` to prepare the selected documents. First use downloads a pinned multilingual model and its runtime into a shared system temporary directory. Later instances reuse them. The project index is stored in `.semantic-search/index.sqlite`; its directory contains an ignore-all `.gitignore`. Hooks register session-owned watchers in the shared daemon. Report unsupported or skipped documents rather than claiming they were indexed.
6. Report the configured folders and index status. If setup fails, retain the valid config and report the actual failure; do not claim search is ready.

The plugin supplies the documentation-awareness hooks itself. Do not add instructions to AGENTS.md, install repository/global hooks, install global packages, or create a system service. If the host reports untrusted plugin hooks, explain that the user must review those hooks in Codex before automatic context injection can run; do not approve trust on the user's behalf.

If MCP tools are unavailable, use the bundled CLI from this skill's plugin root: `node ../../scripts/cli.mjs` (resolve the script to an absolute path, but keep the current project as the command's working directory). Commands: `inspect`, `init <folder...>`, `index`, `status`.
