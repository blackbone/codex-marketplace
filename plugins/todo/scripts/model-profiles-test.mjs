import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, resolveTaskExecution, resolveSavedExecution, resolvePipelineProfiles, initializeRepo, createTask, retryTask, setTaskError } from "./lib.mjs";

test("Sol 6.1 defaults resolve into tasks and pipeline steps without replacing explicit profiles", () => {
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
    assert.equal(resolveTaskExecution(defaults).model, "gpt-6.1-sol");
    assert.equal(resolveTaskExecution(defaults).reasoningEffort, "max");
    assert.equal(resolveTaskExecution(defaults, { modelProfile: "ultra" }).reasoningEffort, "ultra");
    assert.equal(defaults.pipeline.steps[0].model, "gpt-6.1-sol");
    assert.equal(defaults.pipeline.repair.model, "gpt-6.1-sol");
    assert.equal(defaults.pipeline.repair.reasoningEffort, "ultra");

    const explicit = defaults.modelProfiles.map(profile => ({ ...profile,
      ...(profile.name === "expert" || profile.name === "ultra"
        ? { model: "gpt-5.6-sol", reasoningEffort: "high" } : {}),
    }));
    writeFileSync(file, JSON.stringify({ models: explicit, pipeline }));
    const configured = loadConfig(root);
    assert.deepEqual(configured.modelProfiles, explicit);
    assert.equal(resolveTaskExecution(configured).model, "gpt-5.6-sol");
    assert.equal(configured.pipeline.repair.model, "gpt-5.6-sol");
    assert.notEqual(configured.pipeline.digest, defaults.pipeline.digest);
    assert.equal(defaults.pipeline.repair.model, "gpt-6.1-sol");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { DEFAULT_MODEL_PROFILES, profileDiagnostic, modelProfilePlan, applyModelProfilePlan,
  assertProfilesAvailable, refreshModelCatalog } from "./model-profiles.mjs";
import { chmodSync, readFileSync } from "node:fs";

test("Sol 6.1 powers standard through ultra, with Luna for small tasks; invalid config never selects a fallback", () => {
  assert.deepEqual(DEFAULT_MODEL_PROFILES.map(({ name, model, reasoningEffort }) => [name, model, reasoningEffort]), [
    ["mini", "gpt-6-luna", "low"], ["fast", "gpt-6-luna", "medium"],
    ["standard", "gpt-6.1-sol", "low"], ["medium", "gpt-6.1-sol", "medium"],
    ["proven", "gpt-6.1-sol", "high"], ["advanced", "gpt-6.1-sol", "xhigh"],
    ["expert", "gpt-6.1-sol", "max"], ["ultra", "gpt-6.1-sol", "ultra"],
  ]);
  assert.ok(DEFAULT_MODEL_PROFILES.every(p => p.name !== "spark" && !["gpt-5.3-codex-spark", "gpt-6-astra"].includes(p.model)));
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-invalid-models-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    for (const config of [{ models: [] }, { models: "old" }, { models: [{ name: "custom", model: "old", reasoningEffort: "typo" }] }, { defaultModelProfile: "removed" }]) {
      writeFileSync(path.join(root, ".todo/config.json"), JSON.stringify(config));
      const loaded = loadConfig(root);
      assert.ok(loaded.readError);
      assert.throws(() => resolveTaskExecution(loaded), /custom|Custom/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy builtin copies migrate while custom profiles and pipeline references survive", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-legacy-profiles-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const oldModels = { mini: "gpt-5.4-mini", standard: "gpt-5.4", proven: "gpt-5.5", expert: "gpt-5.6-sol", ultra: "gpt-5.6-sol" };
    const custom = { name: "custom", model: "gpt-5.5", reasoningEffort: "high", description: "Intentional override" };
    const original = { workers: 3, defaultModelProfile: "mini", pipeline: { file: "quality.yaml" },
      models: [...DEFAULT_MODEL_PROFILES.map(p => oldModels[p.name] ? { ...p, model: oldModels[p.name], reasoningEffort: "high" } : p), custom] };
    writeFileSync(file, JSON.stringify(original));
    // The executor still offers 5.5 but has removed both 5.4 models.
    const catalog = { command: "codex", checkedAt: new Date().toISOString(), models:
      [...new Set([...DEFAULT_MODEL_PROFILES.map(p => p.model), "gpt-5.5", "gpt-5", "gpt-4.1"])].map(model => ({
        model, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium",
      })) };
    const plan = modelProfilePlan(root, catalog);
    for (const name of Object.keys(oldModels)) {
      assert.deepEqual(plan.proposed.models.find(p => p.name === name), DEFAULT_MODEL_PROFILES.find(p => p.name === name));
    }
    assert.deepEqual(plan.proposed.models.find(p => p.name === "custom"), custom);
    assert.equal(plan.proposed.models.length, 9, "do not automatically rediscover older GPT generations");
    assertProfilesAvailable(plan.proposed.models, catalog);
    applyModelProfilePlan(root, catalog, plan.planId);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual({ ...saved, models: original.models }, original);
    assert.equal(modelProfilePlan(root, catalog).changed, false);
    // Discovery also must not add 5.5 when no intentional custom profile uses it.
    writeFileSync(file, JSON.stringify({ ...saved, models: saved.models.filter(p => p.name !== "custom") }));
    assert.equal(modelProfilePlan(root, catalog).changed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GPT-6 defaults migrate once, preserve custom overrides, and wait for available targets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-quality-migration-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const previous = [
      ["mini", "gpt-6-luna", "low"], ["fast", "gpt-6-luna", "medium"],
      ["standard", "gpt-6-sol", "low"], ["medium", "gpt-6-sol", "medium"],
      ["proven", "gpt-6-sol", "high"], ["advanced", "gpt-6-sol", "xhigh"],
    ].map(([name, model, reasoningEffort]) => ({ name, model, reasoningEffort,
      description: name === "advanced" ? "Multi-step implementation, debugging, and substantial refactoring with extra reasoning."
        : DEFAULT_MODEL_PROFILES.find(p => p.name === name).description,
    }));
    const catalog = { command: "codex", checkedAt: new Date().toISOString(), models:
      [...new Set([...DEFAULT_MODEL_PROFILES.map(p => p.model), ...previous.map(p => p.model)])].map(model => ({
        model, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium",
      })) };
    const original = { workers: 3, defaultModelProfile: "medium", pipeline: { file: "quality.yaml" },
      models: [...previous, ...DEFAULT_MODEL_PROFILES.filter(p => ["expert", "ultra"].includes(p.name))] };
    writeFileSync(file, JSON.stringify(original));
    const plan = modelProfilePlan(root, catalog);
    assert.deepEqual(plan.proposed.models, DEFAULT_MODEL_PROFILES);
    assert.equal(plan.changes.filter(p => p.action === "update").length, 4);
    assert.equal(plan.proposed.defaultModelProfile, "medium");
    assertProfilesAvailable(plan.proposed.models, catalog);
    applyModelProfilePlan(root, catalog, plan.planId);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ...original, models: DEFAULT_MODEL_PROFILES });
    assert.equal(modelProfilePlan(root, catalog).changed, false);

    const overrides = [
      { ...previous[1], reasoningEffort: "high" },
      { ...previous[2], description: "Keep my GPT-6 workflow" },
      { name: "custom", model: "gpt-6-sol", reasoningEffort: "high" },
    ];
    writeFileSync(file, JSON.stringify({ ...original, models: overrides }));
    const customPlan = modelProfilePlan(root, catalog);
    for (const override of overrides) {
      assert.deepEqual(customPlan.proposed.models.find(p => p.name === override.name), override);
    }

    writeFileSync(file, JSON.stringify(original));
    const oldCatalog = { ...catalog, models: catalog.models.filter(m => m.model !== "gpt-6.1-sol") };
    const unavailablePlan = modelProfilePlan(root, oldCatalog);
    for (const profile of previous) {
      assert.deepEqual(unavailablePlan.proposed.models.find(p => p.name === profile.name), profile);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Spark is removed from stale profiles and cannot return through discovery or execution", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-no-spark-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const spark = { name: "custom-spark", model: "gpt-5.3-codex-spark", reasoningEffort: "high" };
    const expert = DEFAULT_MODEL_PROFILES.find(p => p.name === "expert");
    writeFileSync(file, JSON.stringify({ models: [spark, expert], defaultModelProfile: "expert" }));
    assert.throws(() => resolveSavedExecution(loadConfig(root), { modelProfile: spark.name }), /Spark has been removed/);
    const catalog = { command: "codex", checkedAt: new Date().toISOString(), models: [
      { model: spark.model, efforts: ["high"], defaultEffort: "high" },
      { model: expert.model, efforts: ["xhigh", "max"], defaultEffort: "xhigh" },
    ] };
    const plan = modelProfilePlan(root, catalog);
    assert.equal(plan.diagnostics[0].status, "excluded");
    assert.equal(plan.changes.find(p => p.profile === spark.name).action, "remove");
    assert.ok(plan.models.every(p => p.model !== spark.model));
    assert.ok(plan.proposed.models.every(p => p.model !== spark.model));
    applyModelProfilePlan(root, catalog, plan.planId);
    assert.equal(modelProfilePlan(root, catalog).changed, false);
    writeFileSync(file, "{}");
    const inherited = modelProfilePlan(root, catalog);
    assert.ok(inherited.models.every(p => p.model !== spark.model));
    assert.ok(inherited.proposed.models.every(p => p.model !== spark.model));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model update previews retirement/replacements, preserves custom profiles, and rejects stale approval", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-model-update-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const original = { workers: 7, defaultModelProfile: "advanced", models: [
      { name: "advanced", model: "gpt-5.6-sol", reasoningEffort: "low", description: "My workflow" },
      { name: "old", model: "gpt-5.4", reasoningEffort: "high" },
      { name: "gone", model: "removed-model", reasoningEffort: "high" },
      { name: "effort", model: "gpt-5.6-sol", reasoningEffort: "ultra" },
    ] };
    writeFileSync(file, JSON.stringify(original));
    const catalog = { command: "codex", checkedAt: new Date().toISOString(), models: [
      { model: "gpt-5.6-sol", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { model: "gpt-5.4", efforts: ["high"], retirementAt: 1, upgrade: "gpt-5.6-sol" },
      { model: "new-model", efforts: ["medium"], defaultEffort: "medium", description: "New runtime model" },
    ] };
    const plan = modelProfilePlan(root, catalog);
    assert.deepEqual(plan.diagnostics.map(p => p.status), ["available", "retired", "unsupported", "unsupported-effort"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original);
    assert.equal(plan.proposed.models.find(p => p.name === "advanced").reasoningEffort, "low");
    assert.equal(plan.proposed.models.find(p => p.name === "old").model, "gpt-5.6-sol");
    assert.equal(plan.proposed.models.find(p => p.name === "effort").reasoningEffort, "medium");
    assert.equal(plan.proposed.models.some(p => p.name === "gone"), false);
    assert.ok(plan.proposed.models.some(p => p.model === "new-model"));
    assert.throws(() => assertProfilesAvailable([original.models[2]], catalog), /outdated or unavailable/);
    const applied = applyModelProfilePlan(root, catalog, plan.planId);
    assert.deepEqual(JSON.parse(readFileSync(applied.backupPath, "utf8")), original);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).workers, 7);
    assert.equal(loadConfig(root).readError, null);
    assert.equal(modelProfilePlan(root, catalog).changed, false, "repeated inspection must not add duplicate profiles");
    assert.throws(() => applyModelProfilePlan(root, catalog, plan.planId), /stale/);
    assert.equal(profileDiagnostic(original.models[0], null).status, "unverified");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("executor discovery reads every page, validates efforts and distinguishes unavailable Sol 6.1", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-model-discovery-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const command = path.join(root, "fake-codex");
    writeFileSync(command, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(!m.id)continue;
 const result=m.method==='model/list'?{data:[{model:'gpt-6-astra',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:'gpt-5.3-codex-spark',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:m.params.cursor?'custom-model':'gpt-5.6-sol',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:m.params.cursor?null:'page2'}:{};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
}
`.replace("const {createInterface}=require('node:readline');", "import {createInterface} from 'node:readline';"));
    chmodSync(command, 0o755);
    const catalog = await refreshModelCatalog(root, command);
    assert.deepEqual(catalog.models.map(m => m.model), ["gpt-5.6-sol", "custom-model"]);
    assert.equal(profileDiagnostic({ name: "expert", model: "gpt-6.1-sol", reasoningEffort: "xhigh" }, catalog).status, "unsupported");
    assert.equal(profileDiagnostic({ name: "custom", model: "custom-model", reasoningEffort: "ultra" }, catalog).status, "unsupported-effort");
    assert.equal((await refreshModelCatalog(root, command)).checkedAt, catalog.checkedAt);
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
    for (const [name, oldModel] of Object.entries({ mini: "gpt-6-luna", fast: "gpt-6-luna", standard: "gpt-6-sol", medium: "gpt-6-sol", proven: "gpt-6-sol", advanced: "gpt-5.6-sol", expert: "gpt-6-astra", ultra: "gpt-6-astra" })) {
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
    assert.equal(current.model, "gpt-6.1-sol");
    assert.equal(current.reasoningEffort, "max");
    assert.equal(current.backend, "app-server");
    assert.equal(current.ephemeral, true);
    assert.equal(previous.model, "obsolete-model");
    const oldPipeline = { steps: [
      { id: "work", type: "codex-exec", modelProfile: "fast", model: "old-step", reasoningEffort: "low" },
      { id: "test", type: "shell", command: "true" },
    ], repair: { type: "codex-thread", modelProfile: "ultra", model: "old-repair", reasoningEffort: "low" } };
    const resolved = resolvePipelineProfiles(config, oldPipeline, current);
    assert.equal(resolved.steps[0].model, "gpt-6-luna");
    assert.equal(resolved.repair.model, "gpt-6.1-sol");
    assert.equal(resolved.repair.reasoningEffort, "ultra");
    assert.deepEqual(resolved.steps[1], oldPipeline.steps[1]);
    assert.equal(oldPipeline.steps[0].model, "old-step");
    assert.throws(() => resolveSavedExecution(config, { ...previous, modelProfile: "removed-profile" }), /Unknown modelProfile/);
    const catalog = { command: "codex", checkedAt: new Date().toISOString(), models: [] };
    const plan = modelProfilePlan(root, catalog);
    assert.equal(plan.source, "plugin");
    assert.equal(plan.changed, false);
    assert.equal(applyModelProfilePlan(root, catalog, plan.planId).applied, false);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(file, "utf8")), "models"), false);
    spawnSync("git", ["add", "."], { cwd: root });
    assert.equal(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: root }).status, 0);
    writeFileSync(file, JSON.stringify({ ...raw, models: [{ name: "expert", model: "old-model", reasoningEffort: "high" }] }));
    const saved = createTask(root, { title: "Refresh model", description: "Keep the profile" });
    setTaskError(saved.path, "model_unavailable", null, "Old model retired");
    writeFileSync(file, JSON.stringify(raw));
    const retried = retryTask(root, saved.id);
    assert.equal(retried.execution.modelProfile, "expert");
    assert.equal(retried.execution.model, "gpt-6.1-sol");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("latest Sol 5.6 and Astra defaults migrate, while custom Astra is excluded", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-sol61-migration-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const prior = [
      { name: "advanced", model: "gpt-5.6-sol", reasoningEffort: "max", description: "Deep debugging and substantial refactoring with maximum reasoning." },
      { name: "expert", model: "gpt-6-astra", reasoningEffort: "xhigh", description: "Most capable model for complex implementation work." },
      { name: "ultra", model: "gpt-6-astra", reasoningEffort: "max", description: "Most capable model for very complex, high-risk, cross-cutting work." },
    ];
    const customAstra = { name: "custom-astra", model: "gpt-6-astra", reasoningEffort: "low" };
    const customSol = { name: "sol56", model: "gpt-5.6-sol", reasoningEffort: "max" };
    const claude = [{ name: "expert", model: "claude-fable-5-1", reasoningEffort: "xhigh" }];
    const original = { defaultModelProfile: "expert", models: { codex: [...prior, customAstra, customSol], claude } };
    writeFileSync(file, JSON.stringify(original));
    const catalog = { command: "codex", checkedAt: new Date().toISOString(), models:
      ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-5.6-sol"].map(model => ({
        model, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium",
      })) };
    assert.throws(() => resolveSavedExecution(loadConfig(root), { modelProfile: customAstra.name }), /Astra has been removed/);
    assert.throws(() => resolveTaskExecution(loadConfig(root)), /Astra has been removed/);
    const plan = modelProfilePlan(root, catalog);
    for (const old of prior) assert.deepEqual(plan.proposed.models.find(p => p.name === old.name), DEFAULT_MODEL_PROFILES.find(p => p.name === old.name));
    assert.deepEqual(plan.proposed.models.find(p => p.name === customSol.name), customSol);
    assert.ok(plan.models.every(m => m.model !== "gpt-6-astra"));
    assert.ok(plan.proposed.models.every(m => m.model !== "gpt-6-astra"));
    assert.equal(plan.changes.find(p => p.profile === customAstra.name).action, "remove");
    applyModelProfilePlan(root, catalog, plan.planId);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(saved.models.claude, claude);
    assert.equal(saved.defaultModelProfile, "expert");
    assert.equal(modelProfilePlan(root, catalog).changed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("built-in recommendations do not downgrade unavailable efforts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-effort-availability-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const file = path.join(root, ".todo/config.json");
    const ultra = DEFAULT_MODEL_PROFILES.find(p => p.name === "ultra");
    const catalog = { command: "codex", checkedAt: new Date().toISOString(), models: [
      { model: ultra.model, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ] };
    writeFileSync(file, "{}");
    assert.equal(modelProfilePlan(root, catalog).diagnostics.find(p => p.name === "ultra").status, "unsupported-effort");
    assert.throws(() => resolveTaskExecution({ ...loadConfig(root), modelCatalog: catalog }, { modelProfile: "ultra" }), /not supported/);
    writeFileSync(file, JSON.stringify({ models: { codex: [] } }));
    const plan = modelProfilePlan(root, catalog);
    assert.ok(!plan.proposed.models.some(p => p.name === "ultra"));
    assert.ok(plan.proposed.models.every(p => profileDiagnostic(p, catalog).status === "available"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
