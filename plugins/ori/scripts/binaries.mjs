import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const writing = process.argv[2] === '--write';
const output = resolve(process.argv[3] || join(root, 'bin'));
const hash = value => createHash('sha256').update(value).digest('hex');
const walk = dir => readdirSync(join(root, dir), {withFileTypes: true}).flatMap(entry =>
  entry.isDirectory() ? (['node_modules', 'static', 'dist'].includes(entry.name) ? [] : walk(`${dir}/${entry.name}`)) : [`${dir}/${entry.name}`]);
const sources = ['go.mod', 'go.sum', 'assets.go', 'scripts/build.sh', ...['cmd', 'internal', 'web'].flatMap(walk)].sort();
const sourceDigest = hash(sources.map(path => `${path}\0${hash(readFileSync(join(root, path)))}\n`).join(''));
const binaries = {};
for (const os of ['darwin', 'linux', 'windows']) {
  for (const arch of ['amd64', 'arm64']) {
    const path = `${os}-${arch}/ori${os === 'windows' ? '.exe' : ''}`;
    const bytes = readFileSync(join(output, path));
    // Check actual executable format and machine, not just the filename.
    if (os === 'darwin') {
      assert.equal(bytes.readUInt32LE(0), 0xfeedfacf);
      assert.equal(bytes.readUInt32LE(4), arch === 'amd64' ? 0x01000007 : 0x0100000c);
    } else if (os === 'linux') {
      assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46');
      assert.equal(bytes.readUInt16LE(18), arch === 'amd64' ? 62 : 183);
    } else {
      assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
      const pe = bytes.readUInt32LE(0x3c);
      assert.equal(bytes.readUInt32LE(pe), 0x4550);
      assert.equal(bytes.readUInt16LE(pe + 4), arch === 'amd64' ? 0x8664 : 0xaa64);
    }
    binaries[path] = hash(bytes);
  }
}
const expected = {sourceDigest, binaries};
const manifest = join(output, 'checksums.json');
if (writing) writeFileSync(manifest, JSON.stringify(expected, null, 2) + '\n');
else assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), expected, 'Bundled binaries are stale or damaged; run scripts/build.sh --all.');
console.log('Ori binary contract passed: six executable targets, source fingerprint and SHA-256 checksums.');
