import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { resolveProject, readProject, assertTodoCompatible } from './project.mjs';
import { diagnose, readDescriptor, probeServer } from './diagnostics.mjs';
import { withinBudget } from './budget.mjs';
import { recover, commandOutcome } from './runtime.mjs';
import { operationOwner } from './operations.mjs';
import http from 'node:http';
import { completionReference, waitCompletion } from './completion.mjs';
import { projectFromArguments, editorState, isAssetImportWorker } from './processes.mjs';
import { checkPipeline as checkPipelineReal, perform as performReal, initialize, validateAction, acquireLaunch, execute, stateDirectory, ensureEditor, launchWorker } from './runtime.mjs';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commandResponse=result=>({ok:true,data:{success:true,data:{success:true,result:JSON.stringify(result)}}});
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unity-plugin-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  function project(name = 'Project with spaces', pipeline = true) {
    const root = path.join(base, name);
    for (const dir of ['Assets', 'ProjectSettings', 'Packages']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.16f1\n');
    fs.writeFileSync(path.join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: pipeline ? { 'com.unity.pipeline': '0.5.0-exp.1' } : {} }));
    return root;
  }
  return { base, project };
}
function status(rows, ok = true) { return { ok, data: { success: ok, data: { instances: rows } } }; }
function ready(root) { return status([{ project: root, state: 'ready', pid: 42 }]); }

function descriptor(root, fields = {}) {
  const file = path.join(root, 'Library/Pipeline/.unity-pipeline-port');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 42, port: 7800, projectPath: root,
    lastHeartbeat: new Date().toISOString(), evalToken: 'fixture-secret-token', ...fields }));
  return file;
}
function deps(root) { return { waitSeconds:0, idle:async()=>({state:'ready',reason:'ready',facts:{compiling:false,updating:false}}), inspect: () => [{ pid: 42, project: root }], probe: async () => ({ state: 'ownership_unverified' }) }; }
function checkPipeline(project, run) {
  descriptor(project.root);
  return checkPipelineReal(project, run, deps(project.root));
}
function perform(action, project, input, run) {
  descriptor(project.root);
  return performReal(action, project, input, run, deps(project.root));
}

function todoConfig(root, value) {
  fs.mkdirSync(path.join(root, '.todo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.todo/config.json'), JSON.stringify(value));
}

test('ToDo defaults, worktree and invalid config block every wrapper action and hook before Unity', async t => {
  const f = fakeEnvironment(t);
  fs.mkdirSync(path.join(f.root, 'Library'));
  fs.writeFileSync(path.join(f.root, 'Library/cache'), 'keep');
  const manifest = fs.readFileSync(path.join(f.root, 'Packages/manifest.json'), 'utf8');
  for (const value of [{}, { git: {} }, { git: { executionMode: 'worktree' } }, { git: { executionMode: 'unknown' } }, null]) {
    todoConfig(f.root, value);
    const code = value === null ? 'TODO_CONFIG_INVALID' : 'TODO_SINGLE_BRANCH_REQUIRED';
    for (const action of ['open', 'status', 'list', 'run', 'init']) {
      const result = spawnSync(process.execPath, [path.join(f.copy, 'scripts/cli.mjs'), action, '--cwd', f.root],
        { cwd: f.copy, env: f.env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1, action);
      const response = JSON.parse(result.stdout);
      assert.equal(response.error, code);
      assert.match(response.message, /single-branch/);
      assert.equal(response.configPath, path.join(f.root, '.todo/config.json'));
    }
    for (const source of ['startup', 'resume', 'compact']) {
      const output = await f.invoke(f.root, source);
      assert.match(output, new RegExp(code));
      assert.match(output, /single-branch/);
    }
  }
  fs.writeFileSync(path.join(f.root, '.todo/config.json'), '{');
  assert.throws(() => assertTodoCompatible(f.root), { code: 'TODO_CONFIG_INVALID' });
  assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.state + '.calls'), false, 'no process inspection on blocked startup');
  assert.equal(fs.readFileSync(path.join(f.root, 'Library/cache'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(f.root, 'Library/CodexUnity')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'Packages/manifest.json'), 'utf8'), manifest);
});

