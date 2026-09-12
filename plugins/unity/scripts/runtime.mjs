import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readProject, resolveProject, UnityError, assertTodoCompatible } from './project.mjs';
import { diagnose, diagnoseFull, localDiagnosis, report, safeCode, globalArgs } from './diagnostics.mjs';
import { remaining, withinBudget, outsideBudget } from './budget.mjs';
import { waitForReady, waitSeconds, cancelled, expired, pause, temporaryReasons } from './readiness.mjs';
import { acquireOperation, operationOwner, releaseOperation, retainUnknown, operationBlocked, updateOperation, lockPath } from './operations.mjs';

import { safeResult, resultPayload } from './results.mjs';
export { safeResult };
import { completionReference, waitCompletion, completionSeconds, inspectionCommands, validReference, packageMutations } from './completion.mjs';

const scripts = path.dirname(fileURLToPath(import.meta.url));
export const PROBE_MS = 2500;
const COOLDOWN_MS = 30000;


export function execute(binary, args, { cwd, timeout = PROBE_MS, acceptExitCode = false, signal } = {}) {
  assertTodoCompatible(cwd);
  timeout = remaining(timeout);
  return new Promise(resolve => {
    const env = { ...process.env, UNITY_PROJECT_PATH: cwd };
    delete env.UNITY_LOG_PROXY;
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', bytes = 0, reason = null, done = false, started = Boolean(child.pid);
    child.on('spawn', () => { started = true; });
    function finish(code) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let data;
      try { data = JSON.parse(stdout); } catch { /* Only open accepts a plain-text success. */ }
      resolve({ started, ok: code === 0 && (data?.success === true || (acceptExitCode && !data)) && !reason, code, data,
        error: reason || (data?.errors?.[0]?.code ? safeCode(data.errors[0].code) : null) || (code === 0 ? (data?.success === true ? null : 'INVALID_RESPONSE') : 'CLI_FAILED') });
    }
    function abort(error) {
      reason = error;
      child.kill('SIGKILL');
      child.stdout.destroy(); child.stderr.destroy();
      finish(null); // A descendant retaining stdout must not defeat the time bound.
    }
    const onAbort = () => abort('CANCELLED');
    const timer = setTimeout(() => abort('TIMEOUT'), timeout);
    signal?.addEventListener('abort', onAbort, {once:true});
    if (signal?.aborted) onAbort();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) abort('OUTPUT_LIMIT');
      else stdout += chunk;
    });
    child.stderr.on('data', () => {}); // Never persist authentication or launch diagnostics.
    child.on('error', error => { reason = error.code === 'ENOENT' ? 'CLI_MISSING' : 'CLI_FAILED'; });
    child.on('close', finish);
  });
}

export function stateDirectory(root) {
  // Hook-only PLUGIN_DATA is not necessarily inherited by action tool shells.
  // A project-local lock gives both entrypoints and all installed versions the same identity.
  return path.join(root, 'Library', 'CodexUnity');
}

function load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function save(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

export function acquireLaunch(root, recover = false) {
  const dir = stateDirectory(root);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'launch.lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = load(path.join(lock, 'owner.json'));
    const at = owner?.at || fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
    if (!at) return { state: 'launching' }; // A finishing launcher removed it during inspection.
    const stale = (!owner || !alive(owner.pid)) && Date.now() - at > COOLDOWN_MS;
    // Only an explicit open can recover a dead launcher. An exclusive recovery
    // marker and owner recheck keep competing requests from removing a new lock.
    if (stale && recover) {
      try { fs.mkdirSync(path.join(lock, 'recovery')); } catch { return { state: 'launching' }; }
      const current = load(path.join(lock, 'owner.json'));
      if (JSON.stringify(current) !== JSON.stringify(owner)) {
        fs.rmdirSync(path.join(lock, 'recovery'));
        return { state: 'launching' };
      }
      fs.rmSync(lock, { recursive: true });
      return acquireLaunch(root);
    }
    return { state: stale ? 'launch_stale' : 'launching' };
  }
  const receipt = load(path.join(dir, 'launch.json'));
  if (receipt && Date.now() - receipt.at < COOLDOWN_MS) {
    fs.rmdirSync(lock);
    return { state: receipt.state, ...(receipt.error ? { error: receipt.error } : {}) };
  }
  const token = randomUUID();
  save(path.join(lock, 'owner.json'), { token, pid: process.pid, at: Date.now() });
  return { state: 'acquired', dir, lock, token };
}

