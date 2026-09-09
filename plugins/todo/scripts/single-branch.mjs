// Workspace policy for the existing runner; no executor or scheduling loop lives here.
import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync, lstatSync, readlinkSync, readdirSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { withExecutionRegistryLock } from "./git-worktree.mjs";

function fail(kind, message) { const e = new Error(message); e.kind = kind; throw e; }
function git(root, args, env = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env },
  });
  if (result.status !== 0) fail("single_branch_git", result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}
function location(root) {
  return realpathSync(path.resolve(root, git(root, ["rev-parse", "--git-common-dir"]).trim()));
}
function read(file, fallback = null) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback; }
function save(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
export function withRepositoryExecution(root, operation) {
  const common = location(root);
  return withExecutionRegistryLock(common, () => {
    const file = path.join(common, "todo-execution.json");
    return operation(read(file, { reservation: null }), value => save(file, value));
  });
}
export function singleBranchIdentity(root) {
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  if (!branch) fail("single_branch_detached", "single-branch requires a current local branch");
  return { branch, head: git(root, ["rev-parse", "HEAD"]).trim(), root: realpathSync(root) };
}
function fingerprint(root, name) {
  const file = path.join(root, name);
  let info;
  try { info = lstatSync(file); } catch (e) { if (e.code === "ENOENT") return "missing"; throw e; }
  if (!info.isFile() && !info.isSymbolicLink()) fail("single_branch_path", `Cannot safely attribute non-file path: ${name}`);
  return createHash("sha256").update(String(info.mode)).update(info.isSymbolicLink() ? readlinkSync(file) : readFileSync(file)).digest("hex");
}
function safePath(root, name) {
  if (typeof name !== "string" || !name || name.includes("\0") || path.isAbsolute(name) ||
      name.split(/[\\/]/).some(p => !p || p === "." || p === ".." || p === ".git" || p === ".todo")) {
    fail("single_branch_path", `Invalid task-owned file: ${JSON.stringify(name)}`);
  }
  let parent = path.dirname(path.join(root, name));
  while (!existsSync(parent)) parent = path.dirname(parent);
  const relative = path.relative(realpathSync(root), realpathSync(parent));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("single_branch_path", `Task path leaves the working copy: ${name}`);
  }
  return name;
}
export function workspaceSnapshot(root) {
  const names = new Set([
    ...git(root, ["diff", "--name-only", "-z", "--no-renames"]).split("\0"),
    ...git(root, ["diff", "--cached", "--name-only", "-z", "--no-renames"]).split("\0"),
    ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean));
  const files = Object.create(null);
  for (const name of [...names].sort()) {
    safePath(root, name);
    files[name] = { content: fingerprint(root, name), index: git(root, ["ls-files", "--stage", "-z", "--", name]) };
  }
  return { ...singleBranchIdentity(root), files };
}
function taskLocks(root) {
  const roots = git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0")
    .filter(s => s.startsWith("worktree ")).map(s => s.slice(9));
  return roots.flatMap(r => {
    const dir = path.join(r, ".todo");
    return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".md.lock")).map(n => path.join(dir, n)) : [];
  });
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}
export function activeSingleBranchExecutors(state) {
  return Object.entries(state.reservation?.executors || {}).filter(([, entry]) =>
    entry.uncertain || processAlive(entry.group && process.platform !== "win32" ? -entry.pid : entry.pid));
}
export function recordSingleBranchExecutor(root, taskPath, claim, kind, entry) {
  withRepositoryExecution(root, (state, saveState) => {
    const r = state.reservation;
    if (!r || r.taskPath !== realpathSync(taskPath)) return;
    if (read(`${taskPath}.lock`)?.token !== claim.token) fail("single_branch_ownership", "Executor claim changed");
    r.executors ||= {};
    if (entry) r.executors[kind] = entry;
    else if (!(r.executors[kind]?.group && processAlive(-r.executors[kind].pid))) delete r.executors[kind];
    saveState(state);
  });
}
function recoverClosedReservation(state) {
  const r = state.reservation;
  if (!r || existsSync(r.taskPath) || activeSingleBranchExecutors(state).length) return;
  const lockPath = `${r.taskPath}.lock`;
  const lock = read(lockPath);
  if (lock && processAlive(lock.pid)) return;
  const receipt = read(path.join(path.dirname(r.taskPath), "history", `${path.basename(r.taskPath, ".md")}.json`));
  if (!receipt || !["completed", "canceled"].includes(receipt.status) || receipt.git?.executionMode !== "single-branch") return;
  const identity = singleBranchIdentity(r.root);
  if (identity.branch !== r.baseline.branch) return;
  // History is the completion boundary; later user edits become the next baseline.
  if (lock) unlinkSync(lockPath);
  state.reservation = null;
}
// Called while the common Git-directory registry lock is held, before publishing a task claim.
export function reserveSingleBranch(root, taskPath, mode, state, { administrative = false, recover = false } = {}) {
  recoverClosedReservation(state);
  const reservation = state.reservation;
  if (reservation && reservation.taskPath !== realpathSync(taskPath)) {
    fail("single_branch_reserved", `Working copy is reserved by ${reservation.taskPath}; finish or recover that task first`);
  }
  if (mode !== "single-branch" && !reservation) return;
  if (recover === true && reservation?.executors) {
    for (const [kind, entry] of Object.entries(reservation.executors)) if (entry.uncertain) delete reservation.executors[kind];
  }
  const executors = activeSingleBranchExecutors(state);
  if (executors.length) fail("single_branch_executor_alive", `Previous executor may still be running: ${JSON.stringify(executors)}. Confirm it stopped before recovery`);
  const locks = taskLocks(root);
  if (locks.length) fail("single_branch_busy", `Repository executor is already active: ${locks.join(", ")}`);
  if (administrative && !reservation) return;
  if (reservation) {
    if (reservation.root !== realpathSync(root)) fail("single_branch_copy", `Resume in ${reservation.root}; automatic relocation is forbidden`);
    const snapshot = workspaceSnapshot(root);
    if (snapshot.branch !== reservation.baseline.branch) fail("single_branch_branch_changed", `Expected current branch ${reservation.baseline.branch}; found ${snapshot.branch}`);
    if (!recover && !reservation.checkpoint) {
      fail("single_branch_recovery_required", `Unreviewed working-copy changes for ${taskPath}. Inspect git status/diff, confirm the old executor stopped, then use task_retry to resume this task; no files were changed`);
    }
  } else {
    state.reservation = { root: realpathSync(root), taskPath: realpathSync(taskPath), baseline: workspaceSnapshot(root) };
  }
  state.reservation.checkpoint = null;
}
export function checkpointSingleBranch(root, taskPath, state, completed) {
  if (state.reservation?.taskPath !== path.join(realpathSync(path.dirname(taskPath)), path.basename(taskPath))) return;
  if (activeSingleBranchExecutors(state).length) state.reservation.checkpoint = null;
  else if (completed) state.reservation = null;
  else state.reservation.checkpoint = workspaceSnapshot(root);
}
export function singleBranchPlan(root, task) {
  const g = task.metadata.git;
  return { repoRoot: root, worktreePath: g.worktreePath, branch: g.branch,
    targetBranch: g.branch, claimToken: read(`${task.path}.lock`)?.token, executionMode: "single-branch", taskId: task.id, title: task.body.split("\n")[0].replace(/^#\s*/, "") };
}
function assertWorkspace(plan, reservation) {
  if (!reservation || reservation.taskPath !== realpathSync(path.join(plan.repoRoot, ".todo", `${plan.taskId}.md`))) fail("single_branch_ownership", "Task does not own the repository reservation");
  if (realpathSync(plan.repoRoot) !== reservation.root || realpathSync(plan.worktreePath) !== reservation.root) fail("single_branch_copy", `Use the original working copy: ${reservation.root}`);
  if (!plan.claimToken || read(`${reservation.taskPath}.lock`)?.token !== plan.claimToken) fail("single_branch_ownership", "Task execution claim changed or was released");
  if (activeSingleBranchExecutors({ reservation }).length) fail("single_branch_executor_alive", "An executor is still active; completion cannot start");
  const identity = singleBranchIdentity(plan.worktreePath);
  if (identity.branch !== plan.branch) fail("single_branch_branch_changed", `Expected current branch ${plan.branch}; found ${identity.branch}`);
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    const file = path.resolve(plan.worktreePath, git(plan.worktreePath, ["rev-parse", "--git-path", name]).trim());
    if (existsSync(file)) fail("single_branch_git_operation", `Resolve active Git operation ${name} without discarding work`);
  }
  return identity;
}
export function prepareSingleBranch(plan, expectedHead, reviewedTask = null) {
  return withRepositoryExecution(plan.repoRoot, state => {
    const identity = assertWorkspace(plan, state.reservation);
    if (expectedHead && identity.head !== expectedHead) fail("single_branch_head_changed", `HEAD changed from ${expectedHead} to ${identity.head}. After reviewing the manual commits, use task_retry with acceptCurrentHead set to the full current commit SHA`);
    if (reviewedTask?.metadata.git.ownedFiles) assertReviewedFiles(plan, reviewedTask);
    return { head: identity.head, reused: Boolean(expectedHead) };
  });
}
// Invalidate the workspace journal before publishing the new task base. The
// existing claim fences both writes; a crash leaves the old base blocked and
// the same explicit request can finish publishing its saved recovery receipt.
export function recoverSingleBranchHead(plan, task, expectedHead, publish, { automatic = false, reason = null } = {}) {
  return withRepositoryExecution(plan.repoRoot, (state, saveState) => {
    const identity = assertWorkspace(plan, state.reservation);
    if (!automatic && identity.head !== expectedHead) fail("single_branch_head_changed", `Reviewed HEAD ${expectedHead} is stale; current HEAD is ${identity.head}. Inspect it before retrying recovery`);
    if (!automatic && task.metadata.git.headRecoveries?.at(-1)?.toHead === identity.head && task.metadata.git.baseCommit === identity.head) return false;
    const previous = state.reservation.headRecovery;
    const receipt = !automatic && previous?.toHead === identity.head && previous.fromBaseCommit === task.metadata.git.baseCommit
      ? previous : { id: randomUUID(), at: new Date().toISOString(),
        fromBaseCommit: task.metadata.git.baseCommit, fromHeadCommit: task.metadata.git.headCommit || null,
        toHead: identity.head, previousPhase: task.metadata.git.phase, ...(automatic ? { automatic, reason } : {}) };
    const baseline = workspaceSnapshot(plan.repoRoot);
    if ((!automatic && baseline.head !== expectedHead) || baseline.branch !== plan.branch) fail("single_branch_head_changed", "HEAD or branch changed during recovery; inspect the current checkout before retrying");
    receipt.toHead = baseline.head;
    state.reservation.headRecovery = receipt;
    state.reservation.baseline = baseline;
    state.reservation.checkpoint = null;
    delete state.reservation.commit;
    saveState(state);
    publish(receipt);
    return true;
  });
}

export function singleBranchFiles(root, task, files) {
  if (task.metadata.git?.executionMode !== "single-branch") return;
  if (!Array.isArray(files) || files.some(f => typeof f !== "string")) fail("single_branch_files_required", "single-branch completion requires changedFiles: the exact repository-relative files intentionally changed and reviewed by this task (or [])");
  const recorded = Object.assign(Object.create(null), task.metadata.git.ownedFiles);
  for (const name of files) { safePath(root, name); recorded[name] = fingerprint(root, name); }
  task.metadata.git.ownedFiles = recorded;
}
function assertReviewedFiles(plan, task) {
  const owned = task.metadata.git.ownedFiles;
  if (!owned) fail("single_branch_files_required", "No reviewed changedFiles receipt; resume the task to report its files");
  const names = Object.keys(owned);
  for (const name of names) {
    safePath(plan.repoRoot, name);
    if (fingerprint(plan.repoRoot, name) !== owned[name]) fail("single_branch_unreviewed_changes", `File changed after task review: ${name}; review and report changedFiles again`);
  }
  return names;
}
export function verifySingleBranchDelivery(plan, task) {
  return withRepositoryExecution(plan.repoRoot, state => {
    const identity = assertWorkspace(plan, state.reservation);
    if (identity.head !== task.metadata.git.headCommit) fail("single_branch_head_changed", "Committed HEAD changed before completion");
    assertReviewedFiles(plan, task);
  });
}
export function assertSingleBranchCancellation(plan) {
  withRepositoryExecution(plan.repoRoot, state => {
    assertWorkspace(plan, state.reservation);
    if (JSON.stringify(workspaceSnapshot(plan.repoRoot)) !== JSON.stringify(state.reservation.baseline)) {
      fail("single_branch_unfinished_changes", "Cannot cancel: this task retains unfinished changes. Recover/finish it first; no files or caches were removed");
    }
  });
}
export function commitSingleBranch(plan, task) {
  return withRepositoryExecution(plan.repoRoot, (state, saveState) => {
    const reservation = state.reservation;
    const identity = assertWorkspace(plan, reservation);
    const expectedHead = task.metadata.git.baseCommit;
    const journal = reservation.commit;
    // Only recover the exact tree and unique message persisted before our commit.
    if (identity.head !== expectedHead) {
      if (!journal || git(plan.repoRoot, ["show", "-s", "--format=%P%n%T%n%B", "HEAD"]).trim() !== `${expectedHead}\n${journal.tree}\n${journal.message}`) {
        fail("single_branch_head_changed", `HEAD changed from ${expectedHead} to ${identity.head}; cannot attribute the commit. Review it, then use task_retry with acceptCurrentHead set to the full current commit SHA`);
      }
      const names = assertReviewedFiles(plan, task);
      if (names.length) git(plan.repoRoot, ["reset", "-q", identity.head, "--", ...names]);
      return { headCommit: identity.head, changed: true, recovered: true };
    }
    const names = assertReviewedFiles(plan, task);
    if (!names.length) return { headCommit: expectedHead, changed: false };
    // A private index preserves unrelated staged entries and commits only reviewed task paths.
    const message = `todo(${plan.taskId}): ${plan.title}\n\nToDo-Single-Branch: ${randomUUID()}`;
    // Compute the expected tree without touching the user's index.
    const common = location(plan.repoRoot);
    const index = path.join(common, `todo-index-${randomUUID()}`);
    const commitDir = path.join(common, `todo-commit-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" };
    try {
      git(plan.repoRoot, ["read-tree", expectedHead], env);
      git(plan.repoRoot, ["add", "-A", "--", ...names], env);
      const tree = git(plan.repoRoot, ["write-tree"], env).trim();
      assertReviewedFiles(plan, task);
      if (tree === git(plan.repoRoot, ["rev-parse", `${expectedHead}^{tree}`]).trim()) return { headCommit: expectedHead, changed: false };
      reservation.commit = { tree, message };
      saveState(state);
      // Run normal commit hooks in this working directory with a private HEAD.
      // Publish by compare-and-swap so an external commit cannot be overwritten
      // by a tree built from the earlier base. No checkout or worktree is created.
      mkdirSync(commitDir, { mode: 0o700 });
      writeFileSync(path.join(commitDir, "HEAD"), `${expectedHead}\n`);
      const commitEnv = { ...env, GIT_DIR: commitDir, GIT_COMMON_DIR: common, GIT_WORK_TREE: plan.repoRoot };
      git(plan.repoRoot, ["commit", "-m", message], commitEnv);
      const headCommit = git(plan.repoRoot, ["rev-parse", "HEAD"], commitEnv).trim();
      if (git(plan.repoRoot, ["show", "-s", "--format=%P%n%T%n%B", headCommit]).trim() !== `${expectedHead}\n${tree}\n${message}`) fail("single_branch_commit_changed", "Commit hooks changed the reviewed tree; inspect the preserved commit before continuing");
      assertReviewedFiles(plan, task);
      const current = assertWorkspace(plan, reservation);
      if (current.head !== expectedHead) fail("single_branch_head_changed", "HEAD advanced while preparing the task commit; review the retained changes");
      try {
        git(plan.repoRoot, ["update-ref", "-m", `todo(${plan.taskId}): publish reviewed commit`, `refs/heads/${plan.branch}`, headCommit, expectedHead]);
      } catch (error) {
        if (singleBranchIdentity(plan.repoRoot).head !== expectedHead) fail("single_branch_head_changed", "HEAD advanced while publishing the task commit; review the retained changes");
        throw error;
      }
      git(plan.repoRoot, ["reset", "-q", headCommit, "--", ...names]);
      return { headCommit, changed: true };
    } finally {
      // Only our disposable index, never project files or caches.
      if (existsSync(index)) unlinkSync(index);
      if (existsSync(commitDir)) rmSync(commitDir, { recursive: true });
    }
  });
}

export function singleBranchInstructions(task, root) {
  if (task.metadata.git?.executionMode !== "single-branch") return "";
  return `${task.metadata.nextAttemptTrigger === "workspace_refresh" ? "Concurrent edits or commits invalidated the previous review. Continue this same task from the retained implementation; review current files and rerun all configured checks, without redoing completed work from scratch. " : ""}${task.metadata.git.reviewFiles?.length ? `Previously changed task files to review and report again: ${JSON.stringify(task.metadata.git.reviewFiles)}. ` : ""}${task.metadata.nextAttemptTrigger === "head_recovery" ? "Recovery after explicitly accepting manual commits as the new HEAD. Inspect the retained implementation; do not redo completed work from scratch. Review the current diff, make only necessary remaining fixes, and rerun all configured checks. Previous validation is obsolete. " : ""}Repository execution mode: single-branch. Every edit, tool and validation must use ${root}, on current branch ${task.metadata.git.branch}. Never create/switch branches or worktrees, reset, clean, stash, or remove caches. For Unity, resolve the project inside this working copy and verify the Editor project path matches before any Editor command; stop on mismatch. Work from the current on-disk code, including staged, unstaged and untracked changes; a dirty copy is normal and does not block the task. Preserve unrelated edits. Return changedFiles with the exact repository-relative files intentionally changed by this task (including deletions), or []. For each listed path, review its complete current content and diff against HEAD: the runner commits the full current file, including pre-existing edits in that file, never an older HEAD or staged version. Do not restore a changed API to its committed version. Unlisted changes stay uncommitted and do not block completion. On recovery inspect the preserved diff before reporting files. Report all files changed by implementation, repair or generators after reviewing their final content.`;
}
export function singleBranchOutputSchema(schema, task) {
  if (task.metadata.git?.executionMode !== "single-branch") return schema;
  return { ...schema, properties: { ...schema.properties, changedFiles: { type: "array", items: { type: "string", minLength: 1 } } }, required: [...schema.required, "changedFiles"] };
}
export function executionCwd(root, relative, mode) {
  const cwd = path.resolve(root, relative);
  if (mode === "single-branch") {
    const rel = path.relative(realpathSync(root), realpathSync(cwd));
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail("single_branch_cwd", `Validation cwd leaves the working copy: ${cwd}`);
  }
  return cwd;
}
