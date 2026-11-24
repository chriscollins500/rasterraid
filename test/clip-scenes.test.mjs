import assert from 'node:assert/strict';
import test from 'node:test';

const root = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { bestClipScene, planClipScene } = await import(root + 'clip-scenes.mjs');
const { describeVisuals } = await import(root + 'visual-analysis.mjs');
const { clipMatchLink } = await import(root + 'visual-discovery.mjs');
const { searchTarget } = await import(root + 'search.mjs');

const stream = 'https://image.civitai.com/fixtures/scene.mp4';
const colored = (red, green, blue) => describeVisuals(Uint8ClampedArray.from({ length: 64 * 64 * 4 }, (_, index) => [red, green, blue, 255][index % 4]));
const look = colored(211, 47, 29);
const motion = { histogram: [1, 0, 0, 0, 0, 0, 0, 0], pace: .1, spread: 1, radial: 0 };
const reverse = { ...motion, histogram: [0, 0, 0, 0, 1, 0, 0, 0] };
const sound = { texture: [1, 0], dynamics: [1, 1, 1, 1], exactStart: 0, duration: 2, stream };
const differentSound = { ...sound, texture: [0, 1] };
const scene = (values = {}) => ({ stream, appearance: look, motion, sound, seconds: 1, span: .32, videoDuration: 8, ...values });

test('a match needs the picture, motion and sound in the same excerpt on both clips', () => {
  const reference = planClipScene([scene()]);
  assert.deepEqual(reference.signals, ['appearance', 'motion', 'sound']);
  const differentShots = [scene({ sound: differentSound }), scene({ motion: reverse, seconds: 5, sound: { ...sound, exactStart: 4 } })];
  assert.ok(bestClipScene(reference, differentShots, { includeSound: false }));
  assert.equal(bestClipScene(reference, differentShots), undefined);
  const fitted = scene({ seconds: 5, sound: { ...sound, exactStart: 4 } });
  const match = bestClipScene(reference, [differentShots[0], fitted]);
  assert.ok(match.score > .99);
  assert.equal(match.stream, stream);
  assert.equal(match.referenceSeconds, 1);
  assert.deepEqual([match.start, match.seconds, match.end], [4, 5, 6]);
  assert.deepEqual(Object.keys(match.scores), ['appearance', 'motion', 'sound']);
});

test('candidate audio must cover the measured movement on the exact same rendition', () => {
  const reference = planClipScene([scene()]);
  for (const candidate of [scene({ sound: { ...sound, stream: stream + '?different=1' } }),
    scene({ sound: { ...sound, exactStart: 3 } }), scene({ sound: { ...sound, duration: 1.1 } }), scene({ sound: undefined })]) {
    assert.equal(bestClipScene(reference, [candidate]), undefined);
  }
});

test('a reference with missing signals has a truthful fallback, and disjoint signals have no joint anchor', () => {
  const withoutSound = planClipScene([scene({ sound: undefined })]);
  assert.deepEqual(withoutSound.signals, ['appearance', 'motion']);
  assert.deepEqual(Object.keys(bestClipScene(withoutSound, [scene({ sound: undefined })]).scores), ['appearance', 'motion']);
  const split = planClipScene([scene({ sound: undefined }), scene({ motion: undefined, seconds: 5, sound: { ...sound, exactStart: 4 } })]);
  assert.deepEqual(split.signals, ['appearance', 'motion', 'sound']);
  assert.equal(split.anchors.length, 0);
  assert.equal(bestClipScene(split, [scene()]), undefined);
});

test('scene links require an exact supported Civitai clip page', () => {
  for (const origin of ['https://civitai.com', 'https://civitai.red']) {
    const url = clipMatchLink(origin, 20, 'scene');
    assert.equal(url, origin + '/images/20#match-scene');
    assert.deepEqual(searchTarget(url), { kind: 'similarMedia', id: 20, scope: 'videos', scene: true });
    assert.equal(searchTarget(origin + '/images/20?other=1#match-scene').kind, 'image');
  }
  assert.throws(() => searchTarget('https://example.com/images/20#match-scene'), /Use a Civitai/u);
});