export async function launchWorker(root, dir, token, run = execute) {
  const lock = path.join(dir, 'launch.lock');
  if (load(path.join(lock, 'owner.json'))?.token !== token) return;
  save(path.join(lock, 'owner.json'), { token, pid: process.pid, at: Date.now() });
  let receipt;
  try {
    assertTodoCompatible(root);
    readProject(root);
    const found = withinBudget(() => localDiagnosis(readProject(root))).editor;
    if (operationOwner(root)) { receipt = { state: 'operation_busy' }; return; }
    if (found.state !== 'editor_closed') receipt = { state: found.state };
    else {
      const result = await run(process.env.UNITY_CLI || 'unity', ['open', root, ...globalArgs], { cwd: root, timeout: 15000, acceptExitCode: true });
      receipt = { state: result.ok ? 'launch_requested' : 'launch_failed', ...(result.ok ? {} : { error: result.error }) };
    }
  } catch (error) { receipt = { state: 'launch_failed', error: error.code || 'LAUNCH_FAILED' }; }
  finally {
    if (load(path.join(lock, 'owner.json'))?.token === token) {
      save(path.join(dir, 'launch.json'), { ...receipt, at: Date.now() });
      fs.rmSync(lock, { recursive: true });
    }
  }
}

export function ensureEditor(project, deps = {}) {
  assertTodoCompatible(project.root);
  if (Number(project.version.split('.')[0]) < 6000) return { project, state: 'unsupported_unity' };
  if (operationOwner(project.root)) return operationBlocked(project);
  const local = localDiagnosis(project, deps);
  const found = local.editor;
  if (found.state !== 'editor_closed') return { ...report(project, local.reason, local.facts, found.state), ...found };
  const lease = acquireLaunch(project.root, deps.recover === true);
  if (lease.state !== 'acquired') return { ...report(project, lease.state, local.facts), ...(lease.error ? { error: safeCode(lease.error) } : {}) };
  try {
    const child = (deps.spawn || spawn)(process.execPath, [path.join(scripts, 'launch.mjs'), project.root, lease.dir, lease.token],
      { cwd: project.root, detached: true, stdio: 'ignore', env: process.env });
    child.on('error', () => {
      if (load(path.join(lease.lock, 'owner.json'))?.token === lease.token) {
        save(path.join(lease.dir, 'launch.json'), { state: 'launch_failed', error: 'LAUNCH_FAILED', at: Date.now() });
        fs.rmSync(lease.lock, { recursive: true });
      }
    });
    child.unref();
    return report(project, 'launch_requested', local.facts);
  } catch (error) {
    fs.rmSync(lease.lock, { recursive: true });
    throw error;
  }
}

export async function checkPipeline(project, run = execute, deps = {}) {
  return deps.detail==='full'?diagnoseFull(project,run,deps):diagnose(project,run,deps);
}

const forbidden = new Set(['--project-path', '--runtime', '--runtime-path', '--instance', '--port', '--detach', '--timeout',
  '--format', '--json', '--non-interactive', '--proxy', '--proxy-disable', '--log-proxy', '--no-log-proxy', '--no-banner', '--no-pager']);
