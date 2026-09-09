import fs from 'node:fs';
import { remaining } from './budget.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class UnityError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}

export function canonical(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

// Read the repository policy without depending on an installed ToDo package.
// .todo is normally ignored, so linked worktrees must also inspect the main copy.
export function assertTodoCompatible(root, taskCwd = root) {
  function context(start) {
    remaining();
    let config = null, repo = null;
    for (let dir = canonical(start); dir; dir = path.dirname(dir)) {
      const candidate = path.join(dir, '.todo', 'config.json');
      if (!config && fs.existsSync(candidate)) config = candidate;
      if (fs.existsSync(path.join(dir, '.git'))) { repo = dir; break; }
      if (path.dirname(dir) === dir) break;
    }
    const configs = new Set(config ? [config] : []);
    let main = repo;
    if (repo) {
      const env = { ...process.env };
      for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[name];
      const result = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z'],
        { env, encoding: 'utf8', timeout: remaining(1500), maxBuffer: 1024 * 1024 });
      const first = result.stdout?.split('\0')[0];
      if (result.status !== 0 || !first?.startsWith('worktree ')) {
        throw new UnityError('TODO_CONFIG_UNAVAILABLE', 'Cannot verify repository ToDo policy. Restore Git access before running Unity commands.');
      }
      main = canonical(first.slice('worktree '.length));
      if (main) {
        const sharedConfig = path.join(main, '.todo', 'config.json');
        if (fs.existsSync(sharedConfig)) configs.add(sharedConfig);
      }
    }
    for (const file of configs) {
      let policy;
      try {
        policy = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('invalid object');
      } catch {
        throw new UnityError('TODO_CONFIG_INVALID', `Cannot read ToDo configuration ${file}. Fix it and set git.executionMode to "single-branch" before running Unity commands.`, { configPath: file });
      }
      if (policy.git?.executionMode !== 'single-branch') {
        throw new UnityError('TODO_SINGLE_BRANCH_REQUIRED',
          `Unity is incompatible with ToDo worktree mode. Set git.executionMode to "single-branch" in ${file} before running Unity commands. Do not migrate already running tasks.`,
          { configPath: file, executionMode: policy.git?.executionMode ?? 'worktree' });
      }
    }
    if (configs.size && repo !== main && !config) {
      throw new UnityError('TODO_WORKTREE_FORBIDDEN',
        'This checkout inherits ToDo from another working copy. Unity commands are forbidden here even after a mode change. Finish or stop the existing worktree task; start a new single-branch task in the configured copy.');
    }
    return { configured: configs.size > 0, root: repo || (config && path.dirname(path.dirname(config))) };
  }
  const task = context(taskCwd);
  const project = canonical(root) === canonical(taskCwd) ? task : context(root);
  if ((task.configured || project.configured) && task.root !== project.root) {
    throw new UnityError('TODO_PROJECT_MISMATCH', 'Unity project must be inside the same working copy as the ToDo task. Select a project in the current single-branch checkout.');
  }
}

function marker(root) {
  return fs.existsSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt')) &&
    fs.statSync(path.join(root, 'Assets'), { throwIfNoEntry: false })?.isDirectory();
}

export function readProject(root) {
  if (!marker(root)) throw new UnityError('NOT_UNITY_PROJECT', 'The selected folder is not a Unity project.');
  const version = fs.readFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')
    .match(/^m_EditorVersion:\s*(\S+)/m)?.[1];
  if (!version) throw new UnityError('INVALID_PROJECT', 'ProjectVersion.txt has no Editor version.');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'Packages', 'manifest.json'), 'utf8')); }
  catch { throw new UnityError('INVALID_PROJECT', 'Packages/manifest.json is missing or invalid.'); }
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
    throw new UnityError('INVALID_PROJECT', 'The package manifest has no valid dependencies object.');
  }
  return { root, version, pipeline: manifest.dependencies['com.unity.pipeline'] ? (/^[0-9][A-Za-z0-9.+-]{0,80}$/.test(manifest.dependencies['com.unity.pipeline']) ? manifest.dependencies['com.unity.pipeline'] : 'declared') : null };
}

const excluded = new Set(['Library', 'Temp', 'Logs', 'Obj', 'Build', 'Builds', 'UserSettings',
  'Assets', 'Packages', 'ProjectSettings', 'node_modules']);

export function resolveProject(cwd, selected) {
  if (!path.isAbsolute(cwd || '')) throw new UnityError('INVALID_CWD', 'Pass the absolute task folder as --cwd.');
  const start = canonical(cwd);
  if (!start || !fs.statSync(start).isDirectory()) throw new UnityError('INVALID_CWD', 'The task folder does not exist.');
  const resolved = root => {
    const project = readProject(root);
    assertTodoCompatible(root, start);
    return project;
  };
  if (selected) {
    if (!path.isAbsolute(selected)) throw new UnityError('INVALID_PROJECT', '--project must be an absolute Unity project path.');
    const root = canonical(selected);
    if (!root) throw new UnityError('INVALID_PROJECT', 'The selected project does not exist.');
    return resolved(root);
  }
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (marker(dir)) return resolved(dir);
    if (path.dirname(dir) === dir) break;
  }
  const candidates = [];
  let visited = 0;
  function scan(dir, depth) {
    remaining();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      if (++visited > 200) throw new UnityError('SEARCH_LIMIT', 'Project search reached its limit. Select an exact project with --project.');
      const child = path.join(dir, entry.name);
      if (marker(child)) candidates.push(child);
      else if (depth < 2) scan(child, depth + 1);
    }
  }
  scan(start, 1);
  if (candidates.length > 1) throw new UnityError('AMBIGUOUS_PROJECT', 'Choose a Unity project explicitly.', { candidates });
  if (!candidates.length) throw new UnityError('NOT_UNITY_PROJECT', 'No Unity project found in this task folder.');
  return resolved(candidates[0]);
}
