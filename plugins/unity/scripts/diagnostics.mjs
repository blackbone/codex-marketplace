import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { canonical, assertTodoCompatible } from './project.mjs';
import { inspectEditors, editorState } from './processes.mjs';
import { operationOwner } from './operations.mjs';
import { remaining, withinBudget, DIAGNOSTIC_MS } from './budget.mjs';

export const globalArgs = ['--format', 'json', '--non-interactive', '--no-banner', '--no-pager', '--no-log-proxy'];
const reasons = {
  locally_matched: ['status', 'Editor and descriptor match locally; list/run check CLI readiness once before dispatch.'],
  ready: ['execute', 'Run the requested command once.'],
  editor_closed: ['open', 'Use open for this exact project.'],
  launching: ['new_request', 'A launch is already in progress; do not launch again or wait.'],
  launch_requested: ['new_request', 'A launch was submitted; check only on a new request.'],
  launch_stale: ['open', 'Explicit open can recover the dead launch lease; do not remove it manually.'],
  launch_failed: ['inspect_launch', 'The last launch failed; inspect the prerequisite before an explicit open.'],
  editor_unidentified: ['identify_editor', 'Establish ownership of the unidentified Editor before opening or dispatching.'],
  multiple_editors: ['resolve_editors', 'Resolve the duplicate real Editors for this project; never close them automatically.'],
  pipeline_missing: ['init', 'Use unity:init only when package installation is requested.'],
  unsupported_unity: ['supported_editor', 'Pipeline requires Unity 6 or newer.'],
  descriptor_missing: ['recover', 'Editor is already open. Use recover --phase begin for the guarded Pipeline UI procedure.'],
  descriptor_invalid: ['recover', 'Descriptor is malformed; do not edit it. Use recover --phase begin.'],
  descriptor_unreadable: ['check_permissions', 'Restore read access to Library/Pipeline without exposing its contents.'],
  descriptor_pid_mismatch: ['recover', 'Descriptor PID differs from the target Editor; do not connect. Use recover --phase begin.'],
  descriptor_project_mismatch: ['recover', 'Descriptor project differs from the exact target; do not connect. Use recover --phase begin.'],
  descriptor_stale: ['recover', 'CLI reports unreachable and the heartbeat is old. Use recover --phase begin; age alone does not prove a dead server.'],
  server_unreachable: ['recover', 'The target server did not accept the bounded status request. Use recover --phase begin.'],
  authentication_failed: ['recover', 'Pipeline rejected authentication. Never copy tokens or disable authentication; use recover --phase begin.'],
  protocol_incompatible: ['check_versions', 'The response/CLI contract is unsupported. Compare CLI and Pipeline versions; do not upgrade blindly.'],
  compiling: ['new_request', 'Compilation is currently reported. Return now; check only on a new request.'],
  domain_reload: ['new_request', 'Domain reload is currently reported. Return now; check only on a new request.'],
  settling: ['new_request', 'Pipeline reports startup settling, without proving a specific compiler error. Return now.'],
  blocked_by_dialog: ['inspect_dialog', 'Inspect the modal dialog in this exact Editor and resolve it deliberately; no button choice is inferred.'],
  pipeline_unavailable: ['inspect_pipeline_ui', 'CLI did not discover this Editor. Inspect Window/Pipeline in the already open Editor; do not open another.'],
  pipeline_not_ready: ['new_request', 'Pipeline did not report readiness. Return now without dispatch.'],
  diagnostic_timeout: ['new_request', 'The shared diagnostic budget expired; nothing was dispatched.'],
  cli_missing: ['install_cli', 'The configured official Unity CLI executable was not found.'],
  process_inspection_denied: ['configure_worker_access', 'The worker environment blocks OS process inspection. Waiting for import cannot grant access. Use an explicitly authorized worker permission configuration; never bypass the sandbox.'],
  process_inspection_timeout: ['wait', 'Process inspection timed out; retry only readiness within the bounded call.'],
  diagnostic_failed: ['inspect_diagnostic', 'An unexpected diagnostic failure occurred. No user command was dispatched.'],
  process_inspection_failed: ['identify_editor', 'Process ownership could not be inspected; do not launch or dispatch.'],
};
export function report(project, reason, facts = {}, state) {
  const next = reasons[reason] || reasons.pipeline_unavailable;
  const legacy = state || (reason.startsWith('descriptor_') || ['server_unreachable','authentication_failed','protocol_incompatible','diagnostic_timeout','cli_missing','process_inspection_failed','process_inspection_denied','process_inspection_timeout','diagnostic_failed'].includes(reason)
    ? 'pipeline_unavailable' : ['compiling','domain_reload','settling','blocked_by_dialog'].includes(reason) ? 'pipeline_not_ready' : reason);
  return { project, state: legacy, reason, facts, nextAction: { code: next[0], instruction: next[1] },
    requiresInteractive: ['blocked_by_dialog','process_inspection_denied'].includes(reason), ...(reason === 'blocked_by_dialog' ? { interactiveReason: 'A live status response confirms a modal dialog; this wrapper cannot select UI buttons.' } : {}),
    ...(reason === 'process_inspection_denied' ? { interactiveReason: 'The current worker cannot inspect OS processes. An authorized permission change is required, not opening another Unity Editor.' } : {}),
    ...(Number.isInteger(facts.editorPid) ? { pid: facts.editorPid } : {}) };
}
export function safeCode(value) {
  // Arbitrary error messages/codes from extensions are not safe diagnostics.
  return new Set(['TIMEOUT','CANCELLED','OUTPUT_LIMIT','CLI_MISSING','CLI_FAILED','INVALID_RESPONSE','STATUS_NO_INSTANCES','STATUS_ALL_UNREACHABLE',
    'UNAUTHORIZED','AUTHENTICATION_FAILED','PROTOCOL_MISMATCH','VERSION_MISMATCH','COMMAND_NOT_FOUND','INVALID_ARGUMENTS',
    'EDITOR_BUSY','BLOCKED_BY_DIALOG','DIAGNOSTIC_TIMEOUT']).has(value) ? value : 'UNCLASSIFIED_ERROR';
}
export function readDescriptor(root) {
  let fd;
  try {
    fd = fs.openSync(path.join(root, 'Library/Pipeline/.unity-pipeline-port'), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return { state: 'invalid' };
    const buffer = Buffer.alloc(65537);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 65536) return { state: 'invalid' };
    let d; try { d = JSON.parse(buffer.subarray(0, count).toString()); } catch { return { state: 'invalid' }; }
    if (!d || !Number.isInteger(d.pid) || d.pid < 1 || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 ||
        typeof d.projectPath !== 'string' || !path.isAbsolute(d.projectPath) || !Number.isFinite(Date.parse(d.lastHeartbeat)) ||
        typeof d.evalToken !== 'string' || !d.evalToken || d.evalToken.length > 8192 || /[\r\n]/.test(d.evalToken)) return { state: 'invalid' };
    // The authentication credential exists only in this private snapshot, never in report.facts.
    return { state: 'valid', pid: d.pid, port: d.port, project: canonical(d.projectPath),
      heartbeatAgeMs: Math.max(0, Date.now() - Date.parse(d.lastHeartbeat)), token: typeof d.evalToken === 'string' ? d.evalToken : null };
  } catch (e) { return { state: e.code === 'ENOENT' ? 'missing' : e.code === 'ELOOP' ? 'invalid' : 'unreadable' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function launchState(root) {
  const dir = path.join(root, 'Library/CodexUnity');
  try {
    const lock = path.join(dir, 'launch.lock');
    if (fs.existsSync(lock)) {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')); } catch {}
      let alive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); alive = true; } catch (e) { alive = e.code !== 'ESRCH'; }
      }
      const at = owner?.at || fs.statSync(lock, {throwIfNoEntry:false})?.mtimeMs;
      return !alive && at && Date.now()-at > 30000 ? 'launch_stale' : 'launching';
    }
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
    if (Date.now() - receipt.at < 30000 && ['launch_requested','launch_failed'].includes(receipt.state)) return receipt.state;
  } catch { /* No known launch. */ }
  return 'editor_closed';
}
export function localDiagnosis(project, deps = {}) {
  assertTodoCompatible(project.root);
  const editor = editorState(project.root, (deps.inspect || inspectEditors)(project.root));
  const descriptor = readDescriptor(project.root);
  const facts = { editor: editor.state, ...(editor.pid ? { editorPid: editor.pid } : {}),
    ...(editor.pids ? { editorPids: editor.pids } : {}), pipelineDeclared: Boolean(project.pipeline), descriptor: descriptor.state };
  if (descriptor.state === 'valid') Object.assign(facts, { descriptorPid: descriptor.pid, descriptorProjectMatches: descriptor.project === project.root,
    descriptorPidMatches: descriptor.pid === editor.pid, heartbeatAgeMs: descriptor.heartbeatAgeMs });
  let reason = editor.state;
  if (Number(project.version.split('.')[0]) < 6000) reason = 'unsupported_unity';
  else if (editor.state === 'editor_closed') reason = launchState(project.root);
  else if (editor.state === 'editor_running') {
    if (!project.pipeline) reason = 'pipeline_missing';
    else if (descriptor.state !== 'valid') reason = `descriptor_${descriptor.state}`;
    else if (descriptor.project !== project.root) reason = 'descriptor_project_mismatch';
    else if (descriptor.pid !== editor.pid) reason = 'descriptor_pid_mismatch';
    else reason = 'locally_matched';
  }
  return { editor, descriptor, facts, reason };
}
function ownsPort(pid, port) {
  try {
    const text = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
      { encoding: 'utf8', timeout: remaining(500), maxBuffer: 65536, stdio: ['ignore','pipe','ignore'] });
    return text.split('\n').includes(`p${pid}`);
  } catch { return false; }
}
export async function probeServer(d, deps = {}) {
  if (!(deps.ownsPort || ownsPort)(d.pid, d.port)) return { state: 'ownership_unverified' };
  if (!d.token || /[\r\n]/.test(d.token)) return { state: 'descriptor_invalid' };
  const timeout = remaining(800);
  return new Promise(resolve => {
    let finished = false, request;
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer); request?.destroy(); resolve(value); };
    const timer = setTimeout(() => finish({ state: 'server_unreachable' }), timeout);
    request = http.get({ hostname: '127.0.0.1', port: d.port, path: '/api/status', headers: { Authorization: `Bearer ${d.token}` }, agent: false }, response => {
      if ([401,403].includes(response.statusCode)) return finish({ state: 'authentication_failed' });
      if (response.statusCode !== 200) return finish({ state: 'protocol_incompatible' });
      let body = '', bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) finish({ state: 'protocol_incompatible' }); else body += chunk; });
      response.on('error', () => finish({ state: 'server_unreachable' }));
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          const state = data.status ?? data.data?.status;
          finish({ state: ['ready','settling','blocked_by_dialog','compiling','domain_reload','error'].includes(state) ? state : 'protocol_incompatible' });
        } catch { finish({ state: 'protocol_incompatible' }); }
      });
    });
    request.on('error', () => finish({ state: 'server_unreachable' }));
  });
}
export async function diagnose(project, run, deps = {}) {
  return withinBudget(async () => {
    let facts = { budgetMs: DIAGNOSTIC_MS };
    try {
      const local = localDiagnosis(project, deps);
      facts = { ...facts, ...local.facts, discovery: 'not_checked' };
      const owner = operationOwner(project.root);
      if (owner) facts.operation = { kind: ['command','recovery','command_outcome_unknown'].includes(owner.kind) ? owner.kind : 'unidentified', ...(typeof owner.id === 'string' && /^[a-f0-9-]{36}$/.test(owner.id) ? { id: owner.id } : {}) };
      if (local.reason !== 'locally_matched') return report(project, local.reason, facts);
      const result = await run(process.env.UNITY_CLI || 'unity', ['status', '--project-path', project.root, ...globalArgs], { cwd: project.root, timeout: remaining(2500) });
      remaining();
      facts.discovery = result.ok ? 'responded' : 'failed';
      if (!result.ok) facts.cliError = safeCode(result.error);
      const rows = result.data?.data?.instances;
      if (result.ok && !Array.isArray(rows)) return report(project, 'protocol_incompatible', facts);
      const matches = Array.isArray(rows) ? rows.filter(row => typeof row.project === 'string' && canonical(row.project) === project.root) : [];
      if (matches.length > 1) return report(project, 'multiple_editors', facts);
      const row = matches[0];
      if (row && row.pid !== local.editor.pid) return report(project, 'descriptor_pid_mismatch', facts);
      if (row && row.state !== 'unreachable') {
        const state = ['ready','compiling','domain_reload','settling','blocked_by_dialog'].includes(row.state) ? row.state : 'pipeline_not_ready';
        facts.pipeline = state;
        if (result.ok && state === 'ready') return report(project, 'ready', facts);
        if (state !== 'ready') return { ...report(project, state, facts), editorState: state };
      }
      if (result.error === 'CLI_MISSING') return { ...report(project, 'cli_missing', facts), error: 'CLI_MISSING' };
      if (['PROTOCOL_MISMATCH','VERSION_MISMATCH','INVALID_RESPONSE'].includes(result.error)) return report(project, 'protocol_incompatible', facts);
      if (['UNAUTHORIZED','AUTHENTICATION_FAILED'].includes(result.error)) return report(project, 'authentication_failed', facts);
      if (result.error === 'TIMEOUT') return report(project, 'diagnostic_timeout', facts);
      // One fallback GET only, to an OS-verified target-owned socket. It can refresh the
      // package-owned heartbeat. It never substitutes for successful CLI discovery.
      const probe = await (deps.probe || probeServer)(local.descriptor);
      remaining();
      facts.server = probe.state;
      if (['descriptor_invalid','authentication_failed','protocol_incompatible','server_unreachable','compiling','domain_reload','settling','blocked_by_dialog'].includes(probe.state)) return report(project, probe.state, facts);
      if (local.descriptor.heartbeatAgeMs > 30000 && row?.state === 'unreachable') return report(project, 'descriptor_stale', facts);
      return report(project, 'pipeline_unavailable', facts);
    } catch (e) {
      if (e.code?.startsWith('TODO_')) throw e;
      const reason = { DIAGNOSTIC_TIMEOUT: 'diagnostic_timeout', PROCESS_INSPECTION_TIMEOUT: 'process_inspection_timeout',
        PROCESS_INSPECTION_DENIED: 'process_inspection_denied', PROCESS_INSPECTION_FAILED: 'process_inspection_failed' }[e.code] || 'diagnostic_failed';
      if (e.details?.systemCode) facts.processError = e.details.systemCode;
      return report(project, reason, facts);
    }
  });
}
