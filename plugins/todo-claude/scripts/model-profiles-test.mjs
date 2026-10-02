import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, resolveTaskExecution, resolveSavedExecution, resolvePipelineProfiles, initializeRepo, createTask, retryTask, setTaskError } from "./lib.mjs";

test("Opus defaults resolve into tasks and pipeline steps without replacing explicit profiles", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-model-profiles-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const pipeline = { file: "quality.yaml" };
    writeFileSync(path.join(root, pipeline.file), `version: 1
steps:
  - id: implement
    type: codex-thread
    modelProfile: expert
    prompt: Implement.
  - id: test
    type: shell
    command: "true"
repair:
  type: codex-exec
  modelProfile: ultra
  prompt: Repair.
  maxRounds: 1
`);
    writeFileSync(file, JSON.stringify({ pipeline }));
    const defaults = loadConfig(root);
    assert.equal(defaults.readError, null);
    assert.equal(resolveTaskExecution(defaults).model, "claude-opus-5-5");
    assert.equal(resolveTaskExecution(defaults).reasoningEffort, "xhigh");
    assert.equal(resolveTaskExecution(defaults, { modelProfile: "ultra" }).reasoningEffort, "max");
    assert.equal(defaults.pipeline.steps[0].model, "claude-opus-5-5");
    assert.equal(defaults.pipeline.repair.model, "claude-opus-5-5");
    assert.equal(defaults.pipeline.repair.reasoningEffort, "max");

    const explicit = defaults.modelProfiles.map(profile => ({ ...profile,
      ...(profile.name === "expert" || profile.name === "ultra"
        ? { model: "claude-sonnet-5-5", reasoningEffort: "high" } : {}),
    }));
    writeFileSync(file, JSON.stringify({ models: { codex: [{ name: "expert", model: "gpt-6-astra", reasoningEffort: "xhigh" }], claude: explicit }, pipeline }));
    const configured = loadConfig(root);
    assert.deepEqual(configured.modelProfiles, explicit);
    assert.equal(resolveTaskExecution(configured).model, "claude-sonnet-5-5");
    assert.equal(configured.pipeline.repair.model, "claude-sonnet-5-5");
    assert.notEqual(configured.pipeline.digest, defaults.pipeline.digest);
    assert.equal(defaults.pipeline.repair.model, "claude-opus-5-5");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { DEFAULT_MODEL_PROFILES, profileDiagnostic, modelProfilePlan, applyModelProfilePlan,
  assertProfilesAvailable, refreshModelCatalog } from "./model-profiles.mjs";
import { chmodSync, readFileSync } from "node:fs";

test("built-ins use Sonnet for routine work and Opus for heavy work; invalid config never selects a fallback", () => {
  assert.deepEqual(DEFAULT_MODEL_PROFILES.map(({ name, model, reasoningEffort }) => [name, model, reasoningEffort]), [
    ["mini", "claude-sonnet-5-5", "low"], ["fast", "claude-sonnet-5-5", "medium"],
    ["standard", "claude-sonnet-5-5", "high"], ["medium", "claude-sonnet-5-5", "xhigh"],
    ["proven", "claude-opus-5-5", "medium"], ["advanced", "claude-opus-5-5", "high"],
    ["expert", "claude-opus-5-5", "xhigh"], ["ultra", "claude-opus-5-5", "max"],
  ]);
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-invalid-models-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    for (const config of [{ models: { claude: [] } }, { models: { claude: "old" } }, { models: { claude: [{ name: "custom", model: "old", reasoningEffort: "typo" }] } }, { defaultModelProfile: "removed" }]) {
      writeFileSync(path.join(root, ".todo/config.json"), JSON.stringify(config));
      const loaded = loadConfig(root);
      assert.ok(loaded.readError);
      assert.throws(() => resolveTaskExecution(loaded), /custom|Custom/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("omitted models remain inherited and old task models resolve through the same current profile", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-inherited-models-"));
  try {
    assert.equal(spawnSync("git", ["init", "-b", "main"], { cwd: root }).status, 0);
    initializeRepo(root);
    const file = path.join(root, ".todo/config.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(Object.hasOwn(raw, "models"), false);
    const config = loadConfig(root);
    for (const [name, oldModel] of Object.entries({ mini: "gpt-6-luna", fast: "gpt-6-luna", standard: "gpt-6-sol", medium: "gpt-6-sol", proven: "gpt-6-sol", advanced: "gpt-5.6-sol" })) {
      const profile = DEFAULT_MODEL_PROFILES.find(p => p.name === name);
      const execution = resolveSavedExecution(config, { modelProfile: name, model: oldModel, reasoningEffort: "high" });
      assert.equal(execution.model, profile.model);
      assert.equal(execution.reasoningEffort, profile.reasoningEffort);
      const pipeline = resolvePipelineProfiles(config, { steps: [{ id: "work", type: "codex-thread", modelProfile: name, model: oldModel }], repair: null }, execution);
      assert.equal(pipeline.steps[0].model, profile.model);
      assert.equal(pipeline.steps[0].reasoningEffort, profile.reasoningEffort);
    }
    const previous = { backend: "exec", modelProfile: "expert", model: "obsolete-model", reasoningEffort: "low", ephemeral: true, mode: "background" };
    const current = resolveSavedExecution(config, previous);
    assert.equal(current.modelProfile, "expert");
    assert.equal(current.model, "claude-opus-5-5");
    assert.equal(current.reasoningEffort, "xhigh");
    assert.equal(current.backend, "app-server");
    assert.equal(current.ephemeral, true);
    assert.equal(previous.model, "obsolete-model");
    const oldPipeline = { steps: [
      { id: "work", type: "codex-exec", modelProfile: "fast", model: "old-step", reasoningEffort: "low" },
      { id: "test", type: "shell", command: "true" },
    ], repair: { type: "codex-thread", modelProfile: "ultra", model: "old-repair", reasoningEffort: "low" } };
    const resolved = resolvePipelineProfiles(config, oldPipeline, current);
    assert.equal(resolved.steps[0].model, "claude-sonnet-5-5");
    assert.equal(resolved.repair.model, "claude-opus-5-5");
    assert.equal(resolved.repair.reasoningEffort, "max");
    assert.deepEqual(resolved.steps[1], oldPipeline.steps[1]);
    assert.equal(oldPipeline.steps[0].model, "old-step");
    assert.throws(() => resolveSavedExecution(config, { ...previous, modelProfile: "removed-profile" }), /Unknown modelProfile/);
    const catalog = { command: "claude", checkedAt: new Date().toISOString(), models: [] };
    const plan = modelProfilePlan(root, catalog);
    assert.equal(plan.source, "plugin");
    assert.equal(plan.changed, false);
    assert.equal(applyModelProfilePlan(root, catalog, plan.planId).applied, false);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, "utf8")), "models"), false);
    spawnSync("git", ["add", "."], { cwd: root });
    assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: root }).status, 0);
    writeFileSync(file, JSON.stringify({ ...raw, models: { claude: [{ name: "expert", model: "old-model", reasoningEffort: "high" }] } }));
    const saved = createTask(root, { title: "Refresh model", description: "Keep the profile" });
    setTaskError(saved.path, "model_unavailable", null, "Old model retired");
    writeFileSync(file, JSON.stringify(raw));
    const retried = retryTask(root, saved.id);
    assert.equal(retried.execution.modelProfile, "expert");
    assert.equal(retried.execution.model, "claude-opus-5-5");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model updates write the Claude profiles and keep the Codex array", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-host-models-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const codex = [{ name: "expert", model: "gpt-6-astra", reasoningEffort: "xhigh" }];
    const claude = [{ name: "expert", model: "claude-opus-5-5", reasoningEffort: "high" }, { name: "retired", model: "claude-old", reasoningEffort: "low" }];
    writeFileSync(file, JSON.stringify({ models: { codex, claude }, defaultModelProfile: "expert" }));
    const fake = path.join(path.dirname(new URL(import.meta.url).pathname), "claude-fake.test.mjs");
    chmodSync(fake, 0o755);
    const catalog = await refreshModelCatalog(root, fake, { force: true });
    const plan = modelProfilePlan(root, catalog);
    assert.equal(plan.changed, true);
    assert.equal(plan.changes.find(change => change.profile === "retired").action, "remove");
    assert.equal(applyModelProfilePlan(root, catalog, plan.planId).applied, true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved.models.codex, codex);
    assert.equal(saved.models.claude.find(p => p.name === "expert").model, "claude-opus-5-5");
    assert.equal(saved.models.claude.some(p => p.name === "retired"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saved former Haiku and Fable built-ins migrate to Sonnet and Opus", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-former-builtins-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const former = [
      ["mini", "claude-haiku-4-5", "low", "Small, mechanical edits and simple bounded fixes."],
      ["proven", "claude-sonnet-5-5", "high", "Multi-step engineering and debugging with high reasoning."],
      ["expert", "claude-fable-5-1", "xhigh", "Most capable model for complex implementation work."],
      ["ultra", "claude-fable-5-1", "max", "Most capable model for very complex, high-risk, cross-cutting work."],
    ].map(([name, model, reasoningEffort, description]) => ({ name, model, reasoningEffort, description }));
    writeFileSync(path.join(root, ".todo/config.json"), JSON.stringify({ models: { claude: former } }));
    const fake = path.join(path.dirname(new URL(import.meta.url).pathname), "claude-fake.test.mjs");
    chmodSync(fake, 0o755);
    const plan = modelProfilePlan(root, await refreshModelCatalog(root, fake, { force: true }));
    const proposed = Object.fromEntries(plan.proposed.models.map(p => [p.name, `${p.model}/${p.reasoningEffort}`]));
    assert.equal(proposed.mini, "claude-sonnet-5-5/low");
    assert.equal(proposed.proven, "claude-opus-5-5/medium");
    assert.equal(proposed.expert, "claude-opus-5-5/xhigh");
    assert.equal(proposed.ultra, "claude-opus-5-5/max");
    assert.equal(plan.proposed.models.some(p => /haiku|fable/.test(p.model)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("built-in recommendations do not downgrade unavailable efforts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-effort-availability-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const ultra = DEFAULT_MODEL_PROFILES.find(p => p.name === "ultra");
    const catalog = { command: "claude", checkedAt: new Date().toISOString(), models: [
      { model: ultra.model, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ] };
    writeFileSync(file, "{}");
    assert.equal(modelProfilePlan(root, catalog).diagnostics.find(p => p.name === "ultra").status, "unsupported-effort");
    assert.throws(() => resolveTaskExecution({ ...loadConfig(root), modelCatalog: catalog }, { modelProfile: "ultra" }), /not supported/);
    writeFileSync(file, JSON.stringify({ models: { claude: [] } }));
    const plan = modelProfilePlan(root, catalog);
    assert.ok(!plan.proposed.models.some(p => p.name === "ultra"));
    assert.ok(plan.proposed.models.every(p => profileDiagnostic(p, catalog).status === "available"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
