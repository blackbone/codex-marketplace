---
name: status
description: Open a small live Docs indexing dashboard showing registered projects, indexed file and fragment counts, active file paths, the waiting queue and a project documentation search form. Use when the user wants to see indexing progress or open the Docs status page.
---

# Open indexing status

1. Call `docs_dashboard` with the absolute current working directory as `cwd`. It returns a live local `url`; it also shows the current project when configured. An unconfigured folder can inspect registered projects without initializing anything.
2. Open that exact returned URL in the Codex in-app browser using the available browser or app open tool. If no browser-opening tool is available, provide a clickable link. Do not guess the port or reuse a URL from an earlier session.
3. Keep the response short. The page refreshes every two seconds and shows saved index counts, files being processed, and queued paths. Empty queues are not proof that every source is current. Service-offline queues are recovery state, not live work.

Opening the dashboard and its automatic status refresh only observe local state. The page also offers project selection and search with fragment text, paths and line ranges; explicitly submitting a search uses `docs_search` behavior and may start indexing or download the model. Do not initialize, reindex, restart the indexing daemon, or change watcher registrations just to show progress. It does not require hook trust or model downloads. Clicking a result path opens the document in the system default application. Results show section context, highlight the indexed source lines and offer the exact indexed fragment separately. Large sections can be expanded in full. The page server exits after two minutes without page requests.

CLI fallback: resolve `../../scripts/cli.mjs` against this skill directory and run `node <absolute-script> dashboard` from the user's current directory; open the returned `url`. `status` remains the CLI's one-shot freshness check.
