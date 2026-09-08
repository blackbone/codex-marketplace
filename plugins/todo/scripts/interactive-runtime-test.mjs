import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimTask, cleanupStaleClaims, createTask, finishInteractiveTask, formatTaskThreadTitle,
  getTaskStatus, initializeRepo, readTask, reconcileInteractiveClaim, releaseClaim,
  startInteractiveTask, waitForTaskInput, writeTask } from "./lib.mjs";
import { createTaskInteraction } from "./task-interaction.mjs";
import { executionOwner } from "./execution-owner.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { runPipeline } from "./pipeline.mjs";
import { startDashboard } from "./dashboard.mjs";
import { appendTaskChat, parseChatEvents, readTaskChat } from "./task-chat.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-interaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"], ["commit", "--allow-empty", "-m", "fixture"]]) {
    assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
  }
  initializeRepo(root);
  return root;
}
const owner = { threadId: "app-thread", turnId: "app-turn" };
const completed = { status: "completed", summary: "Stage finished", validation: ["Verified"], requiresInteractive: false };

test("interactive claims belong to an exact app turn and recover only after its confirmed end", async t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Native lifecycle", description: "An app task", runMode: "interactive" });
  const run = await startInteractiveTask(root, task.id, { owner });
  assert.equal((await startInteractiveTask(root, task.id, { owner })).claimToken, run.claimToken);
  assert.equal(formatTaskThreadTitle(root, task), `${path.basename(root)} [001]: Native lifecycle`);
  await assert.rejects(finishInteractiveTask(root, task.id, { ...completed, claimToken: run.claimToken,
    owner: { ...owner, turnId: "other" } }), /another executor turn/);
  const claimFile = `${task.path}.lock`;
  const lock = JSON.parse(readFileSync(claimFile));
  writeFileSync(claimFile, JSON.stringify({ ...lock, pid: 99999999 }));
  cleanupStaleClaims(root);
  assert(existsSync(claimFile), "a shared MCP PID cannot expire a native owner");
  const observed = { thread: { id: owner.threadId, status: { type: "active" } }, turns: [{ id: owner.turnId, status: "completed" }] };
  assert.equal(reconcileInteractiveClaim(root, task.id, observed, run.claimToken), false);
  observed.thread.status.type = "idle";
  assert.equal(reconcileInteractiveClaim(root, task.id, observed, "stale-token"), false);
  assert.equal(reconcileInteractiveClaim(root, task.id, observed, run.claimToken), true);
  assert.equal(getTaskStatus(root, task.id).status, "waiting-input");
  const nextOwner = { ...owner, turnId: "next-turn" };
  const next = await startInteractiveTask(root, task.id, { owner: nextOwner });
  assert.notEqual(next.claimToken, run.claimToken);
  assert.equal(reconcileInteractiveClaim(root, task.id, observed, run.claimToken), false);
  waitForTaskInput(root, task.id, { claimToken: next.claimToken, owner: nextOwner, question: "Which layout?" });
  assert.equal(getTaskStatus(root, task.id).interaction.question, "Which layout?");
  assert.equal(getTaskStatus(root, task.id).claim, null);
});

test("Stop cannot release a newer turn or a claim without exact turn evidence", async t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Stop hook", description: "Keep turn ownership", runMode: "interactive" });
  await startInteractiveTask(root, task.id, { owner });
  const stop = turn_id => spawnSync(process.execPath, [path.join(scripts, "interactive-stop.mjs")], {
    input: JSON.stringify({ hook_event_name: "Stop", cwd: root, session_id: owner.threadId, turn_id }), encoding: "utf8",
  });
  assert.equal(stop(undefined).status, 0);
  assert.equal(stop("old-turn").status, 0);
  assert.equal(getTaskStatus(root, task.id).status, "running");
  assert.equal(stop(owner.turnId).status, 0);
  assert.equal(getTaskStatus(root, task.id).status, "waiting-input");
});

