// Integration fixtures never contact the native app or a real model.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claimTask, releaseClaim, beginModelAttempt, createTask, initializeRepo, prepareTaskGit,
  markTaskModelCompleted, finalizeTaskGit, processTaskMergeQueue, prepareTaskMergeConflictRepair,
  finishTaskMergeConflictRepair, getTaskStatus, readTask, writeTask, retryTask,
  startInteractiveTask, finishInteractiveTask, waitForTaskInput, reconcileInteractiveClaim,
  taskMetrics, emptyTokenUsage, cumulativeTaskMetrics } from "./lib.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const metrics = previous => cumulativeTaskMetrics(previous, taskMetrics(Date.now(), Date.now(), emptyTokenUsage()));
const completed = { status: "completed", summary: "Original feature", validation: ["Original gate passed"], error: null };
async function fixture({ conflict = false, rounds = 2 } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-merge-repair-"));
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Merge Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(path.join(root, "conflict.txt"), "base\n");
  writeFileSync(path.join(root, "contract.json"), JSON.stringify(["name"]));
  writeFileSync(path.join(root, "fixture.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(path.join(root, "check.cjs"), `const fs=require('node:fs'),cp=require('node:child_process'),p=require('node:path');
const root=process.env.TODO_RUNNER_REPO_ROOT;
fs.appendFileSync(p.join(root,'.todo/gates'),cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}));
const check=()=>{const contract=JSON.parse(fs.readFileSync('contract.json'));const fixture=JSON.parse(fs.readFileSync('fixture.json'));
if(contract.some(k=>!(k in fixture)) || fs.existsSync(p.join(root,'.todo/force-fail'))) {
 console.error('src/features/builds/new-build.test.ts(6,7): error TS2741: Property "allowedActions" is missing');process.exit(1);
}};
if(fs.existsSync(p.join(root,'.todo/hold-gate'))) {
 fs.writeFileSync(p.join(root,'.todo/gate-started'),'yes');
 const timer=setInterval(()=>{if(!fs.existsSync(p.join(root,'.todo/hold-gate'))){clearInterval(timer);check();}},20);
} else check();
`);
  writeFileSync(path.join(root, "quality.yaml"), `version: 1
steps:
  - id: implement
    type: codex-exec
    prompt: Original implementation must never run again
  - id: frontend
    type: shell
    command: node check.cjs
repair:
  type: codex-exec
  prompt: Fix the failing gate
  maxRounds: ${rounds}
`);
  initializeRepo(root);
  git("add", "."); git("commit", "-qm", "base");
  const fake = path.join(root, ".todo/codex");
  writeFileSync(fake, `#!/usr/bin/env node
import { fakeModelList } from ${JSON.stringify(new URL("./model-catalog-test.mjs", import.meta.url).href)};
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const root=process.env.TODO_RUNNER_REPO_ROOT;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let serial=0;
for await(const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);if(m.id==null)continue;
 if(m.method==='thread/start') { send({id:m.id,error:{code:-1,message:'MUST RESUME ORIGINAL THREAD'}}); }
 else if(m.method==='thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId}}});
 else if(m.method==='turn/start') {
  const prompt=m.params.input.map(x=>x.text||'').join('\\n');
  appendFileSync(root+'/.todo/model-calls',JSON.stringify({threadId:m.params.threadId,prompt,model:m.params.model})+'\\n');
  if(!prompt.includes('repair attempt') || !prompt.includes('Original task requirements:')) process.exit(77);
  if(prompt.includes('merge-conflict repair attempt')) writeFileSync(m.params.cwd+'/conflict.txt','main and task\\n');
  else { const fixture=JSON.parse(readFileSync(m.params.cwd+'/fixture.json'));for(const key of JSON.parse(readFileSync(m.params.cwd+'/contract.json')))fixture[key]=[];writeFileSync(m.params.cwd+'/fixture.json',JSON.stringify(fixture)); }
  const id='repair-'+(++serial);
  send({id:m.id,result:{turn:{id,status:'inProgress'}}});
  const result={status:'completed',summary:'Bounded integration repair',validation:['Diff reviewed'],error:null,requiresInteractive:false,interactiveReason:null};
  send({method:'item/completed',params:{threadId:m.params.threadId,turnId:id,item:{id:'result',type:'agentMessage',text:JSON.stringify(result)}}});
  send({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id,status:'completed',items:[]}}});
 } else send({id:m.id,result:m.method==='model/list'?fakeModelList():{}});
}
`);
  chmodSync(fake, 0o755);
  const cfg = path.join(root, ".todo/config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg)), workers: 1, retries: 0,
    pollIntervalMs: 100, configReloadIntervalMs: 100, dashboardPort: 0, codexCommand: fake,
    pipeline: { file: "quality.yaml" }, git: { delivery: "merge", targetBranch: "main", push: false } }));
  const task = createTask(root, { title: "Repair integration", description: "Preserve original feature and new main contracts", modelProfile: "fast" });
  const worktree = await prepareTaskGit(root, task.path);
  writeFileSync(path.join(worktree.worktreePath, "feature.txt"), "original implementation\n");
  if (conflict) writeFileSync(path.join(worktree.worktreePath, "conflict.txt"), "task\n");
  const claim = claimTask(task.path, "initial", { modelAttempt: true });
  markTaskModelCompleted(task.path, claim, completed, metrics(null), null);
  releaseClaim(claim);
  const stored = readTask(task.path);
  stored.metadata.codexThread = { id: "original-thread", state: "archived", createdAt: new Date().toISOString() };
  writeTask(stored);
  await finalizeTaskGit(root, task.path);
  writeFileSync(path.join(root, "contract.json"), JSON.stringify(["name", "allowedActions"]));
  if (conflict) writeFileSync(path.join(root, "conflict.txt"), "main\n");
  git("add", "."); git("commit", "-qm", "new main contract");
  let daemon, output = "";
  const status = () => getTaskStatus(root, task.id);
  const wait = async check => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
    assert.fail(`Timed out: ${JSON.stringify(status())}\n${output}`);
  };
  const start = (overrides = {}) => {
    const env = { ...process.env, ...overrides }; delete env.CODEX_APP_TOOLS_PIPE_PATH;
    daemon = spawn(process.execPath, [path.join(scripts, "daemon.mjs"), "--repo", root], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    daemon.stdout.on("data", d => { output += d; }); daemon.stderr.on("data", d => { output += d; });
  };
  const stop = async () => {
    if (daemon?.exitCode === null && daemon?.signalCode === null) { const closed = once(daemon, "close"); daemon.kill("SIGINT"); await closed; }
  };
  const calls = () => existsSync(path.join(root, ".todo/model-calls")) ? readFileSync(path.join(root, ".todo/model-calls"), "utf8").trim().split("\n").map(JSON.parse) : [];
  return { root, task, git, worktree: worktree.worktreePath, status, start, stop, wait, calls,
    close: async () => { await stop(); rmSync(root, { recursive: true, force: true }); } };
}

for (const conflict of [true, false]) test(`same task repairs ${conflict ? "conflict then gate" : "gate after clean rebase"} in original thread`, async () => {
  const f = await fixture({ conflict });
  try {
    if (!conflict) {
      // Restart after clean Git rebase, before ToDo saved its new HEAD.
      f.git("worktree", "add", f.worktree, f.status().git.branch);
      f.git("-C", f.worktree, "rebase", "main");
    }
    f.start(); await f.wait(() => f.status().status === "completed"); await f.stop();
    const saved = f.status(), calls = f.calls();
    assert.equal(saved.execution.modelProfile, conflict ? "advanced" : "medium");
    assert.equal(calls.length, conflict ? 2 : 1);
    assert(calls.every(c => c.threadId === "original-thread"));
    assert.match(calls.at(-1).prompt, /frontend[\s\S]*TS2741[\s\S]*allowedActions/);
    assert.match(calls.at(-1).prompt, /Task HEAD: [0-9a-f]{40}.*Target main HEAD: [0-9a-f]{40}/);
    assert.deepEqual(saved.attemptLedger.attempts.map(a => a.trigger), conflict ? ["initial", "merge_conflict", "merge_validation"] : ["initial", "merge_validation"]);
    assert.deepEqual(saved.attemptLedger.deliveryAttempts.map(a => a.status), ["failed_permanent", "completed"]);
    assert.equal(saved.summary, "Original feature");
    assert.equal(readFileSync(path.join(f.root, "feature.txt"), "utf8"), "original implementation\n");
    assert.equal(saved.git.deliveryResult.pipelineValidation.headCommit, f.git("rev-parse", "HEAD"));
    const head = f.git("rev-parse", "HEAD");
    f.start(); await new Promise(r => setTimeout(r, 500)); await f.stop();
    assert.equal(f.git("rev-parse", "HEAD"), head); assert.equal(f.calls().length, calls.length);
    assert.equal(f.status().attemptLedger.deliveryAttempts.length, 2);
  } finally { await f.close(); }
});

test("legacy merge-failed recovery uses supported retry and exclusive interactive continuation", async () => {
  const f = await fixture();
  const owner = { threadId: "original-thread", turnId: "turn-1" };
  try {
    await processTaskMergeQueue(f.root, f.task.path);
    const legacy = readTask(f.task.path);
    legacy.metadata.git.phase = "merge-failed";
    legacy.metadata.error = { kind: "pipeline_validation", message: legacy.metadata.git.mergeConflict.message };
    delete legacy.metadata.git.mergeConflict;
    writeTask(legacy);
    const implementation = legacy.metadata.attemptLedger.attempts[0];
    const reservation = claimTask(f.task.path, "merge-queue");
    assert.throws(() => retryTask(f.root, f.task.id), /running/);
    await assert.rejects(startInteractiveTask(f.root, f.task.id, { owner }), /running/);
    releaseClaim(reservation);
    assert.equal(retryTask(f.root, f.task.id).git.phase, "merge-conflict");
    await assert.rejects(startInteractiveTask(f.root, f.task.id, { owner: { threadId: "other", turnId: "x" } }), /original Codex thread/);
    const run = await startInteractiveTask(f.root, f.task.id, { owner });
    assert.equal(run.worktreePath, f.worktree); assert.equal(run.mergeRepair.stepId, "frontend");
    assert.match(run.mergeRepair.prompt, /TS2741/);
    assert.equal((await startInteractiveTask(f.root, f.task.id, { owner })).claimToken, run.claimToken);
    await assert.rejects(processTaskMergeQueue(f.root, f.task.path), /EEXIST/);
    writeFileSync(path.join(f.worktree, "fixture.json"), JSON.stringify({ name: "fixture", allowedActions: [] }));
    waitForTaskInput(f.root, f.task.id, { claimToken: run.claimToken, question: "Continue repair", owner });
    const nextOwner = { ...owner, turnId: "turn-2" };
    const next = await startInteractiveTask(f.root, f.task.id, { owner: nextOwner });
    await assert.rejects(finishInteractiveTask(f.root, f.task.id, { ...completed, claimToken: run.claimToken, owner }), /claim does not match/);
    // An ended host turn releases its exact claim; saved code remains intact.
    assert.equal(reconcileInteractiveClaim(f.root, f.task.id, { thread: { id: owner.threadId, status: "idle" }, turns: [{ id: nextOwner.turnId, status: "interrupted" }] }, next.claimToken), true);
    const finalOwner = { ...owner, turnId: "turn-3" };
    const finalRun = await startInteractiveTask(f.root, f.task.id, { owner: finalOwner });
    assert.equal((await finishInteractiveTask(f.root, f.task.id, { ...completed, claimToken: finalRun.claimToken, owner: finalOwner })).git.phase, "merge-queued");
    assert.deepEqual(f.status().attemptLedger.attempts[0], implementation);
    f.start(); await f.wait(() => f.status().status === "completed"); await f.stop();
    assert.equal(f.calls().length, 0); assert.equal(f.status().codexThread.id, owner.threadId);
    assert.equal(f.status().attemptLedger.deliveryAttempts.filter(a => a.status === "completed").length, 1);
  } finally { await f.close(); }
});

test("repair exhaustion survives runner restart and explicit retry grants one bounded repair", async () => {
  const f = await fixture({ rounds: 1 });
  try {
    writeFileSync(path.join(f.root, ".todo/force-fail"), "yes");
    f.start(); await f.wait(() => f.status().status === "failed"); await f.stop();
    assert.equal(f.calls().length, 1); assert.equal(f.status().error.kind, "pipeline_validation");
    assert.equal(f.status().git.phase, "merge-failed"); assert.match(f.status().git.mergeConflict.stderrTail, /TS2741/);
    assert(existsSync(path.join(f.worktree, "feature.txt")));
    f.start(); await new Promise(r => setTimeout(r, 600)); await f.stop(); assert.equal(f.calls().length, 1);
    rmSync(path.join(f.root, ".todo/force-fail"));
    retryTask(f.root, f.task.id);
    f.start(); await f.wait(() => f.status().status === "completed"); await f.stop();
    assert.equal(f.calls().length, 2); assert.equal(f.status().attemptLedger.attempts.length, 3);
    assert.equal(f.status().attemptLedger.deliveryAttempts.filter(a => a.status === "completed").length, 1);
  } finally { await f.close(); }
});

test("target advancing during a gate invalidates its receipt; next merge rebases and checks again", async () => {
  const f = await fixture();
  try {
    await processTaskMergeQueue(f.root, f.task.path);
    const claim = claimTask(f.task.path, "merge-repair");
    prepareTaskMergeConflictRepair(f.root, f.task.path, claim); beginModelAttempt(f.task.path, claim);
    writeFileSync(path.join(f.worktree, "fixture.json"), JSON.stringify({ name: "fixture", allowedActions: [] }));
    await finishTaskMergeConflictRepair(f.root, f.task.path, claim, completed, metrics(f.status().metrics)); releaseClaim(claim);
    writeFileSync(path.join(f.root, ".todo/hold-gate"), "yes");
    const merge = processTaskMergeQueue(f.root, f.task.path);
    await f.wait(() => existsSync(path.join(f.root, ".todo/gate-started")));
    writeFileSync(path.join(f.root, "new-main.txt"), "new main\n"); f.git("add", "new-main.txt"); f.git("commit", "-qm", "advance during gate");
    const target = f.git("rev-parse", "HEAD");
    rmSync(path.join(f.root, ".todo/hold-gate"));
    await assert.rejects(merge, /Target changed during merge validation/);
    assert.equal(f.git("rev-parse", "HEAD"), target);
    retryTask(f.root, f.task.id);
    const merged = await processTaskMergeQueue(f.root, f.task.path);
    assert.equal(merged.status, "merged");
    const receipt = JSON.parse(readFileSync(path.join(f.root, merged.delivery.pipelineValidation.receiptPath)));
    assert.equal(receipt.targetCommit, target); assert.equal(receipt.headCommit, f.git("rev-parse", "HEAD"));
    assert.equal(readFileSync(path.join(f.root, ".todo/gates"), "utf8").trim().split("\n").length, 3);
  } finally { await f.close(); }
});

test("failed conflict repair preserves edited files and paused rebase for original-thread continuation", async () => {
  const f = await fixture({ conflict: true });
  try {
    assert.equal((await processTaskMergeQueue(f.root, f.task.path)).status, "conflict");
    const claim = claimTask(f.task.path, "merge-repair");
    prepareTaskMergeConflictRepair(f.root, f.task.path, claim); beginModelAttempt(f.task.path, claim);
    writeFileSync(path.join(f.worktree, "conflict.txt"), "main and task\n");
    await finishTaskMergeConflictRepair(f.root, f.task.path, claim,
      { status: "failed", summary: "Interrupted after editing", error: "Interrupted after editing", errorKind: "interrupted" }, metrics(f.status().metrics));
    releaseClaim(claim);
    assert.equal(f.status().error.kind, "interrupted");
    assert.equal(readFileSync(path.join(f.worktree, "conflict.txt"), "utf8"), "main and task\n");
    const owner = { threadId: "original-thread", turnId: "continue-conflict" };
    const run = await startInteractiveTask(f.root, f.task.id, { owner });
    assert.match(run.mergeRepair.prompt, /rebase is paused/);
    // Model the crash window after Git finished the rebase but before ToDo
    // acknowledged its result. The supported finish must recover Git's record.
    f.git("-C", f.worktree, "add", "-A");
    f.git("-C", f.worktree, "-c", "core.editor=true", "rebase", "--continue");
    assert.equal(readTask(f.task.path).metadata.git.phase, "merge-conflict");
    await finishInteractiveTask(f.root, f.task.id, { ...completed, claimToken: run.claimToken, owner });
    f.start(); await f.wait(() => f.status().status === "completed"); await f.stop();
    assert.equal(f.calls().length, 1, "only the later semantic gate needs an automatic repair");
    assert.equal(f.status().attemptLedger.attempts.length, 4);
    assert.equal(readFileSync(path.join(f.root, "conflict.txt"), "utf8"), "main and task\n");
  } finally { await f.close(); }
});

test("runner interrupted during merge validation retains rebased HEAD and resumes gates without model replay", async () => {
  const f = await fixture();
  try {
    // Accept the original semantic fix before testing interruption of delivery.
    await processTaskMergeQueue(f.root, f.task.path);
    const owner = { threadId: "original-thread", turnId: "fix" };
    const run = await startInteractiveTask(f.root, f.task.id, { owner });
    writeFileSync(path.join(f.worktree, "fixture.json"), JSON.stringify({ name: "fixture", allowedActions: [] }));
    await finishInteractiveTask(f.root, f.task.id, { ...completed, claimToken: run.claimToken, owner });
    writeFileSync(path.join(f.root, "new-main.txt"), "before interruption\n"); f.git("add", "new-main.txt"); f.git("commit", "-qm", "advance main");
    writeFileSync(path.join(f.root, ".todo/hold-gate"), "yes");
    f.start(); await f.wait(() => existsSync(path.join(f.root, ".todo/gate-started"))); await f.stop();
    const failed = f.status();
    assert.equal(failed.git.phase, "merge-failed"); assert.equal(failed.error.kind, "interrupted");
    assert.equal(failed.git.headCommit, f.git("-C", f.worktree, "rev-parse", "HEAD"));
    rmSync(path.join(f.root, ".todo/hold-gate")); retryTask(f.root, f.task.id);
    f.start(); await f.wait(() => f.status().status === "completed"); await f.stop();
    assert.equal(f.calls().length, 0); assert.equal(f.status().attemptLedger.attempts.length, 2);
    assert.equal(f.status().attemptLedger.deliveryAttempts.filter(a => a.status === "completed").length, 1);
  } finally { await f.close(); }
});

test("delivery checkpoint survives a runner crash before branch/worktree cleanup", async () => {
  const f = await fixture();
  try {
    await processTaskMergeQueue(f.root, f.task.path);
    const owner = { threadId: "original-thread", turnId: "before-crash" };
    const run = await startInteractiveTask(f.root, f.task.id, { owner });
    writeFileSync(path.join(f.worktree, "fixture.json"), JSON.stringify({ name: "fixture", allowedActions: [] }));
    await finishInteractiveTask(f.root, f.task.id, { ...completed, claimToken: run.claimToken, owner });
    const bin = path.join(f.root, ".todo/fault-bin"); mkdirSync(bin);
    const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const wrapper = path.join(bin, "git");
    writeFileSync(wrapper, `#!/usr/bin/env node
const {spawnSync}=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('worktree') && args.includes('remove')) {
 const task=fs.readFileSync(${JSON.stringify(f.task.path)},'utf8');
 fs.writeFileSync(${JSON.stringify(path.join(f.root, ".todo/checkpoint-seen"))},task);
 process.kill(process.ppid,'SIGKILL');process.exit(1);
}
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);
`);
    chmodSync(wrapper, 0o755);
    f.start({ PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    await f.wait(() => existsSync(path.join(f.root, ".todo/checkpoint-seen")));
    await new Promise(r => setTimeout(r, 200)); await f.stop();
    const checkpoint = readTask(path.join(f.root, ".todo/checkpoint-seen"));
    assert.equal(checkpoint.metadata.git.phase, "delivered");
    const ledger = checkpoint.metadata.attemptLedger;
    assert.equal(ledger.deliveryAttempts.filter(a => a.status === "completed").length, 1);
    const head = f.git("rev-parse", "HEAD");
    f.start(); await f.wait(() => f.status().status === "completed"); await f.stop();
    assert.equal(f.git("rev-parse", "HEAD"), head); assert.deepEqual(f.status().attemptLedger, ledger);
    assert.equal(f.calls().length, 0);
  } finally { await f.close(); }
});
