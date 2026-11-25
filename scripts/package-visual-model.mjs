import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { visualPackBytes, visualPackMagic, visualPackName, visualPackParts, visualPackSha256 } from '../src/visual-text-pack.mjs';

const [inputs, destination] = process.argv.slice(2);
assert.ok(inputs && destination && basename(destination) === visualPackName,
  'Pass the directory containing the verified input files and the exact visual model pack filename.');

const digest = payload => createHash('sha256').update(payload).digest('hex');
const chunks = [Buffer.from(visualPackMagic, 'ascii')];
for (const part of visualPackParts) {
  const input = await readFile(join(inputs, part.file));
  assert.equal(input.length, part.bytes, part.file + ' length');
  assert.equal(digest(input), part.sha256, part.file + ' digest');
  const gzip = gzipSync(input, { level: 9 });
  assert.equal(gzip.length, part.compressed, part.file + ' gzip length. Use the pinned Node release.');
  chunks.push(gzip);
}
const pack = Buffer.concat(chunks);
assert.equal(pack.length, visualPackBytes);
const sha256 = digest(pack);
assert.equal(sha256, visualPackSha256, 'The packed bytes differ from the pinned release.');
const path = resolve(destination);
await writeFile(path, pack, { flag: 'wx' });
console.log(JSON.stringify({ path, bytes: pack.length, sha256, node: process.version }));
