import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configPath, initializeRepo, readDaemonState } from "./lib.mjs";
import { ensureDaemon } from "./ensure-daemon.mjs";
import { cliModels, findCliModel, normalizeCliModels, profileProblems, readCliModels } from "./claude-models.mjs";
import { seedCliModels, TEST_CLI_MODELS } from "./test-cli-models.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-models-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"], ["commit", "--allow-empty", "-m", "fixture"]]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  initializeRepo(root);
  return root;
}

test("the CLI model list folds aliases into concrete ids with their efforts", () => {
  const models = normalizeCliModels([
    { value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "max"] },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
    { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", supportsEffort: true, supportedEffortLevels: ["low"] },
  ]);
  assert.deepEqual(models.map(m => m.model), ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-opus-4-6"]);
  assert.deepEqual(findCliModel(models, "opus")?.model, "claude-opus-5-5");
  assert.deepEqual(findCliModel(models, "claude-haiku-4-5")?.model, "claude-haiku-4-5-20251001");
  assert.equal(findCliModel(models, "claude-opus-4"), null);
  assert.equal(findCliModel(models, "claude-haiku-4-5")?.supportsEffort, false);
});

test("the list is cached per command and a failed refresh keeps the error", async t => {
  const root = fixture(t);
  let calls = 0;
  const fetch = async () => { calls += 1; return TEST_CLI_MODELS; };
  assert.equal((await cliModels(root, "claude", { fetch })).models.length, TEST_CLI_MODELS.length);
  await cliModels(root, "claude", { fetch });
  assert.equal(calls, 1);
  await cliModels(root, "claude", { fetch, force: true });
  assert.equal(calls, 2);
  assert.equal(readCliModels(root, "other-claude"), null);
  const failed = await cliModels(root, "claude", { force: true, fetch: async () => { throw new Error("spawn claude ENOENT"); } });
  assert.match(failed.error, /ENOENT/);
  assert.equal(failed.models.length, TEST_CLI_MODELS.length);
});

test("profile problems cover names, efforts, defaults and the model list", () => {
  const catalog = { models: TEST_CLI_MODELS, error: null };
  assert.deepEqual(profileProblems([{ name: "deep", model: "opus", reasoningEffort: "max" }], "deep", catalog), []);
  assert.deepEqual(profileProblems([{ name: "quick", model: "claude-haiku-4-5", reasoningEffort: "low" }], "quick", catalog), []);
  const problems = profileProblems([
    { name: "deep", model: "claude-opus-5-5", reasoningEffort: "max" },
    { name: "deep", model: "claude-opus-5-5", reasoningEffort: "high" },
    { name: "Bad", model: "claude-opus-5-5", reasoningEffort: "high" },
    { name: "older", model: "claude-sonnet-4-6", reasoningEffort: "xhigh" },
    { name: "typo", model: "claude-nope-1", reasoningEffort: "high" },
  ], "missing", catalog);
  const text = problems.map(p => `${p.profile}:${p.field}`);
  for (const expected of ["deep:name", "Bad:name", "older:reasoningEffort", "typo:model"]) assert.ok(text.includes(expected), expected);
  assert.ok(problems.some(p => p.field === "defaultModelProfile"));
  assert.ok(profileProblems(catalog.models.length ? [] : [], "x", catalog).length === 1);
  assert.equal(profileProblems([{ name: "a", model: "opus", reasoningEffort: "low" }], "a", null)[0].unchecked, true);
  assert.match(profileProblems([{ name: "a", model: "opus", reasoningEffort: "low" }], "a", { models: [], error: "boom" })[0].message, /unavailable: boom/);
});

test("the runner does not start while a profile names a model outside the CLI list", async t => {
  const root = fixture(t);
  seedCliModels(root);
  const config = JSON.parse(readFileSync(configPath(root), "utf8"));
  config.models = { claude: [
    { name: "advanced", model: "claude-opus-5-5", reasoningEffort: "high" },
    { name: "typo", model: "claude-opus-9-9", reasoningEffort: "high" },
  ] };
  config.defaultModelProfile = "advanced";
  writeFileSync(configPath(root), JSON.stringify(config));
  const result = ensureDaemon(root);
  assert.equal(result.status, "start-blocked");
  assert.match(result.reason, /typo: Model 'claude-opus-9-9' is not in the Claude CLI model list/);
  assert.match(result.reason, /Settings/);
  assert.equal(result.profileProblems[0].profile, "typo");
  assert.equal(readDaemonState(root), null);
});
