import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const CONFIG_NAME = '.semantic-search.json';
export const ENGINE = 'v1';
export const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
export const TRANSFORMERS_VERSION = '3.8.1';
export const MODEL_KEY = `minilm-multilingual-${REVISION}-q8`;
export const DEFAULT_EXTENSIONS = ['.md', '.mdx', '.txt', '.rst', '.adoc'];
export const IGNORED = new Set(['node_modules', 'vendor', 'dist', 'build', '__pycache__', 'coverage']);
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function tempRoot() {
  return path.resolve(process.env.SEMANTIC_SEARCH_TMP_ROOT || path.join(os.tmpdir(), `semantic-search-${process.getuid?.() ?? os.userInfo().username}`));
}

export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Not a private directory owned by this user: ${dir}`);
  }
  fs.chmodSync(dir, 0o700);
  return dir;
}

export function cacheDir(name) {
  return privateDir(path.join(privateDir(tempRoot()), name));
}

export function atomicJson(file, value) {
  const stage = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(stage, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(stage, file); } finally { fs.rmSync(stage, { force: true }); }
}

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function withLock(file, fn, timeoutMs = 600_000) {
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const raw = fs.readFileSync(file, 'utf8');
        let stale = false;
        try { stale = !alive(JSON.parse(raw).pid); }
        catch { stale = Date.now() - fs.statSync(file).mtimeMs > 30_000; }
        if (stale && fs.readFileSync(file, 'utf8') === raw) fs.rmSync(file, { force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path.basename(file)}`);
      await delay(100);
    }
  }
  try { return await fn(); }
  finally {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function currentRoot(cwd = process.cwd()) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute directory path');
  let dir = fs.realpathSync(cwd);
  if (!fs.statSync(dir).isDirectory()) throw new Error('cwd must be a directory');
  while (true) {
    if (fs.existsSync(path.join(dir, CONFIG_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No ${CONFIG_NAME} found. Run $semantic-search:init in the project folder first.`);
    dir = parent;
  }
}

export function readConfig(cwd) {
  const root = currentRoot(cwd);
  const config = JSON.parse(fs.readFileSync(path.join(root, CONFIG_NAME), 'utf8'));
  if (config.version !== 1 || !Array.isArray(config.folders) || !config.folders.length || !Array.isArray(config.extensions) || !config.extensions.length) {
    throw new Error(`Invalid ${CONFIG_NAME}: version, folders and extensions are required`);
  }
  for (const ext of config.extensions) if (typeof ext !== 'string' || !/^\.[a-z0-9]+$/.test(ext)) throw new Error('Invalid extension');
  config.exclude ??= [];
  if (!Array.isArray(config.exclude) || config.exclude.some(x => typeof x !== 'string' || x.includes('..') || path.isAbsolute(x))) throw new Error('exclude must contain relative path prefixes');
  config.folders = validateFolders(root, config.folders, true);
  return { root, config };
}

export function validateFolders(root, folders, allowMissing = false) {
  if (!Array.isArray(folders) || !folders.length) throw new Error('Provide at least one documentation folder');
  return [...new Set(folders.map(folder => {
    if (typeof folder !== 'string' || !folder.trim() || path.isAbsolute(folder)) throw new Error('Documentation folders must be relative to the current project folder');
    const absolute = path.resolve(root, folder);
    if (!inside(root, absolute)) throw new Error(`Documentation folder must be inside this project: ${folder}`);
    // Validate each existing ancestor, including for temporarily missing folders.
    let cursor = root;
    for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Documentation folder must not contain symlinks: ${folder}`); }
      catch (error) { if (error.code !== 'ENOENT' || !allowMissing) throw error; }
    }
    if (allowMissing && !fs.existsSync(absolute)) return path.relative(root, absolute).split(path.sep).join('/');
    if (!fs.statSync(absolute).isDirectory() || !inside(root, fs.realpathSync(absolute))) {
      throw new Error(`Documentation folder must be a real directory inside this project: ${folder}`);
    }
    return path.relative(root, absolute).split(path.sep).join('/') || '.';
  }))];
}

