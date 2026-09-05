import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimTask, cleanupStaleClaims, createTask, finishInteractiveTask, formatTaskThreadTitle,
  getTaskStatus, initializeRepo, readTask, reconcileInteractiveClaim, releaseClaim,
  startInteractiveTask, waitForTaskInput, writeTask } from "./lib.mjs";
import { createTaskInteraction } from "./task-interaction.mjs";
import { DesktopClient, executionOwner } from "./desktop-client.mjs";
import { AppServerClient } from "./app-server-client.mjs";
import { runPipeline } from "./pipeline.mjs";
import { startDashboard } from "./dashboard.mjs";

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
    owner: { ...owner, turnId: "other" } }), /another Codex app turn/);
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
  const abandoned = control.onServerRequest({ method: "item/tool/requestUserInput", params: {
    threadId: "worker", turnId: "turn", questions: [{ id: "confirm", question: "Proceed?" }],
  } });
  control.abandon(task.id);
  await assert.rejects(abandoned, /execution ended/);
  releaseClaim(claim);
  assert.equal(getTaskStatus(root, task.id).status, "waiting-input");
  assert.equal(getTaskStatus(root, task.id).interaction.requestId, undefined);
});

test("desktop precondition failures do not reserve tasks; ambiguous dispatches are never duplicated", async t => {
  const root = fixture(t);
  const task = createTask(root, { title: "App dispatch", description: "Use native tools", runMode: "interactive" });
  let available = false;
  const calls = [];
  const control = createTaskInteraction({ repoRoot: root, active: new Map(), getOwnerThreadId: () => "supervisor",
    getClient: () => ({ call: async (name, args) => {
      calls.push({ name, args });
      if (!available) throw new Error("pipe closed");
      if (name === "list_projects") return { projects: [{ projectKind: "local", path: root, projectId: "project" }] };
      if (name === "create_thread") throw new Error("connection lost after sending");
      throw new Error("unexpected call");
    } }),
  });
  await assert.rejects(control.action({ taskId: task.id, action: "native" }), /pipe closed/);
  assert.equal(getTaskStatus(root, task.id).status, "queued");
  assert.equal(getTaskStatus(root, task.id).claim, null);
  available = true;
  await assert.rejects(control.action({ taskId: task.id, action: "native" }), /connection lost/);
  assert.equal(getTaskStatus(root, task.id).interaction.dispatching, true);
  await assert.rejects(control.action({ taskId: task.id, action: "native" }), /uncertain outcome/);
  assert.equal(calls.filter(c => c.name === "create_thread").length, 1);
});

test("interactive pipeline checkpoints resume their stage and preserve mandatory gates", async () => {
  const pipeline = { steps: [{ id: "plan", type: "codex-thread" }, { id: "implement", type: "codex-thread" },
    { id: "build", type: "shell" }, { id: "test", type: "shell" }], repair: { id: "repair", type: "codex-thread", maxRounds: 1 } };
  const blocked = { status: "failed", requiresInteractive: true, interactiveReason: "Browser required" };
  const paused = await runPipeline(pipeline, { runCodex: async s => s.id === "implement" ? blocked : completed });
  assert.equal(paused.continuation.stage.id, "implement");
  const events = [];
  const resumed = await runPipeline(pipeline, { runCodex: async s => { events.push(s.id); return completed; },
    runShell: async s => { events.push(s.id); return completed; } }, { ...paused.continuation, ready: true, result: completed });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(events, ["build", "test"]);
  const repair = await runPipeline(pipeline, { runCodex: async s => s.id === "repair" ? blocked : completed,
    runShell: async () => ({ status: "failed", error: "build failed" }) });
  assert.equal(repair.continuation.stage.id, "repair");
  const failed = await runPipeline(pipeline, { runShell: async () => ({ status: "failed", error: "still failing" }) },
    { ...repair.continuation, ready: true, result: completed });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failedStep.id, "build");
  await assert.rejects(runPipeline(pipeline, {}, { ...paused.continuation, ready: false }), /Invalid interactive/);
});

test("continuing in a user's discussion does not turn it into a disposable worker chat", async t => {
  const root = fixture(t);
  const task = createTask(root, { title: "Discuss in my chat", description: "Keep the discussion", runMode: "interactive" });
  const run = await startInteractiveTask(root, task.id, { owner });
  waitForTaskInput(root, task.id, { claimToken: run.claimToken, owner, question: "Which option?" });
  const calls = [];
  const control = createTaskInteraction({ repoRoot: root, active: new Map(), getOwnerThreadId: () => "supervisor",
    getClient: () => ({ call: async (name, args) => { calls.push({ name, args }); return {}; } }) });
  await control.action({ taskId: task.id, action: "reply", text: "Option A" });
  assert.deepEqual(calls.map(c => c.name), ["set_thread_archived", "send_message_to_thread"]);
  assert.equal(calls[0].args.archived, false);
  assert.equal(getTaskStatus(root, task.id).interaction.nativeThreadId, null);
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
});

test("desktop adapter speaks standard MCP and passes executor ownership", async t => {
  const root = fixture(t);
  const serverPath = path.join(root, "fake-mcp.mjs");
  writeFileSync(serverPath, `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
 const m = JSON.parse(line); if (!m.id) continue;
 let result = {};
 if (m.method === "tools/list") result = { tools: [{ name: "read_thread" }] };
 if (m.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify({ owner: m.params._meta["openai/threadId"], thread: m.params.arguments.threadId }) }] };
 process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
}`);
  const client = new DesktopClient({ serverPath, env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: "fake" } });
  t.after(() => client.close());
  assert.deepEqual(await client.call("read_thread", { threadId: "child" }, "owner"), { owner: "owner", thread: "child" });
  await assert.rejects(client.call("unknown", {}, "owner"), /unavailable/);
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
