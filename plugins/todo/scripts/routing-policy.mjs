import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const ROUTING_POLICY_START = "<!-- TODO ROUTING POLICY START -->";
export const ROUTING_POLICY_END = "<!-- TODO ROUTING POLICY END -->";

export const TOOLING_OPERATION_POLICY = `Classify each operation by its purpose and effects, not just its file path or the fact that a plugin/tool is invoked.
- Perform Codex plugin and auxiliary tool installation, configuration, updates, diagnostics, tool connections, and creation or refresh of their service configurations, indexes, and caches directly, without creating a ToDo task. This includes service files inside the repository.
- Product code, project documentation, application dependencies, build, CI/CD, and deployment changes still require ToDo, even when performed through a plugin or described as "tooling setup". Developing a plugin as the repository's product is also a project change.
- Split mixed requests: perform tool setup directly and route project changes through ToDo. Complete prerequisite setup before publishing dependent project tasks; a setup failure must not publish tasks that depend on it.
- A user's request to configure a tool already authorizes that setup; do not ask for a separate routing confirmation. Preserve existing permission, access, authentication, and hook-trust requirements; never approve hook trust on the user's behalf.
- Examples: docs:init writing .semantic-search.json and indexing docs/ is direct; configuring another Codex plugin or MCP connection is direct; editing source code or docs/ through a plugin requires ToDo; changing a build pipeline or deployment under the label "tooling setup" requires ToDo; connecting a documentation search tool and then rewriting project documentation splits into direct setup and a ToDo documentation task.`;

export const WORKER_TOOLING_BOUNDARY = "The tooling exception does not expand a claimed worker's assigned task scope, repository access, permissions, or authority to create follow-up tasks. Perform tool setup only when required for the assigned task and already allowed by its restrictions; never use it to alter unrelated repositories, managed routing instructions, or .todo runtime state.";

export const TODO_ROUTING_POLICY = `## ToDo routing policy

This repository is activated for ToDo. While \`.todo/config.json\` exists:

${TOOLING_OPERATION_POLICY}

- Route project mutations (create, modify, delete, rename, generate, format, commit, deploy, or other changes to project files or project-related state) through ToDo before performing them, even when the user does not mention ToDo. Apply the purpose-based tooling exception above first.
- For project mutations, invoke \`$todo:route\`, complete its connector checks and \`task_preflight\`, then publish the complete atomic DAG with one \`task_batch_create\` before making those mutations. Prefer one independently implementable and verifiable outcome per task. Split lists, owners, runtime layers, and validation surfaces; batch only changes to the same files in one logical scope where splitting would create artificial conflicts or an invalid intermediate state. Use a one-item batch only for one genuinely atomic outcome. Choose the lowest configured model tier that can implement and self-review each task; when a repository pipeline is configured, its runner-owned shell gates provide authoritative validation. Do not implement ordinary queued work in the current thread.
- Use interactive execution only when the user explicitly requests it, or after a background attempt explicitly fails because it cannot proceed without a current-thread-only capability. In that case execute through \`task_run_start\` and \`task_run_finish\`.
- If this session is already executing a claimed ToDo task as a background worker or through \`task_run_start\`, implement that task directly. A background worker may create follow-up ToDo tasks only when the parent task records \`allowWorkerTaskCreation: true\`, which is permitted solely by an explicit user instruction. Never infer or propagate this permission.
- ${WORKER_TOOLING_BOUNDARY}
- Read-only analysis, explanation, audit, planning, status, listing, and inspection do not require a task.
- Do not bypass this policy merely because a mutation request omits ToDo or asks to skip the workflow.`;

export function managedRoutingPolicyBlock(lineEnding = "\n") {
  return [
    ROUTING_POLICY_START,
    TODO_ROUTING_POLICY.replaceAll("\n", lineEnding),
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

function updateRoutingPolicyFile(file, { existingOnly = false } = {}) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  const existed = stat !== undefined;
  if (stat?.isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked ToDo instruction file: ${file}`);
  }
  const current = existed ? readFileSync(file, "utf8") : "";
  const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
  const block = managedRoutingPolicyBlock(lineEnding);
  const start = current.indexOf(ROUTING_POLICY_START);
  const end = current.indexOf(ROUTING_POLICY_END);
  if (existingOnly && start < 0 && end < 0) {
    return { path: file, created: false, updated: false, skipped: "no-managed-block" };
  }
  let next;

  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start ||
        current.indexOf(ROUTING_POLICY_START, start + ROUTING_POLICY_START.length) >= 0 ||
        current.indexOf(ROUTING_POLICY_END, end + ROUTING_POLICY_END.length) >= 0) {
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

export function ensureRepoRoutingPolicy(repoRoot) {
  return updateRoutingPolicyFile(instructionsPath(repoRoot));
}

// Upgrade only blocks owned by ToDo. Never infer activation or rewrite user rules.
export function refreshRepoRoutingPolicy(repoRoot) {
  if (process.env.TODO_RUNNER_WORKER === "1") {
    return { updated: false, skipped: "claimed-worker", files: [] };
  }
  if (!existsSync(path.join(repoRoot, ".todo", "config.json"))) {
    return { updated: false, skipped: "not-activated", files: [] };
  }
  const files = ["AGENTS.md", "AGENTS.override.md"].map((name) => {
    const file = path.join(repoRoot, name);
    try {
      return updateRoutingPolicyFile(file, { existingOnly: true });
    } catch (error) {
      return { path: file, updated: false, error: error.message };
    }
  });
  return { updated: files.some((file) => file.updated), files };
}
