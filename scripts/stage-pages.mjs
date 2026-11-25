import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { visualPackBytes, visualPackName, visualPackSha256 } from '../src/visual-text-pack.mjs';
import { audioPackBytes, audioPackName, audioPackSha256 } from '../src/written-sound-artifacts.mjs';

assert.equal(process.argv.length, 2, 'Put the release packs in .tmp/rasterraid-model-release and run without arguments.');
const scratch = new URL('../.tmp/', import.meta.url);
assert.ok((await lstat(new URL('../.tmp', import.meta.url))).isDirectory() &&
  (await lstat(new URL('rasterraid-model-release', scratch))).isDirectory(),
  'Use ordinary directories in the checkout for .tmp and .tmp/rasterraid-model-release.');
const packs = [{ name: visualPackName, bytes: visualPackBytes, sha256: visualPackSha256 },
  { name: audioPackName, bytes: audioPackBytes, sha256: audioPackSha256 }];
for (const pack of packs) {
  const source = new URL('rasterraid-model-release/' + pack.name, scratch);
  const file = await lstat(source);
  assert.ok(file.isFile() && file.size === pack.bytes, 'Expected the exact release size for ' + pack.name);
  pack.source = source;
}

const docs = new URL('../docs', import.meta.url);
assert.ok((await lstat(docs)).isDirectory(), 'Expected the generated site directory.');
const files = await readdir(docs, { withFileTypes: true, recursive: true });
assert.ok(files.every(entry => entry.isFile() || entry.isDirectory()), 'The generated site contains a link or special file.');
const staging = new URL('rasterraid-pages/', scratch);
await mkdir(staging);
const destination = new URL('site/', staging);
await cp(docs, destination, { recursive: true, force: false, errorOnExist: true });
const models = new URL('models/', destination);
await mkdir(models);
for (const pack of packs) {
  const staged = new URL(pack.name, models);
  await copyFile(pack.source, staged);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(staged)) {
    bytes += chunk.length;
    assert.ok(bytes <= pack.bytes, 'The staged model pack is too large.');
    hash.update(chunk);
  }
  assert.equal(bytes, pack.bytes, 'The staged pack is incomplete.');
  assert.equal(hash.digest('hex'), pack.sha256, 'The staged pack does not match the release for ' + pack.name);
}
console.log(JSON.stringify({ directory: fileURLToPath(destination), files: files.filter(entry => entry.isFile()).length + packs.length,
  modelSha256: visualPackSha256, audioModelSha256: audioPackSha256 }));