test('single-branch permits hook, open, probe, commands and init in the same project', async t => {
  const f = fakeEnvironment(t);
  todoConfig(f.root, { git: { executionMode: 'single-branch' } });
  fs.writeFileSync(f.state, JSON.stringify([{ pid: 765430, project: f.root }]));
  const opened=wrapperOpen(f);
  assert.equal(opened.state, 'editor_running', JSON.stringify(opened));
  assert.match(await f.invoke(f.root), /Editor: editor_running/);
  const calls = [];
  const run = async (binary, args, options) => {
    calls.push(args); assert.equal(options.cwd, f.root);
    if (args[0] === 'pipeline') {
      fs.writeFileSync(path.join(f.root, 'Packages/manifest.json'), JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.5.0-exp.1' } }));
    }
    return args[0] === 'status' ? ready(f.root) : { ok: true, data: { success: true, data: { success: true, commands: [], result: {} } } };
  };
  assert.equal((await checkPipeline(readProject(f.root), run)).state, 'ready');
  assert.equal((await perform('list', readProject(f.root), {}, run)).ok, true);
  assert.equal((await perform('run', readProject(f.root), { command: 'editor_status', args: [] }, run)).ok, true);
  fs.writeFileSync(path.join(f.root, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
  assert.equal((await initialize(readProject(f.root), run)).state, 'pipeline_installed');
  assert.deepEqual(calls.map(args => args[0]), ['status', 'status', 'command', 'status', 'command', 'pipeline']);
});

test('policy is rechecked after resolution, before dispatch and in the detached launcher', async t => {
  const f = fixture(t), root = f.project(), project = resolveProject(root);
  todoConfig(root, {});
  const noCall = () => assert.fail('must not call Unity or inspect processes');
  assert.throws(() => ensureEditor(project, { inspect: noCall }), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
  await assert.rejects(checkPipeline(project, noCall), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
  await assert.rejects(initialize(project, noCall), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
  assert.throws(() => execute('unity', [], { cwd: root }), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
  const lease = acquireLaunch(root);
  await launchWorker(root, lease.dir, lease.token, noCall);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lease.dir, 'launch.json'))).error, 'TODO_SINGLE_BRANCH_REQUIRED');
  todoConfig(root, { git: { executionMode: 'single-branch' } });
  await assert.rejects(perform('run', project, { command: 'editor_status', args: [] }, async () => {
    todoConfig(root, {}); return ready(root);
  }), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
});

test('real Git worktrees cannot hide ignored ToDo config or migrate after a mode change', t => {
  const f = fixture(t), root = f.project('main/Game'), main = path.dirname(root), linked = path.join(f.base, 'task');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', main, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  git('init', '-b', 'main');
  fs.writeFileSync(path.join(root, 'Assets/.keep'), '');
  fs.writeFileSync(path.join(main, '.gitignore'), '.todo/\nLibrary/\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  git('worktree', 'add', '-b', 'task', linked);
  todoConfig(main, {});
  assert.throws(() => resolveProject(path.join(root, 'Assets')), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
  assert.throws(() => resolveProject(path.join(linked, 'Game')), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
  todoConfig(linked, { git: { executionMode: 'single-branch' } });
  assert.throws(() => resolveProject(path.join(linked, 'Game')), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
  fs.rmSync(path.join(linked, '.todo'), { recursive: true });
  todoConfig(main, { git: { executionMode: 'single-branch' } });
  assert.equal(resolveProject(main).root, root);
  assert.throws(() => resolveProject(path.join(linked, 'Game')), { code: 'TODO_WORKTREE_FORBIDDEN' });
  const other = f.project('unrelated');
  assert.throws(() => resolveProject(main, other), { code: 'TODO_PROJECT_MISMATCH' });
  todoConfig(main, {});
  assert.throws(() => resolveProject(main, other), { code: 'TODO_SINGLE_BRANCH_REQUIRED' });
});

test('project identity follows task cwd, ancestors and canonical symlinks, never plugin location', t => {
  const f = fixture(t), root = f.project();
  const nested = path.join(root, 'Assets', 'Scripts'); fs.mkdirSync(nested);
  fs.symlinkSync(root, path.join(f.base, 'alias'));
  assert.equal(resolveProject(nested).root, root);
  assert.equal(resolveProject(path.join(f.base, 'alias')).root, root);
  assert.equal(resolveProject(f.base).root, root);
  assert.throws(() => resolveProject('.'), { code: 'INVALID_CWD' });
});

test('multiple candidates, broken manifests, generated roots and deep projects never silently launch', t => {
  const f = fixture(t), one = f.project('one'); f.project('two');
  assert.throws(() => resolveProject(f.base), { code: 'AMBIGUOUS_PROJECT' });
  assert.equal(resolveProject(f.base, one).root, one);
  fs.writeFileSync(path.join(one, 'Packages/manifest.json'), '{');
  assert.throws(() => resolveProject(one), { code: 'INVALID_PROJECT' });
  const hidden = path.join(f.base, 'empty'); fs.mkdirSync(hidden);
  f.project('empty/.todo/worktrees/ignored');
  f.project('empty/Library/ignored');
  f.project('empty/a/b/too-deep');
  assert.throws(() => resolveProject(hidden), { code: 'NOT_UNITY_PROJECT' });
});

test('a directly selected worktree remains independent of the main checkout', t => {
  const f = fixture(t), main = f.project('main'), worktree = f.project('main/.todo/worktrees/task');
  assert.equal(resolveProject(worktree).root, worktree);
  assert.equal(resolveProject(main).root, main);
});

test('search cap never picks a project from a partial scan', t => {
  const f = fixture(t); f.project('000-first');
  for (let i = 0; i < 201; i++) fs.mkdirSync(path.join(f.base, `folder${i}`));
  assert.throws(() => resolveProject(f.base), { code: 'SEARCH_LIMIT' });
});

test('process arguments match exact paths with spaces and unrelated Editors cannot satisfy ownership', t => {
  const f = fixture(t), root = f.project();
  assert.equal(projectFromArguments(['Unity', '-projectPath', root, '-logFile', 'out.log']), root);
  assert.equal(projectFromArguments(`/Applications/Unity.app/Contents/MacOS/Unity -projectPath ${root} -logFile out.log`), root);
  assert.equal(projectFromArguments(`Unity -projectPath "${root}" -batchmode`), root);
  assert.equal(projectFromArguments(`Unity -projectPath ${root}\n`), root);
  assert.equal(projectFromArguments('Unity -batchmode'), null);
  assert.equal(editorState(root, [{ pid: 1, project: `${root}-other` }]).state, 'editor_closed');
  assert.equal(editorState(root, [{ pid: 1, project: null }]).state, 'editor_unidentified');
  assert.equal(editorState(root, [{ pid: 1, project: root }]).state, 'editor_running');
});

test('missing Pipeline and older Unity return without calling any executable', async t => {
  const f = fixture(t), root = f.project('missing', false);
  const noCall = () => { throw new Error('must not run'); };
  assert.equal((await checkPipeline(readProject(root), noCall)).state, 'pipeline_missing');
  assert.equal((await checkPipeline({ ...readProject(root), version: '2022.3.62f3' }, noCall)).state, 'unsupported_unity');
});

test('readiness matches full canonical path, not CLI substring filtering', async t => {
  const f = fixture(t), root = f.project();
  assert.equal((await checkPipeline(readProject(root), async () => ready(`${root}-other`))).state, 'pipeline_unavailable');
  assert.equal((await checkPipeline(readProject(root), async () => ready(root))).state, 'ready');
  assert.equal((await checkPipeline(readProject(root), async () => status([
    { project: root, state: 'ready' }, { project: root, state: 'ready' },
  ]))).state, 'multiple_editors');
});

test('a not-ready action is checked once, never dispatched, stored, delayed or retried', async t => {
  const f = fixture(t), root = f.project();
  const calls = [];
  const run = async (binary, args, options) => { calls.push({ args, options }); return status([{ project: root, state: 'compiling', pid: 42 }]); };
  const result = await perform('run', readProject(root), { command: 'create_gameobject', args: ['--name', 'Cube'] }, run);
  assert.equal(result.state, 'pipeline_not_ready'); assert.equal(result.executed, false);
  assert.equal(calls.length, 1); assert.equal(calls[0].args[0], 'status');
  assert.equal(calls[0].options.timeout, 2500);
  assert.equal(fs.existsSync(path.join(root, 'Library/CodexUnity/operation.lock')), false);
});

test('each action checks afresh and passes argument boundaries plus explicit target', async t => {
  const f = fixture(t), root = f.project();
  const calls = [];
  const run = async (binary, args, options) => { calls.push({ args, options }); return args[0] === 'status' ? ready(root) : { ok: true, data: { success: true, data: { success: true, result: 3 } } }; };
  for (let i = 0; i < 2; i++) {
    const result = await perform('run', readProject(root), { command: 'create_gameobject', args: ['--name', 'A `literal` $(name)'] }, run);
    assert.equal(result.ok, true);
  }
  assert.deepEqual(calls.map(call => call.args[0]), ['status', 'command', 'status', 'command']);
  assert.equal(calls[1].args[calls[1].args.indexOf('--project-path') + 1], root);
  assert.ok(calls[1].args.includes('A `literal` $(name)'));
});

test('dispatch timeout is an unknown result and cannot trigger another mutation', async t => {
  const f = fixture(t), root = f.project(); let count = 0;
  const result = await perform('run', readProject(root), { command: 'create_gameobject', args: [] }, async () => {
    count++; return count === 1 ? ready(root) : { ok: false, error: 'TIMEOUT' };
  });
  assert.equal(count, 2); assert.equal(result.executed, 'unknown'); assert.equal(result.error, 'TIMEOUT');
});

test('request cannot switch project, runtime, output protocol, timeout or queue work', () => {
  for (const arg of ['--project-path=/other', '--runtime', '--runtime-path', '--detach', '--timeout=999', '--format=human', '--proxy=x', '--']) {
    assert.throws(() => validateAction({ command: 'eval', args: [arg] }), { code: 'INVALID_ACTION' });
  }
  assert.throws(() => validateAction({ command: '--help', args: [] }), { code: 'INVALID_ACTION' });
  assert.throws(() => validateAction({ command: 'test', args: [], timeoutSeconds: 121 }), { code: 'INVALID_ACTION' });
});

test('init preserves an existing package and never invokes refresh or open', async t => {
  const f = fixture(t), root = f.project();
  const before = fs.readFileSync(path.join(root, 'Packages/manifest.json'), 'utf8');
  const result = await initialize(readProject(root), () => { throw new Error('must not install'); });
  assert.equal(result.state, 'pipeline_present');
  assert.equal(fs.readFileSync(path.join(root, 'Packages/manifest.json'), 'utf8'), before);
});

test('init installs only the missing package and returns without a readiness probe', async t => {
  const f = fixture(t), root = f.project('new', false); const calls = [];
  const result = await initialize(readProject(root), async (binary, args) => {
    calls.push(args);
    fs.writeFileSync(path.join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: { 'com.unity.pipeline': '0.5.0-exp.1' } }));
    return { ok: true };
  });
  assert.equal(result.state, 'pipeline_installed'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), ['pipeline', 'install', '--project-path', root]);
});

test('probe subprocess has a hard bound and missing CLI is distinct', async t => {
  const f = fixture(t);
  const result = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.base, timeout: 50 });
  assert.equal(result.error, 'TIMEOUT');
  assert.equal((await execute(path.join(f.base, 'absent'), [], { cwd: f.base })).error, 'CLI_MISSING');
});

test('plain-text CLI open succeeds without treating non-JSON action output as success', async t => {
  const f = fixture(t), args = ['-e', 'console.log("Editor opened")'];
  assert.equal((await execute(process.execPath, args, { cwd: f.base, acceptExitCode: true })).ok, true);
  assert.equal((await execute(process.execPath, args, { cwd: f.base })).ok, false);
});

test('a descendant retaining the CLI pipe cannot keep a timed-out request waiting', async t => {
  const f = fixture(t), pidFile = path.join(f.base, 'child.pid');
  t.after(() => {
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
  });
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'inherit'});
    fs.writeFileSync(process.argv[1],String(child.pid));`;
  const start = Date.now();
  const result = await execute(process.execPath, ['-e', script, pidFile], { cwd: f.base, timeout: 150 });
  assert.equal(result.error, 'TIMEOUT');
  assert.ok(Date.now() - start < 1500, 'deadline must not wait for the ten-second descendant');
});

test('all entrypoints share one project-local lock regardless of hook environment', t => {
  const f = fixture(t), root = f.project();
  const before = process.env.PLUGIN_DATA;
  t.after(() => { if (before === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = before; });
  process.env.PLUGIN_DATA = path.join(f.base, 'hook-only-data');
  const first = stateDirectory(root);
  delete process.env.PLUGIN_DATA;
  assert.equal(stateDirectory(root), first);
  assert.equal(acquireLaunch(root).state, 'acquired');
  process.env.PLUGIN_DATA = path.join(f.base, 'other-install');
  assert.equal(acquireLaunch(root).state, 'launching');
});

test('init cannot claim installation from a CLI receipt without a manifest entry', async t => {
  const f = fixture(t), root = f.project('new', false);
  const result = await initialize(readProject(root), async () => ({ ok: true }));
  assert.equal(result.ok, false); assert.equal(result.error, 'PACKAGE_NOT_ADDED');
});

function fakeEnvironment(t) {
  const f = fixture(t), root = f.project();
  const copy = path.join(f.base, 'installed-plugin'); fs.cpSync(plugin, copy, { recursive: true });
  const bin = path.join(f.base, 'bin'); fs.mkdirSync(bin);
  const executable = (name, code) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!${process.execPath}\n${code}`, { mode: 0o755 }); return file;
  };
  const state = path.join(f.base, 'process.json'), log = path.join(f.base, 'calls.jsonl');
  fs.writeFileSync(state, JSON.stringify([]));
  executable('ps', `const fs=require('fs'); fs.appendFileSync(process.env.FAKE_PROCESSES+'.calls',JSON.stringify(process.argv)+'\\n'); const rows=JSON.parse(fs.readFileSync(process.env.FAKE_PROCESSES));
    if(process.argv.includes('-axo')) console.log(rows.map(x=>x.pid+' S /Applications/Unity.app/Contents/MacOS/Unity').join('\\n'));
    else { const pid=Number(process.argv[process.argv.indexOf('-p')+1]); const row=rows.find(x=>x.pid===pid); if(row) console.log(row.args ?? ('Unity -projectPath '+row.project)); }`);
  const unity = executable('fake-unity', `const fs=require('fs'); const args=process.argv.slice(2);
    fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(args)+'\\n');
    if(args[0]==='open') fs.writeFileSync(process.env.FAKE_PROCESSES,JSON.stringify([{pid:765432,project:args[1]}]));
    console.log(JSON.stringify({success:true,data:{instances:[]}}));`);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, UNITY_CLI: unity,
    UNITY_READY_TIMEOUT_SECONDS:'0', PLUGIN_DATA: path.join(f.base, 'plugin-data'), FAKE_PROCESSES: state, FAKE_CALLS: log };
  delete env.PLUGIN_ROOT;
  const hook = path.join(copy, 'scripts/session-context.mjs');
  function invoke(cwd, source = 'startup') {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hook], { cwd: copy, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => output += chunk);
      child.on('error', reject); child.on('close', code => code ? reject(new Error(`hook exit ${code}`)) : resolve(output));
      child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source, cwd }));
    });
  }
  async function launchFinished() {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      if (fs.existsSync(path.join(root, 'Library/CodexUnity/launch.json'))) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('one-shot launcher did not finish: ' + JSON.stringify({ calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', ps: fs.existsSync(state+'.calls') ? fs.readFileSync(state+'.calls', 'utf8') : '' }));
  }
  return { ...f, root, copy, env, state, log, invoke, launchFinished,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

test('installed-copy hook is silent outside Unity and compaction never opens it', async t => {
  const f = fakeEnvironment(t);
  const empty = path.join(f.base, 'empty'); fs.mkdirSync(empty);
  assert.equal(await f.invoke(empty), '');
  const context = JSON.parse(await f.invoke(f.root, 'compact')).hookSpecificOutput.additionalContext;
  assert.match(context, /not_checked/); assert.deepEqual(f.calls(), []);
  assert.equal(fs.existsSync(f.env.PLUGIN_DATA), false);
});

test('concurrent installed-copy hooks launch once and never probe Pipeline', async t => {
  const f = fakeEnvironment(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => f.invoke(f.root)));
  assert.equal(results.length, 5);
  await f.launchFinished();
  assert.deepEqual(f.calls().map(args => args[0]), ['open']);
  assert.equal(f.calls()[0][1], f.root);
  const context = JSON.parse(await f.invoke(f.root)).hookSpecificOutput.additionalContext;
  assert.match(context, /editor_running/, fs.readFileSync(f.state + '.calls', 'utf8')); assert.equal(f.calls().length, 1);
  assert.equal(fs.existsSync(path.join(f.copy, 'projects')), false);
});

test('hook refuses unidentified processes and multiple projects without any CLI call', async t => {
  const f = fakeEnvironment(t); f.project('other');
  assert.match(await f.invoke(f.base), /Multiple Unity projects/);
  fs.writeFileSync(f.state, JSON.stringify([{ pid: 765432, project: '/does-not-exist' }]));
  assert.match(await f.invoke(f.root), /editor_unidentified/);
  assert.deepEqual(f.calls(), []);
});

test('dead launch locks require explicit recovery; live launch ownership is preserved', t => {
  const f = fixture(t), root = f.project();
  const lease = acquireLaunch(root);
  assert.equal(acquireLaunch(root, true).state, 'launching');
  fs.writeFileSync(path.join(lease.lock, 'owner.json'), JSON.stringify({ token: lease.token, pid: 2147483647, at: Date.now() - 60000 }));
  assert.equal(acquireLaunch(root).state, 'launch_stale');
  assert.equal(acquireLaunch(root, true).state, 'acquired');
});

test('worker recognition uses exact -name in argv and ps text, never batch mode alone', () => {
  for (const name of ['AssetImportWorker0', 'AssetImportWorkerHW0', 'AssetImportWorkerHW1']) {
    assert.equal(isAssetImportWorker(['Unity', '-name', name, '-batchMode', '-noUpm', '-parentPid', '72474']), true);
    assert.equal(isAssetImportWorker(`Unity -name "${name}" -batchMode -parentPid 72474\n`), true);
    assert.equal(isAssetImportWorker(`Unity -name '${name}'`), true);
  }
  for (const args of ['Unity -batchMode -projectPath /project', 'Unity -name MyEditor -batchMode',
    'Unity -logFile "-name AssetImportWorkerHW0"', 'Unity -name AssetImportWorkerHW0-custom',
    'Unity -parentPid 72474 -noUpm']) assert.equal(isAssetImportWorker(args), false);
});

function wrapperOpen(f) {
  const result = spawnSync(process.execPath, [path.join(f.copy, 'scripts/cli.mjs'), 'open', '--cwd', f.root],
    { cwd: f.copy, env: f.env, encoding: 'utf8', timeout: 5000 });
  return { exit: result.status, ...JSON.parse(result.stdout) };
}

test('Editor and two import workers remain one Editor in hook, wrapper and launcher recheck', async t => {
  const f = fakeEnvironment(t);
  fs.writeFileSync(f.state, JSON.stringify([
    { pid: 765430, project: f.root },
    ...[0, 1].map(index => ({ pid: 765431 + index,
      args: `Unity -projectPath "${f.root}" -name AssetImportWorkerHW${index} -batchMode -noUpm -parentPid 765430` })),
    { pid: 765433, project: f.project('separate-worktree') },
  ]));
  const result = wrapperOpen(f);
  assert.equal(result.exit, 0); assert.equal(result.state, 'editor_running'); assert.equal(result.pid, 765430);
  assert.match(await f.invoke(f.root), /Editor: editor_running/);
  const lease = acquireLaunch(f.root);
  const launch = spawnSync(process.execPath, [path.join(f.copy, 'scripts/launch.mjs'), f.root, lease.dir, lease.token],
    { env: f.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(launch.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lease.dir, 'launch.json'), 'utf8')).state, 'editor_running');
  assert.deepEqual(f.calls(), []);
});

test('two real Editors still block hook and wrapper with multiple_editors', async t => {
  const f = fakeEnvironment(t);
  fs.writeFileSync(f.state, JSON.stringify([{ pid: 765430, project: f.root }, { pid: 765431, project: f.root }]));
  assert.equal(wrapperOpen(f).state, 'multiple_editors');
  assert.equal(wrapperOpen(f).exit, 1);
  assert.match(await f.invoke(f.root), /Editor: multiple_editors/);
  assert.deepEqual(f.calls(), []);
});

test('a real batch-mode Editor is reused by hook and wrapper', async t => {
  const f = fakeEnvironment(t);
  fs.writeFileSync(f.state, JSON.stringify([{ pid: 765430, args: `Unity -projectPath "${f.root}" -batchMode -name MyEditor` }]));
  assert.equal(wrapperOpen(f).state, 'editor_running');
  assert.match(await f.invoke(f.root), /Editor: editor_running/);
  assert.deepEqual(f.calls(), []);
});

test('unknown real Editor still prevents launching even when import workers are excluded', async t => {
  const f = fakeEnvironment(t);
  fs.writeFileSync(f.state, JSON.stringify([
    { pid: 765430, args: 'Unity -batchMode' },
    { pid: 765431, args: `Unity -projectPath "${f.root}" -name AssetImportWorker0` },
  ]));
  assert.equal(wrapperOpen(f).state, 'editor_unidentified');
  assert.match(await f.invoke(f.root), /Editor: editor_unidentified/);
  assert.deepEqual(f.calls(), []);
});

test('doctor distinguishes local failures without CLI calls or secret disclosure', async t => {
  const f = fixture(t), root = f.project(), p = readProject(root);
  const file = descriptor(root);
  const cases = [
    [() => fs.unlinkSync(file), 'descriptor_missing'],
    [() => fs.writeFileSync(file, '{fixture-secret-token'), 'descriptor_invalid'],
    [() => descriptor(root, { pid: 99 }), 'descriptor_pid_mismatch'],
    [() => descriptor(root, { projectPath: f.project('other') }), 'descriptor_project_mismatch'],
    [() => descriptor(root, { port: 99999 }), 'descriptor_invalid'],
    [() => descriptor(root, { evalToken: null }), 'descriptor_invalid'],
  ];
  for (const [prepare, reason] of cases) {
    prepare();
    const result = await diagnose(p, () => assert.fail('local failure must not invoke CLI'), deps(root));
    assert.equal(result.reason, reason);
    assert.equal(result.requiresInteractive, false);
    assert.ok(!JSON.stringify(result).includes('fixture-secret-token'));
    assert.equal(result.facts.editor, 'editor_running');
    assert.notEqual(result.nextAction.code, 'open');
  }
  descriptor(root);
  for (const [rows, reason] of [[[], 'editor_closed'], [[{pid:42,project:root},{pid:43,project:root}], 'multiple_editors'],
    [[{pid:42,project:root},{pid:43,project:null}], 'editor_unidentified']]) {
    assert.equal((await diagnose(p, () => assert.fail('no CLI'), { inspect: () => rows })).reason, reason);
  }
  fs.mkdirSync(path.join(root,'Library/CodexUnity/launch.lock'), { recursive: true });
  assert.equal((await diagnose(p, () => assert.fail('no CLI'), { inspect: () => [] })).reason, 'launching');
});

test('descriptor parser rejects oversized files and symlinks without reading their target', t => {
  const f = fixture(t), root = f.project(), file = descriptor(root);
  fs.writeFileSync(file, 'x'.repeat(70000));
  assert.equal(readDescriptor(root).state, 'invalid');
  fs.unlinkSync(file); fs.symlinkSync('/does-not-exist', file);
  assert.equal(readDescriptor(root).state, 'invalid');
});

test('one-shot diagnostics distinguish transport, authentication, protocol and live busy signals', async t => {
  const f = fixture(t), root = f.project(), p = readProject(root); descriptor(root);
  for (const error of ['CLI_MISSING','INVALID_RESPONSE','VERSION_MISMATCH','AUTHENTICATION_FAILED','TIMEOUT']) {
    const result = await diagnose(p, async () => ({ok:false,error}), deps(root));
    assert.equal(result.reason, { CLI_MISSING:'cli_missing', INVALID_RESPONSE:'protocol_incompatible', VERSION_MISMATCH:'protocol_incompatible',
      AUTHENTICATION_FAILED:'authentication_failed', TIMEOUT:'diagnostic_timeout' }[error]);
  }
  for (const state of ['compiling','domain_reload','settling','blocked_by_dialog']) {
    const result = await diagnose(p, async () => status([{project:root,pid:42,state}]), deps(root));
    assert.equal(result.reason, state);
    assert.equal(result.requiresInteractive, state === 'blocked_by_dialog');
  }
  for (const state of ['server_unreachable','authentication_failed','protocol_incompatible']) {
    let calls = 0, probes = 0;
    const result = await diagnose(p, async () => { calls++; return { ok:false,error:'STATUS_ALL_UNREACHABLE' }; },
      { ...deps(root), probe: async () => { probes++; return { state }; } });
    assert.equal(result.reason, state); assert.equal(calls,1); assert.equal(probes,1);
  }
  fs.mkdirSync(path.join(root,'Logs')); fs.writeFileSync(path.join(root,'Logs/Editor.log'),'old error CS0000 secret-token');
  const result = await diagnose(p, async () => ({ok:false,error:'STATUS_NO_INSTANCES'}), deps(root));
  assert.equal(result.reason, 'pipeline_unavailable'); assert.equal(result.requiresInteractive,false);
  assert.ok(!JSON.stringify(result).includes('compil'));
  descriptor(root, {lastHeartbeat: new Date(Date.now()-600000).toISOString()});
  assert.equal((await diagnose(p, async () => ready(root), deps(root))).reason,'ready','age alone is not a stale verdict');
  assert.equal((await diagnose(p, async () => status([{project:root,pid:42,state:'unreachable'}],false), deps(root))).reason,'descriptor_stale');
});

test('shared diagnostic deadline bounds process plus CLI work, including a hung CLI', async t => {
  const f = fixture(t), root = f.project(); descriptor(root);
  const start=Date.now();
  const result = await withinBudget(() => diagnose(readProject(root), (b,a,o) => execute(process.execPath, ['-e','setInterval(()=>{},1000)'],o), {
    ...deps(root), inspect: () => { const end=Date.now()+35; while(Date.now()<end) {} return [{pid:42,project:root}]; }
  }), 100);
  assert.equal(result.reason,'diagnostic_timeout');
  assert.ok(Date.now()-start<1000);
});

test('fallback HTTP uses verified socket ownership, authenticates and has an absolute body deadline', async t => {
  const f=fixture(t), root=f.project();
  let count=0, mode='auth';
  const server=http.createServer((req,res)=>{
    count++; assert.equal(req.headers.authorization,'Bearer fixture-secret-token');
    if(mode==='hang') { res.writeHead(200); res.write('{'); return; }
    if(mode==='auth') {res.writeHead(401);res.end('secret-token');return;}
    res.end(JSON.stringify({status:'ready'}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  descriptor(root,{port:server.address().port});
  const d=readDescriptor(root);
  assert.equal((await probeServer(d,{ownsPort:()=>false})).state,'ownership_unverified'); assert.equal(count,0);
  assert.equal((await probeServer(d,{ownsPort:()=>true})).state,'authentication_failed');
  mode='ready'; assert.equal((await probeServer(d,{ownsPort:()=>true})).state,'ready');
  mode='hang'; const at=Date.now();
  assert.equal((await withinBudget(()=>probeServer(d,{ownsPort:()=>true}),70)).state,'server_unreachable');
  assert.ok(Date.now()-at<700);
});

test('command outcome checks nested success and never interprets arbitrary failures as safe rejection', () => {
  assert.equal(commandOutcome({ok:true,data:{success:true,data:{success:false,error:'failed after mutation'}}},'run'),'unknown');
  assert.equal(commandOutcome({ok:true,data:{success:true,data:{success:true,result:{success:false}}}},'run'),'unknown');
  assert.equal(commandOutcome({ok:true,data:{success:true,data:{result:{}}}},'run'),'unknown');
  assert.equal(commandOutcome({ok:false,error:'INVALID_ARGUMENTS'},'run'),'rejected');
  assert.equal(commandOutcome({ok:false,started:false},'run'),'not_sent');
  assert.equal(commandOutcome({ok:true,data:{success:true,data:{success:true,result:{}}}},'run'),'succeeded');
});

test('concurrent commands and recovery cannot overlap; unknown outcome holds lease until explicit reconciliation', async t => {
  const f=fixture(t), root=f.project(), p=readProject(root); descriptor(root);
  let release, calls=0;
  const pending=performReal('run',p,{command:'mutation',args:[]},async (b,args)=>{
    calls++;
    if(args[0]==='status') return ready(root);
    await new Promise(resolve=>{release=resolve;});
    return {ok:false,error:'TIMEOUT'};
  },deps(root));
  // A microtask boundary is enough to let the synthetic status finish, not a Pipeline wait.
  await new Promise(resolve=>setImmediate(resolve));
  const blocked=await recover(p,'begin',null,()=>assert.fail('no second CLI'),deps(root));
  assert.equal(blocked.state,'operation_busy');
  assert.equal((await performReal('list',p,{},()=>assert.fail('no overlapping CLI'),deps(root))).state,'operation_busy');
  release(); const result=await pending;
  assert.equal(result.outcome,'unknown'); assert.equal(calls,2);
  assert.equal(operationOwner(root).kind,'command_outcome_unknown');
  assert.equal((await recover(p,'begin',null,()=>assert.fail('no recovery'),deps(root))).state,'operation_busy');
  await assert.rejects(recover(p,'cancel','wrong-id'),{code:'INVALID_RECOVERY'});
  await recover(p,'cancel',result.operationId);
  assert.equal(operationOwner(root),null);
});

test('explicit UI recovery owns a persistent lease and verifies exactly once after an action', async t => {
  const f=fixture(t), root=f.project(), p=readProject(root); let calls=0;
  const run=async()=>{calls++;return ready(root);};
  const first=await recover(p,'begin',null,run,deps(root));
  assert.equal(first.reason,'descriptor_missing'); assert.equal(first.requiresInteractive,true); assert.equal(calls,0);
  assert.match(first.nextAction.instruction,/Stop Server then Start Server/);
  assert.equal((await recover(p,'begin',null,run,deps(root))).state,'operation_busy');
  const failed=await recover(p,'finish',first.recoveryId,run,deps(root));
  assert.equal(failed.recovery,'not_verified'); assert.ok(operationOwner(root));
  descriptor(root); // Simulates one deliberate external UI recovery action.
  const done=await recover(p,'finish',first.recoveryId,run,deps(root));
  assert.equal(done.recovery,'verified'); assert.equal(calls,1); assert.equal(operationOwner(root),null);
  const healthy=await recover(p,'begin',null,run,deps(root));
  assert.equal(healthy.recovery,'not_needed_or_not_applicable'); assert.equal(operationOwner(root),null);
});

test('installed hook, doctor and action preflight share descriptor diagnosis and do not open a running Editor', async t => {
  const f=fakeEnvironment(t);
  fs.writeFileSync(f.state,JSON.stringify([{pid:765430,project:f.root}]));
  assert.match(await f.invoke(f.root),/descriptor_missing/);
  for(const action of ['doctor','status','list']) {
    const child=spawnSync(process.execPath,[path.join(f.copy,'scripts/cli.mjs'),action,'--cwd',f.root],{env:f.env,encoding:'utf8',timeout:5000});
    const result=JSON.parse(child.stdout);
    assert.equal(result.reason,'descriptor_missing'); assert.equal(result.requiresInteractive,false);
  }
  assert.deepEqual(f.calls(),[]);
});

test('command responses redact auth fields, known credentials, parameters and raw logs', async t => {
  const f=fixture(t),root=f.project();descriptor(root);
  const result=await performReal('run',readProject(root),{command:'editor_status',args:[]},async(b,args)=> args[0]==='status' ? ready(root) :
    {ok:true,data:{success:true,warnings:['fixture-secret-token'],data:{success:true,parameters:{secret:'HIDDEN_CREDENTIAL_9384'},result:{projectPath:root,
      evalToken:'HIDDEN_CREDENTIAL_9384',accessToken:'HIDDEN_CREDENTIAL_9384',logs:['HIDDEN_CREDENTIAL_9384'],message:'fixture-secret-token'}}}},deps(root));
  assert.equal(result.ok,true);
  assert.ok(!JSON.stringify(result).includes('HIDDEN_CREDENTIAL_9384'));
  assert.ok(!JSON.stringify(result).includes('fixture-secret-token'));
  assert.equal(result.result.data.result.projectPath,root);
});

test('PID change between network readiness and dispatch prevents command execution', async t => {
  const f=fixture(t),root=f.project();descriptor(root);let calls=0;
  const result=await performReal('run',readProject(root),{command:'mutation',args:[]},async()=>{
    calls++;descriptor(root,{pid:99});return ready(root);
  },deps(root));
  assert.equal(result.outcome,'not_sent');assert.equal(result.reason,'descriptor_pid_mismatch');assert.equal(calls,1);
});

test('cross-process recovery begin has one owner; other callers return immediately', async t => {
  const f=fakeEnvironment(t);
  fs.writeFileSync(f.state,JSON.stringify([{pid:765430,project:f.root}]));
  const invoke=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(f.copy,'scripts/cli.mjs'),'recover','--cwd',f.root,'--phase','begin'],{env:f.env});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',()=>resolve(JSON.parse(output)));
  });
  const results=await Promise.all(Array.from({length:5},invoke));
  assert.equal(results.filter(r=>r.recovery==='ui_required').length,1);
  assert.equal(results.filter(r=>r.state==='operation_busy').length,4);
  assert.deepEqual(f.calls(),[]);
});

test('discovery retains parameter schemas while execution parameters are omitted', async () => {
  const { safeResult } = await import('./runtime.mjs');
  const result=safeResult({success:true,data:{commands:[{name:'sample',parameters:[{name:'count',type:'integer',required:true}]}]}});
  assert.deepEqual(result.data.commands[0].parameters,[{name:'count',type:'integer',required:true}]);
});

test('wrapper rejects FIFO input without hanging or invoking Unity', t => {
  const f=fakeEnvironment(t), input=path.join(f.base,'request.fifo');
  assert.equal(spawnSync('mkfifo',[input]).status,0);
  const child=spawnSync(process.execPath,[path.join(f.copy,'scripts/cli.mjs'),'run','--cwd',f.root,'--input',input],
    {env:f.env,encoding:'utf8',timeout:2000});
  assert.equal(child.status,1); assert.equal(JSON.parse(child.stdout).error,'INVALID_ACTION');
  assert.deepEqual(f.calls(),[]);
});

test('blocking call survives compilation and imports, dispatches the requested mutation exactly once', async t => {
  const f=fixture(t), root=f.project(), p=readProject(root); descriptor(root);
  let clock=0, probes=0, commands=0; const calls=[];
  const run=async(b,args)=>{
    calls.push(args.slice(0,2));
    if(args[0]==='status') return ready(root);
    if(args[1]==='editor_status') {
      probes++;
      return {ok:true,data:{success:true,data:{success:true,result:{projectPath:root,status:probes===1?'compiling':probes===2?'reloading':'ready',
        compiling:probes===1,domainReloadInProgress:probes===2}}}};
    }
    commands++;return {ok:true,data:{success:true,data:{success:true,result:{}}}};
  };
  const {editorIdle}=await import('./readiness.mjs');
  const result=await performReal('run',p,{command:'mutation',args:[]},run,
    {...deps(root),waitSeconds:10,now:()=>clock,pause:async ms=>{clock+=ms;},idle:editorIdle});
  assert.equal(result.ok,true);assert.equal(probes,3);assert.equal(commands,1);assert.equal(result.wait.attempts,3);
  assert.equal(clock,2000);assert.equal(operationOwner(root),null);
  assert.equal(calls.at(-1)[1],'mutation');
});

test('temporary missing descriptor and process timeout recover within the same call', async t => {
  const f=fixture(t),root=f.project();let clock=0,inspections=0,mutations=0;
  const {UnityError}=await import('./project.mjs');
  const result=await performReal('run',readProject(root),{command:'mutation',args:[]},async(b,args)=>{
    if(args[0]==='status') return ready(root);
    mutations++;return {ok:true,data:{success:true,data:{success:true,result:{}}}};
  },{...deps(root),waitSeconds:10,now:()=>clock,inspect:()=>{
    inspections++;if(inspections===1) throw new UnityError('PROCESS_INSPECTION_TIMEOUT','fixture');
    return [{pid:42,project:root}];
  },pause:async ms=>{clock+=ms;if(clock>=2000) descriptor(root);}});
  assert.equal(result.ok,true);assert.equal(mutations,1);assert.equal(result.wait.attempts,3);
});

test('process permission denial is actionable, permanent, redacted and never treated as import', async t => {
  const {inspectionError}=await import('./processes.mjs');
  const f=fixture(t),root=f.project();descriptor(root);let calls=0;
  const result=await performReal('run',readProject(root),{command:'mutation',args:[]},()=>{calls++;},
    {...deps(root),waitSeconds:10,inspect:()=>{throw inspectionError({code:'EPERM',stderr:'fixture-secret-token'});},pause:()=>assert.fail('must not wait on permissions')});
  assert.equal(calls,0);assert.equal(result.reason,'process_inspection_denied');assert.equal(result.requiresInteractive,true);
  assert.equal(result.facts.processError,'EPERM');assert.equal(result.outcome,'not_sent');assert.equal(operationOwner(root),null);
  assert.ok(!JSON.stringify(result).includes('fixture-secret-token'));
});

test('readiness timeout and cancellation release the unsent command lease', async t => {
  const f=fixture(t),root=f.project();descriptor(root);let clock=0;
  const run=async()=>status([{pid:42,project:root,state:'compiling'}]);
  const opts={...deps(root),waitSeconds:2,now:()=>clock,pause:async ms=>{clock+=ms;}};
  const result=await performReal('run',readProject(root),{command:'mutation',args:[]},run,opts);
  assert.equal(result.reason,'readiness_timeout');assert.equal(result.facts.lastReason,'compiling');assert.equal(result.executed,false);
  assert.equal(clock,2000);assert.equal(operationOwner(root),null);
  const abort=new AbortController();clock=0;
  const cancel=await performReal('run',readProject(root),{command:'mutation',args:[]},run,
    {...opts,signal:abort.signal,pause:async()=>abort.abort()});
  assert.equal(cancel.reason,'readiness_cancelled');assert.equal(cancel.outcome,'not_sent');assert.equal(operationOwner(root),null);
});

test('unexpected diagnostic exception is not mislabeled as process inspection failure', async t => {
  const f=fixture(t),root=f.project();descriptor(root);
  const r=await diagnose(readProject(root),async()=>{throw new Error('private fixture');},deps(root));
  assert.equal(r.reason,'diagnostic_failed');assert.ok(!JSON.stringify(r).includes('private fixture'));
});

test('waiting caller survives another live command but never waits out an unknown outcome', async t => {
  const {acquireOperation,releaseOperation,retainUnknown}=await import('./operations.mjs');
  const f=fixture(t),root=f.project();descriptor(root);let clock=0,pauses=0;
  const owner=acquireOperation(root,'command');
  const r=await performReal('list',readProject(root),{},async(b,args)=>args[0]==='status'?ready(root):{ok:true,data:{success:true,data:{commands:[]}}},
    {...deps(root),waitSeconds:10,now:()=>clock,pause:async ms=>{clock+=ms;pauses++;releaseOperation(root,owner.id);}});
  assert.equal(r.ok,true);assert.equal(pauses,1);
  const unknown=acquireOperation(root,'command');retainUnknown(root,unknown.id);
  const blocked=await performReal('list',readProject(root),{},()=>assert.fail('no CLI'),{...deps(root),waitSeconds:10,pause:()=>assert.fail('no wait')});
  assert.equal(blocked.state,'operation_busy');assert.equal(operationOwner(root).kind,'command_outcome_unknown');
});

test('read-only state probe timeout is bounded and never sends the requested mutation', async t => {
  const f=fixture(t),root=f.project();descriptor(root);const {editorIdle}=await import('./readiness.mjs');
  const start=Date.now();let mutations=0;
  const r=await performReal('run',readProject(root),{command:'mutation',args:[]},async(b,args,options)=>{
    if(args[0]==='status') return ready(root);
    if(args[1]==='editor_status') return execute(process.execPath,['-e','setInterval(()=>{},1000)'],options);
    mutations++;assert.fail('mutation must not be sent');
  },{...deps(root),waitSeconds:1,idle:editorIdle});
  assert.equal(r.reason,'readiness_timeout');assert.equal(mutations,0);assert.ok(Date.now()-start<2500);
  assert.equal(operationOwner(root),null);
});

test('cancellation after dispatch is an unknown mutation, never a safe retry', async t => {
  const f=fixture(t),root=f.project();descriptor(root);const abort=new AbortController();
  const result=await performReal('run',readProject(root),{command:'mutation',args:[]},async(b,args,options)=>{
    if(args[0]==='status') return ready(root);
    setTimeout(()=>abort.abort(),40);
    return execute(process.execPath,['-e','setInterval(()=>{},1000)'],options);
  },{...deps(root),signal:abort.signal});
  assert.equal(result.outcome,'unknown');assert.equal(result.error,'CANCELLED');assert.equal(operationOwner(root).kind,'command_outcome_unknown');
});

test('reload just before dispatch returns to readiness under the original deadline', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root);const file=descriptor(root);
  let clock=0,checks=0,pauses=0,commands=0;
  const r=await performReal('run',p,{command:'mutation',args:[]},async(b,args)=>{
    if(args[0]==='status') return ready(root);
    commands++;return {ok:true,data:{success:true,data:{success:true,result:{}}}};
  },{...deps(root),waitSeconds:10,now:()=>clock,inspect:()=>{
    if(++checks===2) fs.unlinkSync(file);
    return [{pid:42,project:root}];
  },pause:async ms=>{clock+=ms;pauses++;descriptor(root);}});
  assert.equal(r.ok,true);assert.equal(commands,1);assert.equal(pauses,1);assert.equal(operationOwner(root),null);
});

