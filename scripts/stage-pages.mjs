import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visualPackBytes, visualPackName, visualPackSha256 } from '../src/visual-text-pack.mjs';

const [pack, output] = process.argv.slice(2);
assert.ok(pack && output, 'Pass the visual pack and a new staging directory.');
const input = await lstat(pack);
assert.ok(input.isFile() && input.size === visualPackBytes, 'Expected the exact visual pack size.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(pack)) hash.update(chunk);
assert.equal(hash.digest('hex'), visualPackSha256, 'The visual pack does not match the app’s release.');

const docs = fileURLToPath(new URL('../docs/', import.meta.url));
assert.ok((await lstat(docs)).isDirectory(), 'Expected the generated site directory.');
const files = await readdir(docs, { withFileTypes: true, recursive: true });
assert.ok(files.every(entry => entry.isFile() || entry.isDirectory()), 'The generated site contains a link or special file.');
const destination = resolve(output);
await cp(docs, destination, { recursive: true, force: false, errorOnExist: true });
const models = join(destination, 'models');
await mkdir(models);
await copyFile(pack, join(models, visualPackName));
console.log(JSON.stringify({ directory: destination, files: files.filter(entry => entry.isFile()).length + 1, modelSha256: visualPackSha256 }));
