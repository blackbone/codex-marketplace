import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { cacheDir, hash, alive, withLock, delay } from './common.mjs';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const runtimeKey = hash(['common.mjs', 'embedding.mjs', 'index.mjs', 'queue.mjs', 'server.mjs', 'client.mjs'].map(file => fs.readFileSync(path.join(sourceDir, file))).map(x => hash(x)).join(':')).slice(0, 16);
export const statePath = () => path.join(cacheDir('servers'), 'daemon-v2.json');

export async function healthy() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (!alive(state.pid) || state.protocol !== 2 || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535) return null;
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(1500) });
    const health = await response.json();
    return response.ok && health.pid === state.pid && health.protocol === 2 ? state : null;
  } catch { return null; }
}

export async function ensureServer() {
  const existing = await healthy();
  if (existing) return existing;
  return withLock(`${statePath()}.lock`, async () => {
    const running = await healthy();
    if (running) return running;
    // A live but unresponsive owner must not result in a second daemon.
    try {
      const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      if (alive(state.pid)) throw new Error('Search daemon is alive but not responding; retry shortly');
    } catch (error) { if (error.message.startsWith('Search daemon')) throw error; }
    const log = fs.openSync(path.join(cacheDir('servers'), `${runtimeKey}.log`), 'w', 0o600);
    const child = spawn(process.execPath, [path.join(sourceDir, 'server.mjs'), runtimeKey], {
      cwd: sourceDir, detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, SEMANTIC_SEARCH_TOKEN: crypto.randomBytes(32).toString('hex') },
    });
    fs.closeSync(log);
    let spawnError;
    child.on('error', e => { spawnError = e; });
    child.unref();
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      const state = await healthy();
      if (state) return state;
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`Search process did not start. See ${path.join(cacheDir('servers'), `${runtimeKey}.log`)}`);
  }, 30_000);
}

export async function request(method, args) {
  const state = method === 'unregister' ? await healthy() : await ensureServer();
  if (!state) return { unregistered: true };
  const response = await fetch(`http://127.0.0.1:${state.port}/call`, {
    method: 'POST', headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(900_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Search service returned ${response.status}`);
  return { ...result, servicePid: state.pid };
}
