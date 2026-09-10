import { setTimeout as delay } from 'node:timers/promises';
import { canonical, UnityError } from './project.mjs';
import { diagnose, globalArgs, report, safeCode } from './diagnostics.mjs';
import { outsideBudget, withinBudget } from './budget.mjs';

export const READY_WAIT_SECONDS = 600;
export function waitSeconds(value = process.env.UNITY_READY_TIMEOUT_SECONDS ?? READY_WAIT_SECONDS) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600 || value === '') throw new UnityError('INVALID_WAIT', 'Readiness wait must be an integer from 0 to 3600 seconds.');
  return n;
}
export const temporaryReasons = new Set(['compiling','domain_reload','settling','descriptor_missing','descriptor_invalid','descriptor_stale',
  'server_unreachable','pipeline_unavailable','pipeline_not_ready','diagnostic_timeout','process_inspection_timeout','editor_status_timeout',
  'launching','launch_requested']);

// Only this known read-only status command is retried. The requested operation is
// never passed to this loop. isUpdating is exposed as domainReloadInProgress by Pipeline.
export async function editorIdle(project, run, timeout) {
  const result = await run(process.env.UNITY_CLI || 'unity',
    ['command','editor_status','--project-path',project.root,'--timeout',String(Math.max(1, Math.ceil(timeout / 1000))), ...globalArgs],
    { cwd: project.root, timeout });
  const d = result.data?.data;
  const status = d?.result;
  if (result.ok && d?.success !== true) return report(project,'protocol_incompatible');
  if (!result.ok) {
    const reason = ['TIMEOUT','CANCELLED'].includes(result.error) ? 'editor_status_timeout' :
      ['UNAUTHORIZED','AUTHENTICATION_FAILED'].includes(result.error) ? 'authentication_failed' :
      result.error === 'CLI_MISSING' ? 'cli_missing' : 'pipeline_unavailable';
    return report(project, reason, { cliError: safeCode(result.error) });
  }
  if (typeof status?.projectPath !== 'string' || canonical(status.projectPath) !== project.root) return report(project,'descriptor_project_mismatch');
  if (status.status === 'blocked_by_dialog') return report(project,'blocked_by_dialog');
  if (typeof status.compiling !== 'boolean' || typeof status.domainReloadInProgress !== 'boolean') return report(project,'protocol_incompatible');
  const facts = { compiling: status.compiling, updating: status.domainReloadInProgress };
  if (status.compiling) return report(project,'compiling', facts);
  if (status.domainReloadInProgress) return report(project,'domain_reload', facts);
  if (!['ready','playing'].includes(status.status)) return report(project,'pipeline_not_ready',facts);
  return report(project,'ready',facts);
}

export function cancelled(project) {
  return { ok:false, project, state:'cancelled', reason:'readiness_cancelled', executed:false, outcome:'not_sent', requiresInteractive:false };
}
export function expired(project, last, elapsedMs) {
  return { ...last, ok:false, project, state:'readiness_timeout', reason:'readiness_timeout', executed:false, outcome:'not_sent', requiresInteractive:false,
    facts:{...last?.facts,lastReason:last?.reason,elapsedMs},
    nextAction:{code:'diagnose_persistent_failure',instruction:'Readiness did not recover within the call budget. Preserve implementation and inspect the last reason; do not rerun or replay the task automatically.'} };
}
export async function pause(ms, signal) {
  try { await delay(ms, undefined, { signal }); } catch (e) { if (e.name !== 'AbortError') throw e; }
}
export async function waitForReady(project, run, deps = {}) {
  // The interactive caller may have a short diagnostic scope; waiting has its own
  // absolute deadline. Every individual probe still has a short bounded scope.
  return outsideBudget(async () => {
    const seconds = waitSeconds(deps.waitSeconds);
    const now = deps.now || Date.now, start = now();
    const deadline = deps.deadline ?? start + (seconds === 0 ? 16000 : seconds * 1000);
    let last, attempts = 0;
    while (true) {
      if (deps.signal?.aborted) return cancelled(project);
      if (now() >= deadline) return expired(project,last,now()-start);
      try {
        last = await withinBudget(() => diagnose(project,run,deps),Math.max(1,Math.min(6000,deadline-now())));
        attempts++;
        if (last.state === 'ready') {
          const idle = await withinBudget(() => (deps.idle || editorIdle)(project,run,Math.max(1,Math.min(10000,deadline-now()))),Math.max(1,deadline-now()));
          last = {...last,...idle,pid:last.pid,facts:{...last.facts,...idle.facts}};
          if (last.state === 'ready') {
            if (deps.signal?.aborted) return cancelled(project);
            if (now() >= deadline) return expired(project,last,now()-start);
            return {...last,wait:{attempts,elapsedMs:now()-start}};
          }
        }
      } catch(e) {
        if (e.code !== 'DIAGNOSTIC_TIMEOUT') throw e;
        last = report(project,'diagnostic_timeout');
      }
      if (deps.signal?.aborted) return cancelled(project);
      if (seconds === 0 || !temporaryReasons.has(last.reason)) return {...last,wait:{attempts,elapsedMs:now()-start}};
      deps.onProgress?.({reason:last.reason,elapsedMs:now()-start});
      await (deps.pause || pause)(Math.max(0,Math.min(1000,deadline-now())),deps.signal);
    }
  });
}
