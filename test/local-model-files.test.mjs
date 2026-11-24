import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const importRoot = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { localFileChecksum } = await import(importRoot + 'local-file-checksum.mjs');
const { modelFileIdentity, readCiviScribeMapping, studioModelIdentity } = await import(importRoot + 'model-handoff.js');
const { inspectReferenceDocument } = await import(importRoot + 'reference-provenance.mjs');
const { readPublishedFiles, searchTarget } = await import(importRoot + 'search.mjs');
const megabyte = 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('checksums are byte-exact for native and incremental reads at SHA-256 padding boundaries', async () => {
  const bytes = Buffer.allocUnsafe(4 * megabyte + 65);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 ^ i >>> 8) & 255;
  for (const length of [0, 55, 56, 63, 64, 4 * megabyte, ...[1, 55, 56, 63, 64, 65].map(n => 4 * megabyte + n)]) {
    const input = bytes.subarray(0, length);
    const source = new Blob([input]);
    const reads = [];
    const progress = [];
    const actual = await localFileChecksum({
      size: length,
      arrayBuffer: () => {
        assert.ok(length <= 4 * megabyte, 'Large files must use bounded reads');
        return source.arrayBuffer();
      },
      slice(start, end) {
        reads.push([start, end]);
        assert.ok(end - start <= megabyte);
        return source.slice(start, end);
      },
    }, { onProgress: value => progress.push(value) });
    assert.equal(actual, digest(input));
    assert.equal(progress.at(-1), length);
    if (length > 4 * megabyte) assert.equal(reads.length, 5);
  }
});

test('cancellation stops reading before the next block and short reads yield no digest', async () => {
  const controller = new AbortController();
  let reads = 0;
  const full = new Blob([Buffer.alloc(megabyte)]);
  const file = { size: 6 * megabyte, slice() { reads++; return full; } };
  await assert.rejects(localFileChecksum(file, { signal: controller.signal, onProgress: () => controller.abort() }),
    { name: 'AbortError' });
  assert.equal(reads, 1);
  await assert.rejects(localFileChecksum({ ...file, slice: () => new Blob([]) }), /File data changed/u);
});

const unique = 'a'.repeat(64);
const shared = 'b'.repeat(64);
const missing = 'c'.repeat(64);
const gated = 'd'.repeat(64);
const different = 'e'.repeat(64);
const broken = 'f'.repeat(64);
const origin = 'https://civitai.red';
const context = { origin, browsingLevel: 3, hosted: true, token: 'fixture-app' };
const model = (id, version, fileId, SHA256, browsingLevel = 1) => ({
  id, name: 'Catalog name', type: 'LORA', browsingLevel,
  modelVersions: [{ id: version, files: [{ id: fileId, name: 'catalog.safetensors', hashes: { SHA256 } }] }],
});

test('batch verification reads only digests and version IDs and distinguishes shared, inaccessible, and missing files', async () => {
  const requests = [];
  const { files } = await readPublishedFiles(context, [unique.toUpperCase(), shared, missing, gated, broken, unique], {
    fetcher(url, options) {
      requests.push({ path: url.pathname, method: options.method ?? 'GET' });
      assert.equal(url.origin, origin);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      if (options.method === 'POST') {
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.cache, 'no-store');
        assert.equal(url.search, '');
        assert.deepEqual(JSON.parse(options.body), [unique, shared, missing, gated, broken]);
        return Response.json([
          { hash: unique, modelVersionId: 81 },
          { hash: shared, modelVersionId: 82, modelId: 12 },
          { hash: shared, modelVersionId: 83 },
          { hash: gated, modelVersionId: 84 },
          { hash: broken, modelVersionId: 85 },
        ]);
      }
      assert.deepEqual(Object.fromEntries(url.searchParams), { modelVersionIds: '81,82,84,85,83', limit: '5' });
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, 'Bearer fixture-app');
      return Response.json({ items: [model(11, 81, 601, unique), model(12, 82, 602, shared),
        model(13, 83, 603, shared), model(14, 84, 604, gated, 8), model(15, 85, 605, different)] });
    },
  });
  assert.deepEqual(requests, [
    { path: '/api/v1/model-versions/by-hash/ids', method: 'POST' },
    { path: '/api/v1/blocks/models', method: 'GET' },
  ]);
  assert.deepEqual([...files].map(([key, { status, candidates }]) => [key, status, candidates.map(row => row.selectedFile.id)]), [
    [unique, 'unique', [601]], [shared, 'shared', [602, 603]], [missing, 'missing', []],
    [gated, 'incomplete', []], [broken, 'incomplete', []],
  ]);
});

