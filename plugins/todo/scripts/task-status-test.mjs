import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { initializeRepo, createTask, completeTask, getTaskStatus } from "./lib.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "todo-status-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.name", "ToDo Test");
  git("config", "user.email", "todo@example.invalid");
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "-m", "fixture");
  initializeRepo(root);
  return { root, task: createTask(root, { title: "Status race", description: "Complete while reading status." }) };
}

// Force the daemon's completion exactly between the reader's existence check
// and filesystem operation. No sleeps or probabilistic concurrent scheduling.
function interceptTaskRead(t, operation, taskPath, action, readStatus) {
  const original = fs[operation];
  let intercepted = false;
  t.mock.method(fs, operation, function (file, ...args) {
    if (!intercepted && file === taskPath) {
      intercepted = true;
      action();
    }
    return original.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = readStatus();
    assert.equal(intercepted, true, "The requested race boundary must be exercised");
    return result;
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

for (const operation of ["readFileSync", "statSync"]) {
  for (const shorthand of [false, true]) {
    test(`completion during ${operation} returns history (${shorthand ? "numeric" : "full"} ID)`, t => {
      const { root, task } = fixture(t);
      let receipt;
      const status = interceptTaskRead(t, operation, task.path, () => {
        receipt = completeTask(root, task.path, { summary: "Finished", validation: ["checked"] });
      }, () => getTaskStatus(root, shorthand ? task.id.split("-")[0] : task.id));
      assert.deepEqual(status, receipt);
      assert.equal(status.status, "completed");
      assert.equal(fs.existsSync(task.path), false);
    });
  }
}

test("disappearing active file without history is unknown, not invalid metadata", t => {
  const { root, task } = fixture(t);
  const status = interceptTaskRead(t, "readFileSync", task.path,
    () => fs.unlinkSync(task.path), () => getTaskStatus(root, task.id));
  assert.deepEqual(status, { id: task.id, status: "unknown" });
});

test("malformed active metadata still reports its validation error", t => {
  const { root, task } = fixture(t);
  fs.writeFileSync(task.path, "not a task header\n");
  const status = getTaskStatus(root, task.id);
  assert.equal(status.status, "failed");
  assert.equal(status.error.kind, "invalid_metadata");
});

test("non-ENOENT stat failures are not hidden by history fallback", t => {
  const { root, task } = fixture(t);
  assert.throws(() => interceptTaskRead(t, "statSync", task.path, () => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" });
  }, () => getTaskStatus(root, task.id)), { code: "EACCES" });
});
