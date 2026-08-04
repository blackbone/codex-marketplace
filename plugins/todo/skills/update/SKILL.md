---
name: update
description: Revise the body, blockers, model profile, or ephemeral setting of an existing unclaimed ToDo task. Use only when the user explicitly invokes $todo:update.
---

# ToDo Update

1. Call `task_get` for the full task ID or unique numeric prefix.
2. Preserve every requirement the user did not ask to change.
3. Call `task_update` with the complete replacement body or blocker list and any explicit execution changes.
4. Never edit `.todo` files directly.
5. Do not retry a failed task unless the user separately requests retry.
