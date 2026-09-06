import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, readConfig, inspect, readDocument, withLock, scan } from './common.mjs';
import { chunkDocument, refresh, search, status, databasePath, indexedFiles, indexSummary } from './index.mjs';

import { IndexQueue } from './queue.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-search-tests-'));
process.env.SEMANTIC_SEARCH_TMP_ROOT = path.join(base, 'cache');
const scripts = path.dirname(fileURLToPath(import.meta.url));
let embedded = 0;
const fake = {
  model: 'test-only',
  tokenCount: text => Array.from(text).length / 3 + 2,
  async embed(texts) {
    embedded += texts.length;
    return texts.map(text => {
      const v = [1, Number(text.includes('ORCHID')), Number(text.includes('logout')), Number(text.includes('warehouse'))];
      const norm = Math.hypot(...v);
      return v.map(x => x / norm);
    });
  },
};
function fixture(name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  return fs.realpathSync(root);
}
test.after(() => { for (const q of queues) if (!q.closed) q.close(); fs.rmSync(base, { recursive: true, force: true }); });

test('init uses exact cwd; preserves existing config; nested roots stay isolated', () => {
  const root = fixture('roots');
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# Example');
  assert.equal(inspect(root).configExists, false);
  assert.ok(inspect(root).candidates.some(x => x.folder === 'docs'));
  const created = initialize(root, ['docs']);
  assert.equal(created.root, root);
  const before = fs.readFileSync(created.configPath, 'utf8');
  assert.equal(initialize(root, ['.']).created, false);
  assert.equal(fs.readFileSync(created.configPath, 'utf8'), before);
  const child = path.join(root, 'child');
  fs.mkdirSync(path.join(child, 'manual'), { recursive: true });
  assert.equal(readConfig(child).root, root);
  initialize(child, ['manual']);
  assert.equal(readConfig(child).root, child);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.semantic-search.json', 'child', 'docs']);
});

test('documents are fully chunked beyond 500 words with bounded input and source lines', () => {
  const text = '# Architecture\n' + 'ordinary text '.repeat(900) + '\n## Revocation\nORCHID logout\n```js\n# not a heading\n```';
  const chunks = chunkDocument(text, 'manual.md', fake.tokenCount);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every(c => fake.tokenCount(c.input) <= 120));
  assert.ok(chunks.some(c => c.text.includes('ORCHID') && c.fromLine <= 4 && c.toLine >= 4));
  assert.equal(chunks.map(c => c.text).join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.ok(chunks.filter(c => c.text.includes('not a heading')).every(c => c.heading === 'Architecture > Revocation'));
});

test('hash refresh detects same-size same-mtime edits, additions and deletions', async () => {
  const root = fixture('incremental');
  initialize(root, ['docs']);
  const doc = path.join(root, 'docs', 'auth.md');
  fs.writeFileSync(doc, '# Access\nORCHID logout');
  const first = await refresh(root, fake);
  assert.equal(first.updated, 1);
  assert.equal(status(root).stale, false);
  const count = embedded;
  assert.equal((await refresh(root, fake)).updated, 0);
  assert.equal(embedded, count);
  const old = fs.statSync(doc);
  fs.writeFileSync(doc, '# Access\nORCHID renew!');
  fs.utimesSync(doc, old.atime, old.mtime);
  assert.equal(status(root).stale, true);
  const changed = await search(root, 'ORCHID renew', 6, fake);
  assert.equal(changed.updated, 1);
  assert.ok(changed.results.some(r => r.text.includes('renew!')));
  assert.ok(changed.results.every(r => !r.text.includes('logout')));
  fs.writeFileSync(path.join(root, 'docs', 'new.md'), '# New\nwarehouse');
  fs.unlinkSync(doc);
  const next = await search(root, 'warehouse', 6, fake);
  assert.equal(next.removed, 1);
  assert.equal(next.updated, 1);
  assert.ok(next.results.every(r => r.path === 'docs/new.md'));
  fs.rmSync(databasePath(root));
  assert.equal(status(root).indexExists, false);
  assert.equal((await refresh(root, fake)).updated, 1);
});

