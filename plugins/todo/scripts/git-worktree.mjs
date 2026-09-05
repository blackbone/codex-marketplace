import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
export const TASK_GIT_DELIVERIES = Object.freeze(["keep", "merge", "pr"]);
const deliveries = new Set(TASK_GIT_DELIVERIES);
const gitQueues = new Map();
const lockOwnerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_LOCK_WAIT_MS = 30_000;
const GIT_LOCK_POLL_MS = 25;

function slugify(value, fallback = "task") {
  return (
    String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || fallback
  );
}

function normalizedTask(taskId, title) {
  const raw = path.basename(String(taskId)).replace(/\.md$/, "");
  const match = /^(\d+)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/.exec(raw);
  if (!match) throw new Error(`Invalid task ID: ${taskId}`);
  return {
    id: match[1],
    key: raw,
    slug: slugify(title, match[2] || "task"),
  };
}

function lifecycleError(kind, message, cause, details = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "GitWorktreeError";
  error.kind = kind;
  error.preserveWorktree = true;
  error.details = details;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function gitLockPaths(repoRoot) {
  const lockPath = path.join(repoRoot, ".todo", "git-operation.lock");
  return { lockPath, recoveryPath: `${lockPath}.recovery` };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function readLockOwner(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw lifecycleError(
      "git_lock_read",
      `Could not read Git operation lock: ${lockPath}`,
      error,
    );
  }
  try {
    const owner = JSON.parse(raw);
    if (
      !owner ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !lockOwnerPattern.test(owner.token) ||
      typeof owner.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(owner.acquiredAt))
    ) {
      throw new Error("invalid owner");
    }
    return owner;
  } catch (error) {
    throw lifecycleError(
      "git_lock_invalid",
      `Git operation lock has invalid ownership data: ${lockPath}`,
      error,
    );
  }
}

function tryCreateLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
  };
  const claimPath = `${lockPath}.${owner.pid}.${owner.token}`;
  let fd;
  try {
    fd = openSync(claimPath, "wx", 0o600);
  } catch (error) {
    throw lifecycleError(
      "git_lock_create",
      `Could not create Git operation lock claim: ${claimPath}`,
      error,
    );
  }
  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
    try {
      linkSync(claimPath, lockPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        closeSync(fd);
        unlinkSync(claimPath);
        return null;
      }
      throw error;
    }
    unlinkSync(claimPath);
    return { fd, lockPath, owner };
  } catch (error) {
    closeSync(fd);
    rmSync(claimPath, { force: true });
    const published = readLockOwner(lockPath);
    if (published?.token === owner.token) unlinkSync(lockPath);
    throw lifecycleError(
      "git_lock_create",
      `Could not initialize Git operation lock: ${lockPath}`,
      error,
    );
  }
}

function releaseLock(lock) {
  try {
    const owner = readLockOwner(lock.lockPath);
    if (
      !owner ||
      owner.pid !== lock.owner.pid ||
      owner.token !== lock.owner.token
    ) {
      throw lifecycleError(
        "git_lock_ownership",
        `Git operation lock ownership changed: ${lock.lockPath}`,
      );
    }
    unlinkSync(lock.lockPath);
  } finally {
    closeSync(lock.fd);
  }
}

async function recoverStaleLock(lockPath, recoveryPath) {
  const recovery = tryCreateLock(recoveryPath);
  if (!recovery) {
    const owner = readLockOwner(recoveryPath);
    if (!owner || !processIsAlive(owner.pid)) {
      throw lifecycleError(
        "git_lock_recovery_stale",
        `Stale Git lock recovery requires manual cleanup: ${recoveryPath}`,
      );
    }
    return false;
  }
  try {
    const owner = readLockOwner(lockPath);
    if (!owner || processIsAlive(owner.pid)) return false;
    unlinkSync(lockPath);
    return true;
  } finally {
    releaseLock(recovery);
  }
}

async function acquireGitLock(repoRoot) {
  const { lockPath, recoveryPath } = gitLockPaths(repoRoot);
  const deadline = Date.now() + GIT_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const recoveryOwner = readLockOwner(recoveryPath);
    if (recoveryOwner) {
      if (!processIsAlive(recoveryOwner.pid)) {
        throw lifecycleError(
          "git_lock_recovery_stale",
          `Stale Git lock recovery requires manual cleanup: ${recoveryPath}`,
        );
      }
      await sleep(GIT_LOCK_POLL_MS);
      continue;
    }

    const lock = tryCreateLock(lockPath);
    if (lock) return lock;
    const owner = readLockOwner(lockPath);
    if (!owner) continue;
    if (!processIsAlive(owner.pid)) {
      await recoverStaleLock(lockPath, recoveryPath);
      continue;
    }
    if (owner.pid === process.pid) {
      throw lifecycleError(
        "git_lock_reentrant",
        `Git operation lock is already held by this process: ${lockPath}`,
      );
    }
    await sleep(GIT_LOCK_POLL_MS);
  }
  throw lifecycleError(
    "git_lock_timeout",
    `Timed out waiting for Git operation lock: ${lockPath}`,
  );
}

async function withRepoFileLock(repoRoot, operation) {
  const lock = await acquireGitLock(repoRoot);
  try {
    return await operation();
  } finally {
    releaseLock(lock);
  }
}

async function command(commandName, args, { cwd, allowFailure = false } = {}) {
  try {
    const result = await execFileAsync(commandName, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      code: 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } catch (error) {
    const result = {
      ok: false,
      code: Number.isInteger(error.code) ? error.code : null,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || "",
    };
    if (allowFailure) return result;
    throw lifecycleError(
      "git_command",
      `${commandName} failed: ${result.stderr.trim() || "unknown error"}`,
      error,
      { command: commandName, args, cwd, ...result },
    );
  }
}

function git(cwd, args, options) {
  return command("git", ["-C", cwd, ...args], options);
}

async function output(cwd, args) {
  return (await git(cwd, args)).stdout.trim();
}

async function refHead(repoRoot, ref) {
  const result = await git(
    repoRoot,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { allowFailure: true },
  );
  return result.ok ? result.stdout.trim() : null;
}

async function status(
  worktreePath,
  { includeIgnored = false, excludeTodo = true } = {},
) {
  return output(worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    ...(includeIgnored ? ["--ignored=matching"] : []),
    "--",
    ".",
    ...(excludeTodo ? [":(exclude).todo/**"] : []),
  ]);
}