test("a live input answer is fenced by request and claim; steering is fenced by turn", async t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Ask a question", description: "Need a decision" });
  const claim = claimTask(task.path, "worker-1");
  const active = new Map([[task.id, { taskId: task.id, taskPath: task.path, claim, threadId: "worker", turnId: "turn" }]]);
  const steers = [];
  const control = createTaskInteraction({ repoRoot: root, active,
    getAppServer: () => ({ steerTurn: (...args) => { steers.push(args); return { turnId: "turn" }; } }) });
  const response = control.onServerRequest({ method: "item/tool/requestUserInput", params: {
    threadId: "worker", turnId: "turn", questions: [{ id: "color", question: "Which color?" }],
  } });
  const requestId = getTaskStatus(root, task.id).interaction.requestId;
  assert.equal(getTaskStatus(root, task.id).status, "waiting-input");
  await assert.rejects(control.action({ taskId: task.id, action: "reply", requestId: "stale", answers: { color: "Blue" } }), /no longer active/);
  await assert.rejects(control.action({ taskId: task.id, action: "reply", requestId, answers: {} }), /Answer required/);
  await control.action({ taskId: task.id, action: "reply", requestId, answers: { color: "Blue" } });
  assert.deepEqual(await response, { answers: { color: { answers: ["Blue"] } } });
  assert.equal(getTaskStatus(root, task.id).status, "running");
  await assert.rejects(control.action({ taskId: task.id, action: "steer", expectedTurnId: "old", text: "Change" }), /active turn changed/);
  await control.action({ taskId: task.id, action: "steer", expectedTurnId: "turn", text: "Change" });
  assert.deepEqual(steers, [["worker", "turn", "Change"]]);
  assert.deepEqual(readTaskChat(root, task.id).messages.filter(m => m.role === "user").map(m => m.text), ["Which color?\nBlue", "Change"]);
  const abandoned = control.onServerRequest({ method: "item/tool/requestUserInput", params: {
    threadId: "worker", turnId: "turn", questions: [{ id: "confirm", question: "Proceed?" }],
  } });
  control.abandon(task.id);
  await assert.rejects(abandoned, /execution ended/);
  releaseClaim(claim);
  assert.equal(getTaskStatus(root, task.id).status, "waiting-input");
  assert.equal(getTaskStatus(root, task.id).interaction.requestId, undefined);
});

test("durable answers queue the existing task without desktop dispatch or model escalation", async t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Resume a paused task", description: "Keep context" });
  const saved = readTask(task.path);
  const execution = { ...saved.metadata.execution };
  saved.metadata.interaction = { state: "waiting-input", question: "Retry?", updatedAt: "question-1" };
  saved.metadata.error = { kind: "interactive_required", message: "Retry?", at: new Date().toISOString(), exit_code: null };
  saved.metadata.codexThread = { id: "existing", state: "archived", createdAt: new Date().toISOString() };
  writeTask(saved);
  const control = createTaskInteraction({ repoRoot: root, active: new Map() });
  await assert.rejects(control.action({ taskId: task.id, action: "reply", text: "Yes", expectedInteractionId: "old" }), /question changed/);
  await assert.rejects(control.action({ taskId: task.id, action: "reply", text: "", expectedInteractionId: "question-1" }), /Enter an answer/);
  assert.equal(getTaskStatus(root, task.id).status, "waiting-input");
  const result = await control.action({ taskId: task.id, action: "reply", text: "try again", expectedInteractionId: "question-1" });
  assert.equal(result.queued, true);
  assert.equal(result.threadId, "existing");
  const resumed = getTaskStatus(root, task.id);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.execution.modelProfile, execution.modelProfile);
  assert.equal(resumed.execution.backend, "app-server");
  assert.equal(resumed.interaction.response.text, "try again");
  assert.deepEqual(readTaskChat(root, task.id).messages.filter(m => m.role === "user").map(m => m.text), ["try again"]);
  await assert.rejects(control.action({ taskId: task.id, action: "reply", text: "duplicate", expectedInteractionId: "question-1" }), /question changed/);
  await assert.rejects(control.action({ taskId: task.id, action: "continue", text: "duplicate" }), /already queued/);
  for (const action of ["open", "native"]) await assert.rejects(control.action({ taskId: task.id, action }), /Unsupported/);
});

test("an orphaned live question can resume after the runner loses its process", async t => {
  const root = fixture(t);
  const task = createTask(root, {title: "Recovered question", description: "Answer after restart"});
  const saved = readTask(task.path);
  saved.metadata.interaction = {state: "waiting-input", requestId: "orphan", updatedAt: "question-1",
    questions: [{id: "confirm", question: "Continue?"}]};
  writeTask(saved);
  const control = createTaskInteraction({repoRoot: root, active: new Map()});
  await control.action({taskId: task.id, action: "reply", requestId: "orphan", expectedInteractionId: "question-1", answers: {confirm: "Yes"}});
  assert.equal(getTaskStatus(root, task.id).status, "queued");
  assert.equal(getTaskStatus(root, task.id).interaction.response.text, "Continue?\nYes");
});

