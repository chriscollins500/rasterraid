import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { galleryDescriptionSample } from '../src/visual-research.mjs';
import { sha256Hex, unpackModel } from '../src/model-bytes.mjs';

const origin = 'https://civitai.red';
const result = { gallery: { scope: 'gallery', query: '虹のある湖 without people' }, target: { kind: 'text' } };
const context = { origin, browsingLevel: 3 };
const picture = (id, flags = {}) => ({ id, postId: Math.floor((id + 1) / 2), link: origin + '/images/' + id,
  preview: 'https://image.civitai.com/gallery/' + id + '.jpg', browsingLevel: id % 2 ? 1 : 2, title: 'Gallery picture ' + id, ...flags });

test('appearance compares eight displayed eligible pictures and preserves the display order', () => {
  const displayed = [picture(1), picture(17, { browsingLevel: 4 }), picture(18, { video: true }),
    picture(19, { link: 'https://civitai.com/images/19' }), picture(20, { preview: 'https://example.com/20.jpg' }),
    ...Array.from({ length: 12 }, (_, index) => picture(index + 1))];
  const idsBefore = displayed.map(row => row.id);
  const match = galleryDescriptionSample(result, displayed, context);
  assert.equal(match.description, '虹のある湖');
  assert.deepEqual(match.sample.map(({ id }) => id), [1, 3, 5, 7, 9, 11, 2, 4]);
  assert.deepEqual(displayed.map(row => row.id), idsBefore);
  assert.equal(galleryDescriptionSample({ ...result, library: {} }, displayed, context), null);
  assert.equal(galleryDescriptionSample(result, displayed, { ...context, connectionLost: true }), null);
  assert.equal(galleryDescriptionSample(result, [picture(1), picture(2)], { ...context, browsingLevel: 1 }), null);
});

const magic = 'RRVISUAL1\n';

async function samplePack() {
  const inputs = [Buffer.from('model part A'), Buffer.from('model part B')];
  const blobs = inputs.map(bytes => gzipSync(bytes));
  const parts = await Promise.all(inputs.map(async (input, index) => ({
    key: String(index), bytes: input.length, compressed: blobs[index].length, sha256: await sha256Hex(input),
  })));
  return { parts, blobs, inputs, source: Buffer.concat([Buffer.from(magic), ...blobs]) };
}

function chunks(bytes) {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.subarray(offset, offset + 3));
    offset = Math.min(offset + 3, bytes.length);
  } });
}

test('the streaming reader verifies packed model parts split across transport chunks', async () => {
  const { parts, inputs, source } = await samplePack();
  let progress;
  const result = await unpackModel(chunks(source), magic, parts, loaded => { progress = loaded; });
  assert.deepEqual(Object.values(result).map(bytes => Buffer.from(bytes)), inputs);
  assert.equal(progress, source.length);
});

test('the pack reader rejects wrong headers, changed content, truncation, overflow, and trailing bytes', async () => {
  const { parts, blobs, source } = await samplePack();
  const wrongMagic = Buffer.from(source);
  wrongMagic[0] = 0;
  const changed = gzipSync(Buffer.from('model part X'));
  assert.equal(changed.length, blobs[0].length);
  await assert.rejects(unpackModel(chunks(wrongMagic), magic, parts), /Unexpected visual model pack/u);
  await assert.rejects(unpackModel(chunks(Buffer.concat([Buffer.from(magic), changed, blobs[1]])), magic, parts), /verification failed/u);
  await assert.rejects(unpackModel(chunks(source.subarray(0, -2)), magic, parts), /truncated/u);
  await assert.rejects(unpackModel(chunks(source), magic, [{ ...parts[0], bytes: 1 }, parts[1]]), /Unexpected inference file size/u);
  await assert.rejects(unpackModel(chunks(Buffer.concat([source, Buffer.from('\x00')])), magic, parts), /data after/u);
});
