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
import { projectFromArguments, editorState, isAssetImportWorker } from './processes.mjs';
import { checkPipeline as checkPipelineReal, perform as performReal, initialize, validateAction, acquireLaunch, execute, stateDirectory, ensureEditor, launchWorker } from './runtime.mjs';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
function deps(root) { return { inspect: () => [{ pid: 42, project: root }], probe: async () => ({ state: 'ownership_unverified' }) }; }
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
  assert.equal(wrapperOpen(f).state, 'editor_running');
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
    PLUGIN_DATA: path.join(f.base, 'plugin-data'), FAKE_PROCESSES: state, FAKE_CALLS: log };
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