function committableStatus(worktreePath) {
  return status(worktreePath, { excludeTodo: false });
}

function cleanupStatus(worktreePath) {
  return status(worktreePath, { includeIgnored: true, excludeTodo: false });
}

async function branchAt(worktreePath) {
  const result = await git(
    worktreePath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { allowFailure: true },
  );
  return result.ok ? result.stdout.trim() : null;
}

async function worktrees(repoRoot) {
  const text = (await git(repoRoot, ["worktree", "list", "--porcelain"]))
    .stdout;
  return text
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const item = {};
      for (const line of block.split(/\r?\n/)) {
        const separator = line.indexOf(" ");
        if (separator < 0) continue;
        item[line.slice(0, separator)] = line.slice(separator + 1);
      }
      return item;
    });
}

async function assertPlanRefs(plan) {
  for (const ref of [plan.branch, plan.targetBranch]) {
    const valid = await git(
      plan.repoRoot,
      ["check-ref-format", "--branch", ref],
      { allowFailure: true },
    );
    if (!valid.ok) {
      throw lifecycleError("invalid_ref", `Invalid Git branch: ${ref}`);
    }
  }
  const targetHead = await refHead(
    plan.repoRoot,
    `refs/heads/${plan.targetBranch}`,
  );
  if (!targetHead) {
    throw lifecycleError(
      "missing_target",
      `Target branch does not exist: ${plan.targetBranch}`,
    );
  }
  return targetHead;
}

