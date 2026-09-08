import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTask, getTaskStatus, initializeRepo, readDaemonState } from "./lib.mjs";
const scripts = path.dirname(fileURLToPath(import.meta.url));

test("dashboard answer resumes an archived pipeline repair after runner restart", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-reply-"));
  let daemon;
  let output = "";
  async function stop() {
    if (daemon?.exitCode === null && daemon?.signalCode === null) {
      const closed = once(daemon, "close"); daemon.kill("SIGINT"); await closed;
    }
  }
  t.after(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
  function git(...args) {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, ".gitignore"), "codex\ntrace.jsonl\ngates\n");
  writeFileSync(path.join(root, "pipeline.yaml"), `version: 1
steps:
  - id: implement
    type: codex-thread
    prompt: IMPLEMENT_ONCE
  - id: backend
    type: shell
    command: node gate.mjs backend
  - id: frontend
    type: shell
    command: node gate.mjs frontend
repair:
  type: codex-thread
  prompt: REPAIR_PAUSED_STAGE
  maxRounds: 1
`);
  writeFileSync(path.join(root, "gate.mjs"), `import {appendFileSync,existsSync} from 'node:fs';
appendFileSync(process.env.FIXTURE_ROOT+'/gates', process.argv[2]+'\\n');
if (!existsSync('repaired.txt')) process.exit(1);
`);
  git("add", "."); git("commit", "-m", "fixture");
  initializeRepo(root); git("add", "AGENTS.md"); git("commit", "-m", "activate");
  const fake = path.join(root, "codex");
  writeFileSync(fake, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {appendFileSync,writeFileSync} from 'node:fs';
import {fakeModelList} from ${JSON.stringify(new URL("./model-catalog-test.mjs", import.meta.url).href)};
if (process.argv[2] !== 'app-server') process.exit(64);
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');let turn=0;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);appendFileSync(process.env.FIXTURE_ROOT+'/trace.jsonl',line+'\\n');
 if(m.id==null)continue;
 if(m.method==='model/list'){send({id:m.id,result:fakeModelList()});continue;}
 if(m.method==='thread/start'||m.method==='thread/resume') {send({id:m.id,result:{thread:{id:'same-thread'}}});continue;}
 if(m.method==='turn/start') {
  const text=m.params.input.map(i=>i.text||'').join('\\n');const repair=text.includes('Pipeline step: repair');
  const answered=text.includes('RETRY_OK');const waiting=repair&&!answered;const turnId='turn-'+(++turn);
  if(!repair)writeFileSync(m.params.cwd+'/implementation.txt','preserve me\\n');
  if(answered)writeFileSync(m.params.cwd+'/repaired.txt','fixed\\n');
  send({id:m.id,result:{turn:{id:turnId,status:'inProgress',items:[]}}});
  const result={status:waiting?'failed':'completed',summary:waiting?'Need an answer':'done',validation:['fixture verified'],requiresInteractive:waiting,interactiveReason:waiting?'Ready to retry?':null};
  send({method:'item/completed',params:{threadId:m.params.threadId,turnId,item:{id:turnId,type:'agentMessage',text:JSON.stringify(result)}}});
  send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:turnId,status:'completed',items:[]}}});continue;
 }
 send({id:m.id,result:{}});
}
`);
  chmodSync(fake, 0o755);
  const configPath = path.join(root, ".todo/config.json");
  const config = JSON.parse(readFileSync(configPath));
  writeFileSync(configPath, JSON.stringify({ ...config, codexCommand: fake, workers: 1, retries: 0,
    pollIntervalMs: 100, configReloadIntervalMs: 100, dashboardPort: 0, pipeline: { file: "pipeline.yaml" } }));
  const task = createTask(root, { title: "Pipeline reply", description: "Preserve implementation; repair after answer" });
  function start() {
    daemon = spawn(process.execPath, [path.join(scripts, "daemon.mjs"), "--repo", root], {
      cwd: root, env: { ...process.env, FIXTURE_ROOT: root, CODEX_APP_TOOLS_PIPE_PATH: "/must-not-connect.sock" }, stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout.on("data", c => { output += c; }); daemon.stderr.on("data", c => { output += c; });
  }
  async function waitFor(predicate) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const value = predicate(); if (value) return value;
      assert.equal(daemon.exitCode, null, output);
      await new Promise(r => setTimeout(r, 100));
    }
    assert.fail(output);
  }
  start();
  await waitFor(() => { const s = getTaskStatus(root, task.id); return s.status === "waiting-input" && !s.claim && s.codexThread?.state === "archived" && s; });
  await stop(); start();
  await waitFor(() => readDaemonState(root)?.pid === daemon.pid);
  const waiting = getTaskStatus(root, task.id);
  const url = readDaemonState(root).dashboard.url.replace(/\/$/, "");
  const response = await fetch(url + "/api/task-action", { method: "POST",
    headers: { Origin: url, "Content-Type": "application/json", "X-ToDo-Action": "1" },
    body: JSON.stringify({ taskId: task.id, action: "reply", text: "RETRY_OK", expectedInteractionId: waiting.interaction.updatedAt }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).queued, true);
  const completed = await waitFor(() => { const s = getTaskStatus(root, task.id); return s.status === "completed" && s; });
  assert.equal(completed.codexThread.id, "same-thread");
  const messages = readFileSync(path.join(root, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const turns = messages.filter(m => m.method === "turn/start");
  assert.equal(turns.length, 3, "implementation, waiting repair, answered repair only");
  assert(turns.every(m => m.params.threadId === "same-thread"));
  assert(turns[2].params.input[0].text.includes("RETRY_OK"));
  assert(turns[2].params.input[0].text.includes("Pipeline step: repair"));
  assert(messages.some(m => m.method === "thread/unarchive" && m.params.threadId === "same-thread"));
  assert(messages.some(m => m.method === "thread/resume" && m.params.threadId === "same-thread"));
  assert.deepEqual(readFileSync(path.join(root, "gates"), "utf8").trim().split("\n"), ["backend", "backend", "frontend"]);
  assert(!output.includes("desktop_reconcile"));
});