test('unpublished lock owner receives bounded grace, but is never force-unlocked', async t => {
  const {releaseOperation}=await import('./operations.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const lock=path.join(root,'Library/CodexUnity/operation.lock');fs.mkdirSync(lock,{recursive:true});
  let clock=0,pauses=0;
  const r=await performReal('run',p,{command:'mutation',args:[]},async(b,args)=>args[0]==='status'?ready(root):({ok:true,data:{success:true,data:{success:true,result:{}}}}),
    {...deps(root),waitSeconds:10,now:()=>clock,pause:async ms=>{
      clock+=ms;pauses++;
      if(pauses===1) fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({id:'publisher',kind:'command',pid:process.pid}));
      else releaseOperation(root,'publisher');
    }});
  assert.equal(r.ok,true);assert.equal(pauses,2);
  fs.mkdirSync(lock);clock=0;
  const blocked=await performReal('run',p,{command:'mutation',args:[]},()=>assert.fail('no dispatch'),
    {...deps(root),waitSeconds:10,now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.equal(blocked.state,'operation_busy');assert.equal(clock,2000);assert.ok(fs.existsSync(lock));
});

test('nested failure preserves redacted diagnostic detail and known status timeout cannot strand a lease', async t => {
  const {safeResult}=await import('./runtime.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const failed=await performReal('run',p,{command:'mutation',args:[]},async(b,args,opts)=>args[0]==='status'?ready(root):
    execute(process.execPath,['-e','process.stdout.write(JSON.stringify({success:true,data:{success:false,error:"Fixture exception line 7",evalToken:"fixture-secret-token",errorDetails:"fixture-secret-token"}}))'],opts),deps(root));
  assert.equal(failed.error,'COMMAND_FAILED');assert.equal(failed.diagnostics.data.error,'Fixture exception line 7');
  assert.ok(!JSON.stringify(failed).includes('fixture-secret-token'));assert.equal(operationOwner(root).kind,'command_outcome_unknown');
  const clean=safeResult({result:JSON.stringify({failed:true,errors:['CS0001 fixture-secret-token'],password:'nested-secret',warnings:['nested-secret']}),logs:['Bearer abcde'],evalToken:'fixture-secret-token'});
  assert.equal(JSON.parse(clean.result).errors[0],'CS0001 [redacted]');assert.ok(!JSON.stringify(clean).includes('nested-secret'));
  assert.equal(clean.logs[0],'Bearer [redacted]');
  const root2=f.project('read-only');descriptor(root2);
  const status=await performReal('run',readProject(root2),{command:'test_status',args:[]},async(b,args)=>args[0]==='status'?ready(root2):({ok:false,error:'TIMEOUT'}),deps(root2));
  assert.equal(status.ok,false);assert.equal(operationOwner(root2),null);
});

test('pending mutation permits only known status inspection and preserves the original lease', async t => {
  const {inspectOperation}=await import('./runtime.mjs');
  const {acquireOperation,retainUnknown}=await import('./operations.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const lease=acquireOperation(root,'command');retainUnknown(root,lease.id);
  const r=await inspectOperation(p,'test_status',lease.id,async(b,args)=>{
    assert.deepEqual(args.slice(0,2),['command','test_status']);
    return {ok:true,data:{success:true,data:{success:true,result:{status:'completed'}}}};
  },{...deps(root),idle:()=>assert.fail('diagnostic status must not wait for the pending operation to become idle')});
  assert.equal(r.ok,true);assert.equal(operationOwner(root).id,lease.id);
  await assert.rejects(inspectOperation(p,'eval_file',lease.id),{code:'INVALID_ACTION'});
  await assert.rejects(inspectOperation(p,'test_status','wrong-id',()=>assert.fail('no dispatch'),deps(root)),{code:'INVALID_OPERATION'});
  assert.equal((await performReal('run',p,{command:'mutation',args:[]},()=>assert.fail('no dispatch'),deps(root))).state,'operation_busy');
});

test('recompile waits through reload and returns the completed compiler result without replay', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root);const file=descriptor(root);
  let clock=0,triggers=0,polls=0;
  const r=await performReal('run',p,{command:'recompile',args:[]},async(b,args)=>{
    if(args[0]==='status') return ready(root);
    if(args[1]==='recompile') {triggers++;fs.unlinkSync(file);return {ok:true,data:{success:true,data:{success:true,result:{status:'compiling'}}}};}
    assert.equal(args[1],'recompile_status');polls++;
    return {ok:true,data:{success:true,data:{success:true,result:JSON.stringify({status:'completed',failed:false,errors:[]})}}};
  },{...deps(root),now:()=>clock,pause:async ms=>{clock+=ms;descriptor(root);}});
  assert.equal(r.state,'completed');assert.equal(r.result.status,'completed');assert.equal(triggers,1);assert.equal(polls,1);assert.equal(operationOwner(root),null);
});

test('compiler/test failures preserve details and require reconciliation, never repeat the trigger', async t => {
  for(const type of ['recompile','run_tests']) {
    const f=fixture(t),root=f.project(type),p=readProject(root);descriptor(root);let triggers=0;
    const r=await performReal('run',p,{command:type,args:[]},async(b,args)=>{
      if(args[0]==='status') return ready(root);
      if(args[1]===type) {triggers++;return {ok:true,data:{success:true,data:{success:true,result:type==='recompile'?{status:'compiling'}:{statusPath:'Temp/test-status.json',result:'playmode_running'}}}};}
      const result=type==='recompile'?{status:'completed',failed:true,errors:['CS0001 Fixture compile error']}:{status:'completed',summary:{failed:1},results:[{message:'Fixture assertion'}]};
      return {ok:true,data:{success:true,data:{success:true,result:JSON.stringify(result)}}};
    },deps(root));
    assert.equal(r.state,'operation_failed');assert.equal(triggers,1);assert.equal(operationOwner(root).kind,'command_outcome_unknown');
    assert.match(JSON.stringify(r.result),type==='recompile'?/CS0001/:/Fixture assertion/);
  }
});

test('job waits by ID, survives connection timeout, and submits exactly once', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);let clock=0,submits=0,polls=0;
  const r=await performReal('run',p,{command:'long_probe',args:[],job:true},async(b,args)=>{
    if(args[0]==='status') return ready(root);
    if(args[0]==='command') {assert.ok(args.includes('--detach'));submits++;return {ok:true,data:{success:true,data:{success:true,result:{jobId:'fixture-job',state:'queued'}}}};}
    assert.deepEqual(args.slice(0,3),['job','status','fixture-job']);polls++;
    if(polls===1)return {ok:false,error:'TIMEOUT'};
    return {ok:true,data:{success:true,data:{jobId:'fixture-job',state:'completed',result:{answer:42}}}};
  },{...deps(root),now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.equal(r.ok,true);assert.equal(r.result.result.answer,42);assert.equal(submits,1);assert.equal(polls,2);assert.equal(operationOwner(root),null);
});

test('completion timeout is resumable by ID; resume neither resubmits nor unlocks a missing job', async t => {
  const {resumeOperation}=await import('./runtime.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);let clock=0,submits=0;
  const r=await performReal('run',p,{command:'long_probe',args:[],job:true,completionTimeoutSeconds:1},async(b,args)=>{
    if(args[0]==='status')return ready(root);
    if(args[0]==='command'){submits++;return {ok:true,data:{success:true,data:{success:true,result:{jobId:'job-1',state:'queued'}}}};}
    return {ok:true,data:{success:true,data:{jobId:'job-1',state:'running'}}};
  },{...deps(root),now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.equal(r.reason,'completion_timeout');assert.equal(submits,1);
  const missing=await resumeOperation(p,r.operationId,async(b,args)=>{assert.equal(args[0],'job');return {ok:false,error:'JOB_NOT_FOUND'};},deps(root));
  assert.equal(missing.reason,'completion_unavailable');assert.equal(operationOwner(root).id,r.operationId);
  const completed=await resumeOperation(p,r.operationId,async(b,args)=>{
    assert.deepEqual(args.slice(0,3),['job','status','job-1']);return {ok:true,data:{success:true,data:{jobId:'job-1',state:'completed',result:{value:1}}}};
  },deps(root));
  assert.equal(completed.ok,true);assert.equal(operationOwner(root),null);assert.equal(submits,1);
});

test('job observations cannot follow a different Editor PID or a different job ID', async t => {
  const {waitCompletion}=await import('./completion.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const changed=await waitCompletion(p,{kind:'job',jobId:'job-1',pid:99},()=>assert.fail('no dispatch'),deps(root));
  assert.equal(changed.reason,'editor_changed');
  const wrong=await waitCompletion(p,{kind:'job',jobId:'job-1',pid:42},async()=>({ok:true,data:{success:true,data:{jobId:'job-2',state:'completed'}}}),deps(root));
  assert.equal(wrong.reason,'completion_protocol_incompatible');
  assert.throws(()=>validateAction({command:'recompile',args:[],job:true}),{code:'INVALID_ACTION'});
  assert.throws(()=>validateAction({command:'long_probe',args:[],completionTimeoutSeconds:0}),{code:'INVALID_ACTION'});
});

test('published CLI detached acknowledgement is flat, followed by job status with a matching ID', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);let submits=0;
  const r=await performReal('run',p,{command:'editor_status',args:[],job:true},async(b,args)=>{
    if(args[0]==='status')return ready(root);
    if(args[0]==='command'){submits++;return {ok:true,data:{success:true,command:'command editor_status',data:{command:'editor_status',jobId:'flat-job',state:'queued',detached:true},errors:[],warnings:[]}};}
    return {ok:true,data:{success:true,command:'job status',data:{jobId:'flat-job',state:'completed',result:{compiling:false}}}};
  },deps(root));
  assert.equal(r.ok,true);assert.equal(submits,1);assert.equal(r.result.result.compiling,false);assert.equal(operationOwner(root),null);
});

test('cancelled completion can resume; concurrent resume and unlock are blocked', async t => {
  const {resumeOperation}=await import('./runtime.mjs');
  const {acquireOperation,updateOperation,retainUnknown}=await import('./operations.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const lease=acquireOperation(root,'command');updateOperation(root,lease.id,{completion:{kind:'job',jobId:'pending-job',pid:42}});retainUnknown(root,lease.id);
  const abort=new AbortController();let finish;
  const pending=resumeOperation(p,lease.id,async()=>{await new Promise(resolve=>{finish=resolve;});return {ok:true,data:{success:true,data:{jobId:'pending-job',state:'running'}}};},{...deps(root),signal:abort.signal});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await resumeOperation(p,lease.id,()=>assert.fail('no concurrent poll'),deps(root))).state,'operation_busy');
  await assert.rejects(recover(p,'cancel',lease.id),{code:'OPERATION_ACTIVE'});
  abort.abort();finish();const result=await pending;
  assert.equal(result.reason,'completion_cancelled');assert.equal(operationOwner(root).id,lease.id);
  assert.equal(fs.existsSync(path.join(root,'Library/CodexUnity/operation.lock/resume.lock')),false);
});

test('cancelled pre-dispatch reload wait sends nothing and retains no new lock', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root);const file=descriptor(root);let checks=0;
  const abort=new AbortController();
  const r=await performReal('run',p,{command:'mutation',args:[]},async(b,args)=>{assert.equal(args[0],'status');return ready(root);},
    {...deps(root),waitSeconds:10,signal:abort.signal,inspect:()=>{if(++checks===2)fs.unlinkSync(file);return [{pid:42,project:root}];},pause:async()=>abort.abort()});
  assert.equal(r.reason,'readiness_cancelled');assert.equal(operationOwner(root),null);
});

