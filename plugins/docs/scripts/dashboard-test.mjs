import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { initialize } from './common.mjs';
import { refresh } from './index.mjs';
import { sourceContext, contextualResults, openDocument } from './dashboard-documents.mjs';
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

test('search POST validates requests before invoking the shared search contract and returns real indexed fragments', async () => {
  const root = fixture('search-project');
  fs.writeFileSync(path.join(root, 'docs', 'sessions.md'), '# Session revocation\n\nRevoke refresh tokens to end user sessions.');
  const { search } = await import('./index.mjs');
  const calls = [];
  const dashboard = await startDashboard({ token: crypto.randomBytes(32).toString('hex'), search: async args => {
    calls.push(args);
    if (args.query === 'failure') throw new Error('Search service unavailable');
    return search(args.cwd, args.query, args.limit, fake);
  } });
  const origin = new URL(dashboard.url).origin;
  const post = (body, headers = {}) => fetch(dashboard.url + 'search', { method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(dashboard.url + 'search')).status, 405);
    assert.equal((await post({ cwd: root, query: 'sessions' }, { origin: 'https://example.com' })).status, 403);
    assert.equal((await post({ cwd: root, query: 'sessions' }, { origin: '' })).status, 403);
    assert.equal((await post({ cwd: root, query: 'sessions' }, { 'content-type': 'text/plain' })).status, 415);
    for (const query of ['', '   ', 'x'.repeat(4001), null]) assert.equal((await post({ cwd: root, query })).status, 400);
    for (const cwd of [undefined, null, '.', 42]) assert.equal((await post({ cwd, query: 'sessions' })).status, 400);
    assert.equal((await post({ cwd: base, query: 'sessions' })).status, 400);
    assert.equal((await post({ cwd: root, query: 'x'.repeat(21000) })).status, 413);
    assert.equal(calls.length, 0);
    const response = await post({ cwd: path.join(root, 'docs'), query: ' sessions ' });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(calls[0], { cwd: root, query: 'sessions', limit: 20 });
    assert.equal(data.results[0].path, 'docs/sessions.md');
    assert.equal(data.results[0].fromLine, 1);
    assert.match(data.results[0].text, /Revoke refresh tokens/);
    const empty = await (await post({ cwd: fixture('empty-search'), query: 'sessions' })).json();
    assert.deepEqual(empty.results, []);
    const failed = await post({ cwd: root, query: 'failure' });
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { error: 'Search service unavailable' });
  } finally { dashboard.stop(); }
});

test('a long search keeps the dashboard alive until it completes', async () => {
  const root = fixture('slow-search');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const dashboard = await startDashboard({ token: crypto.randomBytes(32).toString('hex'), idleMs: 100,
    search: async () => { entered(); await gate; return { results: [] }; } });
  try {
    const pending = fetch(dashboard.url + 'search', { method: 'POST',
      headers: { origin: new URL(dashboard.url).origin, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: root, query: 'sessions' }) });
    await started;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await fetch(dashboard.url + 'health')).status, 200);
    release();
    assert.equal((await pending).status, 200);
  } finally { release(); dashboard.stop(); }
});

test('result context restores a whole section, filters Markdown-only hits and merges duplicate sections', () => {
  const root = fixture('context-results');
  const paragraph = 'Railgun fires a projectile through the target. '.repeat(20);
  const text = '# Weapons\n\n## Railgun\n\n' + paragraph + '\n\nDamage falls with distance.\n\n## Armour\nProtection.';
  fs.writeFileSync(path.join(root, 'docs', 'weapons.md'), text);
  const hit = { path: 'docs/weapons.md', heading: 'Weapons > Railgun', fromLine: 5, toLine: 5, text: paragraph.slice(0, 80) };
  const found = contextualResults(root, { results: [
    { ...hit, text: '|---|---:|---|' }, { ...hit, text: '## Railgun' }, hit,
    { ...hit, fromLine: 7, toLine: 7, text: 'Damage falls with distance.' },
  ] });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].text, hit.text, 'retain the precise indexed chunk separately');
  assert.equal(found.results[0].context.fromLine, 3);
  assert.equal(found.results[0].context.toLine, 8);
  assert.ok(found.results[0].context.text.includes(paragraph));
  assert.match(found.results[0].context.text, /Damage falls/);
  assert.doesNotMatch(found.results[0].context.text, /Protection/);
  fs.writeFileSync(path.join(root, 'docs', 'weapons.md'), '# Changed\nCompletely different.');
  const stale = contextualResults(root, { results: [hit] }).results[0];
  assert.equal(stale.context, null);
  assert.match(stale.contextError, /изменился/);
  fs.unlinkSync(path.join(root, 'docs', 'weapons.md'));
  assert.match(contextualResults(root, { results: [hit] }).results[0].contextError, /недоступен/);
});

