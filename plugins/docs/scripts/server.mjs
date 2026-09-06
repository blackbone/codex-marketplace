import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { cacheDir, atomicJson, withLock } from './common.mjs';
import { search, status } from './index.mjs';
import { IndexQueue } from './queue.mjs';

const runtimeKey = process.argv[2];
const token = process.env.SEMANTIC_SEARCH_TOKEN;
if (!/^[a-f0-9]{16}$/.test(runtimeKey || '') || !/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Start the search service through client.mjs');
const stateFile = path.join(cacheDir('servers'), 'daemon-v2.json');
// A lifetime lock also prevents split writers if startup/health checks race.
await withLock(path.join(cacheDir('servers'), 'daemon-v2.owner.lock'), async () => {
  const indexer = new IndexQueue();
  indexer.restore();
  let lastUse = Date.now();
  let pending = 0;
  let stopping = false;
  let finished;
  const lifetime = new Promise(resolve => { finished = resolve; });
  const reply = (res, code, body) => { if (!res.destroyed) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
  const server = http.createServer(async (req, res) => {
    if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) return reply(res, 403, { error: 'Forbidden' });
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { pid: process.pid, runtimeKey, protocol: 2 });
    if (req.method !== 'POST' || req.url !== '/call') return reply(res, 404, { error: 'Unknown endpoint' });
    let body = '';
    pending++;
    lastUse = Date.now();
    let owner;
    try {
      for await (const part of req) {
        body += part;
        if (body.length > 100_000) throw new Error('Request too large');
      }
      const { method, args } = JSON.parse(body);
      if (!args || typeof args !== 'object') throw new Error('Missing arguments');
      if (method === 'register') {
        const root = indexer.register(args.cwd, args.owner);
        return reply(res, 200, { root, registered: root !== null });
      }
      if (method === 'unregister') {
        if (typeof args.owner !== 'string' || !args.owner) throw new Error('A registration owner is required');
        indexer.unregister(args.owner);
        return reply(res, 200, { unregistered: true });
      }
      if (!['search', 'index', 'status'].includes(method)) throw new Error('Unknown method');
      if (method === 'status') return reply(res, 200, status(args.cwd));
      owner = `request:${crypto.randomUUID()}`;
      const root = indexer.register(args.cwd, owner);
      const ready = await indexer.flush(root, { reconcile: method === 'index' });
      const result = method === 'search' ? await search(root, args.query, args.limit, undefined, ready) : ready;
      reply(res, 200, result);
    } catch (error) { reply(res, 400, { error: error.message }); }
    finally {
      if (owner) indexer.unregister(owner);
      pending--; lastUse = Date.now();
    }
  });
  function stop() {
    if (stopping) return;
    stopping = true;
    indexer.close(); // Persist active paths; restart rereads their current bytes.
    clearInterval(idle);
    try { if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid === process.pid) fs.rmSync(stateFile, { force: true }); } catch {}
    server.close();
    server.closeAllConnections();
    finished();
  }
  server.on('error', error => { console.error(error); stop(); process.exitCode = 1; });
  server.listen(0, '127.0.0.1', () => atomicJson(stateFile, { pid: process.pid, port: server.address().port, token, runtimeKey, protocol: 2 }));
  // Registered projects keep their watchers alive even when inference is idle.
  const idle = setInterval(() => {
    if (!pending && !indexer.projects.size && !indexer.pending.size && !indexer.active.length && Date.now() - lastUse > 120_000) stop();
  }, 5000);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await lifetime;
}, 30_000);
process.exit(process.exitCode || 0);