test('saved completion from a crashed owner can be resumed, but a live owner cannot', async t => {
  const {resumeOperation}=await import('./runtime.mjs');
  const {acquireOperation,updateOperation}=await import('./operations.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const lease=acquireOperation(root,'command');updateOperation(root,lease.id,{completion:{kind:'job',jobId:'saved-job',pid:42}});
  assert.equal((await resumeOperation(p,lease.id,()=>assert.fail('no poll'),deps(root))).state,'operation_busy');
  updateOperation(root,lease.id,{pid:2147483647});
  const result=await resumeOperation(p,lease.id,async()=>({ok:true,data:{success:true,data:{jobId:'saved-job',state:'completed',result:{value:1}}}}),deps(root));
  assert.equal(result.ok,true);assert.equal(operationOwner(root),null);
});

test('unpublished resume owner blocks lease cancellation until its identity is known', async t => {
  const {acquireOperation,retainUnknown}=await import('./operations.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const lease=acquireOperation(root,'command');retainUnknown(root,lease.id);
  fs.mkdirSync(path.join(root,'Library/CodexUnity/operation.lock/resume.lock'));
  await assert.rejects(recover(p,'cancel',lease.id),{code:'OPERATION_ACTIVE'});
  assert.equal(operationOwner(root).id,lease.id);
});

test('native package add survives reload, awaits import idle and submits once', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root),file=descriptor(root);
  let clock=0,submits=0,polls=0,idleChecks=0;
  const value={operation:'add',argument:'com.example.fixture@1.0.0',success:true};
  const result=await performReal('run',p,{command:'package_add',args:['--identifier',value.argument,'--confirm','true','--wait','false']},async(b,args)=>{
    if(args[0]==='status') return ready(root);
    if(args[1]==='package_add') {submits++;fs.unlinkSync(file);return commandResponse({...value,status:'in_progress'});}
    assert.equal(args[1],'package_status');polls++;
    assert.equal(operationOwner(root).kind,'command');
    return commandResponse({...value,status:polls===1?'in_progress':'completed',requiresRecompile:true});
  },{...deps(root),now:()=>clock,pause:async ms=>{clock+=ms;descriptor(root);},idle:async()=>{
    idleChecks++;
    return idleChecks===2?{state:'pipeline_not_ready',reason:'domain_reload'}:{state:'ready',reason:'ready'};
  }});
  assert.equal(result.ok,true);assert.equal(submits,1);assert.equal(polls,2);assert.equal(idleChecks,3);
  assert.equal(result.result.requiresRecompile,true);assert.equal(operationOwner(root),null);
});