test('a captured source commits even when edited during embedding', async () => {
  const root = fixture('racing-editor');
  initialize(root, ['docs']);
  const file = path.join(root, 'docs', 'note.md');
  fs.writeFileSync(file, 'first content');
  await refresh(root, fake);
  fs.writeFileSync(file, 'second content');
  const changing = { ...fake, async embed(texts) { fs.writeFileSync(file, 'third content'); return fake.embed(texts); } };
  assert.equal((await refresh(root, changing)).updated, 1);
  assert.ok((await search(root, 'second', 6, fake, indexSummary(root))).results.some(x => x.text.includes('second content')));
  assert.equal(status(root).stale, true);
  assert.ok((await search(root, 'third', 6, fake)).results.some(x => x.text.includes('third content')));
});

test('configured boundaries reject traversal and outside symlinks; reads use current source', () => {
  const root = fixture('boundaries');
  initialize(root, ['docs']);
  fs.writeFileSync(path.join(root, 'outside.md'), 'not documentation');
  fs.writeFileSync(path.join(root, 'docs', 'read.md'), 'one\ntwo\nthree');
  fs.symlinkSync(path.join(root, 'outside.md'), path.join(root, 'docs', 'linked.md'));
  assert.throws(() => readDocument(root, 'outside.md'), /not in/);
  assert.throws(() => readDocument(root, '../outside.md'), /relative/);
  assert.throws(() => readDocument(root, 'docs/linked.md'), /not in/);
  assert.equal(readDocument(root, 'docs/read.md', 2, 1).text, '2: two');
  fs.writeFileSync(path.join(root, 'docs', 'read.md'), 'new text');
  assert.equal(readDocument(root, 'docs/read.md').text, '1: new text');
  assert.throws(() => initialize(root, ['../']), /inside/);
  fs.writeFileSync(path.join(root, 'docs', 'binary.pdf'), 'a pdf');
  assert.ok(scan(root, readConfig(root).config).skipped.some(x => x.reason === 'unsupported extension'));
});

test('hooks inject for configured cwd/descendants, and do nothing elsewhere', () => {
  const root = fixture('hook');
  function hook(cwd, name) {
    const run = spawnSync(process.execPath, [path.join(scripts, 'session-context.mjs')], { input: JSON.stringify({ cwd, hook_event_name: name }), encoding: 'utf8' });
    assert.equal(run.status, 0);
    return run.stdout;
  }
  assert.equal(hook(root, 'SessionStart'), '');
  initialize(root, ['docs']);
  for (const name of ['SessionStart', 'UserPromptSubmit', 'SubagentStart']) {
    const result = JSON.parse(hook(path.join(root, 'docs'), name));
    assert.equal(result.hookSpecificOutput.hookEventName, name);
    assert.ok(result.hookSpecificOutput.additionalContext.includes(root));
  }
  assert.equal(hook(root, 'PostToolUse'), '');
});

test('cross-process lock excludes competitors and recovers a dead owner', async () => {
  const lock = path.join(base, 'shared.lock');
  const events = path.join(base, 'events');
  const childCode = `import fs from 'node:fs'; import {withLock,delay} from ${JSON.stringify(new URL('./common.mjs', import.meta.url).href)}; await withLock(process.argv[1],async()=>{fs.appendFileSync(process.argv[2],'start\\n');await delay(40);fs.appendFileSync(process.argv[2],'end\\n');});`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, lock, events], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
  })));
  assert.equal(fs.readFileSync(events, 'utf8'), 'start\nend\n'.repeat(4));
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, token: 'dead' }));
  let ran = false;
  await withLock(lock, async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(fs.existsSync(lock), false);
});

const queues = [];
function queue(name, options = {}) {
  const q = new IndexQueue({ file: path.join(base, `${name}-queue.json`), embedder: fake, watch: false, debounceMs: 5, ...options });
  queues.push(q);
  return q;
}
async function until(condition, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function docs(name, content = 'ORCHID logout') {
  const root = fixture(name);
  initialize(root, ['docs']);
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), content);
  return root;
}

test('idempotent registration and reconciliation; project-local indexes ignore themselves', async () => {
  const root = docs('queue-idempotent');
  const q = queue('idempotent');
  q.register(root, 'one');
  const sequence = q.sequence;
  q.register(root, 'one');
  q.reconcile(root);
  assert.equal(q.sequence, sequence);
  assert.equal(q.pending.size, 1);
  await q.flush(root);
  const before = embedded;
  const checked = indexSummary(root).checkedAt;
  for (let i = 0; i < 3; i++) { q.register(root, 'one'); q.reconcile(root); await q.flush(root); }
  assert.equal(embedded, before);
  assert.equal(indexSummary(root).checkedAt, checked);
  assert.equal(databasePath(root), path.join(root, '.semantic-search', 'index.sqlite'));
  assert.equal(fs.readFileSync(path.join(root, '.semantic-search', '.gitignore'), 'utf8'), '*\n');
  q.unregister('one');
  assert.equal(q.projects.size, 0);
  q.close();
});