test('a failed batch stays incomplete and never makes extra requests or falls back to file names', async () => {
  const requests = [];
  const { files } = await readPublishedFiles(context, [unique], {
    fetcher(url) {
      requests.push(url.pathname);
      return new Response('', { status: 503 });
    },
  });
  assert.deepEqual(requests, ['/api/v1/model-versions/by-hash/ids']);
  assert.deepEqual(files.get(unique), { status: 'incomplete', candidates: [] });
  await assert.rejects(readPublishedFiles(context, ['private-local.ckpt']), /full SHA-256/u);
});

test('a published file opens its exact model and version in a research report', () => {
  const reference = origin + '/models/4?modelVersionId=8&modelFileId=20';
  assert.deepEqual(searchTarget(reference), { kind: 'version', id: 8, modelId: 4, fileId: 20 });
  assert.throws(() => searchTarget(reference + '&modelFileId=21'), /model file ID/u);
});

test('the Metadata Studio handoff includes only the selected catalog file and round-trips as an exact claim', async () => {
  const first = { id: 601, sha256: unique.toUpperCase(), name: 'private-filename-canary.safetensors', format: 'SafeTensor', fileType: 'Model' };
  const second = { ...first, id: 602 };
  const candidate = { modelId: 11, id: 81, model: 'Catalog model', version: 'v1', type: 'LoCon', base: 'SDXL 1.0', matchingFiles: [first, second] };
  assert.equal(modelFileIdentity(candidate, { ...first, id: 603 }), null);
  assert.equal(modelFileIdentity(candidate, { ...first, sha256: shared }), null);
  const identity = modelFileIdentity(candidate, second);
  const document = studioModelIdentity(identity);
  assert.equal(identity.role, 'lora');
  assert.deepEqual(document.resources.map(row => row.fileId), [602]);
  const json = JSON.stringify(document);
  assert.doesNotMatch(json, /private-filename-canary/u);
  const parsed = await inspectReferenceDocument(new File([json], 'identities.json'));
  assert.deepEqual(parsed.references.map(row => [row.modelId, row.versionId, row.fileId, row.sha256]), [[11, 81, 602, unique]]);
});

test('CiviScribe receives the published AIR with the exact file qualifier and a checksum-only selector', async () => {
  const resource = { modelId: 11, modelVersionId: 81, fileId: 601, hashes: { SHA256: unique } };
  const expected = 'urn:air:sdxl:lora:civitai:11@81+601.safetensor';
  const file = { id: 601, type: 'Model', hashes: { SHA256: unique.toUpperCase() }, metadata: { format: 'SafeTensor' } };
  const lookup = (air, found = file) => readCiviScribeMapping(origin, resource, {
    fetcher(url, options) {
      assert.equal(url.href, origin + '/api/v1/model-versions/81');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.body, undefined);
      return Response.json({ id: 81, modelId: 11, air, files: [found] });
    },
  });
  assert.deepEqual(await lookup('urn:air:sdxl:lora:civitai:11@81'), [{ match: { hashes: { SHA256: unique } }, air: expected }]);
  assert.deepEqual(await lookup(null, { ...file, air: expected }), [{ match: { hashes: { SHA256: unique } }, air: expected }]);
  for (const [air, found] of [
    ['urn:air:sdxl:lora:civitai:11@81+602.safetensor', file],
    ['urn:air:sdxl:lora:civitai:11@81+601.gguf', file],
    ['urn:air:sdxl:lora:civitai:12@81', file],
    ['urn:air:sdxl:lora:civitai:11@81', { ...file, type: 'VAE' }],
    ['urn:air:sdxl:lora:civitai:11@81', { ...file, hashes: { SHA256: shared } }],
    ['urn:air:sdxl:lora:civitai:11@81', { ...file, air: 'urn:air:sdxl:lora:civitai:11@81' }],
    [null, file],
  ]) assert.equal(await lookup(air, found), null);
});
