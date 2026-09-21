---
name: change
description: Propose, semantically review and apply an Ori product-graph change with revision-bound review and conflict detection.
---

# Change the graph

Resolve the plugin's `scripts/ori` launcher two directories above this skill directory. Always pass `--root REPOSITORY` before the command. Read `graph`, search relevant intent with `find --query`, and expand explicit dependencies with `impact --ids` before editing the proposed graph.

Write a proposal JSON file outside the graph:

```json
{"intent":"Requested product change","baseRevision":"REVISION_FROM_GRAPH","operations":[{"path":"components/example.json","content":"COMPLETE_FILE_CONTENT"},{"path":"relations/obsolete.json","delete":true}]}
```

Paths are relative to the graph directory. `content` is the complete replacement file, including JSON encoding where relevant. Run `change propose --file PROPOSAL_FILE`. This validates a candidate and stores a draft without applying it.

Review the exact candidate against the user's request, affected components, typed relations, constraints and any new intent. A schema check cannot answer whether the product meaning remains consistent. If questions require the user, record them and ask for the missing information. Existing authorization to make a concrete change remains sufficient when its meaning is clear.

Submit `change review --id CHANGE_ID --file REVIEW_FILE` with:

```json
{"baseRevision":"PROPOSAL_BASE","proposalDigest":"PROPOSAL_DIGEST","reviewer":"Codex","summary":"Concrete semantic findings and checked constraints","approved":true,"questions":[]}
```

Use the proposal's exact returned digests. This receipt is a reviewer attestation, not proof of independent model review. Only approve when the review has actually been performed. Any unresolved questions keep the proposal waiting; a negative review rejects it.

When the reviewed change is within the user's authorized request and has no unresolved questions, run `change apply --id CHANGE_ID`. If the base changed, reconcile against the new graph and create a new proposal and review. Do not bypass conflict checks by editing graph files directly. Validate the applied graph and summarize its meaning and changed files; do not auto-commit.

See [the package documentation](../../README.md) for storage and source-execution boundaries.

On Windows PowerShell, use `scripts/ori.ps1` with the same arguments. The shell launcher and MCP/hooks require Git for Windows `sh.exe` on PATH.
