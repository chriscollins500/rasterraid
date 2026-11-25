import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speechRate, spokenRegions } from '../src/spoken-regions.mjs';
import { spokenWordHits } from '../src/spoken-view.js';

test('speech region times refer to the original clip and silence does not contribute a cue', () => {
  const samples = new Float32Array(7 * speechRate);
  assert.deepEqual(spokenRegions(samples), []);
  samples.fill(0.05, speechRate, 2 * speechRate);
  samples.fill(0.03, 4 * speechRate, 5 * speechRate);
  samples.fill(0.03, 6.4 * speechRate, 6.5 * speechRate);
  const regions = spokenRegions(samples);
  assert.deepEqual(regions, [
    { start: 16_000, from: 14_400, through: 34_720 },
    { start: 64_000, from: 62_400, through: 82_720 },
  ]);
});

test('spoken phrase matching returns the original excerpt and keeps silent gaps between cues', () => {
  const item = { title: 'Speech control', link: 'https://civitai.com/images/100' };
  const rows = [{ item, cues: [
    { start: 1, end: 2, text: 'Here is a recorded voice.' },
    { start: 4, end: 5, text: 'A different phrase starts here.' },
  ] }];
  const [hit] = spokenWordHits(rows, 'RECORDED voice');
  assert.equal(hit.start, 1);
  assert.equal(hit.item, item);
  assert.equal(hit.text.slice(hit.from, hit.through), 'recorded voice');
  assert.deepEqual(spokenWordHits(rows, 'recorded different'), []);
  assert.deepEqual(spokenWordHits(rows, 'voice a different'), []);
  assert.deepEqual(spokenWordHits(rows, 'one two three four five six seven eight nine ten eleven twelve thirteen'), []);
});

test('only trusted dedicated-worker events can start a speech model download', async t => {
  const downloads = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected model download'); });
  const previousSelf = globalThis.self;
  let listener;
  globalThis.self = {
    addEventListener(name, handler) { if (name === 'message') listener = handler; },
    set onmessage(handler) { listener = handler; },
    postMessage() {},
  };
  t.after(() => {
    if (previousSelf === undefined) delete globalThis.self;
    else globalThis.self = previousSelf;
  });
  await import('../src/spoken-worker.mjs');
  const direct = { isTrusted: true, origin: '', source: null, ports: [], data: { type: 'load' } };
  for (const changed of [{ isTrusted: false }, { origin: 'https://example.com' }, { source: {} }, { ports: [{}] }]) {
    await listener({ ...direct, ...changed });
  }
  assert.equal(downloads.mock.callCount(), 0);
  await listener(direct);
  assert.equal(downloads.mock.callCount(), 4);
});