export function validateAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['command', 'args', 'timeoutSeconds', 'waitSeconds', 'job', 'completionTimeoutSeconds'].includes(key)) ||
      !/^[A-Za-z][A-Za-z0-9_./-]*$/.test(input.command || '') ||
      !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg === '--' || forbidden.has(arg.split('=')[0]))) {
    throw new UnityError('INVALID_ACTION', 'Use {command, args: string[], timeoutSeconds?}; target overrides and detached jobs are not allowed.');
  }
  const timeout = input.timeoutSeconds ?? 30;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new UnityError('INVALID_ACTION', 'timeoutSeconds must be an integer from 1 to 120.');
  if (input.waitSeconds !== undefined) waitSeconds(input.waitSeconds);
  if (input.job !== undefined && typeof input.job !== 'boolean') throw new UnityError('INVALID_ACTION','job must be a boolean.');
  if (input.job && (['recompile','run_tests','package_resolve'].includes(input.command) || packageMutations.has(input.command))) throw new UnityError('INVALID_ACTION','Use native completion tracking for compilation, tests and packages; jobs do not survive domain reload.');
  if (input.completionTimeoutSeconds !== undefined) completionSeconds(input.completionTimeoutSeconds);
  return { ...input, timeoutSeconds: timeout };
}

export function commandOutcome(result, action) {
  const envelope = result.data;
  const nested = envelope?.data;
  if (result.started === false || result.error === 'CLI_MISSING') return 'not_sent';
  // Pipeline's command success lives at data.success, not the process envelope.
  // A failed custom command can have changed state before failing, so it is unknown.
  const rejectedCodes = new Set(['COMMAND_NOT_FOUND','INVALID_ARGUMENTS','UNAUTHORIZED','AUTHENTICATION_FAILED','EDITOR_BUSY','BLOCKED_BY_DIALOG']);
  if (rejectedCodes.has(result.error) || (envelope?.success === false && rejectedCodes.has(envelope.errors?.[0]?.code))) return 'rejected';
  if (result.ok && envelope?.success === true && (action === 'list' ? Array.isArray(nested?.commands) : nested?.success === true) && resultPayload(result)?.success !== false) return 'succeeded';
  return 'unknown';
}