test('pending dedup moves to tail; batches mix projects and keep results isolated', async () => {
  const a = docs('queue-alpha', 'alpha ORCHID');
  const b = docs('queue-beta', 'beta warehouse');
  const batches = [];
  const q = queue('shared', { embedder: { ...fake, async embed(texts) { batches.push(texts); return fake.embed(texts); } } });
  q.register(a, 'one'); q.register(b, 'two');
  q.enqueue(a, 'docs/a.md', { immediate: true });
  assert.deepEqual([...q.pending.values()].map(x => x.root), [b, a]);
  const persisted = JSON.parse(fs.readFileSync(q.file));
  assert.deepEqual(persisted.pending.map(x => x.root), [b, a]);
  assert.ok(persisted.pending.every(x => Object.keys(x).sort().join(',') === 'path,root'));
  await Promise.all([q.flush(a), q.flush(b)]);
  assert.ok(batches.some(texts => texts.some(text => text.includes('alpha')) && texts.some(text => text.includes('beta'))));
  const found = await search(a, 'ORCHID', 6, fake, indexSummary(a));
  assert.ok(found.results.every(x => !x.text.includes('beta')));
  q.close();
});

test('edit during inference commits captured hash, then next batch commits the new source', async () => {
  const root = docs('queue-live-edit', 'first version');
  let entered, resume;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  let calls = 0;
  const q = queue('live-edit', { embedder: { ...fake, async embed(texts) {
    if (++calls === 1) { entered(); await gate; }
    return fake.embed(texts);
  } } });
  q.register(root, 'session');
  const firstWait = q.flush(root);
  await started;
  const firstHash = scan(root, readConfig(root).config).files.get('docs/a.md').hash;
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'second version');
  q.enqueue(root, 'docs/a.md');
  q.reconcile(root); q.reconcile(root);
  assert.equal(q.active.length, 1);
  assert.equal(q.pending.size, 1);
  resume();
  await firstWait;
  assert.equal(indexedFiles(root).get('docs/a.md').hash, firstHash);
  assert.equal(status(root).stale, true);
  await q.flush(root);
  assert.equal(status(root).stale, false);
  assert.equal(calls, 2);
  assert.match((await search(root, 'version', 6, fake, indexSummary(root))).results[0].text, /second version/);
  q.close();
});

test('recover interrupted paths, prune dead projects/files, reconcile offline edits idempotently', async () => {
  const root = docs('queue-recovery', 'before crash');
  const dead = docs('queue-dead');
  let entered, resume;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const q = queue('recovery', { embedder: { ...fake, async embed(texts) { entered(); await gate; return fake.embed(texts); } } });
  q.register(root, 'session'); q.register(dead, 'other');
  await started;
  assert.ok(JSON.parse(fs.readFileSync(q.file)).active.length);
  q.close();
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'after crash latest');
  fs.writeFileSync(path.join(root, 'docs', 'new.md'), 'offline addition');
  fs.rmSync(dead, { recursive: true });
  resume();
  await until(() => !q.running);
  const recovered = queue('recovery');
  recovered.restore();
  await recovered.flush(root);
  assert.equal(status(root).stale, false);
  assert.equal(indexSummary(root).indexed, 2);
  assert.equal(recovered.projects.has(dead), false);
  assert.equal(fs.existsSync(dead), false);
  const count = embedded;
  recovered.close();
  const again = queue('recovery');
  again.restore();
  await again.flush(root);
  assert.equal(embedded, count);
  fs.unlinkSync(path.join(root, 'docs', 'a.md'));
  again.enqueue(root, 'docs/a.md');
  again.close();
  const deletion = queue('recovery'); deletion.restore();
  await deletion.flush(root);
  assert.equal(indexSummary(root).indexed, 1);
  assert.equal(indexedFiles(root).has('docs/a.md'), false);
  deletion.close();
});

