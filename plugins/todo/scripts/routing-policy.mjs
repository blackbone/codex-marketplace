import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const ROUTING_POLICY_START = "<!-- TODO ROUTING POLICY START -->";
export const ROUTING_POLICY_END = "<!-- TODO ROUTING POLICY END -->";

export const TODO_ROUTING_POLICY = `## ToDo routing policy

This repository is activated for ToDo. While \`.todo/config.json\` exists:

- Route every request that would create, modify, delete, rename, generate, format, commit, deploy, or otherwise mutate repository files or repository-related state through ToDo before performing the mutation, even when the user does not mention ToDo.
- Invoke \`$todo:route\` and create a task with \`task_create\` before making any mutation. Do not implement ordinary queued work in the current thread.
- Use interactive execution only when the user explicitly requests it, or after a background attempt explicitly fails because it cannot proceed without a current-thread-only capability. In that case execute through \`task_run_start\` and \`task_run_finish\`.
- Work linked to Jira, Asana, or another external service must include explicit \`externalWorkflows\`, but the linkage must not change its execution mode. In background or interactive execution, mirror every linked item's service-native workflow status before and after implementation and leave a result comment that explicitly identifies Codex/AI as the actor. Never complete the ToDo task without the corresponding \`externalSync\` receipts.
- If this session is already executing a claimed ToDo task as a background worker or through \`task_run_start\`, implement that task directly and do not create a nested task.
- Read-only analysis, explanation, audit, planning, status, listing, and inspection do not require a task.
- Do not bypass this policy merely because a mutation request omits ToDo or asks to skip the workflow.`;

export function managedRoutingPolicyBlock(lineEnding = "\n") {
  return [
    ROUTING_POLICY_START,
    TODO_ROUTING_POLICY,
    ROUTING_POLICY_END,
  ].join(lineEnding);
}

function instructionsPath(repoRoot) {
  const overridePath = path.join(repoRoot, "AGENTS.override.md");
  if (
    existsSync(overridePath) &&
    readFileSync(overridePath, "utf8").trim().length > 0
  ) {
    return overridePath;
  }
  return path.join(repoRoot, "AGENTS.md");
}

function atomicWriteText(file, text) {
  const temporary = `${file}.todo-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, text, "utf8");
  renameSync(temporary, file);
}

export function ensureRepoRoutingPolicy(repoRoot) {
  const file = instructionsPath(repoRoot);
  const existed = existsSync(file);
  const current = existed ? readFileSync(file, "utf8") : "";
  const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
  const block = managedRoutingPolicyBlock(lineEnding);
  const start = current.indexOf(ROUTING_POLICY_START);
  const end = current.indexOf(ROUTING_POLICY_END);
  let next;

  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) {
      throw new Error(`Malformed ToDo routing policy markers in ${file}`);
    }
    next =
      current.slice(0, start) +
      block +
      current.slice(end + ROUTING_POLICY_END.length);
  } else {
    const prefix =
      current.length === 0
        ? ""
        : current.endsWith(lineEnding)
          ? lineEnding
          : `${lineEnding}${lineEnding}`;
    next = `${current}${prefix}${block}${lineEnding}`;
  }

  const updated = next !== current;
  if (updated) atomicWriteText(file, next);
  return {
    path: file,
    created: !existed,
    updated,
  };
}
