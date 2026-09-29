// Workspace policy for the existing runner; no executor or scheduling loop lives here.
import { existsSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync, lstatSync, readlinkSync, readdirSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { withExecutionRegistryLock } from "./git-worktree.mjs";

function fail(kind, message) { const e = new Error(message); e.kind = kind; throw e; }
function git(root, args, env = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    windowsHide: true,
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", ...env },
  });
  if (result.status !== 0) fail("single_branch_git", result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}
function location(root) {
  // Callers supply a worktree root. Resolve Git's administrative files directly:
  // stale-claim polling must not launch git.exe on every daemon tick.
  const marker = path.resolve(root, process.env.GIT_DIR || ".git");
  let gitDir = marker;
  if (!statSync(marker).isDirectory()) {
    const match = /^gitdir: (.+)$/.exec(readFileSync(marker, "utf8").replace(/[\r\n]+$/, ""));
    if (!match) fail("single_branch_git", `Invalid Git directory pointer: ${marker}`);
    gitDir = path.resolve(path.dirname(marker), match[1]);
  }
  gitDir = realpathSync(gitDir);
  let common = gitDir;
  if (process.env.GIT_COMMON_DIR) {
    common = path.resolve(root, process.env.GIT_COMMON_DIR);
  } else {
    const file = path.join(gitDir, "commondir");
    let relative;
    try { relative = readFileSync(file, "utf8").replace(/[\r\n]+$/, ""); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (relative !== undefined) {
      if (!relative || /[\r\n\0]/.test(relative)) fail("single_branch_git", `Invalid Git common directory pointer: ${file}`);
      common = path.resolve(gitDir, relative);
    }
  }
  common = realpathSync(common);
  if (!statSync(common).isDirectory()) fail("single_branch_git", `Git common directory is not a directory: ${common}`);
  return common;
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
  let cursor = root;
  for (const part of name.split("/").slice(0, -1)) {
    cursor = path.join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail("single_branch_path", `Task path traverses a symlink: ${name}`);
  }
  let parent = path.dirname(path.join(root, name));
  while (!existsSync(parent)) parent = path.dirname(parent);
  const relative = path.relative(realpathSync(root), realpathSync(parent));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("single_branch_path", `Task path leaves the working copy: ${name}`);
  }
  return name;
}
// Discover only Git-registered gitlinks; never treat arbitrary directories as repositories.
function repositoryTree(root, prefix = "", result = Object.create(null)) {
  const top = realpathSync(root);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== top) fail("single_branch_path", `Invalid submodule checkout: ${prefix}`);
  const ref = git(root, ["rev-parse", "--symbolic-full-name", "HEAD"]).trim();
  result[prefix] = { root: top, head: git(root, ["rev-parse", "HEAD"]).trim(), ref, links: Object.create(null) };
  for (const entry of git(root, ["ls-files", "--stage", "-z"]).split("\0").filter(Boolean)) {
    const match = /^(160000) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const [, , head, stage, name] = match;
    safePath(root, name);
    if (stage !== "0") fail("single_branch_git_operation", `Unmerged submodule: ${prefix}${name}`);
    const child = path.join(root, name), key = prefix ? `${prefix}/${name}` : name;
    if (existsSync(child) && lstatSync(child).isSymbolicLink()) fail("single_branch_path", `Symlink submodule: ${key}`);
    result[prefix].links[name] = head;
    if (existsSync(path.join(child, ".git"))) repositoryTree(child, key, result);
  }
  return result;
}
function ownerRepository(root, name, repositories) {
  safePath(root, name);
  let key = "";
  for (const candidate of Object.keys(repositories)) if (candidate && name.startsWith(`${candidate}/`) && candidate.length > key.length) key = candidate;
  const repo = repositories[key], local = key ? name.slice(key.length + 1) : name;
  if (Object.keys(repo.links).some(link => local === link || local.startsWith(`${link}/`))) fail("single_branch_path", `Report files inside an initialized submodule, not its directory: ${name}`);
  let parent = path.dirname(path.join(repo.root, local));
  while (!existsSync(parent)) parent = path.dirname(parent);
  if (realpathSync(git(parent, ["rev-parse", "--show-toplevel"]).trim()) !== repo.root) fail("single_branch_path", `Unregistered nested repository: ${name}`);
  return { key, repo, local };
}
function repositoryHeads(repositories) {
  return Object.fromEntries(Object.entries(repositories).map(([key, repo]) => [key, { head: repo.head, ref: repo.ref, links: repo.links }]));
}
export function workspaceSnapshot(root) {
  const repositories = repositoryTree(root), files = Object.create(null);
  for (const [key, repo] of Object.entries(repositories)) {
    const names = new Set([
      ...git(repo.root, ["diff", "--ignore-submodules=none", "--name-only", "-z", "--no-renames"]).split("\0"),
      ...git(repo.root, ["diff", "--cached", "--ignore-submodules=none", "--name-only", "-z", "--no-renames"]).split("\0"),
      ...git(repo.root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ].filter(Boolean));
    for (const name of [...names].sort()) {
      safePath(repo.root, name);
      const full = key ? `${key}/${name}` : name;
      files[full] = { content: Object.hasOwn(repo.links, name) ? `gitlink:${repositories[full]?.head || "uninitialized"}` : fingerprint(repo.root, name),
        index: git(repo.root, ["ls-files", "--stage", "-z", "--", name]) };
    }
  }
  return { ...singleBranchIdentity(root), files, repositories: repositoryHeads(repositories) };
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
    fail("single_branch_reserved", `Working copy is reserved by ${reservation.taskPath}; finish or recover that task before starting another ToDo task. Local builds, tests, and previews without project edits run directly without a ToDo claim; they do not require releasing this reservation`);
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
  else {
    try {
      state.reservation.checkpoint = workspaceSnapshot(root);
      delete state.reservation.checkpointError;
    } catch (error) {
      // A snapshot failure must not keep a finished worker's claim alive.
      state.reservation.checkpoint = null;
      state.reservation.checkpointError = { kind: error.kind || "single_branch_snapshot", message: error.message };
    }
  }
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
    if (reviewedTask?.metadata.git.ownedFiles) {
      assertReviewedFiles(plan, reviewedTask);
      assertReviewedRepositories(plan, reviewedTask, state.reservation);
    }
    return { head: identity.head, reused: Boolean(expectedHead), repositories: state.reservation.baseline.repositories || repositoryHeads(repositoryTree(plan.repoRoot)) };
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
    receipt.repositories = baseline.repositories;
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
  const repositories = repositoryTree(root);
  for (const name of files) { ownerRepository(root, name, repositories); recorded[name] = fingerprint(root, name); }
  task.metadata.git.reviewedRepositories ||= repositoryHeads(repositories);
  task.metadata.git.ownedFiles = recorded;
}
function assertReviewedFiles(plan, task) {
  const owned = task.metadata.git.ownedFiles;
  if (!owned) fail("single_branch_files_required", "No reviewed changedFiles receipt; resume the task to report its files");
  const names = Object.keys(owned);
  const repositories = repositoryTree(plan.repoRoot);
  for (const name of names) {
    ownerRepository(plan.repoRoot, name, repositories);
    if (fingerprint(plan.repoRoot, name) !== owned[name]) fail("single_branch_unreviewed_changes", `File changed after task review: ${name}; review and report changedFiles again`);
  }
  return names;
}
function matchesJournal(root, head, journal) {
  return journal && git(root, ["show", "-s", "--format=%P%n%T%n%B", head]).trim() === `${journal.base}\n${journal.tree}\n${journal.message}`;
}
function assertReviewedRepositories(plan, task, reservation) {
  const current = repositoryTree(plan.repoRoot), reviewed = task.metadata.git.reviewedRepositories;
  if (!reviewed) {
    if (Object.keys(task.metadata.git.ownedFiles || {}).some(name => ownerRepository(plan.repoRoot, name, current).key)) {
      fail("single_branch_unreviewed_changes", "Saved submodule files require a fresh repository HEAD review; resume this same task and report changedFiles again");
    }
    return current;
  }
  if (JSON.stringify(Object.keys(current).sort()) !== JSON.stringify(Object.keys(reviewed).sort())) fail("single_branch_unreviewed_changes", "Registered submodule checkouts changed after review");
  for (const [key, repo] of Object.entries(current)) {
    const before = reviewed[key], journal = key ? reservation.submoduleCommits?.[key] : reservation.commit;
    for (const name of new Set([...Object.keys(before.links), ...Object.keys(repo.links)])) {
      if (repo.links[name] !== before.links[name] &&
          !(matchesJournal(repo.root, repo.head, journal) && git(repo.root, ["rev-parse", `${repo.head}:${name}`]).trim() === repo.links[name])) {
        fail("single_branch_unreviewed_changes", `Submodule index changed after review: ${key ? key + "/" : ""}${name}`);
      }
    }
    if (!key) continue; // Parent HEAD is checked by the existing task base/journal contract.
    if (repo.ref !== before.ref || (repo.head !== before.head && !(journal?.base === before.head && matchesJournal(repo.root, repo.head, journal)))) fail("single_branch_unreviewed_changes", `Submodule HEAD or branch changed after review: ${key}`);
  }
  return current;
}
export function verifySingleBranchDelivery(plan, task) {
  return withRepositoryExecution(plan.repoRoot, state => {
    const identity = assertWorkspace(plan, state.reservation);
    if (identity.head !== task.metadata.git.headCommit) fail("single_branch_head_changed", "Committed HEAD changed before completion");
    assertReviewedFiles(plan, task);
    assertReviewedRepositories(plan, task, state.reservation);
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
// One independently journaled commit per repository, deepest submodule first.
function commitRepository({ root, expectedHead, names, plan, verify, checkIdentity, getJournal, setJournal }) {
  function reconcileIndex(head, journal) {
    if (!names.length) return;
    const current = git(root, ["ls-files", "--stage", "-z", "--", ...names]);
    // Do not erase staging performed after our private-index commit started.
    if (journal.indexBefore !== undefined && current !== journal.indexBefore) {
      const expected = git(root, ["ls-tree", "-rz", head, "--", ...names]).split("\0").filter(Boolean)
        .map(row => row.replace(/^(\d+) \w+ ([a-f0-9]+)\t/, "$1 $2 0\t")).join("\0");
      if (current !== (expected ? expected + "\0" : "")) fail("single_branch_unreviewed_changes", "Task index changed during commit; preserved concurrent staging");
      return;
    }
    git(root, ["reset", "-q", head, "--", ...names]);
  }
  const journal = getJournal();
  const identity = checkIdentity();
  // Only recover the exact tree and unique message persisted before our commit.
  if (identity.head !== expectedHead) {
    if (!journal || git(root, ["show", "-s", "--format=%P%n%T%n%B", "HEAD"]).trim() !== `${expectedHead}\n${journal.tree}\n${journal.message}`) {
      fail("single_branch_head_changed", `HEAD changed from ${expectedHead} to ${identity.head}; cannot attribute the commit. Review it, then use task_retry with acceptCurrentHead set to the full current commit SHA`);
    }
    verify();
    reconcileIndex(identity.head, journal);
    return { headCommit: identity.head, changed: true, recovered: true };
  }
  verify();
  if (!names.length) return { headCommit: expectedHead, changed: false };
  const indexBefore = git(root, ["ls-files", "--stage", "-z", "--", ...names]);
  // A private index preserves unrelated staged entries and commits only reviewed task paths.
  const message = `todo(${plan.taskId}): ${plan.title}\n\nToDo-Single-Branch: ${randomUUID()}`;
  // Compute the expected tree without touching the user's index.
  const common = location(root);
  const index = path.join(common, `todo-index-${randomUUID()}`);
  const commitDir = path.join(common, `todo-commit-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" };
  try {
    git(root, ["read-tree", expectedHead], env);
    git(root, ["add", "-A", "--", ...names], env);
    const tree = git(root, ["write-tree"], env).trim();
    verify();
    if (tree === git(root, ["rev-parse", `${expectedHead}^{tree}`]).trim()) return { headCommit: expectedHead, changed: false };
    setJournal({ base: expectedHead, tree, message, indexBefore });
    // Run normal commit hooks in this working directory with a private HEAD.
    // Publish by compare-and-swap so an external commit cannot be overwritten
    // by a tree built from the earlier base. No checkout or worktree is created.
    mkdirSync(commitDir, { mode: 0o700 });
    writeFileSync(path.join(commitDir, "HEAD"), `${expectedHead}\n`);
    const commitEnv = { ...env, GIT_DIR: commitDir, GIT_COMMON_DIR: common, GIT_WORK_TREE: root };
    git(root, ["commit", "-m", message], commitEnv);
    const headCommit = git(root, ["rev-parse", "HEAD"], commitEnv).trim();
    if (git(root, ["show", "-s", "--format=%P%n%T%n%B", headCommit]).trim() !== `${expectedHead}\n${tree}\n${message}`) fail("single_branch_commit_changed", "Commit hooks changed the reviewed tree; inspect the preserved commit before continuing");
    verify();
    const current = checkIdentity();
    if (current.head !== expectedHead) fail("single_branch_head_changed", "HEAD advanced while preparing the task commit; review the retained changes");
    try {
      git(root, ["update-ref", "-m", `todo(${plan.taskId}): publish reviewed commit`, identity.ref, headCommit, expectedHead]);
    } catch (error) {
      if (checkIdentity().head !== expectedHead) fail("single_branch_head_changed", "HEAD advanced while publishing the task commit; review the retained changes");
      throw error;
    }
    reconcileIndex(headCommit, getJournal());
    return { headCommit, changed: true };
  } finally {
    // Only our disposable index, never project files or caches.
    if (existsSync(index)) unlinkSync(index);
    if (existsSync(commitDir)) rmSync(commitDir, { recursive: true });
  }

}
export function commitSingleBranch(plan, task) {
  return withRepositoryExecution(plan.repoRoot, (state, saveState) => {
    const reservation = state.reservation;
    assertWorkspace(plan, reservation);
    const repositories = assertReviewedRepositories(plan, task, reservation);
    const names = assertReviewedFiles(plan, task), groups = new Map();
    for (const name of names) {
      const { key, local } = ownerRepository(plan.repoRoot, name, repositories);
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(local);
      let child = key;
      while (child) {
        const parent = Object.keys(repositories).filter(k => k !== child && (!k || child.startsWith(`${k}/`))).sort((a,b) => b.length-a.length)[0];
        if (!groups.has(parent)) groups.set(parent, new Set());
        groups.get(parent).add(parent ? child.slice(parent.length+1) : child);
        child = parent;
      }
    }
    if (!groups.has("")) groups.set("", new Set());
    for (const [key, paths] of groups) {
      const repo = repositories[key];
      for (const name of paths) if (Object.hasOwn(repo.links, name)) {
        const base = key ? task.metadata.git.reviewedRepositories[key].head : task.metadata.git.baseCommit;
        const baseLink = git(repo.root, ["ls-tree", base, "--", name]).trim().split(/\s+/)[2];
        const child = repositories[key ? `${key}/${name}` : name];
        if (repo.links[name] !== baseLink && repo.links[name] !== child?.head) fail("single_branch_unreviewed_changes", `Preserved foreign staged gitlink: ${name}`);
      }
    }
    const verify = () => { assertWorkspace(plan, reservation); assertReviewedFiles(plan, task); assertReviewedRepositories(plan, task, reservation); };
    let result;
    for (const key of [...groups.keys()].sort((a,b) => b.length-a.length)) {
      const repo = repositories[key];
      const expectedHead = key ? task.metadata.git.reviewedRepositories[key].head : task.metadata.git.baseCommit;
      const getJournal = () => key ? reservation.submoduleCommits?.[key] : reservation.commit;
      result = commitRepository({ root: repo.root, expectedHead, names: [...groups.get(key)].sort(), plan, verify,
        checkIdentity: () => {
          verify();
          const current = repositoryTree(plan.repoRoot)[key];
          if (!current || current.ref !== repo.ref) fail("single_branch_unreviewed_changes", `Repository branch changed: ${key}`);
          for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
            if (existsSync(path.resolve(repo.root, git(repo.root, ["rev-parse", "--git-path", name]).trim()))) fail("single_branch_git_operation", `Resolve active Git operation in ${key || "."}: ${name}`);
          }
          return current;
        }, getJournal, setJournal: journal => {
          if (key) { reservation.submoduleCommits ||= {}; reservation.submoduleCommits[key] = journal; }
          else reservation.commit = journal;
          saveState(state);
        } });
    }
    return result;
  });
}

export function singleBranchInstructions(task, root) {
  if (task.metadata.git?.executionMode !== "single-branch") return "";
  return `${task.metadata.nextAttemptTrigger === "workspace_refresh" ? "Concurrent edits or commits invalidated the previous review. Continue this same task from the retained implementation; review current files and rerun all configured checks, without redoing completed work from scratch. " : ""}${task.metadata.git.reviewFiles?.length ? `Previously changed task files to review and report again: ${JSON.stringify(task.metadata.git.reviewFiles)}. ` : ""}${task.metadata.nextAttemptTrigger === "head_recovery" ? "Recovery after explicitly accepting manual commits as the new HEAD. Inspect the retained implementation; do not redo completed work from scratch. Review the current diff, make only necessary remaining fixes, and rerun all configured checks. Previous validation is obsolete. " : ""}Repository execution mode: single-branch. Every edit, tool and validation must use ${root}, on current branch ${task.metadata.git.branch}. Never create/switch branches or worktrees, reset, clean, stash, or remove caches. For Unity, resolve the project inside this working copy and verify the Editor project path matches before any Editor command; stop on mismatch. Work from the current on-disk code, including staged, unstaged and untracked changes; a dirty copy is normal and does not block the task. Preserve unrelated edits. Return changedFiles with the exact repository-relative files intentionally changed by this task (including deletions), or []. For registered submodules report the full parent-relative file paths, never the submodule directory itself; review their current HEAD and diffs too. The runner commits each submodule before its parent gitlink. For each listed path, review its complete current content and diff against HEAD: the runner commits the full current file, including pre-existing edits in that file, never an older HEAD or staged version. Do not restore a changed API to its committed version. Unlisted changes stay uncommitted and do not block completion. On recovery inspect the preserved diff before reporting files. Report all files changed by implementation, repair or generators after reviewing their final content.`;
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
