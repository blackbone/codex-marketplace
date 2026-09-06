import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { initialize } from './common.mjs';
import { refresh } from './index.mjs';
import { IndexQueue } from './queue.mjs';
import { dashboardSnapshot, startDashboard, openDashboard } from './dashboard.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-dashboard-tests-')));
process.env.SEMANTIC_SEARCH_TMP_ROOT = path.join(base, 'cache');
const fixture = name => {
  const root = path.join(base, name); fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); initialize(root, ['docs']); return root;
};
const fake = { tokenCount: text => text.length / 4, embed: async texts => texts.map(() => [1, 0]) };
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('dashboard observes real queued work without taking ownership or initializing indexes', async () => {
  const root = fixture('observed');
  fs.writeFileSync(path.join(root, 'docs', 'old.md'), '# Saved document');
  await refresh(root, fake);
  const empty = fixture('no-index');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const queue = new IndexQueue({ watch: false, maxFiles: 1, embedder: { ...fake, embed: async texts => { entered(); await gate; return fake.embed(texts); } } });
  try {
    fs.writeFileSync(path.join(root, 'docs', 'active.md'), '# Active document');
    fs.writeFileSync(path.join(root, 'docs', 'waiting.md'), '# Waiting document');
    queue.register(root, 'test-owner');
    await started;
    const before = fs.readFileSync(queue.file, 'utf8');
    const snapshot = await dashboardSnapshot(empty, { service: async () => ({ pid: process.pid }) });
    assert.deepEqual(snapshot.totals, { projects: 2, indexed: 1, active: 1, pending: 1 });
    const project = snapshot.projects.find(p => p.root === root);
    assert.equal(project.chunks, 1);
    assert.deepEqual(project.active, ['docs/active.md']);
    assert.deepEqual(project.pending, ['docs/waiting.md']);
    assert.equal(fs.existsSync(path.join(empty, '.semantic-search')), false);
    assert.equal(fs.readFileSync(queue.file, 'utf8'), before);
    const offline = await dashboardSnapshot(root, { service: async () => null });
    assert.equal(offline.running, false);
    assert.equal(offline.projects.find(p => p.root === root).watching, false);
    assert.equal(offline.totals.active, 1, 'preserved active paths are recovery state when offline');
    release();
    await queue.flush(root);
    const finished = await dashboardSnapshot(root, { service: async () => ({}) });
    assert.deepEqual(finished.totals, { projects: 1, indexed: 3, active: 0, pending: 0 });
  } finally { release(); queue.close(); }
});

test('missing or malformed queue is explicit; unreadable indexes do not masquerade as zero counts', async () => {
  const journal = path.join(base, 'cache', 'servers', 'index-queue.json');
  fs.rmSync(journal, { force: true });
  const empty = await dashboardSnapshot(null, { service: async () => null });
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.queueError, null);
  fs.writeFileSync(journal, '{invalid');
  assert.ok((await dashboardSnapshot(null, { service: async () => null })).queueError);
  const root = fixture('broken-index');
  fs.mkdirSync(path.join(root, '.semantic-search'));
  fs.writeFileSync(path.join(root, '.semantic-search', 'index.sqlite'), 'broken sqlite');
  const snapshot = await dashboardSnapshot(root, { service: async () => null });
  assert.ok(snapshot.projects[0].error);
  assert.equal(snapshot.projects[0].indexed, undefined);
  assert.equal(snapshot.totals.indexed, null);
});

test('HTTP page refresh reads only local status and enforces private URL, host, origin and methods', async () => {
  const root = fixture('http-project');
  const token = crypto.randomBytes(32).toString('hex');
  const roots = [];
  const dashboard = await startDashboard({ token, snapshot: async root => { roots.push(root); return { count: roots.length }; } });
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /Индексация/);
    assert.equal((await fetch(dashboard.url + 'app.js')).status, 200);
    assert.equal((await fetch(dashboard.url + 'style.css')).status, 200);
    const state = dashboard.url + 'state?cwd=' + encodeURIComponent(path.join(root, 'docs'));
    assert.deepEqual(await (await fetch(state)).json(), { count: 1 });
    assert.deepEqual(await (await fetch(state)).json(), { count: 2 });
    assert.deepEqual(roots, [root, root]);
    assert.equal((await fetch(new URL('/state', dashboard.url))).status, 403);
    assert.equal((await fetch(state, { headers: { origin: 'https://example.com' } })).status, 403);
    const hostileHost = await new Promise((resolve, reject) => {
      http.get(state, { headers: { host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(hostileHost, 403);
    assert.equal((await fetch(state, { method: 'POST' })).status, 405);
    assert.equal((await fetch(dashboard.url + 'missing')).status, 404);
    assert.equal(roots.length, 2);
  } finally { dashboard.stop(); }
});

test('idle dashboard closes and repeated opens reuse the local page server without starting the indexer', async () => {
  const stopped = new Promise(async resolve => {
    await startDashboard({ token: crypto.randomBytes(32).toString('hex'), idleMs: 25, onStop: resolve });
  });
  await stopped;
  const one = await openDashboard(base);
  const two = await openDashboard(base);
  assert.equal(one.url, two.url);
  assert.equal(one.root, null);
  assert.equal(fs.existsSync(path.join(base, 'cache', 'servers', 'daemon-v2.json')), false);
  const health = await (await fetch(one.url + 'health')).json();
  process.kill(health.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!fs.readdirSync(path.join(base, 'cache', 'servers')).some(file => /^dashboard-.*\.json$/.test(file))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Dashboard failed to remove its own state on shutdown');
});
