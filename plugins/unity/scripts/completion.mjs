import { UnityError } from './project.mjs';
import { createHash } from 'node:crypto';
import { localDiagnosis, report, globalArgs, safeCode } from './diagnostics.mjs';
import { withinBudget } from './budget.mjs';
import { pause, temporaryReasons } from './readiness.mjs';
import { resultPayload, safeResult } from './results.mjs';
import { waitForReady } from './readiness.mjs';

export const packageMutations=new Set(['package_add','package_remove']);
const argumentHash=value=>createHash('sha256').update(value).digest('hex');

export function completionSeconds(value=600) {
  if (!Number.isInteger(value) || value<1 || value>3600) throw new UnityError('INVALID_ACTION','completionTimeoutSeconds must be an integer from 1 to 3600.');
  return value;
}
export function completionReference(request,result) {
  const payload=resultPayload(result);
  const accepted=result?.data?.data;
  const job=accepted?.detached===true ? accepted : accepted?.success===true ? payload : null;
  if (request.job && result.ok && result.data?.success===true && ['queued','running'].includes(job?.state) && typeof job?.jobId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(job.jobId)) return {kind:'job',jobId:job.jobId};
  if (request.command==='recompile' && ['triggered','compiling'].includes(payload?.status)) return {kind:'recompile'};
  if (request.command==='run_tests' && (payload?.statusPath || ['running','started','playmode_running'].includes(payload?.result))) return {kind:'tests'};
  if (packageMutations.has(request.command) && payload?.status==='in_progress' && payload.success===true &&
      payload.operation===request.command.slice(8) && typeof payload.argument==='string' && payload.argument.length>0) {
    // Native UPM has a last-operation status, not job IDs. Never persist URLs or credentials.
    return {kind:'package',operation:payload.operation,argumentHash:argumentHash(payload.argument)};
  }
  return null;
}
export const inspectionCommands=new Set(['editor_status','recompile_status','test_status','package_status']);
export function validReference(ref) {
  return ref && Number.isInteger(ref.pid) && ref.pid>0 &&
    (['recompile','tests'].includes(ref.kind) ||
      (ref.kind==='package' && ['add','remove'].includes(ref.operation) && /^[a-f0-9]{64}$/.test(ref.argumentHash)) ||
      (ref.kind==='job' && typeof ref.jobId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(ref.jobId)));
}
function terminal(ref,result) {
  if (!result.ok) return null;
  const value=ref.kind==='job'?result.data?.data:resultPayload(result);
  if (ref.kind==='job') {
    if(value?.jobId!==ref.jobId) return {invalid:true};
    if(['completed','failed','canceled'].includes(value.state)) return {value,ok:value.state==='completed' && value.result?.success!==false};
    return ['queued','running'].includes(value.state)?null:{invalid:true};
  }
  if (result.data?.data?.success!==true || !value || typeof value!=='object') return {invalid:true};
  if(ref.kind==='package') {
    if(value.operation!==ref.operation || typeof value.argument!=='string' || argumentHash(value.argument)!==ref.argumentHash) return {invalid:true};
    if(['completed','failed'].includes(value.status) && typeof value.success==='boolean') return {value,ok:value.status==='completed' && value.success};
    return value.status==='in_progress'?null:{invalid:true};
  }
  if(ref.kind==='recompile') {
    if(['completed','up_to_date'].includes(value.status) && typeof value.failed==='boolean') return {value,ok:!value.failed};
    return ['idle','triggered','compiling'].includes(value.status)?null:{invalid:true};
  }
  if(value.status==='completed' && Number.isInteger(value.summary?.failed)) return {value,ok:value.summary.failed===0};
  if(['error','cancelled'].includes(value.status)) return {value,ok:false};
  return ['running','no_tests'].includes(value.status)?null:{invalid:true};
}
export async function waitCompletion(project,ref,run,deps={}) {
  if(!validReference(ref)) throw new UnityError('INVALID_OPERATION','Unsupported completion reference.');
  const now=deps.now||Date.now,start=now(),deadline=start+completionSeconds(deps.completionTimeoutSeconds)*1000;
  let lastReason='completion_pending';
  const unfinished=reason=>({ok:false,state:'operation_pending',reason,outcome:'unknown',completion:{...ref,lastReason},
    nextAction:{code:'resume_operation',instruction:'Resume this operation ID to read its result. Never submit the original command again. Jobs may be lost across domain reload.'}});
  while(now()<deadline) {
    if(deps.signal?.aborted) return unfinished('completion_cancelled');
    let local;
    try { local=withinBudget(()=>localDiagnosis(project,deps),Math.max(1,Math.min(6000,deadline-now()))); }
    catch(e) {
      if(!['DIAGNOSTIC_TIMEOUT','PROCESS_INSPECTION_TIMEOUT'].includes(e.code)) throw e;
      local={reason:'diagnostic_timeout'};
    }
    lastReason=local.reason;
    if(local.reason==='locally_matched') {
      if(local.editor.pid!==ref.pid) return unfinished('editor_changed');
      const args=ref.kind==='job'?['job','status',ref.jobId]:['command',ref.kind==='recompile'?'recompile_status':ref.kind==='package'?'package_status':'test_status'];
      const response=await withinBudget(()=>run(process.env.UNITY_CLI||'unity',[...args,'--project-path',project.root,...globalArgs],
        {cwd:project.root,timeout:Math.max(1,Math.min(10000,deadline-now())),signal:deps.signal}),Math.max(1,deadline-now()));
      if(deps.signal?.aborted) return unfinished('completion_cancelled');
      const done=terminal(ref,response);
      if(done?.invalid) return unfinished('completion_protocol_incompatible');
      if(done?.ok && ref.kind==='package') {
        // UPM's persisted completion can precede import/reload completion.
        const ready=await waitForReady(project,run,{...deps,deadline,waitSeconds:Math.max(1,Math.ceil((deadline-now())/1000))});
        if(ready.state!=='ready') return {...unfinished('package_readiness_pending'),diagnostic:ready};
        if(ready.pid!==ref.pid) return unfinished('editor_changed');
      }
      if(done) return {ok:done.ok,state:done.ok?'completed':'operation_failed',reason:done.ok?'operation_completed':'operation_failed',
        outcome:done.ok?'succeeded':'unknown',completion:ref,result:safeResult(done.value,local.descriptor.token)};
      if(!response.ok) {
        lastReason=safeCode(response.error);
        if(!['TIMEOUT','CLI_FAILED','STATUS_NO_INSTANCES','STATUS_ALL_UNREACHABLE'].includes(response.error)) return unfinished('completion_unavailable');
      }
    } else if(!temporaryReasons.has(local.reason)) return {...unfinished(local.reason),diagnostic:report(project,local.reason,local.facts)};
    deps.onProgress?.({reason:'completion_pending',elapsedMs:now()-start});
    await (deps.pause||pause)(Math.max(0,Math.min(1000,deadline-now())),deps.signal);
  }
  return unfinished('completion_timeout');
}
