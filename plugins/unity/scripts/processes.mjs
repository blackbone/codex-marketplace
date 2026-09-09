import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { remaining } from './budget.mjs';
import { canonical, UnityError } from './project.mjs';

// ps loses argv boundaries on macOS. A path ending before the next option is
// accepted only if it resolves to an actual project; ambiguous output stays unknown.
export function projectFromArguments(value) {
  if (Array.isArray(value)) {
    const index = value.findIndex(arg => /^-(projectPath|createproject)$/i.test(arg));
    return index < 0 || !path.isAbsolute(value[index + 1] || '') ? null : canonical(value[index + 1]);
  }
  const match = value.trim().match(/\s-(?:projectPath|createproject)\s+(.*?)(?=\s+-[A-Za-z]|$)/i);
  if (!match) return null;
  const candidate = match[1].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  return path.isAbsolute(candidate) ? canonical(candidate) : null;
}

export function isAssetImportWorker(value) {
  const args = Array.isArray(value) ? value :
    (value.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(arg => arg.replace(/^(["'])(.*)\1$/, '$2'));
  // Unity uses its Editor executable for import workers too. A batch-mode
  // Editor is still an Editor; only the specific worker -name identifies these children.
  return args.some((arg, index) => /^-name$/i.test(arg) && /^AssetImportWorker(?:HW)?\d+$/.test(args[index + 1] || ''));
}

export function inspectEditors(root) {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new UnityError('UNSUPPORTED_PLATFORM', 'Automatic Editor detection currently supports macOS and Linux.');
  }
  let output;
  try { output = execFileSync('ps', ['-axo', 'pid=,stat=,comm='], { encoding: 'utf8', timeout: remaining(1500), maxBuffer: 4 * 1024 * 1024 }); }
  catch { throw new UnityError('PROCESS_INSPECTION_FAILED', 'Could not inspect Unity processes; no Editor was launched.'); }
  const editors = [];
  const deadline = Date.now() + remaining(3000);
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || match[2].includes('Z') || !/(?:^|\/)Unity$/.test(match[3])) continue;
    if (Date.now() > deadline) throw new UnityError('PROCESS_INSPECTION_TIMEOUT', 'Editor process inspection exceeded its budget; no Editor was launched.');
    const pid = Number(match[1]);
    let project = null;
    try {
      let args;
      if (process.platform === 'linux') {
        try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { /* ps fallback */ }
      }
      args ??= execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: remaining(500) });
      if (isAssetImportWorker(args)) continue;
      project = projectFromArguments(args);
      // A project opened through Hub may lack -projectPath. Check ownership of
      // this project's Unity lock rather than guessing from a process name.
      if (!project && fs.existsSync(path.join(root, 'Temp', 'UnityLockfile'))) {
        try {
          const locks = execFileSync('lsof', ['-a', '-p', String(pid), '-Fp', '--', path.join(root, 'Temp', 'UnityLockfile')],
            { encoding: 'utf8', timeout: remaining(500), stdio: ['ignore', 'pipe', 'ignore'] });
          if (locks.split('\n').includes(`p${pid}`)) project = root;
        } catch { /* Unknown ownership must not trigger another Editor. */ }
      }
    } catch { /* Exited or inaccessible processes remain conservatively unknown. */ }
    remaining();
    editors.push({ pid, project });
  }
  return editors;
}

export function editorState(root, editors) {
  const matching = editors.filter(editor => editor.project === root);
  if (matching.length > 1) return { state: 'multiple_editors', pids: matching.map(editor => editor.pid) };
  if (editors.some(editor => !editor.project)) return { state: 'editor_unidentified' };
  if (matching.length === 1) return { state: 'editor_running', pid: matching[0].pid };
  if (editors.some(editor => !editor.project)) return { state: 'editor_unidentified' };
  return { state: 'editor_closed' };
}