test('package timeout persists only hashed correlation; resume follows native status without replay', async t => {
  const {resumeOperation,inspectOperation}=await import('./runtime.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);let clock=0,submits=0;
  const value={operation:'add',argument:'https://user:fixture-password@example.test/repo.git?token=fixture-query-secret',success:true};
  const result=await performReal('run',p,{command:'package_add',args:[],completionTimeoutSeconds:1},async(b,args)=>{
    if(args[0]==='status') return ready(root);
    if(args[1]==='package_add') submits++;
    return commandResponse({...value,status:'in_progress'});
  },{...deps(root),now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.equal(result.reason,'completion_timeout');assert.equal(submits,1);
  const owner=operationOwner(root);
  assert.equal(owner.completion.kind,'package');assert.match(owner.completion.argumentHash,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify([owner,result]),/fixture-password|fixture-query-secret|example\.test/);
  const observed=await inspectOperation(p,'package_status',owner.id,async(b,args)=>{
    assert.equal(args[1],'package_status');return commandResponse({...value,status:'completed'});
  },deps(root));
  assert.equal(observed.ok,true);assert.equal(operationOwner(root).id,owner.id);
  assert.doesNotMatch(JSON.stringify(observed),/fixture-password|fixture-query-secret/);
  const resumed=await resumeOperation(p,owner.id,async(b,args)=>{
    if(args[0]==='status') return ready(root);
    assert.equal(args[1],'package_status');return commandResponse({...value,status:'completed'});
  },deps(root));
  assert.equal(resumed.ok,true);assert.equal(operationOwner(root),null);
  assert.doesNotMatch(JSON.stringify(resumed),/fixture-password|fixture-query-secret/);
});

test('package status cannot complete another operation, argument or Editor', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);
  const value={operation:'remove',argument:'com.example.fixture',status:'in_progress',success:true};
  const ref={...completionReference({command:'package_remove'},commandResponse(value)),pid:42};
  for(const change of [{operation:'add'},{argument:'com.example.other'},{operation:null},{success:undefined}]) {
    const result=await waitCompletion(p,ref,async()=>commandResponse({...value,status:'completed',...change}),deps(root));
    assert.equal(result.reason,'completion_protocol_incompatible');
  }
  const result=await waitCompletion(p,{...ref,pid:99},()=>assert.fail('no other Editor dispatch'),deps(root));
  assert.equal(result.reason,'editor_changed');
  for(const command of ['package_add','package_remove','package_resolve']) assert.throws(()=>validateAction({command,args:[],job:true}),{code:'INVALID_ACTION'});
});

test('native package failure retains its lease and diagnostics; malformed acceptance cannot pass', async t => {
  for(const malformed of [false,true]) {
    const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);let submits=0;
    const value={operation:'remove',argument:'com.example.fixture',success:true};
    const result=await performReal('run',p,{command:'package_remove',args:[]},async(b,args)=>{
      if(args[0]==='status') return ready(root);
      if(args[1]==='package_remove') {submits++;return commandResponse({...value,status:'in_progress',...(malformed?{argument:null}:{})});}
      return commandResponse({...value,status:'failed',success:false,error:'Fixture UPM failure'});
    },deps(root));
    assert.equal(result.ok,false);assert.equal(submits,1);assert.equal(operationOwner(root).kind,'command_outcome_unknown');
    assert.equal(result.reason,malformed?'unsupported_package_response':'operation_failed');
    if(!malformed) assert.equal(result.result.error,'Fixture UPM failure');
  }
});

