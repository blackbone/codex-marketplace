import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { cacheDir, tempRoot, readConfig, atomicJson, withLock, alive, hash, delay } from './common.mjs';
import { healthy } from './client.mjs';

const script = fileURLToPath(import.meta.url);
const assets = new URL('../assets/dashboard/', import.meta.url);
const version = hash([fs.readFileSync(script), ...['index.html', 'app.js', 'style.css'].map(file => fs.readFileSync(new URL(file, assets)))].map(hash).join(':')).slice(0, 16);
const statePath = () => path.join(cacheDir('servers'), `dashboard-${version}.json`);

function indexCounts(root) {
  const dir = path.join(root, '.semantic-search');
  const file = path.join(dir, 'index.sqlite');
  if (!fs.existsSync(file)) return { indexed: 0, chunks: 0, checkedAt: null, indexExists: false };
  for (const target of [dir, file, file + '-wal', file + '-shm']) {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Index files must not be symlinks');
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN');
    return { indexExists: true, indexed: db.prepare('SELECT count(*) AS n FROM files').get().n,
      chunks: db.prepare('SELECT count(*) AS n FROM chunks').get().n,
      checkedAt: db.prepare("SELECT value FROM metadata WHERE key = 'checkedAt'").get()?.value ?? null };
  } finally { db.close(); }
}

export async function dashboardSnapshot(selectedRoot, { service = healthy } = {}) {
  const running = Boolean(await service());
  let queue = { projects: [], active: [], pending: [] }, queueError = null;
  try {
    queue = JSON.parse(fs.readFileSync(path.join(tempRoot(), 'servers', 'index-queue.json'), 'utf8'));
    if (queue.version !== 1 || !['projects', 'active', 'pending'].every(key => Array.isArray(queue[key]))) throw new Error('Unsupported queue format');
  } catch (error) {
    if (error.code !== 'ENOENT') queueError = error.message;
    queue = { projects: [], active: [], pending: [] };
  }
  const roots = new Set(queue.projects.map(project => project.root).filter(root => typeof root === 'string' && path.isAbsolute(root)));
  if (selectedRoot) roots.add(selectedRoot);
  const projects = [...roots].sort().map(root => {
    const active = queue.active.filter(job => job.root === root).map(job => job.path);
    const pending = queue.pending.filter(job => job.root === root).map(job => job.path);
    const project = { root, name: path.basename(root), selected: root === selectedRoot,
      watching: running && queue.projects.some(project => project.root === root),
      activeCount: active.length, pendingCount: pending.length, active: active.slice(0, 100), pending: pending.slice(0, 100) };
    try { return { ...project, folders: readConfig(root).config.folders, ...indexCounts(root) }; }
    catch (error) { return { ...project, error: error.message }; }
  });
  return { checkedAt: new Date().toISOString(), running, queueError, projects,
    totals: { projects: projects.length, indexed: projects.some(p => p.error) ? null : projects.reduce((n, p) => n + p.indexed, 0),
      active: projects.reduce((n, p) => n + p.activeCount, 0), pending: projects.reduce((n, p) => n + p.pendingCount, 0) } };
}

export async function startDashboard({ token, idleMs = 120_000, snapshot = dashboardSnapshot, onStop = () => {} } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('A private dashboard token is required');
  let lastUse = Date.now();
  let origin;
  const prefix = `/${token}/`;
  const resources = new Map([['', ['index.html', 'text/html; charset=utf-8']], ['app.js', ['app.js', 'text/javascript; charset=utf-8']], ['style.css', ['style.css', 'text/css; charset=utf-8']]]);
  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: 'Forbidden' });
    if (req.method !== 'GET') return send(405, { error: 'Read-only dashboard' });
    const url = new URL(req.url, origin);
    if (!url.pathname.startsWith(prefix)) return send(403, { error: 'Forbidden' });
    const route = url.pathname.slice(prefix.length);
    lastUse = Date.now();
    if (route === 'health') return send(200, { pid: process.pid, version });
    try {
      if (route === 'state') {
        const cwd = url.searchParams.get('cwd');
        const root = cwd ? readConfig(cwd).root : null;
        return send(200, await snapshot(root));
      }
      if (resources.has(route)) {
        const [file, type] = resources.get(route);
        return send(200, fs.readFileSync(new URL(file, assets)), type);
      }
      send(404, { error: 'Not found' });
    } catch (error) { send(400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true; clearInterval(timer); server.close(); server.closeAllConnections(); onStop();
  };
  const timer = setInterval(() => { if (Date.now() - lastUse > idleMs) stop(); }, Math.min(5000, idleMs));
  return { url: origin + prefix, stop, port: server.address().port };
}

async function existingDashboard() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (!alive(state.pid) || !Number.isInteger(state.port) || !/^[a-f0-9]{64}$/.test(state.token)) return null;
    const url = `http://127.0.0.1:${state.port}/${state.token}/`;
    const response = await fetch(url + 'health', { signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    return response.ok && health.pid === state.pid && health.version === version ? { ...state, url } : null;
  } catch { return null; }
}

export async function openDashboard(cwd) {
  // Unconfigured folders can still inspect the shared queue without initializing.
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('cwd must be an absolute directory path');
  let root = null;
  try { root = readConfig(cwd).root; }
  catch (error) { if (!error.message.startsWith('No .semantic-search.json found.')) throw error; }
  const state = await withLock(statePath() + '.lock', async () => {
    const existing = await existingDashboard();
    if (existing) return existing;
    const log = fs.openSync(path.join(cacheDir('servers'), `dashboard-${version}.log`), 'a', 0o600);
    const child = spawn(process.execPath, [script, '--serve'], { detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, DOCS_DASHBOARD_TOKEN: crypto.randomBytes(32).toString('hex') } });
    fs.closeSync(log);
    let spawnError;
    child.on('error', error => { spawnError = error; }); child.unref();
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      const started = await existingDashboard();
      if (started) return started;
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error('Docs dashboard did not start; inspect its local dashboard log');
  }, 15_000);
  return { url: state.url + (root ? `?cwd=${encodeURIComponent(root)}` : ''), root, refreshSeconds: 2 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script && process.argv[2] === '--serve') {
  const token = process.env.DOCS_DASHBOARD_TOKEN;
  const dashboard = await startDashboard({ token, onStop: () => {
    try { if (JSON.parse(fs.readFileSync(statePath(), 'utf8')).pid === process.pid) fs.rmSync(statePath(), { force: true }); } catch {}
  } });
  atomicJson(statePath(), { pid: process.pid, port: dashboard.port, token });
  process.on('SIGTERM', dashboard.stop); process.on('SIGINT', dashboard.stop);
}