test("interactive pipeline checkpoints resume their stage and preserve mandatory gates", async () => {
  const pipeline = { steps: [{ id: "plan", type: "codex-thread" }, { id: "implement", type: "codex-thread" },
    { id: "build", type: "shell" }, { id: "test", type: "shell" }], repair: { id: "repair", type: "codex-thread", maxRounds: 1 } };
  const blocked = { status: "failed", requiresInteractive: true, interactiveReason: "Browser required" };
  const paused = await runPipeline(pipeline, { runCodex: async s => s.id === "implement" ? blocked : completed });
  assert.equal(paused.continuation.stage.id, "implement");
  const answeredStages = [];
  const answered = await runPipeline(pipeline, {
    runCodex: async step => { answeredStages.push(step.id); return completed; },
    runShell: async step => { answeredStages.push(step.id); return completed; },
  }, { ...paused.continuation, resume: true });
  assert.equal(answered.status, "completed");
  assert.deepEqual(answeredStages, ["implement", "build", "test"]);
  const asksAgain = await runPipeline(pipeline, { runCodex: async () => blocked }, { ...paused.continuation, resume: true });
  assert.equal(asksAgain.status, "failed");
  assert.equal(asksAgain.continuation.stage.id, "implement");
  const events = [];
  const resumed = await runPipeline(pipeline, { runCodex: async s => { events.push(s.id); return completed; },
    runShell: async s => { events.push(s.id); return completed; } }, { ...paused.continuation, ready: true, result: completed });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(events, ["build", "test"]);
  const repair = await runPipeline(pipeline, { runCodex: async s => s.id === "repair" ? blocked : completed,
    runShell: async () => ({ status: "failed", error: "build failed" }) });
  assert.equal(repair.continuation.stage.id, "repair");
  const repairedStages = [];
  const repaired = await runPipeline(pipeline, {
    runCodex: async step => { repairedStages.push(step.id); return completed; },
    runShell: async step => { repairedStages.push(step.id); return completed; },
  }, { ...repair.continuation, resume: true });
  assert.equal(repaired.status, "completed");
  assert.deepEqual(repairedStages, ["repair", "build", "test"]);
  const failed = await runPipeline(pipeline, { runShell: async () => ({ status: "failed", error: "still failing" }) },
    { ...repair.continuation, ready: true, result: completed });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failedStep.id, "build");
  await assert.rejects(runPipeline(pipeline, {}, { ...paused.continuation, ready: false }), /Invalid interactive/);
});

