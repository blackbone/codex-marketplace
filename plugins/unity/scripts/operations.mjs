import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const lockPath = root => path.join(root, 'Library/CodexUnity/operation.lock');
export function operationOwner(root) {
  const lock = lockPath(root);
  try { return JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); }
  catch { return fs.existsSync(lock) ? { kind: 'unidentified' } : null; }
}
export function acquireOperation(root, kind) {
  const lock = lockPath(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  const owner = { id: randomUUID(), kind, pid: process.pid, at: Date.now() };
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  return owner;
}
export function releaseOperation(root, id) {
  if (operationOwner(root)?.id !== id) return false;
  fs.rmSync(lockPath(root), { recursive: true });
  return true;
}
export function updateOperation(root, id, fields) {
  const owner = operationOwner(root);
  if (owner?.id !== id) return false;
  const file = path.join(lockPath(root), 'owner.json');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...owner, ...fields, id:owner.id }), { mode:0o600 });
    if (operationOwner(root)?.id !== id) return false;
    fs.renameSync(temp,file);
    return true;
  } finally { fs.rmSync(temp,{force:true}); }
}
export function retainUnknown(root, id) {
  return updateOperation(root,id,{kind:'command_outcome_unknown'});
}

export function operationBlocked(project) {
  const owner = operationOwner(project.root);
  return { ok: false, project, state: 'operation_busy', reason: owner?.kind === 'recovery' ? 'recovery_in_progress' : 'operation_in_progress',
    executed: false, outcome: 'not_sent', facts: { operation: ['command','recovery','command_outcome_unknown'].includes(owner?.kind) ? owner.kind : 'unidentified' },
    nextAction: { code: 'resolve_operation', instruction: 'Do not dispatch or recover concurrently. The owning task must finish recovery or reconcile its command result. A dead owner never authorizes an automatic retry.' }, requiresInteractive: false };
}