export async function perform(action, project, input, run = execute, deps = {}) {
  return outsideBudget(() => performInner(action, project, input, run, deps));
}
async function performInner(action, project, input, run, deps) {
  const request = action === 'run' ? validateAction(input) : null;
  const secondsToWait = waitSeconds(deps.waitSeconds ?? request?.waitSeconds);
  const now = deps.now || Date.now, startedAt = now();
  const deadline = deps.deadline ?? startedAt + (secondsToWait === 0 ? 16000 : secondsToWait * 1000);
  const call = (binary,args,options) => run(binary,args,{...options,signal:deps.signal});
  const readOnly = request && !request.job && request.args.length === 0 && inspectionCommands.has(request.command);
  let lease, publicationWaitStarted, borrowed = false;
  if (deps.observationId) {
    const owner=operationOwner(project.root);
    if (!readOnly || owner?.id!==deps.observationId || owner.kind!=='command_outcome_unknown') throw new UnityError('INVALID_OPERATION','Inspection requires the pending operation ID and a known status command without arguments.');
    lease=owner; borrowed=true;
  }
  while (!lease) {
    if (deps.signal?.aborted) return cancelled(project);
    if (now() >= deadline) return expired(project,operationBlocked(project),now()-startedAt);
    withinBudget(() => assertTodoCompatible(project.root),Math.max(1,deadline-now()));
    const owner = operationOwner(project.root);
    if (owner) {
      let active = false;
      if (owner.kind === 'command' && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid,0); active = true; } catch(e) { active = e.code === 'EPERM'; }
      }
      // A concurrent mkdir winner has not necessarily published owner.json yet.
      // Wait briefly; never remove or claim an unidentified/dead owner's lease.
      if (owner.kind === 'unidentified' && secondsToWait > 0) {
        publicationWaitStarted ??= now();
        if (now()-publicationWaitStarted < 2000) active = true;
      }
      if (!active || secondsToWait === 0) return operationBlocked(project);
      deps.onProgress?.({reason:'operation_in_progress',elapsedMs:now()-startedAt});
      await (deps.pause || pause)(Math.max(0,Math.min(1000,deadline-now())),deps.signal);
    } else lease = acquireOperation(project.root, 'command');
  }
  let sent = false, unknown = false;
  try {
    let status, local;
    if (borrowed) {
      // Diagnostic-only observation must work while the pending operation is busy.
      // It has fixed command names/no args and cannot release the original lease.
      local=withinBudget(()=>localDiagnosis(project,deps));
      if(local.reason!=='locally_matched') return {ok:false,...report(project,local.reason,local.facts),executed:false,outcome:'not_sent'};
      status={pid:local.editor.pid,wait:{attempts:0,elapsedMs:now()-startedAt}};
    }
    while (!borrowed) {
      status = await waitForReady(project, call, {...deps,waitSeconds:secondsToWait,deadline});
      if (status.state !== 'ready') return { ok:false,...status,executed:false,outcome:'not_sent' };
      assertTodoCompatible(project.root);
      try { local = withinBudget(() => localDiagnosis(project,deps),Math.max(1,deadline-now())); }
      catch(e) {
        const reason={DIAGNOSTIC_TIMEOUT:'diagnostic_timeout',PROCESS_INSPECTION_TIMEOUT:'process_inspection_timeout',PROCESS_INSPECTION_DENIED:'process_inspection_denied'}[e.code];
        if(!reason) throw e;
        local={reason,facts:e.details?.systemCode?{processError:e.details.systemCode}:{}};
      }
      if (local.reason === 'locally_matched' && local.editor.pid === status.pid) break;
      const reason = local.reason === 'locally_matched' ? 'descriptor_pid_mismatch' : local.reason;
      const last = report(project,reason,local.facts);
      if (secondsToWait === 0 || !temporaryReasons.has(reason)) return {ok:false,...last,executed:false,outcome:'not_sent'};
      if (deps.signal?.aborted) return cancelled(project);
      if (now() >= deadline) return expired(project,last,now()-startedAt);
      deps.onProgress?.({reason,elapsedMs:now()-startedAt});
      await (deps.pause || pause)(Math.max(0,Math.min(1000,deadline-now())),deps.signal);
    }
    const args = action === 'run' ? [request.command,...request.args,...(request.job ? ['--detach'] : [])] :
      ['--detail',input?.detail || 'compact','--limit','20',...(input?.query ? ['--query',input.query] : [])];
    const seconds = request?.timeoutSeconds || 3;
    if (deps.signal?.aborted) return cancelled(project);
    if (now() >= deadline) return expired(project,status,now()-startedAt);
    if (borrowed && operationOwner(project.root)?.id!==lease.id) throw new UnityError('OPERATION_CHANGED','The pending operation changed before inspection.');
    sent = true;
    const result = await outsideBudget(() => call(process.env.UNITY_CLI || 'unity',
      ['command', ...args, '--project-path', project.root, '--timeout', String(seconds), ...globalArgs],
      { cwd: project.root, timeout: seconds * 1000 + 1000 }));
    const acceptedJob = request?.job ? completionReference(request,result) : null;
    const outcome = acceptedJob ? 'succeeded' : commandOutcome(result, action);
    unknown = outcome === 'unknown' && action === 'run' && !readOnly;
    const reference = outcome === 'succeeded' && request ? completionReference(request,result) : null;
    if (reference) {
      reference.pid = status.pid;
      if (!updateOperation(project.root,lease.id,{completion:reference})) throw new UnityError('OPERATION_CHANGED','Operation ownership changed.');
      const completed = await waitCompletion(project,reference,call,{...deps,completionTimeoutSeconds:request.completionTimeoutSeconds});
      unknown = !completed.ok;
      return {...completed,project,wait:status.wait,executed:completed.ok ? true : 'unknown',
        ...(unknown ? {operationId:lease.id} : {})};
    }
    // An unrecognized async acceptance must not be reported as completed.
    if ((request?.job || (packageMutations.has(request?.command) && resultPayload(result)?.status==='in_progress')) && !reference && outcome === 'succeeded') {
      unknown = true;
      return {ok:false,project,state:'command_failed',reason:request.job?'unsupported_job_response':'unsupported_package_response',outcome:'unknown',executed:'unknown',operationId:lease.id};
    }
    const ok = outcome === 'succeeded';
    return { ok, project, state: ok ? 'completed' : 'command_failed', reason: ok ? 'command_succeeded' : `command_${outcome}`,
      outcome, wait:status.wait, executed: action === 'run' ? (ok ? true : outcome === 'unknown' ? 'unknown' : false) : false,
      ...(ok ? { result: safeResult(result.data, local.descriptor.token) } : { error: result.error ? safeCode(result.error) : 'COMMAND_FAILED', diagnostics:safeResult(result.data,local.descriptor.token), nextAction: { code: 'inspect_result', instruction: 'Do not resend automatically. Reconcile possible side effects before a new attempt.' } }),
      ...(unknown ? { operationId: lease.id } : {}) };
  } catch (e) {
    unknown = sent && action === 'run' && !readOnly;
    if (unknown) return { ok: false, project, state: 'command_failed', reason: 'command_unknown', outcome: 'unknown', executed: 'unknown', operationId: lease.id,
      nextAction: { code: 'inspect_result', instruction: 'Command outcome is unknown. Reconcile side effects; never retry automatically.' } };
    throw e;
  } finally {
    if (!borrowed) {
      if (unknown) retainUnknown(project.root, lease.id);
      else releaseOperation(project.root, lease.id);
    }
  }
}