test("dashboard accepts actions only from its own origin and rejects oversized input", async t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Dashboard", description: "Input" });
  const calls = [];
  const dashboard = await startDashboard(root, 0, "test-thread", async action => { calls.push(action); return { accepted: true }; });
  t.after(() => new Promise(resolve => dashboard.server.close(resolve)));
  const url = `http://127.0.0.1:${dashboard.server.address().port}`;
  const headers = { Origin: url, "Content-Type": "application/json", "X-ToDo-Action": "1" };
  const body = JSON.stringify({ taskId: task.id, action: "reply", text: "Yes" });
  assert.equal((await fetch(url + "/api/task-action", { method: "POST", body })).status, 403);
  assert.equal((await fetch(url + "/api/task-action", { method: "POST", body, headers: { ...headers, Origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await fetch(url + "/api/task-action", { method: "POST", headers, body: "x".repeat(32769) })).status, 413);
  assert.equal((await fetch(url + "/api/task-action", { method: "POST", headers, body })).status, 200);
  assert.equal(calls.length, 1);
  const html = await (await fetch(url)).text();
  assert(html.includes('id="input-dialog"'));
  assert(html.includes('data-control-task="' + task.id + '"'));
  appendTaskChat(root, task.id, { role: "user", text: "Saved answer" });
  assert.equal((await (await fetch(url + "/api/chat?task=" + task.id)).json()).messages[0].text, "Saved answer");
  assert.equal((await fetch(url + "/api/chat?task=../../outside")).status, 400);
});

test("chat combines streaming deltas with completed items without duplication or reasoning", () => {
  const events = [
    { method: "item/agentMessage/delta", params: { itemId: "m", delta: "Hello" } },
    { method: "item/agentMessage/delta", params: { itemId: "m", delta: " world" } },
    { method: "item/completed", params: { item: { id: "m", type: "agentMessage", text: "Hello world!" } } },
    { type: "item.completed", item: { id: "c", type: "command_execution", command: "build", aggregated_output: "Passed", status: "completed" } },
    { method: "item/completed", params: { item: { id: "r", type: "reasoning", text: "Internal" } } },
  ];
  const messages = parseChatEvents('partial record\n' + events.map(e => JSON.stringify(e)).join("\n") + '\n{"incomplete":', "stage", 10);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "Hello world!");
  assert.equal(messages[1].text, "Passed");
  assert.equal(messages[1].role, "tool");
});

test("chat reads pipeline stages with a bounded tail and rejects linked log paths", t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Pipeline chat", description: "Review" });
  const logs = path.join(root, ".todo", "logs", task.id);
  const stage = path.join(logs, "attempt-1", "pipeline", "001-review-run");
  mkdirSync(stage, { recursive: true });
  const line = JSON.stringify({ method: "item/completed", params: { item: { id: "last", type: "agentMessage", text: "Reviewed" } } });
  writeFileSync(path.join(stage, "stdout.log"), "x".repeat(300000) + "\n" + line + "\n");
  const outside = path.join(root, "private.log");
  writeFileSync(outside, "PRIVATE");
  symlinkSync(outside, path.join(stage, "stderr.log"));
  symlinkSync(root, path.join(logs, "attempt-linked"));
  const chat = readTaskChat(root, task.id);
  assert.equal(chat.truncated, true);
  assert.deepEqual(chat.messages.map(m => m.text), ["Reviewed"]);
  assert(!JSON.stringify(chat).includes("PRIVATE"));
  symlinkSync(outside, path.join(logs, "chat.jsonl"));
  assert.throws(() => appendTaskChat(root, task.id, { role: "user", text: "No" }), /Invalid task chat file/);
  assert.equal(readFileSync(outside, "utf8"), "PRIVATE");
});

test("executor ownership is parsed without any desktop transport", () => {
  assert.deepEqual(executionOwner({ "x-codex-turn-metadata": JSON.stringify({ thread_id: "t", turn_id: "r" }) }, {}), { threadId: "t", turnId: "r" });
  assert.equal(executionOwner({}, {}), null);
});

test("app-server transports a suspended input request and steer to the same turn", async t => {
  const root = fixture(t);
  const fake = path.join(root, "codex");
  writeFileSync(fake, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
 const m = JSON.parse(line);
 if (m.method === "initialize") send({id:m.id,result:{}});
 if (m.method === "thread/start") send({id:m.id,result:{thread:{id:"worker"}}});
 if (m.method === "turn/start") {
   send({id:m.id,result:{turn:{id:"turn"}}});
   send({id:"user-question",method:"item/tool/requestUserInput",params:{threadId:"worker",turnId:"turn",questions:[{id:"q",question:"Continue?"}]}});
 }
 if (m.method === "turn/steer") send({id:m.id,result:{turnId:m.params.expectedTurnId}});
 if (m.id === "user-question" && m.result?.answers?.q?.answers?.[0] === "Yes") {
   send({method:"turn/completed",params:{threadId:"worker",turn:{id:"turn",status:"completed"}}});
 }
}`);
  chmodSync(fake, 0o755);
  let answer;
  let requested;
  const requestSeen = new Promise(resolve => { requested = resolve; });
  const client = new AppServerClient({ command: fake, cwd: root,
    onServerRequest: m => { requested(m); return new Promise(resolve => { answer = resolve; }); } });
  t.after(() => client.close());
  await client.start();
  const thread = await client.startThread({ cwd: root });
  const turn = await client.startTurn({ threadId: thread.id, input: [{ type: "text", text: "Start" }] });
  assert.equal((await requestSeen).params.turnId, turn);
  assert.deepEqual(await client.steerTurn(thread.id, turn, "Use the current layout"), { turnId: turn });
  answer({ answers: { q: { answers: ["Yes"] } } });
  assert.equal((await client.waitForTurn(thread.id, turn)).status, "completed");
});
