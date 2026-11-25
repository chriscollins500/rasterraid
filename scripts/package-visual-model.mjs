import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { visualPackBytes, visualPackMagic, visualPackName, visualPackParts, visualPackSha256 } from '../src/visual-text-pack.mjs';

assert.equal(process.argv.length, 2, 'Put the verified input files in .tmp/visual-model-parts and run without arguments.');
const scratch = new URL('../.tmp/', import.meta.url);
const inputs = new URL('visual-model-parts/', scratch);
assert.ok((await lstat(fileURLToPath(scratch))).isDirectory() && (await lstat(fileURLToPath(inputs))).isDirectory(),
  'Use ordinary directories in the checkout for .tmp and .tmp/visual-model-parts.');

const digest = payload => createHash('sha256').update(payload).digest('hex');
const chunks = [Buffer.from(visualPackMagic, 'ascii')];
for (const part of visualPackParts) {
  const file = new URL(part.file, inputs);
  const info = await lstat(file);
  assert.ok(info.isFile() && info.size === part.bytes, part.file + ' must be a regular file of the expected size.');
  const input = await readFile(file);
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
const path = fileURLToPath(new URL(visualPackName, scratch));
await writeFile(path, pack, { flag: 'wx' });
console.log(JSON.stringify({ path, bytes: pack.length, sha256, node: process.version }));