async function assertOwnedWorktree(plan) {
  if (!existsSync(plan.worktreePath)) return null;
  const root = await git(
    plan.worktreePath,
    ["rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );
  if (
    !root.ok ||
    realpathSync(root.stdout.trim()) !== realpathSync(plan.worktreePath)
  ) {
    throw lifecycleError(
      "worktree_collision",
      `Worktree path is not owned by this task: ${plan.worktreePath}`,
    );
  }
  const registered = (await worktrees(plan.repoRoot)).find(
    (item) => item.worktree && sameRealPath(item.worktree, plan.worktreePath),
  );
  if (!registered) {
    throw lifecycleError(
      "worktree_collision",
      `Worktree path is not registered by this repository: ${plan.worktreePath}`,
    );
  }
  const branch = await branchAt(plan.worktreePath);
  if (branch !== plan.branch) {
    throw lifecycleError(
      "worktree_collision",
      `Expected ${plan.branch} at ${plan.worktreePath}, found ${branch || "detached HEAD"}`,
    );
  }
  return output(plan.worktreePath, ["rev-parse", "HEAD"]);
}

async function verifyHeadUnlocked(plan, expectedHead) {
  const head = await assertOwnedWorktree(plan);
  if (!head) {
    throw lifecycleError(
      "missing_worktree",
      `Task worktree is missing: ${plan.worktreePath}`,
    );
  }
  if (head !== expectedHead) {
    throw lifecycleError(
      "child_moved_head",
      `Task worker moved HEAD from ${expectedHead} to ${head}`,
      null,
      { expectedHead, head },
    );
  }
  return { head, dirty: Boolean(await committableStatus(plan.worktreePath)) };
}

async function cleanupUnlocked(
  plan,
  {
    deleteBranch = false,
    forceDeleteBranch = false,
    discardIgnored = false,
  } = {},
) {
  const warnings = [];
  if (existsSync(plan.worktreePath)) {
    const dirty = await (
      discardIgnored
        ? committableStatus(plan.worktreePath)
        : cleanupStatus(plan.worktreePath)
    ).catch(() => "unknown");
    if (dirty) {
      warnings.push(`Preserved non-clean worktree: ${plan.worktreePath}`);
    } else {
      const removed = await git(
        plan.repoRoot,
        [
          "worktree",
          "remove",
          ...(discardIgnored ? ["--force"] : []),
          plan.worktreePath,
        ],
        { allowFailure: true },
      );
      if (!removed.ok) {
        warnings.push(
          `Could not remove worktree: ${removed.stderr.trim() || plan.worktreePath}`,
        );
      }
    }
  }

  if (deleteBranch && !existsSync(plan.worktreePath)) {
    const branchHead = await refHead(plan.repoRoot, plan.branch);
    if (branchHead) {
      const removed = await git(
        plan.repoRoot,
        ["branch", forceDeleteBranch ? "-D" : "-d", plan.branch],
        { allowFailure: true },
      );
      if (!removed.ok) {
        warnings.push(
          `Could not delete branch ${plan.branch}: ${removed.stderr.trim()}`,
        );
      }
    }
  }
  return warnings;
}

async function assertDeliveryState(plan, expectedHead) {
  const branchHead = await refHead(plan.repoRoot, plan.branch);
  if (!branchHead) return { branchHead: null, worktreePresent: false };
  if (branchHead !== expectedHead) {
    throw lifecycleError(
      "branch_moved",
      `Task branch moved from ${expectedHead} to ${branchHead}`,
      null,
      { expectedHead, branchHead },
    );
  }
  if (existsSync(plan.worktreePath)) {
    const worktreeHead = await assertOwnedWorktree(plan);
    const dirty = await committableStatus(plan.worktreePath);
    if (worktreeHead !== branchHead || dirty) {
      throw lifecycleError(
        "worktree_not_clean",
        `Task worktree must be clean before delivery: ${plan.worktreePath}`,
        null,
        { branchHead, worktreeHead, dirty },
      );
    }
  }
  return { branchHead, worktreePresent: existsSync(plan.worktreePath) };
}

async function containsCommit(repoRoot, branch, commit) {
  const result = await git(
    repoRoot,
    ["merge-base", "--is-ancestor", commit, branch],
    { allowFailure: true },
  );
  return result.ok;
}

async function containsEquivalentPatch(repoRoot, branch, commit) {
  const result = await git(
    repoRoot,
    ["cherry", branch, commit, `${commit}^`],
    { allowFailure: true },
  );
  return (
    result.ok &&
    result.stdout
      .trim()
      .split(/\r?\n/)
      .includes(`- ${commit}`)
  );
}

async function targetCheckout(plan) {
  const branchRef = `refs/heads/${plan.targetBranch}`;
  const matches = (await worktrees(plan.repoRoot)).filter(
    (item) => item.branch === branchRef,
  );
  if (matches.length > 1) {
    throw lifecycleError(
      "ambiguous_target",
      `Target branch is checked out more than once: ${plan.targetBranch}`,
    );
  }
  if (matches.length === 1) {
    return { path: path.resolve(matches[0].worktree), temporary: false };
  }

  const targetPath = path.join(
    plan.repoRoot,
    ".todo",
    "worktrees",
    `.target-${slugify(plan.targetBranch)}`,
  );
  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (existsSync(targetPath)) {
    throw lifecycleError(
      "target_worktree_collision",
      `Target worktree path already exists: ${targetPath}`,
    );
  }
  await git(plan.repoRoot, [
    "worktree",
    "add",
    targetPath,
    `refs/heads/${plan.targetBranch}`,
  ]);
  return { path: targetPath, temporary: true };
}

async function gitStatePath(worktreePath, name) {
  const statePath = await output(worktreePath, ["rev-parse", "--git-path", name]);
  return path.isAbsolute(statePath)
    ? statePath
    : path.resolve(worktreePath, statePath);
}

async function activeGitOperations(worktreePath) {
  const names = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_LOG",
  ];
  const active = [];
  for (const name of names) {
    if (existsSync(await gitStatePath(worktreePath, name))) active.push(name);
  }
  return active;
}

async function cherryPickStartedFor(worktreePath, headCommit) {
  const cherryPickHead = await gitStatePath(worktreePath, "CHERRY_PICK_HEAD");
  if (!existsSync(cherryPickHead)) return false;
  return readFileSync(cherryPickHead, "utf8")
    .split(/\s+/)
    .includes(headCommit);
}

async function deliverMerge(plan, headCommit) {
  const targetRef = `refs/heads/${plan.targetBranch}`;
  if (await containsCommit(plan.repoRoot, targetRef, headCommit)) {
    return {
      alreadyDelivered: true,
      strategy: "fast-forward",
      targetCommit: await refHead(plan.repoRoot, targetRef),
    };
  }
  if (await containsEquivalentPatch(
    plan.repoRoot,
    targetRef,
    headCommit,
  )) {
    return {
      alreadyDelivered: true,
      strategy: "cherry-pick",
      targetCommit: await refHead(plan.repoRoot, targetRef),
    };
  }

  const target = await targetCheckout(plan);
  try {
    const operations = await activeGitOperations(target.path);
    if (operations.length > 0) {
      throw lifecycleError(
        "git_operation_in_progress",
        `Target checkout already has a Git operation in progress: ${operations.join(", ")}`,
        null,
        { operations, targetPath: target.path },
      );
    }
    const dirty = await status(target.path);
    if (dirty) {
      throw lifecycleError(
        "dirty_target",
        `Target checkout is dirty: ${target.path}`,
        null,
        { dirty },
      );
    }
    const targetHead = await output(target.path, ["rev-parse", "HEAD"]);
    const canFastForward = await containsCommit(
      plan.repoRoot,
      headCommit,
      targetHead,
    );
    if (canFastForward) {
      const fastForwarded = await git(
        target.path,
        ["merge", "--ff-only", headCommit],
        { allowFailure: true },
      );
      if (!fastForwarded.ok) {
        throw lifecycleError(
          "fast_forward_failed",
          `Could not fast-forward ${plan.targetBranch} to ${plan.branch}: ${fastForwarded.stderr.trim() || fastForwarded.stdout.trim()}`,
          null,
          { stdout: fastForwarded.stdout, stderr: fastForwarded.stderr },
        );
      }
      return {
        alreadyDelivered: false,
        strategy: "fast-forward",
        targetCommit: headCommit,
      };
    }

    const cherryPicked = await git(
      target.path,
      ["cherry-pick", "-x", headCommit],
      { allowFailure: true },
    );
    if (!cherryPicked.ok) {
      if (await cherryPickStartedFor(target.path, headCommit)) {
        await git(target.path, ["cherry-pick", "--abort"], {
          allowFailure: true,
        });
      }
      throw lifecycleError(
        "cherry_pick_failed",
        `Could not cherry-pick ${plan.branch} into ${plan.targetBranch}: ${cherryPicked.stderr.trim() || cherryPicked.stdout.trim()}`,
        null,
        { stdout: cherryPicked.stdout, stderr: cherryPicked.stderr },
      );
    }
    const targetCommit = await output(target.path, ["rev-parse", "HEAD"]);
    if (!(await containsEquivalentPatch(plan.repoRoot, targetRef, headCommit))) {
      throw lifecycleError(
        "cherry_pick_incomplete",
        `Target branch does not record the cherry-pick of ${headCommit}`,
      );
    }
    return {
      alreadyDelivered: false,
      strategy: "cherry-pick",
      targetCommit,
    };
  } finally {
    if (target.temporary && existsSync(target.path)) {
      const dirty = await cleanupStatus(target.path).catch(() => "unknown");
      if (!dirty) {
        await git(
          plan.repoRoot,
          ["worktree", "remove", target.path],
          { allowFailure: true },
        );
      }
    }
  }
}

async function ensureQueuedWorktreeUnlocked(plan, expectedHead) {
  const existingHead = await assertOwnedWorktree(plan);
  if (existingHead) {
    const dirty = await committableStatus(plan.worktreePath);
    if (existingHead !== expectedHead || dirty) {
      throw lifecycleError(
        "merge_queue_worktree_changed",
        `Queued task worktree does not match ${expectedHead}: ${plan.worktreePath}`,
        null,
        { existingHead, expectedHead, dirty },
      );
    }
    return existingHead;
  }
  const branchHead = await refHead(plan.repoRoot, plan.branch);
  if (branchHead !== expectedHead) {
    throw lifecycleError(
      "merge_queue_branch_changed",
      `Queued task branch moved from ${expectedHead} to ${branchHead || "missing"}`,
      null,
      { branchHead, expectedHead },
    );
  }
  mkdirSync(path.dirname(plan.worktreePath), { recursive: true });
  await git(plan.repoRoot, [
    "worktree",
    "add",
    plan.worktreePath,
    plan.branch,
  ]);
  return output(plan.worktreePath, ["rev-parse", "HEAD"]);
}

async function mergeConflictDetails(plan, targetHead, rebaseResult) {
  const files = (await git(
    plan.worktreePath,
    ["diff", "--name-only", "--diff-filter=U"],
    { allowFailure: true },
  )).stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    status: "conflict",
    branch: plan.branch,
    targetBranch: plan.targetBranch,
    targetCommit: targetHead,
    worktreePath: plan.worktreePath,
    files,
    stdout: rebaseResult.stdout.trim().slice(0, 8000),
    stderr: rebaseResult.stderr.trim().slice(0, 8000),
  };
}

