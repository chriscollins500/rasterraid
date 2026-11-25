import assert from 'node:assert/strict';
import test from 'node:test';
import { requestSoundWorker } from '../src/sound-worker-client.mjs';
import { audioDownloadBytes, audioPackBytes } from '../src/written-sound-artifacts.mjs';
import { createAudioPatches, soundPatchCount, soundPatchWidth } from '../src/written-sound-features.mjs';
import { rankWrittenSoundMatches, validWrittenSoundWindows, writtenSoundBrief, writtenSoundRate, writtenSoundWindows } from '../src/written-sound.mjs';

test('written sound descriptions keep each requested and avoided cue', () => {
  assert.deepEqual(writtenSoundBrief('  Rain falling   without a dog barking ', 'Thunder', 'Speech'),
    { required: ['Rain falling', 'Thunder'], avoid: ['a dog barking', 'Speech'] });
  assert.deepEqual(writtenSoundBrief('Sea waves', 'sea waves'), { required: ['Sea waves'], avoid: [] });
  for (const input of ['', 'without singing', 'rain without', 'rain without Rain', 'rain without a without b without c', 'r'.repeat(161)]) {
    assert.equal(writtenSoundBrief(input), null, input);
  }
});

test('sound ranking favors both cues in one window and uses an independent avoid cue', () => {
  const make = (link, windows) => ({ item: { link }, rendition: link + '.wav',
    checked: windows.map((scores, index) => ({ start: index * 5, end: index * 5 + 5, scores })) });
  const separated = make('separated', [[.95, .10, .04], [.10, .95, .04]]);
  const aligned = make('aligned', [[.71, .72, .78], [.71, .72, .04]]);
  const brief = writtenSoundBrief('rain', 'dog', 'speech');
  const [first, second] = rankWrittenSoundMatches([separated, aligned], brief);
  assert.equal(first.item.link, 'aligned');
  assert.equal(first.start, 5);
  assert.equal(first.rendition, 'aligned.wav');
  assert.equal(second.item.link, 'separated');
});

test('exact sample boundaries retain a short audible clip and skip silent or tiny tails', () => {
  const samples = new Float32Array(12 * writtenSoundRate);
  samples[writtenSoundRate * 5 + 2] = .15;
  samples[writtenSoundRate * 10 + 7] = -.15;
  const windows = writtenSoundWindows(samples);
  assert.deepEqual(windows.map(({ start, end }) => [start, end]), [[5, 10], [10, 12]]);
  const patches = createAudioPatches(windows[1].wave);
  assert.equal(patches.length, soundPatchCount * soundPatchWidth);
  assert.ok(patches.every(Number.isFinite));
  assert.equal(createAudioPatches(new Float32Array(writtenSoundRate * 2)), null);
  assert.deepEqual(writtenSoundWindows(samples.subarray(0, 11 * writtenSoundRate)).map(({ start }) => start), [5]);
  assert.equal(audioPackBytes, 26_609_301);
  assert.equal(audioDownloadBytes, 41_458_153);
});

test('a worker reply cannot associate an out-of-bounds or invalid window with a public source', () => {
  const brief = writtenSoundBrief('rain', '', 'speech');
  const samples = 12 * writtenSoundRate;
  assert.ok(validWrittenSoundWindows([{ start: 10, end: 12, scores: [.4, -.2] }], brief, samples));
  for (const bad of [
    { start: 9, end: 12, scores: [.4, -.2] },
    { start: 10, end: 15, scores: [.4, -.2] },
    { start: 10, end: 12, scores: [.4, -.2, .1] },
    { start: 10, end: 12, scores: [.4, -20] },
    { start: 10, end: 12, scores: [.4, Number.NaN] },
  ]) assert.ok(!validWrittenSoundWindows([bad], brief, samples));
});

test('worker client ignores synthetic messages and clears handlers on cancellation', async () => {
  const worker = { postMessage() {} };
  const controller = new AbortController();
  const authentic = { isTrusted: true, origin: '', source: null, ports: [], data: { type: 'ready' } };
  let progress = 0;
  const pending = requestSoundWorker(worker, { type: 'load' }, controller.signal, 1000, { progress: () => { progress++; } });
  worker.onmessage({ ...authentic, isTrusted: false, data: { type: 'progress' } });
  worker.onmessage({ ...authentic, origin: 'https://invalid.example', data: { type: 'progress' } });
  worker.onmessage({ ...authentic, data: { type: 'progress' } });
  worker.onmessage(authentic);
  assert.deepEqual(await pending, { type: 'ready' });
  assert.equal(progress, 1);
  assert.equal(worker.onmessage, null);
  const next = requestSoundWorker(worker, { type: 'read' }, controller.signal, 1000);
  controller.abort();
  await assert.rejects(next, { name: 'AbortError' });
  assert.equal(worker.onerror, null);
});