export async function inspectOperation(project,command,id,run=execute,deps={}) {
  if (!inspectionCommands.has(command)) throw new UnityError('INVALID_ACTION','Inspect supports only editor_status, recompile_status, test_status or package_status.');
  return perform('run',project,{command,args:[]},run,{...deps,observationId:id});
}

export async function resumeOperation(project,id,run=execute,deps={}) {
  return outsideBudget(async()=>{
    assertTodoCompatible(project.root);
    const owner=operationOwner(project.root);
    if (!id || owner?.id!==id || !['command','command_outcome_unknown'].includes(owner.kind) || !validReference(owner.completion)) throw new UnityError('INVALID_OPERATION','No resumable completion reference for this pending operation ID. Use inspect to reconcile it.');
    if (owner.kind==='command' && alive(owner.pid)) return operationBlocked(project);
    const marker=path.join(lockPath(project.root),'resume.lock');
    try { fs.mkdirSync(marker); } catch(e) { if(e.code==='EEXIST') return operationBlocked(project); throw e; }
    try {
      fs.writeFileSync(path.join(marker,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});
      if(operationOwner(project.root)?.id!==id) throw new UnityError('OPERATION_CHANGED','Operation changed before resume.');
      if (!updateOperation(project.root,id,{kind:'command_outcome_unknown'})) throw new UnityError('OPERATION_CHANGED','Operation changed before resume.');
      const result=await waitCompletion(project,owner.completion,run,deps);
      if(result.ok) releaseOperation(project.root,id);
      return {...result,project,executed:result.ok?true:'unknown',...(result.ok?{}:{operationId:id})};
    } finally { if (operationOwner(project.root)?.id===id) fs.rmSync(marker,{recursive:true,force:true}); }
  });
}