export function queueTaskWorktreeForMerge(plan, headCommit) {
  return withGitLock(plan.repoRoot, async () => {
    await assertDeliveryState(plan, headCommit);
    const cleanupWarnings = await cleanupUnlocked(plan, {
      deleteBranch: false,
      discardIgnored: true,
    });
    if (cleanupWarnings.length > 0) {
      throw lifecycleError(
        "merge_queue_cleanup_failed",
        cleanupWarnings.join("; "),
        null,
        { cleanupWarnings },
      );
    }
    return {
      delivery: "merge",
      branch: plan.branch,
      headCommit,
      queued: true,
      cleanupWarnings,
    };
  });
}

export function mergeQueuedTaskWorktree(plan, expectedHead, { validate } = {}) {
  return withGitLock(plan.repoRoot, async () => {
    const targetHead = await assertPlanRefs(plan);
    await ensureQueuedWorktreeUnlocked(plan, expectedHead);
    const operations = await activeGitOperations(plan.worktreePath);
    if (operations.length > 0) {
      throw lifecycleError(
        "merge_queue_operation_in_progress",
        `Queued task already has a Git operation in progress: ${operations.join(", ")}`,
        null,
        { operations, worktreePath: plan.worktreePath },
      );
    }
    const rebased = await git(
      plan.worktreePath,
      ["rebase", `refs/heads/${plan.targetBranch}`],
      { allowFailure: true },
    );
    if (!rebased.ok) {
      const operationsAfter = await activeGitOperations(plan.worktreePath);
      if (operationsAfter.some((item) => item.startsWith("rebase-"))) {
        return mergeConflictDetails(plan, targetHead, rebased);
      }
      throw lifecycleError(
        "merge_queue_rebase_failed",
        `Could not rebase ${plan.branch} onto ${plan.targetBranch}: ${rebased.stderr.trim() || rebased.stdout.trim()}`,
        null,
        { stdout: rebased.stdout, stderr: rebased.stderr },
      );
    }

    const headCommit = await output(plan.worktreePath, ["rev-parse", "HEAD"]);
    let pipelineValidation = null;
    if (validate) {
      try {
        pipelineValidation = await validate({ headCommit, worktreePath: plan.worktreePath });
        const currentHead = await output(plan.worktreePath, ["rev-parse", "HEAD"]);
        const trackedChanges = await output(plan.worktreePath, ["status", "--porcelain", "--untracked-files=no"]);
        if (currentHead !== headCommit || trackedChanges) {
          throw new Error("Merge validation changed tracked files or HEAD; rerun implementation before delivery");
        }
      } catch (error) {
        error.kind = error.kind || "pipeline_validation";
        error.details = { ...error.details, headCommit };
        throw error;
      }
    }
    const target = await targetCheckout(plan);
    try {
      const dirty = await status(target.path);
      if (dirty) {
        throw lifecycleError(
          "dirty_target",
          `Target checkout is dirty: ${target.path}`,
          null,
          { dirty, headCommit },
        );
      }
      const fastForwarded = await git(
        target.path,
        ["merge", "--ff-only", headCommit],
        { allowFailure: true },
      );
      if (!fastForwarded.ok) {
        throw lifecycleError(
          "merge_queue_fast_forward_failed",
          `Could not fast-forward ${plan.targetBranch} to rebased ${plan.branch}: ${fastForwarded.stderr.trim() || fastForwarded.stdout.trim()}`,
          null,
          {
            stdout: fastForwarded.stdout,
            stderr: fastForwarded.stderr,
            headCommit,
          },
        );
      }
    } finally {
      if (target.temporary && existsSync(target.path)) {
        const dirty = await cleanupStatus(target.path).catch(() => "unknown");
        if (!dirty) {
          await git(plan.repoRoot, ["worktree", "remove", target.path], {
            allowFailure: true,
          });
        }
      }
    }
    const cleanupWarnings = await cleanupUnlocked(plan, {
      deleteBranch: true,
      forceDeleteBranch: false,
      discardIgnored: true,
    });
    return {
      status: "merged",
      delivery: "merge",
      strategy: "rebase-fast-forward",
      ...(pipelineValidation ? { pipelineValidation } : {}),
      branch: plan.branch,
      previousHead: expectedHead,
      headCommit,
      targetCommit: headCommit,
      cleanupWarnings,
    };
  });
}

export function continueQueuedTaskRebase(plan) {
  return withGitLock(plan.repoRoot, async () => {
    const operations = await activeGitOperations(plan.worktreePath);
    if (!operations.some((item) => item.startsWith("rebase-"))) {
      throw lifecycleError(
        "merge_queue_rebase_missing",
        `No queued rebase is active in ${plan.worktreePath}`,
      );
    }
    await git(plan.worktreePath, ["add", "-A", "--"]);
    const continued = await git(
      plan.worktreePath,
      ["-c", "core.editor=true", "rebase", "--continue"],
      { allowFailure: true },
    );
    if (!continued.ok) {
      const targetHead = await refHead(
        plan.repoRoot,
        `refs/heads/${plan.targetBranch}`,
      );
      return mergeConflictDetails(plan, targetHead, continued);
    }
    return {
      status: "resolved",
      headCommit: await output(plan.worktreePath, ["rev-parse", "HEAD"]),
      worktreePath: plan.worktreePath,
    };
  });
}

