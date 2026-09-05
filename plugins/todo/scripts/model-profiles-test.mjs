import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, resolveTaskExecution, resolveSavedExecution, resolvePipelineProfiles, initializeRepo, createTask, retryTask, setTaskError } from "./lib.mjs";

test("Astra defaults resolve into tasks and pipeline steps without replacing explicit profiles", () => {
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
    assert.equal(resolveTaskExecution(defaults).model, "gpt-6-astra");
    assert.equal(resolveTaskExecution(defaults).reasoningEffort, "xhigh");
    assert.equal(resolveTaskExecution(defaults, { modelProfile: "ultra" }).reasoningEffort, "max");
    assert.equal(defaults.pipeline.steps[0].model, "gpt-6-astra");
    assert.equal(defaults.pipeline.repair.model, "gpt-6-astra");
    assert.equal(defaults.pipeline.repair.reasoningEffort, "max");

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
    assert.equal(defaults.pipeline.repair.model, "gpt-6-astra");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { DEFAULT_MODEL_PROFILES, profileDiagnostic, modelProfilePlan, applyModelProfilePlan,
  assertProfilesAvailable, refreshModelCatalog } from "./model-profiles.mjs";
import { chmodSync, readFileSync } from "node:fs";

test("seven eligible executor models have task roles; invalid config never selects a fallback", () => {
  assert.equal(new Set(DEFAULT_MODEL_PROFILES.map(p => p.model)).size, 7);
  assert.ok(DEFAULT_MODEL_PROFILES.every(p => p.name !== "spark" && p.model !== "gpt-5.3-codex-spark"));
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

test("executor discovery reads every page, validates efforts and distinguishes unavailable Astra", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-model-discovery-"));
  try {
    mkdirSync(path.join(root, ".todo"));
    const command = path.join(root, "fake-codex");
    writeFileSync(command, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(!m.id)continue;
 const result=m.method==='model/list'?{data:[{model:'gpt-5.3-codex-spark',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:m.params.cursor?'custom-model':'gpt-5.6-sol',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:m.params.cursor?null:'page2'}:{};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
}
`.replace("const {createInterface}=require('node:readline');", "import {createInterface} from 'node:readline';"));
    chmodSync(command, 0o755);
    const catalog = await refreshModelCatalog(root, command);
    assert.deepEqual(catalog.models.map(m => m.model), ["gpt-5.6-sol", "custom-model"]);
    assert.equal(profileDiagnostic({ name: "expert", model: "gpt-6-astra", reasoningEffort: "xhigh" }, catalog).status, "unsupported");
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
    const previous = { backend: "exec", modelProfile: "expert", model: "obsolete-model", reasoningEffort: "low", ephemeral: true, mode: "background" };
    const current = resolveSavedExecution(config, previous);
    assert.equal(current.modelProfile, "expert");
    assert.equal(current.model, "gpt-6-astra");
    assert.equal(current.reasoningEffort, "xhigh");
    assert.equal(current.backend, "exec");
    assert.equal(current.ephemeral, true);
    assert.equal(previous.model, "obsolete-model");
    const oldPipeline = { steps: [
      { id: "work", type: "codex-exec", modelProfile: "fast", model: "old-step", reasoningEffort: "low" },
      { id: "test", type: "shell", command: "true" },
    ], repair: { type: "codex-thread", modelProfile: "ultra", model: "old-repair", reasoningEffort: "low" } };
    const resolved = resolvePipelineProfiles(config, oldPipeline, current);
    assert.equal(resolved.steps[0].model, "gpt-5.6-luna");
    assert.equal(resolved.repair.model, "gpt-6-astra");
    assert.equal(resolved.repair.reasoningEffort, "max");
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
    assert.equal(retried.execution.model, "gpt-6-astra");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