test('native previews stay synchronous and serialized negative results cannot be called success', async t => {
  for(const command of ['run_script','package_add']) {
    const f=fixture(t),root=f.project(),p=readProject(root);descriptor(root);let submits=0;
    const input={command,args:command==='run_script'?['--file','AgentScripts/Fixture.cs','--entry','Fixture.Read','--dry_run','true']:['--identifier','com.example.fixture','--dry_run','true']};
    const result=await performReal('run',p,input,async(b,args)=>{
      if(args[0]==='status') return ready(root);
      assert.deepEqual(args.slice(1,2+input.args.length),[command,...input.args]);submits++;
      return commandResponse({success:true,status:'dry_run'});
    },deps(root));
    assert.equal(result.ok,true);assert.equal(submits,1);assert.equal(operationOwner(root),null);
  }
  assert.equal(commandOutcome(commandResponse({success:false,status:'failed'}),'run'),'unknown');
});

test('full doctor filters native Safe Mode evidence to exact project and PID, preserving diagnosis and lease', async t => {
  const {acquireOperation,retainUnknown}=await import('./operations.mjs');
  const f=fixture(t),root=f.project(),p=readProject(root);
  const lease=acquireOperation(root,'command');retainUnknown(root,lease.id);let calls=0;
  const result=await checkPipelineReal(p,async(b,args,options)=>{
    calls++;assert.deepEqual(args.slice(0,2),['pipeline','list']);assert.ok(options.timeout<=8000);
    return {ok:true,data:{success:true,data:{summary:{instancesInSafeMode:99},instances:[
      {projectPath:f.base,pid:42,safeMode:{detected:false},secret:'other-project'},
      {projectPath:root,pid:999,safeMode:{detected:false}},
      {projectPath:root,pid:42,safeMode:{detected:true,logPath:'private-log',message:'fixture-secret-token'}}
    ]}}};
  },{...deps(root),detail:'full'});
  assert.equal(calls,1);assert.equal(result.reason,'descriptor_missing');
  assert.equal(result.facts.pipelineList.safeModeReported,true);
  assert.equal(result.requiresInteractive,false);assert.equal(operationOwner(root).id,lease.id);
  assert.doesNotMatch(JSON.stringify(result),/other-project|private-log|fixture-secret-token|instancesInSafeMode/);
});