export function abortQueuedTaskRebase(plan) {
  return withGitLock(plan.repoRoot, async () => {
    const operations = await activeGitOperations(plan.worktreePath);
    if (operations.some((item) => item.startsWith("rebase-"))) {
      await git(plan.worktreePath, ["rebase", "--abort"]);
    }
    return {
      headCommit: await output(plan.worktreePath, ["rev-parse", "HEAD"]),
      worktreePath: plan.worktreePath,
    };
  });
}

async function deliverPullRequest(
  plan,
  { title, body = "", remote = "origin" },
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote)) {
    throw lifecycleError("invalid_remote", `Invalid Git remote: ${remote}`);
  }
  await git(plan.repoRoot, ["push", "-u", remote, plan.branch]);

  const existing = await command(
    "gh",
    ["pr", "view", plan.branch, "--json", "url", "--jq", ".url"],
    { cwd: plan.repoRoot, allowFailure: true },
  );
  if (existing.ok && existing.stdout.trim()) {
    return { url: existing.stdout.trim(), alreadyDelivered: true };
  }
  const created = await command(
    "gh",
    [
      "pr",
      "create",
      "--base",
      plan.targetBranch,
      "--head",
      plan.branch,
      "--title",
      String(title || plan.title),
      "--body",
      String(body),
    ],
    { cwd: plan.repoRoot },
  );
  const url = created.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//.test(line));
  if (!url) {
    throw lifecycleError(
      "pr_result",
      "gh pr create did not return a pull request URL",
    );
  }
  return { url, alreadyDelivered: false };
}

export function taskBranchName(taskId, title) {
  const task = normalizedTask(taskId, title);
  return `codex/todo-${task.id}-${task.slug}`;
}

export function taskWorktreePlan({
  repoRoot,
  taskId,
  title,
  targetBranch,
  delivery = "keep",
  branch = taskBranchName(taskId, title),
}) {
  const task = normalizedTask(taskId, title);
  if (!targetBranch || typeof targetBranch !== "string") {
    throw new Error("targetBranch must be a non-empty string");
  }
  if (!deliveries.has(delivery)) {
    throw new Error("delivery must be keep, merge, or pr");
  }
  const root = path.resolve(repoRoot);
  if (
    typeof branch !== "string" ||
    !branch.startsWith(`codex/todo-${task.id}-`)
  ) {
    throw new Error(`invalid task branch: ${branch}`);
  }
  if (branch === targetBranch) {
    throw new Error("task branch and target branch must differ");
  }
  return Object.freeze({
    repoRoot: root,
    taskId: task.key,
    title: String(title || task.slug).trim(),
    targetBranch,
    branch,
    delivery,
    worktreePath: path.join(root, ".todo", "worktrees", task.key),
  });
}

export function withGitLock(repoRoot, operation) {
  const key = realpathSync(path.resolve(repoRoot));
  const previous = gitQueues.get(key) || Promise.resolve();
  const run = () => withRepoFileLock(key, operation);
  const current = previous.then(run, run);
  const tail = current.catch(() => {});
  gitQueues.set(key, tail);
  tail.finally(() => {
    if (gitQueues.get(key) === tail) gitQueues.delete(key);
  });
  return current;
}

export function prepareTaskWorktree(plan, { expectedBase = null } = {}) {
  return withGitLock(plan.repoRoot, async () => {
    const targetHead = await assertPlanRefs(plan);
    const existingHead = await assertOwnedWorktree(plan);
    if (existingHead) {
      const dirty = await committableStatus(plan.worktreePath);
      if (
        (expectedBase && existingHead !== expectedBase) ||
        (!expectedBase && (dirty || existingHead !== targetHead))
      ) {
        throw lifecycleError(
          "unjournaled_worktree",
          `Refusing to reuse task worktree without a safe journaled or target base: ${plan.worktreePath}`,
          null,
          { expectedBase, existingHead, targetHead, dirty },
        );
      }
      return {
        ...plan,
        head: existingHead,
        targetHead,
        reused: true,
        dirty: Boolean(dirty),
      };
    }

    mkdirSync(path.dirname(plan.worktreePath), { recursive: true });
    const branchHead = await refHead(plan.repoRoot, plan.branch);
    if (branchHead) {
      const registered = (await worktrees(plan.repoRoot)).find(
        (item) => item.branch === `refs/heads/${plan.branch}`,
      );
      if (registered) {
        throw lifecycleError(
          "branch_in_use",
          `Task branch is already checked out at ${registered.worktree}`,
        );
      }
      throw lifecycleError(
        "branch_collision",
        `Refusing to adopt pre-existing task branch without its journaled worktree: ${plan.branch}`,
        null,
        { branchHead },
      );
    } else {
      await git(plan.repoRoot, [
        "worktree",
        "add",
        "-b",
        plan.branch,
        plan.worktreePath,
        `refs/heads/${plan.targetBranch}`,
      ]);
    }
    const head = await assertOwnedWorktree(plan);
    return {
      ...plan,
      head,
      targetHead,
      reused: false,
      dirty: false,
    };
  });
}

export function verifyTaskWorktreeHead(plan, expectedHead) {
  return withGitLock(plan.repoRoot, () =>
    verifyHeadUnlocked(plan, expectedHead),
  );
}

