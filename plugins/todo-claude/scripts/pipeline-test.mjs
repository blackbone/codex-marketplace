import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTask,
  initializeRepo,
  loadConfig,
  readTask,
  startInteractiveTask,
  finishInteractiveTask,
  getTaskStatus,
} from "./lib.mjs";
import {
  loadPipelineSnapshot,
  parseYamlSubset,
  runPipeline,
} from "./pipeline.mjs";

const pipelineText = `version: 1
name: required-quality
steps:
  - id: implement
    type: codex-thread
    modelProfile: expert
    prompt: |
      Implement the task without running Git delivery.
  - id: build
    type: shell
    command: npm run build
    timeoutSeconds: 300
  - id: test
    type: shell
    command: npm test
repair:
  type: codex-thread
  modelProfile: expert
  maxRounds: 2
  prompt: |
    Repair the failed validation step.
`;

const parsed = parseYamlSubset(pipelineText, "pipeline.yaml");
assert.equal(parsed.version, 1);
assert.equal(parsed.steps.length, 3);
assert.equal(parsed.steps[0].prompt, "Implement the task without running Git delivery.\n");
assert.equal(parsed.repair.maxRounds, 2);

const root = mkdtempSync(path.join(os.tmpdir(), "todo-pipeline-"));
assert.equal(spawnSync("git", ["init", "-b", "main"], { cwd: root }).status, 0);
spawnSync("git", ["config", "user.name", "ToDo Test"], { cwd: root });
spawnSync("git", ["config", "user.email", "todo@example.invalid"], { cwd: root });
writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
spawnSync("git", ["add", "README.md"], { cwd: root });
assert.equal(spawnSync("git", ["commit", "-m", "fixture"], { cwd: root }).status, 0);
initializeRepo(root);
const pipelineFile = path.join(root, "todo-pipeline.yaml");
writeFileSync(pipelineFile, pipelineText, "utf8");
const configFile = path.join(root, ".todo", "config.json");
const config = JSON.parse(readFileSync(configFile, "utf8"));
writeFileSync(
  configFile,
  `${JSON.stringify({ ...config, pipeline: { file: "todo-pipeline.yaml" } }, null, 2)}\n`,
  "utf8",
);
const loaded = loadConfig(root);
assert.equal(loaded.readError, null);
assert.equal(loaded.pipeline.name, "required-quality");
assert.match(loaded.pipeline.digest, /^[a-f0-9]{64}$/);

const task = createTask(root, {
  title: "Pipeline snapshot",
  description: "Keep the configured pipeline immutable for this task.",
});
const taskRecord = readTask(task.path);
assert.equal(taskRecord.metadata.pipeline.digest, loaded.pipeline.digest);
writeFileSync(pipelineFile, pipelineText.replace("npm test", "npm run test:changed"), "utf8");
const snapshot = loadPipelineSnapshot(root, taskRecord.metadata.pipeline);
assert.equal(snapshot.steps[2].command, "npm test");
assert.notEqual(loadConfig(root).pipeline.digest, snapshot.digest);
const interactiveClaim = await startInteractiveTask(root, task.id);
assert.equal(interactiveClaim.requiresPipelineValidation, true);
const queuedForValidation = await finishInteractiveTask(root, task.id, {
  claimToken: interactiveClaim.claimToken, status: "completed", summary: "Interactive work complete",
  validation: ["Interactive stage inspected"],
});
assert.equal(queuedForValidation.status, "queued");
assert.equal(queuedForValidation.pipelineContinuation.ready, true);
assert.notEqual(getTaskStatus(root, task.id).git.phase, "delivered");
const interactivePipeline = createTask(root, {
  title: "Interactive pipeline", description: "Return to mandatory gates after app execution.", runMode: "interactive",
});
assert.ok(interactivePipeline.pipeline);

writeFileSync(
  configFile,
  `${JSON.stringify({ ...config, pipeline: { file: "missing.yaml" } }, null, 2)}\n`,
  "utf8",
);
assert.match(loadConfig(root).readError, /pipeline file does not exist/);

const events = [];
let buildRuns = 0;
const completed = await runPipeline(snapshot, {
  runCodex: async (step, context) => {
    events.push(context.mode === "repair" ? "repair" : step.id);
    return {
      status: "completed",
      summary: context.mode === "repair" ? "repaired" : "implemented",
      validation: [],
      requiresInteractive: false,
      interactiveReason: null,
    };
  },
  runShell: async (step) => {
    events.push(step.id);
    if (step.id === "build") buildRuns += 1;
    const passed = step.id !== "build" || buildRuns > 1;
    return {
      status: passed ? "completed" : "failed",
      summary: passed ? `${step.id} passed` : `${step.id} failed`,
      error: passed ? null : "exit 1",
      validation: passed ? [`${step.id}: passed`] : [],
      requiresInteractive: false,
      interactiveReason: null,
    };
  },
});
assert.equal(completed.status, "completed");
assert.equal(completed.repairRound, 1);
assert.deepEqual(events, ["implement", "build", "repair", "build", "test"]);

const exhausted = await runPipeline(
  {
    ...snapshot,
    repair: { ...snapshot.repair, maxRounds: 1 },
  },
  {
    runCodex: async () => ({
      status: "completed",
      summary: "done",
      validation: [],
      requiresInteractive: false,
      interactiveReason: null,
    }),
    runShell: async () => ({
      status: "failed",
      summary: "still failing",
      error: "exit 1",
      validation: [],
      requiresInteractive: false,
      interactiveReason: null,
    }),
  },
);
assert.equal(exhausted.status, "failed");
assert.equal(exhausted.repairRound, 1);

assert.throws(
  () =>
    parseYamlSubset(
      "version: 1\nsteps:\n\t- id: invalid\n",
      "invalid.yaml",
    ),
  /tabs are unsupported/,
);

console.log("todo pipeline tests passed");