test('full doctor does not infer Safe Mode from other instances or alter fast preflight', async t => {
  const f=fixture(t),root=f.project(),p=readProject(root);let inspections=0;
  await checkPipelineReal(p,()=>assert.fail('ordinary local doctor requires no CLI'),deps(root));
  for(const rows of [[],[{projectPath:root,pid:99,safeMode:{detected:true}}],[{projectPath:root,pid:42,safeMode:null}]]) {
    const result=await checkPipelineReal(p,async()=>({ok:true,data:{success:true,data:{instances:rows}}}),{...deps(root),detail:'full'});
    assert.notEqual(result.facts.pipelineList.safeModeReported,true);assert.equal(result.reason,'descriptor_missing');
  }
  const changed=await checkPipelineReal(p,async()=>({ok:true,data:{success:true,data:{instances:[{projectPath:root,pid:42,safeMode:{detected:true}}]}}}),
    {...deps(root),detail:'full',inspect:()=>[{pid:++inspections===1?42:99,project:root}]});
  assert.equal(changed.facts.pipelineList.state,'editor_changed');
  const unknown=await checkPipelineReal(p,()=>assert.fail('no query with unidentified owner'),{...deps(root),detail:'full',inspect:()=>[{pid:42,project:null}]});
  assert.equal(unknown.reason,'editor_unidentified');assert.equal(unknown.facts.pipelineList,undefined);
});