test('large table previews are bounded, can expand fully, and fenced headings do not split context', () => {
  const text = '# Resources\n\n| Name | Effect |\n|---|---|\n' + Array.from({ length: 200 }, (_, i) => `| Module ${i} | ${'Adds damage. '.repeat(30)} |`).join('\n') + '\n\n# Next\nOther.';
  const preview = sourceContext(text, 100, 100);
  assert.ok(preview.truncated);
  assert.ok(preview.fromLine <= 100 && preview.toLine >= 100);
  assert.ok(preview.text.length <= 24000);
  const full = sourceContext(text, 100, 100, true);
  assert.equal(full.truncated, false);
  assert.match(full.text, /Module 0/);
  assert.match(full.text, /Module 199/);
  assert.doesNotMatch(full.text, /Other/);
  const code = '# Example\n```python\n# code comment\nprint(1)\n```\nExplanation.\n# Next';
  assert.equal(sourceContext(code, 4, 4).fromLine, 1);
  assert.match(sourceContext(code, 4, 4).text, /Explanation/);
  assert.equal(sourceContext(code, 100, 101), null);
});

test('file opening and full context only expose configured documents and enforce same-origin POST', async () => {
  const root = fixture('document-access');
  const filename = 'docs/rail $(unsafe) & "name".md';
  fs.writeFileSync(path.join(root, filename), '# Rails\n\nRailgun damage.\n\n# Armour\nShield.');
  fs.writeFileSync(path.join(root, 'secret.md'), 'Outside configured docs');
  fs.writeFileSync(path.join(root, 'docs', 'ignored.txt'), 'Excluded');
  fs.symlinkSync(path.join(root, 'secret.md'), path.join(root, 'docs', 'link.md'));
  const configFile = path.join(root, '.semantic-search.json');
  const config = JSON.parse(fs.readFileSync(configFile)); config.exclude = ['docs/ignored.txt'];
  fs.writeFileSync(configFile, JSON.stringify(config));
  const calls = [];
  const launch = async (...args) => calls.push(args);
  const dashboard = await startDashboard({ token: crypto.randomBytes(32).toString('hex'), launch });
  const origin = new URL(dashboard.url).origin;
  const post = (file, headers = {}) => fetch(dashboard.url + 'open', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ cwd: root, path: file }) });
  const get = (route, file, from = 3, to = 3) => fetch(dashboard.url + route + '?' + new URLSearchParams({ cwd: root, path: file, from, to }));
  try {
    assert.equal((await fetch(dashboard.url + 'open')).status, 405);
    assert.equal((await post(filename, { origin: '' })).status, 403);
    assert.equal((await post(filename, { origin: 'https://example.com' })).status, 403);
    assert.equal((await post(filename, { 'content-type': 'text/plain' })).status, 415);
    for (const file of ['../outside.md', '/etc/passwd', 'secret.md', 'docs/link.md', 'docs/ignored.txt', 'docs/missing.md']) {
      assert.equal((await post(file)).status, 400);
      assert.equal((await get('document', file)).status, 400);
      assert.equal((await get('context', file)).status, 400);
    }
    assert.equal(calls.length, 0);
    const opened = await post(filename);
    assert.deepEqual(await opened.json(), { opened: true, path: filename });
    assert.equal(calls.length, 1);
    if (process.platform === 'win32') assert.equal(calls[0][2].env.DOCS_OPEN_FILE, path.join(root, filename));
    else assert.deepEqual(calls[0][1], [path.join(root, filename)], 'path is passed as a single argv value, never shell code');
    const document = await get('document', filename);
    assert.match(document.headers.get('content-type'), /^text\/plain/);
    assert.match(await document.text(), /Shield/);
    const context = await (await get('context', filename)).json();
    assert.match(context.text, /Railgun/); assert.doesNotMatch(context.text, /Shield/);
    assert.equal((await get('context', filename, -1, 2)).status, 400);
    await assert.rejects(openDocument(root, filename, async () => { throw new Error('No default application'); }), /No default application/);
  } finally { dashboard.stop(); }
});
