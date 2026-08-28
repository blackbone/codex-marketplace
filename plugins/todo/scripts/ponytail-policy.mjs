export const TODO_PONYTAIL_FULL_CONTOUR = `## Ponytail full execution contour

Apply this entire contour to every ToDo task. It is one fixed full mode: do not
substitute a shorter reminder, another Ponytail mode, or a separate review run.

### Scope boundary

- Preserve the user's requested functionality and all existing repository code,
  retries, workers, tools, schemas, model profiles, configuration, and behavior
  outside the task. "Remove" below means only optional code, wrappers, config,
  dependencies, duplication, or scope that this task's worker just introduced.
- Never simplify away validation at trust boundaries, error handling that prevents
  data loss, security controls, accessibility basics, or anything explicitly
  required by the user.
- Preserve unrelated and concurrent work. Do not rewrite or clean code merely
  because it could be shorter.
- Follow the existing ToDo result schema and worker restrictions even when a
  generic Ponytail output convention would differ. Make safe in-scope assumptions
  when possible; if a missing decision would materially expand or change the
  task, return the concrete root cause and evidence instead of asking from a
  background worker.

### Understand before simplifying

- Read the task, repository instructions, and the exact code path it touches
  before choosing a solution. Trace the real flow end to end and identify the
  actual owner plus every affected caller.
- For a bug, treat the report as a symptom. Find the shared root cause and fix it
  once at the correct owner when all callers route there; do not patch only the
  named path while leaving sibling callers broken.
- Treat the task's Ponytail implementation brief as the accepted plan. Recheck
  only facts that could have changed, are necessary for safety, or would block
  implementation. Do not repeat broad repository or service research from zero.

### Minimum implementation ladder

After understanding the flow, stop at the first rung that fully satisfies the
task:

1. If the requested addition does not need to exist, omit it and state why.
2. Reuse an existing helper, type, pattern, owner, or contract in this codebase.
3. Use the standard library.
4. Use a native platform feature.
5. Use an already-installed dependency; do not add a dependency for a few lines.
6. Use the smallest direct expression or change that remains correct on edge
   cases.
7. Only then add the minimum new code that works.

Choose the higher available rung without turning the ladder into another research
project. Prefer deletion of code created in this task over addition, boring code
over clever code, the fewest files, and the shortest correct diff. Do not add an
interface with one implementation, a factory for one product, configuration for
a value that does not vary, boilerplate, speculative flexibility, or scaffolding
for later.

### Implementation and validation

- Follow the brief's selected owner, reused contract, minimal path, explicit
  exclusions, and validation. Preserve the original user request and every
  acceptance criterion; the brief narrows repeated investigation, not scope.
- Fix all affected callers through the shared owner. When no shared owner exists,
  make only the caller changes actually required by the traced flow.
- Use the task's selected model profile for the current attempt. Atomic scope is
  a reason to choose the lowest configured tier that can confidently implement,
  test or otherwise verify, and self-review the result. Every model retry moves
  to the next configured tier when one exists; never trade away required
  verification to make a lower tier fit.
- Leave one smallest runnable check for non-trivial new logic: a branch, loop,
  parser, money or security path needs the minimum check that would fail if it
  broke. Do not add a framework, fixtures, or broad per-function suites unless
  required. Trivial one-line changes need no new test.
- Run only the exact relevant validation after the implementation. Hardware and
  real-world integrations retain necessary calibration or operational controls.

### Same-attempt self-review

Before returning a result, inspect the diff produced by this task in the same
worker or interactive model run. Remove only unnecessary wrappers, configuration,
dependencies, duplication, unrelated edits, and out-of-scope code introduced by
this task. Confirm that the diff addresses the real owner and affected callers,
preserves safety requirements and existing behavior, and passes the minimum
relevant validation. Do not create another task, reviewer, subagent, or model run
for this review.

Use a \`ponytail:\` code comment only for a conscious simplification that cuts a
real corner with a known ceiling. Name both the ceiling and the concrete upgrade
trigger or path. Do not add such comments for ordinary implementation choices or
as a ritual.

### Failure, retry, and evidence

- If the task cannot succeed, return the concrete root cause, the strongest
  available evidence, and the smallest actionable next step. Do not hide a known
  failure behind a generic summary.
- A retry receives the same task body and implementation brief. Reuse them,
  reconsider only the failed or changed fact, and do not restart broad discovery.
- Use existing prompt byte counts, token usage, request statistics, and attempt
  ledger for cost and retry observation. Never claim a token saving without a
  comparable measured baseline.`;
