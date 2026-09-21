import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const scripts = dirname(fileURLToPath(import.meta.url));
test('launcher selects bundled targets, preserves invocation, and never builds', {skip: process.platform === 'win32'}, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ori launch space-')));
  try {
    const plugin = join(root, 'plugin'), path = join(root, 'path');
    mkdirSync(join(plugin, 'scripts'), {recursive: true});
    mkdirSync(path);
    copyFileSync(join(scripts, 'ori'), join(plugin, 'scripts/ori'));
    // Deliberately omit Go, npm, node and hash utilities from the launcher's PATH.
    writeFileSync(join(path, 'dirname'), '#!/bin/sh\nif [ "$1" = -- ]; then shift; fi\nprintf "%s\\n" "${1%/*}"\n', {mode: 0o755});
    writeFileSync(join(path, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo "$TEST_OS";; -m) echo "$TEST_ARCH";; esac\n', {mode: 0o755});
    const invoke = (os, arch, extra = {}) => spawnSync('/bin/sh', [join(plugin, 'scripts/ori'), '--root', 'project with spaces', 'hook'], {
      cwd: root, env: {...process.env, PATH: path, TEST_OS: os, TEST_ARCH: arch, ...extra}, input: 'hook payload\n', encoding: 'utf8',
    });
    const targets = [
      ['Darwin', 'x86_64', 'darwin-amd64/ori'], ['Darwin', 'arm64', 'darwin-arm64/ori'],
      ['Linux', 'x86_64', 'linux-amd64/ori'], ['Linux', 'aarch64', 'linux-arm64/ori'],
      ['MINGW64_NT-10.0', 'x86_64', 'windows-amd64/ori.exe'], ['MSYS_NT-10.0', 'aarch64', 'windows-arm64/ori.exe'],
    ];
    for (const [os, arch, target] of targets) {
      const binary = join(plugin, 'bin', target);
      mkdirSync(dirname(binary), {recursive: true});
      writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${target}' "$PWD" "$@"\nread -r payload\nprintf '%s\\n' "$payload"\nexit 17\n`, {mode: 0o755});
      const result = invoke(os, arch);
      assert.equal(result.status, 17, result.stderr);
      assert.deepEqual(result.stdout.trim().split('\n'), [target, root, '--root', 'project with spaces', 'hook', 'hook payload']);
      rmSync(binary);
      const missing = invoke(os, arch);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Reinstall the plugin/);
      const hook = invoke(os, arch, {ORI_NO_BUILD: '1'});
      assert.equal(hook.status, 0);
      assert.equal(hook.stdout + hook.stderr, '');
    }
    assert.match(invoke('FreeBSD', 'x86_64').stderr, /unsupported operating system/);
    assert.match(invoke('Linux', 'i686').stderr, /unsupported architecture/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
