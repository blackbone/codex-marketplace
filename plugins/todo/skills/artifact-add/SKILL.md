---
name: artifact-add
description: Attach chat images, files, code references, URLs, or text context to an existing unclaimed ToDo task. Use only when the user explicitly invokes $todo:artifact-add.
---

# ToDo Artifact Add

1. Require a full task ID or unique numeric prefix.
2. Map each attachment to the appropriate artifact kind: `image`, `file`, `code`, `url`, or `text`.
3. Add a concise label and explain what the worker must inspect.
4. Call `task_artifact_add`.
5. Do not modify a running task.
