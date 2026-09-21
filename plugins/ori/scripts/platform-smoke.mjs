import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '..');
const target = `${{darwin: 'darwin', linux: 'linux', win32: 'windows'}[process.platform]}-${{x64: 'amd64', arm64: 'arm64'}[process.arch]}`;
const binary = join(root, 'bin', target, process.platform === 'win32' ? 'ori.exe' : 'ori');
const temp = mkdtempSync(join(tmpdir(), 'ori native smoke '));
const workspace = join(temp, 'project with spaces');
const exec = (command, args, options = {}) => execFileSync(command, args, {encoding: 'utf8', ...options});
try {
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin/plugin.json'), 'utf8'));
  assert.equal(JSON.parse(exec(binary, ['version'])).version, manifest.version.split('+')[0]);
  console.log(exec(process.execPath, [join(scripts, 'smoke.mjs'), binary, workspace]));
  const args = ['--root', workspace, 'doctor'];
  assert.equal(JSON.parse(exec('sh', [join(scripts, 'ori'), ...args])).ready, true);
  if (process.platform === 'win32') {
    assert.equal(JSON.parse(exec('powershell.exe', ['-NoProfile', '-File', join(scripts, 'ori.ps1'), ...args])).ready, true);
  }
  console.log(exec(process.execPath, [join(scripts, 'hook-smoke.mjs'), workspace]));
  console.log(`Ori native smoke passed: ${target}.`);
} finally { rmSync(temp, {recursive: true, force: true}); }