export async function recover(project, phase, id, run = execute, deps = {}) {
  return withinBudget(() => recoverInner(project, phase, id, run, deps));
}
async function recoverInner(project, phase, id, run, deps) {
  assertTodoCompatible(project.root);
  if (phase === 'begin') {
    const lease = acquireOperation(project.root, 'recovery');
    if (!lease) return operationBlocked(project);
    try {
      const status = await checkPipeline(project, run, deps);
      if (status.state === 'ready' || status.facts.editor !== 'editor_running' || !project.pipeline ||
          !['descriptor_missing','descriptor_invalid','descriptor_pid_mismatch','descriptor_project_mismatch','descriptor_stale',
            'server_unreachable','authentication_failed','pipeline_unavailable'].includes(status.reason)) {
        releaseOperation(project.root, lease.id);
        return { ...status, ok: status.state === 'ready', recovery: 'not_needed_or_not_applicable' };
      }
      return { ...status, ok: false, recovery: 'ui_required', recoveryId: lease.id, requiresInteractive: true,
        interactiveReason: 'The official CLI has no server start/stop command. Commands through unavailable Pipeline cannot repair their own connection.',
        nextAction: { code: 'pipeline_menu', instruction: 'Hold this recovery lease. Confirm this exact project and Editor PID in UI and confirm no other client command is active. In Window/Pipeline choose Start Server if enabled; if already running, deliberately choose Stop Server then Start Server. Do not restart Editor. Then call recover --phase finish --recovery-id with this ID once; it must report ready with matching PID/project. If not ready, stop and report; never loop. Cancel this lease if abandoning the procedure.' } };
    } catch (e) { releaseOperation(project.root, lease.id); throw e; }
  }
  const owner = operationOwner(project.root);
  if (!id || owner?.id !== id) throw new UnityError('INVALID_RECOVERY', 'Recovery/operation ID does not match the current lease.');
  if (phase === 'cancel') {
    const resumeMarker=path.join(lockPath(project.root),'resume.lock');
    const resumer=load(path.join(resumeMarker,'owner.json'));
    if (fs.existsSync(resumeMarker) && (!Number.isInteger(resumer?.pid) || resumer.pid<1 || alive(resumer.pid))) throw new UnityError('OPERATION_ACTIVE','A caller is still waiting for this operation result.');
    // No force-unlock of an active command from a different caller.
    if (owner.kind === 'command') {
      try { process.kill(owner.pid, 0); throw new UnityError('OPERATION_ACTIVE', 'The command owner is still alive.'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    releaseOperation(project.root, id);
    return { ok: true, project, state: 'recovery_cancelled', reason: 'lease_released', outcome: 'not_sent' };
  }
  if (phase !== 'finish' || owner.kind !== 'recovery') throw new UnityError('INVALID_RECOVERY', 'Use begin, finish, or cancel with the owning recovery ID.');
  const status = await checkPipeline(project, run, deps);
  if (status.state === 'ready') releaseOperation(project.root, id);
  return { ...status, ok: status.state === 'ready', recovery: status.state === 'ready' ? 'verified' : 'not_verified', recoveryId: id };
}

export async function initialize(project, run = execute, deps = {}) {
  assertTodoCompatible(project.root);
  if (Number(project.version.split('.')[0]) < 6000) return { ok: false, project, state: 'unsupported_unity' };
  const lease=acquireOperation(project.root,'command');
  if (!lease) return operationBlocked(project);
  let sent=false,unknown=false;
  try {
    const before=readProject(project.root);
    if(deps.signal?.aborted) return cancelled(project);
    sent=true;
    const result = await run(process.env.UNITY_CLI || 'unity',
      ['pipeline', before.pipeline ? 'upgrade' : 'install', '--project-path', project.root, ...globalArgs],
      { cwd: project.root, timeout: 30000, signal:deps.signal });
    const updated = readProject(project.root);
    const ok = result.ok && Boolean(updated.pipeline);
    unknown=!ok && result.started!==false && result.error!=='CLI_MISSING';
    return { ok, project: updated, versionPolicy:'latest',
      state: ok ? (!before.pipeline ? 'pipeline_installed' : before.pipeline===updated.pipeline ? 'pipeline_present' : 'pipeline_upgraded') : 'install_failed',
      outcome:ok?'succeeded':unknown?'unknown':'not_sent',
      ...(unknown?{operationId:lease.id}:{}),
      ...(ok ? {} : { error: result.ok ? 'PACKAGE_NOT_ADDED' : safeCode(result.error) }) };
  } catch(error) {
    unknown=sent;
    if(!sent) throw error;
    return {ok:false,project,state:'install_failed',outcome:'unknown',error:'INSTALL_OUTCOME_UNKNOWN',operationId:lease.id};
  } finally {
    if(unknown) retainUnknown(project.root,lease.id);
    else releaseOperation(project.root,lease.id);
  }
}

export { resolveProject };

export { localDiagnosis, report, withinBudget, outsideBudget, waitForReady };
