// Development-only fixture renderer. Runtime code has no browser dependency.
// Set PLAYWRIGHT_MODULE to an installed Playwright module if it isn't on Node's search path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProject } from './project.mjs';
import { ensureEditor, perform } from './runtime.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unity-screenshots-')));
let browser;
try {
  for (const dir of ['Assets', 'Packages', 'ProjectSettings']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.16f1\n');
  fs.writeFileSync(path.join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.6.0-exp.1' } }));
  const project = readProject(root);
  const startup = ensureEditor(project, { inspect: () => [{ pid: 4242, project: root }] });
  fs.mkdirSync(path.join(root, 'Library/Pipeline'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Library/Pipeline/.unity-pipeline-port'), JSON.stringify({pid:4242,port:7800,projectPath:root,lastHeartbeat:new Date().toISOString(),evalToken:'fixture-only-token'}));
  let calls = 0, mutations = 0, clock = 0;
  const action = await perform('run', project, { command: 'recompile', args: [] }, async (binary,args) => {
    if(args[0] === 'status') { calls++; return {ok:true,data:{success:true,data:{instances:[{project:root,pid:4242,state:calls===1?'compiling':'ready'}]}}}; }
    if(args[1]==='recompile_status') return {ok:true,data:{success:true,data:{success:true,result:JSON.stringify({status:'completed',failed:false,errors:[]})}}};
    mutations++; return {ok:true,data:{success:true,data:{success:true,result:{status:'compiling'}}}};
  }, { inspect: () => [{pid:4242,project:root}],waitSeconds:10,now:()=>clock,pause:async ms=>{clock+=ms;},
    idle:async()=>({state:'ready',reason:'ready',facts:{compiling:false,updating:false}}) });
  fs.mkdirSync(path.join(root, '.todo'));
  fs.writeFileSync(path.join(root, '.todo/config.json'), JSON.stringify({ git: { executionMode: 'worktree' } }));
  let blocked;
  try { ensureEditor(project); }
  catch (error) { blocked = { ok: false, error: error.code, ...error.details }; }
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const normalize = value => JSON.stringify(value, null, 2).replaceAll(root, '/workspace/MyGame');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
  const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/screenshots');
  fs.mkdirSync(output, { recursive: true });
  for (const item of [
    { name: 'startup', title: 'Open a task. Reuse Unity.', sub: 'The session hook finds the project and its Editor.',
      value: {state:startup.state,reason:startup.reason,facts:startup.facts,nextAction:startup.nextAction}, checks: ['Exact project: /workspace/MyGame', 'Existing Editor reused', 'Missing descriptor identified locally'] },
    { name: 'action', title: 'Wait through the whole operation.', sub: 'Ready, submit once, then read the final compiler result.',
      value: {state:action.state,reason:action.reason,outcome:action.outcome,executed:action.executed,wait:action.wait,completion:action.result}, checks: [`Readiness checks: ${calls}`, `Requested command dispatches: ${mutations}`, 'No task restart. No mutation replay.'] },
    { name: 'todo-guard', title: 'ToDo requires a single branch.', sub: 'Unity commands are blocked in ToDo worktree mode.',
      value: blocked, checks: ['Set git.executionMode to single-branch', 'No Unity CLI call or Editor launch', 'Keep running tasks in their current copy'] },
  ]) {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#11141b;color:#f3f5fa;font:20px system-ui;padding:58px}
      .brand{color:#9ec8ff;letter-spacing:2px;font-size:17px;font-weight:700}h1{font-size:43px;letter-spacing:-1.2px;margin:24px 0 12px}
      p{color:#b0b9cc;margin:0 0 32px}.panel{display:grid;grid-template-columns:1.4fr 1fr;gap:24px}
      pre{margin:0;background:#1b2130;border:1px solid #333e55;padding:25px;border-radius:16px;font:17px/1.6 monospace;white-space:pre-wrap;overflow-wrap:anywhere}
      ul{list-style:none;margin:0;padding:0}li{padding:22px;background:#202c2d;border:1px solid #3b5550;border-radius:13px;margin-bottom:15px;color:#c4f0de;font-size:19px}
      footer{margin-top:32px;font-size:15px;color:#a0aabd}code{color:#bee1ff}
      </style><div class="brand">UNITY / CODEX PLUGIN</div><h1>${escape(item.title)}</h1><p>${escape(item.sub)}</p>
      <div class="panel"><pre>${escape(normalize(item.value))}</pre><ul>${item.checks.map(check => `<li>✓ ${escape(check)}</li>`).join('')}</ul></div>
      <footer>Fixture demonstration · Actual plugin output with a simulated Editor · Project path normalized</footer>`);
    await page.screenshot({ path: path.join(output, `${item.name}.png`), fullPage: true });
  }
} finally {
  await browser?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