export function commitTaskWorktree(
  plan,
  {
    expectedHead,
    recoverCommittedHead = false,
    message = `todo(${normalizedTask(plan.taskId).id}): ${plan.title}`,
  },
) {
  return withGitLock(plan.repoRoot, async () => {
    const currentHead = await assertOwnedWorktree(plan);
    if (currentHead !== expectedHead) {
      const dirty = await committableStatus(plan.worktreePath);
      const parent = await git(
        plan.worktreePath,
        ["rev-parse", "--verify", `${currentHead}^`],
        { allowFailure: true },
      );
      if (
        !recoverCommittedHead ||
        dirty ||
        !parent.ok ||
        parent.stdout.trim() !== expectedHead
      ) {
        throw lifecycleError(
          "child_moved_head",
          `Task worker moved HEAD from ${expectedHead} to ${currentHead}`,
          null,
          { expectedHead, head: currentHead, dirty },
        );
      }
      return { changed: true, headCommit: currentHead, recovered: true };
    }
    await git(plan.worktreePath, ["add", "-A", "--"]);
    const staged = await git(
      plan.worktreePath,
      ["diff", "--cached", "--quiet", "--exit-code"],
      { allowFailure: true },
    );
    if (staged.ok) {
      return { changed: false, headCommit: expectedHead };
    }
    if (staged.code !== 1) {
      throw lifecycleError(
        "staged_diff_failed",
        `Could not inspect staged changes: ${staged.stderr.trim()}`,
        null,
        staged,
      );
    }

    await git(plan.worktreePath, ["commit", "-m", String(message)]);
    const headCommit = await output(plan.worktreePath, ["rev-parse", "HEAD"]);
    const dirty = await committableStatus(plan.worktreePath);
    if (dirty) {
      throw lifecycleError(
        "post_commit_dirty",
        `Commit completed but worktree is still dirty: ${plan.worktreePath}`,
        null,
        { headCommit, dirty },
      );
    }
    return { changed: true, headCommit };
  });
}

export function deliverTaskWorktree(
  plan,
  {
    headCommit,
    noChanges = false,
    baseCommit = null,
    title = plan.title,
    body = "",
    remote = "origin",
  },
) {
  return withGitLock(plan.repoRoot, async () => {
    if (plan.delivery === "merge") {
      throw lifecycleError(
        "merge_queue_required",
        `Merge delivery must be processed through the merge queue for ${plan.branch}`,
        null,
        { branch: plan.branch, targetBranch: plan.targetBranch },
      );
    }
    if (
      noChanges === true &&
      (typeof baseCommit !== "string" || baseCommit !== headCommit)
    ) {
      throw lifecycleError(
        "invalid_no_changes",
        "No-change delivery requires matching persisted baseCommit and headCommit",
        null,
        { baseCommit, headCommit },
      );
    }
    const provenNoChanges = noChanges === true;
    const state = await assertDeliveryState(plan, headCommit);
    if (!state.branchHead) {
      if (
        provenNoChanges &&
        (await refHead(plan.repoRoot, headCommit)) === headCommit
      ) {
        return {
          delivery: plan.delivery,
          branch: plan.branch,
          headCommit,
          alreadyDelivered: true,
          noChanges: true,
          ...(plan.delivery === "pr" ? { url: null } : {}),
          cleanupWarnings: [],
        };
      }
      throw lifecycleError(
        "missing_branch",
        `Task branch is missing: ${plan.branch}`,
      );
    }

    let result = { alreadyDelivered: false };
    const targetHead = await refHead(
      plan.repoRoot,
      `refs/heads/${plan.targetBranch}`,
    );
    if (provenNoChanges || headCommit === targetHead) {
      result = { alreadyDelivered: true, noChanges: true };
    }
    if (plan.delivery === "pr") {
      if (result.noChanges === true) {
        result = { alreadyDelivered: true, noChanges: true, url: null };
      } else {
        result = await deliverPullRequest(plan, { title, body, remote });
      }
    }

    const cleanupWarnings = await cleanupUnlocked(plan, {
      deleteBranch: result.noChanges === true,
      forceDeleteBranch: false,
      discardIgnored: false,
    });
    return {
      delivery: plan.delivery,
      branch: plan.branch,
      headCommit,
      ...result,
      cleanupWarnings,
    };
  });
}

export function cleanupTaskWorktree(plan, options) {
  return withGitLock(plan.repoRoot, () => cleanupUnlocked(plan, options));
}