export function initialize(cwd, folders) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be the absolute current project folder');
  const root = fs.realpathSync(cwd);
  const file = path.join(root, CONFIG_NAME);
  const config = { version: 1, folders: validateFolders(root, folders), extensions: DEFAULT_EXTENSIONS, exclude: [] };
  try { fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return { created: false, root, configPath: file, ...readConfig(root), message: 'Existing configuration preserved. Edit it only if the user requests different folders.' };
  }
  return { created: true, root, configPath: file, config };
}

export function inspect(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  const root = fs.realpathSync(cwd);
  const candidates = [];
  let visited = 0;
  function walk(dir, depth) {
    if (depth > 3 || visited++ >= 250) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const samples = entries.filter(e => e.isFile() && DEFAULT_EXTENSIONS.includes(path.extname(e.name).toLowerCase())).slice(0, 6).map(e => e.name);
    if (samples.length || /^(docs?|documentation|wiki|notes|adr|design|specs?)$/i.test(path.basename(dir))) {
      candidates.push({ folder: path.relative(root, dir).split(path.sep).join('/') || '.', sampleFiles: samples });
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !IGNORED.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  }
  walk(root, 0);
  return { root, configExists: fs.existsSync(path.join(root, CONFIG_NAME)), candidates, boundedScan: true };
}

export function scan(root, config) {
  const files = new Map();
  const skipped = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const item of entries) {
      const absolute = path.join(dir, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (item.name.startsWith('.') || IGNORED.has(item.name) || config.exclude.some(p => relative === p.replace(/\/$/, '') || relative.startsWith(p.replace(/\/$/, '') + '/'))) continue;
      if (item.isSymbolicLink()) { skipped.push({ path: relative, reason: 'symlink' }); continue; }
      if (item.isDirectory()) walk(absolute);
      else if (item.isFile()) {
        if (!config.extensions.includes(path.extname(item.name).toLowerCase())) { skipped.push({ path: relative, reason: 'unsupported extension' }); continue; }
        if (files.has(relative)) continue;
        if (fs.statSync(absolute).size > 4 * 1024 * 1024) throw new Error(`Document exceeds 4 MiB: ${relative}. Split it or explicitly exclude it.`);
        const bytes = fs.readFileSync(absolute);
        if (bytes.includes(0)) throw new Error(`Document is not plain text: ${relative}`);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
        files.set(relative, { text, hash: hash(bytes) });
      }
    }
  }
  for (const folder of config.folders) walk(path.resolve(root, folder));
  return { files, skipped };
}

export function readDocument(cwd, file, fromLine = 1, maxLines = 100) {
  const { root, config } = readConfig(cwd);
  if (typeof file !== 'string' || path.isAbsolute(file) || !inside(root, path.resolve(root, file))) throw new Error('path must be project-relative');
  if (!Number.isInteger(fromLine) || fromLine < 1 || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 500) throw new Error('Use fromLine >= 1 and maxLines between 1 and 500');
  const normalized = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  const entry = scan(root, config).files.get(normalized);
  if (!entry) throw new Error('File is not in the configured documentation');
  const lines = entry.text.split('\n');
  return { root, path: normalized, hash: entry.hash, fromLine, totalLines: lines.length, text: lines.slice(fromLine - 1, fromLine - 1 + maxLines).map((line, i) => `${fromLine + i}: ${line}`).join('\n') };
}

// Read only an allowed current source, without following directory symlinks.
export function sourceEntry(root, config, file) {
  if (typeof file !== 'string' || path.isAbsolute(file) || !inside(root, path.resolve(root, file))) return null;
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  const parts = relative.split('/');
  if (parts.some(part => part.startsWith('.') || IGNORED.has(part))) return null;
  if (!config.folders.some(folder => folder === '.' || relative.startsWith(folder + '/'))) return null;
  if (config.exclude.some(prefix => relative === prefix.replace(/\/$/, '') || relative.startsWith(prefix.replace(/\/$/, '') + '/'))) return null;
  if (!config.extensions.includes(path.extname(relative).toLowerCase())) return null;
  try {
    let cursor = root;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    const absolute = path.join(root, relative);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return null;
    if (stat.size > 4 * 1024 * 1024) throw new Error(`Document exceeds 4 MiB: ${relative}. Split it or explicitly exclude it.`);
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) throw new Error(`Document is not plain text: ${relative}`);
    return { hash: hash(bytes), text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n') };
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}
