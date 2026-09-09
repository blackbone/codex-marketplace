import fs from 'node:fs';
import { resolveProject, ensureEditor, checkPipeline, perform, initialize, recover, withinBudget, outsideBudget } from './runtime.mjs';
import { UnityError } from './project.mjs';

try {
  await withinBudget(async () => {
  const [action, ...args] = process.argv.slice(2);
  if (!['open', 'status', 'doctor', 'recover', 'init', 'list', 'run'].includes(action)) throw new UnityError('INVALID_ACTION', 'Choose open, status, doctor, recover, init, list, or run.');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--cwd', '--project', '--input', '--query', '--detail', '--phase', '--recovery-id'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
      throw new UnityError('INVALID_OPTIONS', 'Pass --cwd, optionally --project, and --input for run or --query for list.');
    }
    options[args[i]] = args[i + 1];
  }
  const project = withinBudget(() => resolveProject(options['--cwd'], options['--project']));
  let result;
  if (action === 'open') {
    result = withinBudget(() => ensureEditor(project, { recover: true }));
    result.ok = ['editor_running', 'launch_requested', 'launching'].includes(result.state);
  }
  if (action === 'status' || action === 'doctor') { result = await checkPipeline(project); result.ok = result.state === 'ready'; }
  if (action === 'recover') result = await recover(project, options['--phase'] || 'begin', options['--recovery-id']);
  if (action === 'init') result = await outsideBudget(() => initialize(project));
  if (action === 'list') {
    if (options['--detail'] && !['compact', 'full'].includes(options['--detail'])) throw new UnityError('INVALID_OPTIONS', '--detail is compact or full.');
    result = await perform(action, project, { query: options['--query'], detail: options['--detail'] });
  }
  if (action === 'run') {
    if (!options['--input']) throw new UnityError('INVALID_ACTION', 'run requires a JSON --input file.');
    const fd = fs.openSync(options['--input'], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    let input;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new UnityError('INVALID_ACTION', 'Request must be a regular JSON file of at most 1 MiB.');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count > 1024 * 1024) throw new UnityError('INVALID_ACTION', 'Request exceeded 1 MiB.');
      input = JSON.parse(buffer.subarray(0, count).toString());
    } finally { fs.closeSync(fd); }
    result = await perform(action, project, input);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
  });
} catch (error) {
  console.log(JSON.stringify({ ok: false, state: 'error', error: error.code === 'DIAGNOSTIC_TIMEOUT' ? error.code : error instanceof UnityError ? error.code : 'INVALID_INPUT', message: error instanceof UnityError ? error.message : 'Could not read the request or complete the operation.', ...(error instanceof UnityError ? error.details : {}) }));
  process.exitCode = 1;
}