export async function runSelfCheck() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "todo-git-worktree-"));
  try {
    await git(repoRoot, ["init", "--quiet", "--initial-branch=main"]);
    await git(repoRoot, ["config", "user.name", "ToDo Self Check"]);
    await git(repoRoot, ["config", "user.email", "todo@example.invalid"]);
    writeFileSync(path.join(repoRoot, "README.md"), "initial\n", "utf8");
    writeFileSync(path.join(repoRoot, ".gitignore"), "*.tmp\n", "utf8");
    await git(repoRoot, ["add", "README.md", ".gitignore"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "initial"]);

    const plan = taskWorktreePlan({
      repoRoot,
      taskId: "001-example",
      title: "Example change",
      targetBranch: "main",
      delivery: "keep",
    });
    assert.equal(plan.branch, "codex/todo-001-example-change");
    const prepared = await prepareTaskWorktree(plan);
    writeFileSync(path.join(plan.worktreePath, "result.txt"), "done\n", "utf8");
    await verifyTaskWorktreeHead(plan, prepared.head);
    const committed = await commitTaskWorktree(plan, {
      expectedHead: prepared.head,
    });
    assert.equal(committed.changed, true);
    const delivered = await deliverTaskWorktree(plan, committed);
    assert.equal(delivered.delivery, "keep");
    assert.equal(existsSync(plan.worktreePath), false);
    assert.equal(await refHead(repoRoot, plan.branch), committed.headCommit);

    const recoveryPlan = taskWorktreePlan({
      repoRoot,
      taskId: "002-recovery",
      title: "Recovery change",
      targetBranch: "main",
      delivery: "keep",
    });
    const recoveryPrepared = await prepareTaskWorktree(recoveryPlan);
    const safeUnjournaledRecovery = await prepareTaskWorktree(recoveryPlan);
    assert.equal(safeUnjournaledRecovery.reused, true);
    const reusedRecovery = await prepareTaskWorktree(recoveryPlan, {
      expectedBase: recoveryPrepared.head,
    });
    assert.equal(reusedRecovery.reused, true);
    writeFileSync(
      path.join(recoveryPlan.worktreePath, "recovery.txt"),
      "done\n",
      "utf8",
    );
    await assert.rejects(
      prepareTaskWorktree(recoveryPlan),
      (error) => error.kind === "unjournaled_worktree",
    );
    await git(recoveryPlan.worktreePath, ["add", "-A"]);
    await git(recoveryPlan.worktreePath, ["commit", "-m", "simulated crash"]);
    await assert.rejects(
      prepareTaskWorktree(recoveryPlan),
      (error) => error.kind === "unjournaled_worktree",
    );
    const recovered = await commitTaskWorktree(recoveryPlan, {
      expectedHead: recoveryPrepared.head,
      recoverCommittedHead: true,
    });
    assert.equal(recovered.recovered, true);
    await deliverTaskWorktree(recoveryPlan, recovered);

    const ignoredPlan = taskWorktreePlan({
      repoRoot,
      taskId: "003-ignored",
      title: "Ignored output",
      targetBranch: "main",
      delivery: "keep",
    });
    const ignoredPrepared = await prepareTaskWorktree(ignoredPlan);
    writeFileSync(path.join(ignoredPlan.worktreePath, "valuable.tmp"), "keep\n");
    const ignoredCommitted = await commitTaskWorktree(ignoredPlan, {
      expectedHead: ignoredPrepared.head,
    });
    assert.equal(ignoredCommitted.changed, false);
    const ignoredDelivered = await deliverTaskWorktree(
      ignoredPlan,
      {
        ...ignoredCommitted,
        noChanges: true,
        baseCommit: ignoredPrepared.head,
      },
    );
    assert.equal(existsSync(path.join(ignoredPlan.worktreePath, "valuable.tmp")), true);
    assert.equal(ignoredDelivered.cleanupWarnings.length, 1);

    const ignoredMergePlan = taskWorktreePlan({
      repoRoot,
      taskId: "010-ignored-merge",
      title: "Ignored merge output",
      targetBranch: "main",
      delivery: "merge",
    });
    const ignoredMergePrepared = await prepareTaskWorktree(ignoredMergePlan);
    writeFileSync(
      path.join(ignoredMergePlan.worktreePath, "merged.txt"),
      "merged\n",
      "utf8",
    );
    writeFileSync(
      path.join(ignoredMergePlan.worktreePath, "build.tmp"),
      "discard after merge\n",
      "utf8",
    );
    const ignoredMergeCommitted = await commitTaskWorktree(ignoredMergePlan, {
      expectedHead: ignoredMergePrepared.head,
    });
    const ignoredMergeQueued = await queueTaskWorktreeForMerge(
      ignoredMergePlan,
      ignoredMergeCommitted.headCommit,
    );
    assert.equal(ignoredMergeQueued.queued, true);
    const ignoredMergeDelivered = await mergeQueuedTaskWorktree(
      ignoredMergePlan,
      ignoredMergeCommitted.headCommit,
    );
    assert.equal(ignoredMergeDelivered.strategy, "rebase-fast-forward");
    assert.deepEqual(ignoredMergeDelivered.cleanupWarnings, []);
    assert.equal(existsSync(ignoredMergePlan.worktreePath), false);
    assert.equal(await refHead(repoRoot, ignoredMergePlan.branch), null);

    for (const [index, delivery] of ["keep", "pr"].entries()) {
      const noChangePlan = taskWorktreePlan({
        repoRoot,
        taskId: `00${index + 4}-no-change-${delivery}`,
        title: `No change ${delivery}`,
        targetBranch: "main",
        delivery,
      });
      const noChangePrepared = await prepareTaskWorktree(noChangePlan);
      const noChangeCommitted = await commitTaskWorktree(noChangePlan, {
        expectedHead: noChangePrepared.head,
      });
      assert.equal(noChangeCommitted.changed, false);
      await deliverTaskWorktree(noChangePlan, {
        ...noChangeCommitted,
        noChanges: true,
        baseCommit: noChangePrepared.head,
      });
      assert.equal(await refHead(repoRoot, noChangePlan.branch), null);
      writeFileSync(
        path.join(repoRoot, `advance-${delivery}.txt`),
        `${delivery}\n`,
      );
      await git(repoRoot, ["add", `advance-${delivery}.txt`]);
      await git(repoRoot, ["commit", "--quiet", "-m", `advance ${delivery}`]);
      const replayed = await deliverTaskWorktree(noChangePlan, {
        ...noChangeCommitted,
        noChanges: true,
        baseCommit: noChangePrepared.head,
      });
      assert.equal(replayed.alreadyDelivered, true);
      assert.equal(replayed.noChanges, true);
      await assert.rejects(
        deliverTaskWorktree(noChangePlan, noChangeCommitted),
        (error) => error.kind === "missing_branch",
      );
    }

    const collisionPlan = taskWorktreePlan({
      repoRoot,
      taskId: "006-collision",
      title: "Collision",
      targetBranch: "main",
      delivery: "keep",
    });
    await git(repoRoot, ["branch", collisionPlan.branch, "main"]);
    await assert.rejects(
      prepareTaskWorktree(collisionPlan),
      (error) => error.kind === "branch_collision",
    );
    assert.equal(existsSync(collisionPlan.worktreePath), false);
    await git(repoRoot, ["branch", "-D", collisionPlan.branch]);

    const operationPlan = taskWorktreePlan({
      repoRoot,
      taskId: "007-operation",
      title: "Operation guard",
      targetBranch: "main",
      delivery: "keep",
    });
    const operationPrepared = await prepareTaskWorktree(operationPlan);
    writeFileSync(
      path.join(operationPlan.worktreePath, "operation.txt"),
      "task\n",
    );
    const operationCommitted = await commitTaskWorktree(operationPlan, {
      expectedHead: operationPrepared.head,
    });
    const kept = await deliverTaskWorktree(
      operationPlan,
      operationCommitted,
    );
    assert.equal(kept.delivery, "keep");
    assert.equal(await refHead(repoRoot, "main"), operationPrepared.head);
    assert.equal(await refHead(repoRoot, operationPlan.branch), operationCommitted.headCommit);

    const mergeDirectPlan = taskWorktreePlan({
      repoRoot,
      taskId: "008-merge-direct",
      title: "Queue-only merge delivery",
      targetBranch: "main",
      delivery: "merge",
    });
    const mergeDirectPrepared = await prepareTaskWorktree(mergeDirectPlan);
    writeFileSync(
      path.join(mergeDirectPlan.worktreePath, "conflict.txt"),
      "task\n",
      "utf8",
    );
    const mergeDirectCommitted = await commitTaskWorktree(mergeDirectPlan, {
      expectedHead: mergeDirectPrepared.head,
    });
    await assert.rejects(
      deliverTaskWorktree(mergeDirectPlan, mergeDirectCommitted),
      (error) => error.kind === "merge_queue_required",
    );

    const queuePlan = taskWorktreePlan({
      repoRoot,
      taskId: "011-merge-queue",
      title: "Merge queue rebase",
      targetBranch: "main",
      delivery: "merge",
    });
    const queuePrepared = await prepareTaskWorktree(queuePlan);
    writeFileSync(path.join(queuePlan.worktreePath, "queued.txt"), "task\n");
    const queueCommitted = await commitTaskWorktree(queuePlan, {
      expectedHead: queuePrepared.head,
    });
    const queued = await queueTaskWorktreeForMerge(
      queuePlan,
      queueCommitted.headCommit,
    );
    assert.equal(queued.queued, true);
    assert.equal(existsSync(queuePlan.worktreePath), false);
    assert.equal(await refHead(repoRoot, queuePlan.branch), queueCommitted.headCommit);
    writeFileSync(path.join(repoRoot, "queue-advance.txt"), "main\n");
    await git(repoRoot, ["add", "queue-advance.txt"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "advance before queue"]);
    const queueTarget = await refHead(repoRoot, "main");
    const queueMerged = await mergeQueuedTaskWorktree(
      queuePlan,
      queueCommitted.headCommit,
    );
    assert.equal(queueMerged.status, "merged");
    assert.equal(queueMerged.strategy, "rebase-fast-forward");
    assert.notEqual(queueMerged.headCommit, queueCommitted.headCommit);
    assert.equal(
      await containsCommit(repoRoot, queueMerged.headCommit, queueTarget),
      true,
    );
    assert.equal(await refHead(repoRoot, queuePlan.branch), null);
    assert.equal(existsSync(queuePlan.worktreePath), false);

    writeFileSync(path.join(repoRoot, "queue-conflict.txt"), "base\n");
    await git(repoRoot, ["add", "queue-conflict.txt"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "queue conflict base"]);
    const queueConflictPlan = taskWorktreePlan({
      repoRoot,
      taskId: "012-merge-queue-conflict",
      title: "Merge queue conflict",
      targetBranch: "main",
      delivery: "merge",
    });
    const queueConflictPrepared = await prepareTaskWorktree(queueConflictPlan);
    writeFileSync(
      path.join(queueConflictPlan.worktreePath, "queue-conflict.txt"),
      "task\n",
    );
    const queueConflictCommitted = await commitTaskWorktree(queueConflictPlan, {
      expectedHead: queueConflictPrepared.head,
    });
    await queueTaskWorktreeForMerge(
      queueConflictPlan,
      queueConflictCommitted.headCommit,
    );
    writeFileSync(path.join(repoRoot, "queue-conflict.txt"), "main\n");
    await git(repoRoot, ["add", "queue-conflict.txt"]);
    await git(repoRoot, ["commit", "--quiet", "-m", "queue conflict main"]);
    const queueConflict = await mergeQueuedTaskWorktree(
      queueConflictPlan,
      queueConflictCommitted.headCommit,
    );
    assert.equal(queueConflict.status, "conflict");
    assert.deepEqual(queueConflict.files, ["queue-conflict.txt"]);
    writeFileSync(
      path.join(queueConflictPlan.worktreePath, "queue-conflict.txt"),
      "main and task\n",
    );
    const resolvedQueueConflict = await continueQueuedTaskRebase(
      queueConflictPlan,
    );
    assert.equal(resolvedQueueConflict.status, "resolved");
    const queueConflictMerged = await mergeQueuedTaskWorktree(
      queueConflictPlan,
      resolvedQueueConflict.headCommit,
    );
    assert.equal(queueConflictMerged.status, "merged");
    assert.equal(
      readFileSync(path.join(repoRoot, "queue-conflict.txt"), "utf8"),
      "main and task\n",
    );
    assert.equal(await refHead(repoRoot, queueConflictPlan.branch), null);

    const { lockPath, recoveryPath } = gitLockPaths(repoRoot);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, token: randomUUID(), acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    let recoveredStaleLock = false;
    await withGitLock(repoRoot, async () => {
      recoveredStaleLock = true;
    });
    assert.equal(recoveredStaleLock, true);
    writeFileSync(
      recoveryPath,
      `${JSON.stringify({ pid: 2_147_483_647, token: randomUUID(), acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await assert.rejects(
      withGitLock(repoRoot, async () => {}),
      (error) => error.kind === "git_lock_recovery_stale",
    );
    unlinkSync(recoveryPath);

    const heldSignal = path.join(repoRoot, ".todo", "lock-held");
    const childCode = `
      import { writeFileSync } from "node:fs";
      import { withGitLock } from ${JSON.stringify(import.meta.url)};
      await withGitLock(${JSON.stringify(repoRoot)}, async () => {
        writeFileSync(${JSON.stringify(heldSignal)}, "held");
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
    `;
    const holder = execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      childCode,
    ]);
    const signalDeadline = Date.now() + 2_000;
    while (!existsSync(heldSignal) && Date.now() < signalDeadline) {
      await sleep(10);
    }
    assert.equal(existsSync(heldSignal), true);
    const waitedAt = Date.now();
    await withGitLock(repoRoot, async () => {});
    assert.ok(Date.now() - waitedAt >= 200);
    await holder;
    unlinkSync(heldSignal);
    assert.equal(await output(repoRoot, ["rev-list", "--merges", "--count", "main"]), "0");
    return { status: "passed", branch: plan.branch };
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (process.argv[2] !== "--self-check") {
    process.stderr.write("Usage: node git-worktree.mjs --self-check\n");
    process.exitCode = 2;
  } else {
    runSelfCheck()
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
      });
  }
}
