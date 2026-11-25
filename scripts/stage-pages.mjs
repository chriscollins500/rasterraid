import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { visualPackBytes, visualPackName, visualPackSha256 } from '../src/visual-text-pack.mjs';

assert.equal(process.argv.length, 2, 'Put the release pack in .tmp/rasterraid-model-release and run without arguments.');
const scratch = new URL('../.tmp/', import.meta.url);
const release = new URL('rasterraid-model-release/', scratch);
assert.ok((await lstat(fileURLToPath(scratch))).isDirectory() && (await lstat(fileURLToPath(release))).isDirectory(),
  'Use ordinary directories in the checkout for .tmp and .tmp/rasterraid-model-release.');
const pack = new URL(visualPackName, release);
const input = await lstat(pack);
assert.ok(input.isFile() && input.size === visualPackBytes, 'Expected the exact visual pack size.');

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
assert.ok((await lstat(docs)).isDirectory(), 'Expected the generated site directory.');
const files = await readdir(docs, { withFileTypes: true, recursive: true });
assert.ok(files.every(entry => entry.isFile() || entry.isDirectory()), 'The generated site contains a link or special file.');
const staging = new URL('rasterraid-pages/', scratch);
await mkdir(staging);
const destination = new URL('site/', staging);
await cp(docs, destination, { recursive: true, force: false, errorOnExist: true });
const models = new URL('models/', destination);
await mkdir(models);
const stagedPack = new URL(visualPackName, models);
await copyFile(pack, stagedPack);
const hash = createHash('sha256');
let bytes = 0;
for await (const chunk of createReadStream(stagedPack)) {
  bytes += chunk.length;
  assert.ok(bytes <= visualPackBytes, 'The staged visual pack is too large.');
  hash.update(chunk);
}
assert.equal(bytes, visualPackBytes, 'The staged visual pack is incomplete.');
assert.equal(hash.digest('hex'), visualPackSha256, 'The staged visual pack does not match the app’s release.');
console.log(JSON.stringify({ directory: fileURLToPath(destination), files: files.filter(entry => entry.isFile()).length + 1,
  modelSha256: visualPackSha256 }));