test('real filesystem watchers index edits, renames, folder recreation and owner refcounts', async () => {
  const root = docs('queue-watcher');
  const q = queue('watcher', { watch: true });
  q.register(root, 'one'); q.register(root, 'two');
  await q.flush(root);
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'changed by watcher');
  await until(() => !status(root).stale);
  fs.renameSync(path.join(root, 'docs', 'a.md'), path.join(root, 'docs', 'renamed.md'));
  await until(() => !status(root).stale);
  assert.equal(indexedFiles(root).has('docs/a.md'), false);
  assert.equal(indexedFiles(root).has('docs/renamed.md'), true);
  fs.rmSync(path.join(root, 'docs'), { recursive: true });
  await until(() => indexSummary(root).indexed === 0);
  fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'nested', 'fresh.md'), 'new directory');
  await until(() => indexSummary(root).indexed === 1 && !status(root).stale);
  q.unregister('one');
  assert.ok(q.projects.get(root).watchers.size > 0);
  q.unregister('two');
  assert.equal(q.projects.has(root), false);
  q.close();
});

test('missing queue cache is repaired on registration; changed config removes excluded content', async () => {
  const root = docs('queue-cache-loss');
  await refresh(root, fake);
  fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'offline update');
  const q = queue('cache-loss'); q.restore(); q.register(root, 'one');
  await q.flush(root);
  assert.equal(status(root).stale, false);
  const { config } = readConfig(root);
  fs.writeFileSync(path.join(root, '.semantic-search.json'), JSON.stringify({ ...config, exclude: ['docs/a.md'] }));
  q.reconcile(root); await q.flush(root);
  assert.equal(indexSummary(root).indexed, 0);
  q.close();
});

test('SIGKILL recovery replays active paths with current bytes', async () => {
  const root = docs('queue-killed', 'before process crash');
  const file = path.join(base, 'killed-queue.json');
  const marker = path.join(base, 'killed-started');
  const module = new URL('./queue.mjs', import.meta.url).href;
  const code = `setInterval(()=>{},1000); import fs from 'node:fs'; import {IndexQueue} from ${JSON.stringify(module)}; const q = new IndexQueue({file:process.argv[2],watch:false,embedder:{tokenCount:t=>t.length/3,embed:async texts=>{fs.writeFileSync(process.argv[3],'ready');await new Promise(()=>{});}}});q.register(process.argv[1],'session');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, file, marker], { stdio: 'ignore' });
  try {
    await until(() => fs.existsSync(marker));
    assert.equal(JSON.parse(fs.readFileSync(file)).active.length, 1);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'latest after kill');
    const q = queue('killed'); q.restore();
    await q.flush(root);
    assert.equal(status(root).stale, false);
    assert.match((await search(root, 'latest', 6, fake, indexSummary(root))).results[0].text, /latest after kill/);
    q.close();
  } finally { child.kill('SIGKILL'); }
});

test('a broken document does not block another project and can recover', async () => {
  const bad = docs('queue-bad');
  const good = docs('queue-good');
  const q = queue('isolation', { retryMs: 100 });
  q.register(bad, 'bad'); q.register(good, 'good');
  fs.writeFileSync(path.join(bad, 'docs', 'a.md'), Buffer.from([0, 1, 2]));
  await assert.rejects(q.flush(bad), /not plain text/);
  await q.flush(good);
  assert.equal(status(good).stale, false);
  fs.writeFileSync(path.join(bad, 'docs', 'a.md'), 'repaired');
  q.reconcile(bad);
  await q.flush(bad);
  assert.equal(status(bad).stale, false);
  q.close();
});

test('recovery skips committed batches and releases abandoned request-only registrations', async () => {
  const root = docs('queue-already-committed');
  await refresh(root, fake);
  const count = embedded;
  const q = queue('already-committed');
  fs.writeFileSync(q.file, JSON.stringify({ version: 1, projects: [{ root, owners: ['session'] }], active: [{ root, path: 'docs/a.md' }], pending: [] }));
  q.restore(); await q.flush(root);
  assert.equal(embedded, count);
  q.close();
  const orphan = queue('orphan-request');
  fs.writeFileSync(orphan.file, JSON.stringify({ version: 1, projects: [{ root, owners: ['request:dead'] }], active: [], pending: [] }));
  orphan.restore();
  assert.equal(orphan.projects.size, 0);
  assert.equal(embedded, count);
  orphan.close();
});
