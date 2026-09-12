import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopTitleClient, desktopTitleCommand } from "./desktop-title.mjs";
import { bindSupervisor, claimTask, completeTask, createTask, initializeRepo, readDaemonState, readTask, releaseClaim, requestDashboardThread, setTaskError, writeTask } from "./lib.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "todo-live-title-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const mcp = path.join(home, ".tmp/bundled-marketplaces/openai-bundled/plugins/codex-app-tools");
  mkdirSync(path.join(mcp, "scripts"), { recursive: true });
  const trace = path.join(root, "trace.jsonl");
  const server = path.join(mcp, "server.mjs");
  writeFileSync(server, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let calls = 0;
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if (!m.id) continue;
 const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 if(m.method==='initialize')send({});
 else if(m.method==='tools/list')send({tools:[{name:'set_thread_title'}]});
 else if(m.method==='tools/call') {
   appendFileSync(process.env.FAKE_TRACE,JSON.stringify(m.params)+'\\n');
   calls++;
   if(process.env.FAKE_HANG==='1')continue;
   setTimeout(()=>send(calls===1&&process.env.FAKE_FAIL==='1'?{isError:true,content:[{type:'text',text:'temporary failure'}]}:{content:[]}),Number(process.env.FAKE_DELAY||0));
 } else throw Error('Unexpected method '+m.method);
}
`);
  const launcher = path.join(mcp, "scripts/launch_codex_app_tools_mcp");
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(launcher, 0o755);
  const env = { ...process.env, CODEX_HOME: home, CODEX_APP_TOOLS_PIPE_PATH: "fixture-only", FAKE_TRACE: trace };
  delete env.CODEX_ELECTRON_RESOURCES_PATH;
  delete env.CODEX_MCP_NODE_PATH;
  const calls = () => existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  return { root, env, calls, server };
}

async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail("Title did not converge before timeout");
}

test("desktop title client surfaces tool failures, timeout and reconnects", async t => {
  const f = fixture(t);
  const client = new DesktopTitleClient({ env: { ...f.env, FAKE_FAIL: "1" }, timeoutMs: 300 });
  t.after(() => client.close());
  await assert.rejects(client.setThreadName("owner", "first"), /temporary failure/);
  await client.setThreadName("owner", "second");
  assert.equal(f.calls()[1]._meta["openai/threadId"], "owner");
  client.close();
  client.env = { ...f.env, FAKE_HANG: "1" };
  await assert.rejects(client.setThreadName("owner", "timeout"), /timed out/);
  client.env = f.env;
  await client.setThreadName("owner", "reconnected");
  assert.equal(f.calls().at(-1).arguments.title, "reconnected");
  assert.equal(desktopTitleCommand({}), null);
});

test("task file events publish current dashboard counts without waiting for the task poll", async t => {
  const f = fixture(t);
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: f.root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.name", "ToDo Test");
  git("config", "user.email", "todo@example.invalid");
  writeFileSync(path.join(f.root, "README.md"), "fixture\n");
  git("add", "README.md"); git("commit", "-m", "fixture");
  initializeRepo(f.root);
  const configPath = path.join(f.root, ".todo/config.json");
  const config = JSON.parse(readFileSync(configPath));
  writeFileSync(configPath, JSON.stringify({ ...config, pollIntervalMs: 60000, configReloadIntervalMs: 60000, dashboardPort: 0 }));
  bindSupervisor(f.root, { automationId: "old", targetThreadId: "old-supervisor", name: "old", prompt: "old", rrule: "FREQ=MINUTELY;INTERVAL=15", status: "ACTIVE" });
  requestDashboardThread(f.root, "dashboard-owner");
  const daemon = spawn(process.execPath, [new URL("./daemon.mjs", import.meta.url).pathname, "--repo", f.root], {
    env: { ...f.env, FAKE_DELAY: "80", FAKE_FAIL: "1" }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  daemon.stderr.on("data", data => { stderr += data; });
  t.after(async () => {
    if (daemon.exitCode === null) { const closed = once(daemon, "close"); daemon.kill("SIGINT"); await closed; }
  });
  const synced = title => readDaemonState(f.root)?.supervisorThreadTitle?.title === title && readDaemonState(f.root)?.supervisorThreadTitle?.status === "synced";
  // The first desktop rename fails; recovery must precede the 60-second poll.
  await until(() => synced("-> ToDo (0r / 0q / 0f)"), 8000);
  const task = createTask(f.root, { title: "Live counts", description: "No worker model needed", runMode: "interactive" });
  await until(() => synced("-> ToDo (0r / 1q / 0f)"));
  const claim = claimTask(task.path, 1);
  await until(() => synced("-> ToDo (1r / 0q / 0f)"));
  const waiting = readTask(task.path);
  waiting.metadata.interaction = { state: "waiting-input", question: "Continue?", updatedAt: new Date().toISOString() };
  writeTask(waiting);
  await until(() => synced("-> ToDo (0r / 0q / 0f / 1w)"));
  releaseClaim(claim);
  const failed = readTask(task.path); delete failed.metadata.interaction; writeTask(failed);
  setTaskError(task.path, "test_failure", 1, "fixture");
  await until(() => synced("-> ToDo (0r / 0q / 1f)"));
  completeTask(f.root, task.path, { summary: "Done", validation: [] });
  await until(() => synced("-> ToDo (0r / 0q / 0f)"));
  // Change state while the previous title request is still in flight.
  const next = createTask(f.root, { title: "Fast transition", description: "Coalesce in-flight requests", runMode: "interactive" });
  await until(() => f.calls().at(-1)?.arguments.title === "-> ToDo (0r / 1q / 0f)");
  completeTask(f.root, next.path, { summary: "Done", validation: [] });
  await until(() => f.calls().at(-1)?.arguments.title === "-> ToDo (0r / 0q / 0f)");
  requestDashboardThread(f.root, "new-dashboard-owner");
  await until(() => f.calls().at(-1)?.arguments.threadId === "new-dashboard-owner");
  assert(f.calls().every(call => call.name === "set_thread_title"));
  assert(!f.calls().some(call => call.arguments.threadId === "old-supervisor"));
  assert.equal(readDaemonState(f.root).supervisorThreadTitle.transport, "desktop");
  assert.equal(stderr, "");
});
