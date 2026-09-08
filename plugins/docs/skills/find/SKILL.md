---
name: find
description: Find relevant local documentation fragments by topic through the Docs plugin.
---

# Find documentation fragments

- Call `docs_search` with the requested topic as `query` and the absolute current working directory as `cwd`.
- Return the relevant fragments with their paths and line ranges.
- If needed, use `docs_read` with the same `cwd`, the returned `path`, `fromLine`, and `maxLines = toLine - fromLine + 1` to read only the matching range.
- If no results are found or search is unavailable, report that briefly.
