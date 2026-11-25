import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { visualPackBytes, visualPackMagic, visualPackName, visualPackParts, visualPackSha256 } from '../src/visual-text-pack.mjs';

assert.equal(process.argv.length, 2, 'Put the verified input files in .tmp/visual-model-parts and run without arguments.');
const scratch = new URL('../.tmp/', import.meta.url);
assert.ok((await lstat(new URL('../.tmp', import.meta.url))).isDirectory() &&
  (await lstat(new URL('visual-model-parts', scratch))).isDirectory(),
  'Use ordinary directories in the checkout for .tmp and .tmp/visual-model-parts.');

async function readPart(part) {
  const file = new URL('visual-model-parts/' + part.file, scratch);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(file, flags);
  try {
    const actual = await handle.stat({ bigint: true });
    const named = await lstat(file, { bigint: true });
    assert.ok(named.isFile() && actual.isFile() && actual.dev === named.dev && actual.ino === named.ino &&
      actual.size === BigInt(part.bytes), part.file + ' must be a regular file of the expected size.');
    const input = Buffer.alloc(part.bytes + 1);
    let received = 0;
    while (received < input.length) {
      const { bytesRead } = await handle.read(input, received, input.length - received, received);
      if (!bytesRead) break;
      received += bytesRead;
    }
    assert.equal(received, part.bytes, part.file + ' length');
    return input.subarray(0, received);
  } finally {
    await handle.close();
  }
}

const digest = payload => createHash('sha256').update(payload).digest('hex');
const chunks = [Buffer.from(visualPackMagic, 'ascii')];
for (const part of visualPackParts) {
  const input = await readPart(part);
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
