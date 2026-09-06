import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { initialize, tempRoot } from './common.mjs';
import { request } from './client.mjs';
import { databasePath, status } from './index.mjs';

// This deliberately uses the real downloaded embedding model. Unit tests use
// an injected deterministic embedder only for index lifecycle invariants.
const exec = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-search-real-test-')));
const roots = [path.join(base, 'alpha'), path.join(base, 'beta')];
for (const root of roots) {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  initialize(root, ['docs']);
}
fs.writeFileSync(path.join(roots[0], 'docs', 'sessions.md'), '# Session revocation\n\nWhen an employee leaves, an administrator invalidates their refresh tokens. Existing access credentials expire in fifteen minutes. Forced logout revokes all sessions for that account.\n');
fs.writeFileSync(path.join(roots[0], 'docs', 'shipping.md'), '# Warehouse shipping\n\nPacking boxes and delivery trucks move physical packages between warehouses. Shipment tracking uses barcodes and carrier labels.\n');
fs.writeFileSync(path.join(roots[1], 'docs', 'food.md'), '# Pasta\n\nBoil water and cook spaghetti. Mix pasta with tomato sauce and cheese.\n');

async function cli(cwd, question) {
  const { stdout } = await exec(process.execPath, [path.join(scripts, 'cli.mjs'), 'find', question], { cwd, timeout: 900_000 });
  return JSON.parse(stdout);
}

async function hook(cwd, event, session) {
  const child = spawn(process.execPath, [path.join(scripts, 'session-context.mjs')], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); });
  child.stdin.end(JSON.stringify({ cwd, hook_event_name: event, session_id: session }));
  await done;
  assert.doesNotMatch(stdout + stderr, /registration failed|unregister failed/);
  return stdout;
}
async function until(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Watcher indexing timeout'); await new Promise(resolve => setTimeout(resolve, 50)); }
}
let mcp;
try {
  await hook(roots[0], 'SessionStart', `e2e-${process.pid}-a`);
  await hook(roots[0], 'SessionStart', `e2e-${process.pid}-b`);
  await hook(roots[1], 'SessionStart', `e2e-${process.pid}-c`);
  const started = await Promise.allSettled([cli(roots[0], 'Как отключить доступ у уволенного сотрудника?'), cli(roots[1], 'Как сварить макароны?')]);
  for (const result of started) if (result.status === 'rejected') throw result.reason;
  const [alpha, beta] = started.map(result => result.value);
  assert.equal(alpha.results[0].path, 'docs/sessions.md');
  assert.equal(beta.results[0].path, 'docs/food.md');
  assert.equal(alpha.servicePid, beta.servicePid, 'Independent CLI instances must share one loaded model process');
  assert.ok(alpha.results.every(x => x.path !== 'docs/food.md'));
  const reused = await cli(roots[0], 'How do we invalidate refresh tokens?');
  assert.equal(reused.updated, 0);
  assert.equal(reused.servicePid, alpha.servicePid);

  mcp = spawn(process.execPath, [path.join(scripts, 'mcp-server.mjs')], { cwd: roots[0], stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let counter = 0;
  readline.createInterface({ input: mcp.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  async function rpc(method, params) {
    const id = ++counter;
    const result = new Promise(resolve => waiting.set(id, resolve));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    let timer;
    try { return await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP timeout')), 30_000); })]); }
    finally { clearTimeout(timer); }
  }
  const handshake = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } });
  assert.equal(handshake.result.serverInfo.name, 'docs');
  const listed = await rpc('tools/list', {});
  assert.equal(listed.result.tools.length, 7);
  const found = await rpc('tools/call', { name: 'docs_search', arguments: { cwd: roots[0], query: 'Как заблокировать все сеансы пользователя?' } });
  assert.equal(found.result.isError, false);
  const answer = JSON.parse(found.result.content[0].text);
  assert.equal(answer.results[0].path, 'docs/sessions.md');
  assert.equal(answer.servicePid, alpha.servicePid);
  const read = await rpc('tools/call', { name: 'docs_read', arguments: { cwd: roots[0], path: 'docs/sessions.md', fromLine: 3, maxLines: 1 } });
  assert.match(JSON.parse(read.result.content[0].text).text, /^3: When an employee/);
  const invalid = await rpc('tools/call', { name: 'docs_read', arguments: { cwd: roots[0], path: '../outside.md' } });
  assert.equal(invalid.result.isError, true);
  await hook(roots[0], 'SessionEnd', `e2e-${process.pid}-a`);
  fs.writeFileSync(path.join(roots[0], 'docs', 'watcher.md'), '# Background indexing\nORCHID documents are updated by the watcher without a search request.');
  await until(() => !status(roots[0]).stale);
  fs.renameSync(path.join(roots[0], 'docs', 'watcher.md'), path.join(roots[0], 'docs', 'renamed.md'));
  await until(() => !status(roots[0]).stale);
  const watcherResult = await cli(roots[0], 'ORCHID background indexing');
  assert.ok(watcherResult.results.some(result => result.path === 'docs/renamed.md'));
  assert.ok(watcherResult.results.every(result => result.path !== 'docs/watcher.md'));
  if (process.env.SEMANTIC_SEARCH_EXAMPLE_OUTPUT) fs.writeFileSync(process.env.SEMANTIC_SEARCH_EXAMPLE_OUTPUT, JSON.stringify({ config: JSON.parse(fs.readFileSync(path.join(roots[0], '.semantic-search.json'))), status: { indexed: watcherResult.indexed, pending: watcherResult.pending, index: '.semantic-search/index.sqlite' }, query: 'Как отключить доступ у уволенного сотрудника?', result: alpha.results[0] }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: ['real multilingual semantic retrieval', 'two projects remain isolated', 'parallel CLI and MCP share one model process', 'unchanged files reuse embeddings', 'MCP handshake and seven tools', 'current source line reads', 'path boundaries', 'session hooks register/unregister with owner refcounts', 'watcher indexes without a query', 'rename removes old index entries'], servicePid: alpha.servicePid, cacheRoot: tempRoot() }, null, 2));
} finally {
  mcp?.kill();
  for (const suffix of ['a', 'b', 'c']) await request('unregister', { owner: `session:e2e-${process.pid}-${suffix}` }).catch(() => {});
  for (const root of roots) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath(root) + suffix, { force: true });
  fs.rmSync(base, { recursive: true, force: true });
}
