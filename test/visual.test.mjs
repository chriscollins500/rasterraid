import assert from 'node:assert/strict';
import test from 'node:test';
import { clipAnalysisUrl } from '../src/catalog.mjs';
const { describeVisuals, rankVisualMatches, samplePublicClip, samplePublicMotion, visualRegion, visualRegionLabel, visualScorer } =
  await import(process.env.RASTERRAID_TEST_DIST ? '../dist/src/visual-analysis.mjs' : '../src/visual-analysis.mjs');

test('the crop scorer locates each cue and keeps joined traits in one candidate region', () => {
  const warm = picture(() => [200, 42, 28]);
  const cool = picture(() => [27, 51, 133]);
  const focus = { aspect: 1, scale: .5 };
  const region = [.5, .5, 1, 1];
  const layout = { ...cool, palette: warm.palette };
  const joined = visualScorer([{ role: 'palette', focus, features: warm }, { role: 'lighting', focus, features: cool }]);
  const separated = joined(cool, [
    { focus, region, features: warm }, { focus, region: [0, 0, .5, .5], features: cool },
  ]);
  assert.ok(separated.score < .99);
  const together = joined(cool, [{ focus, region, features: layout }]);
  assert.equal(together.score, 1);
  assert.deepEqual(together.cues.map(cue => cue.region), [region, region]);
  assert.equal(visualRegionLabel(region), 'lower right');
  const avoid = visualScorer([{ role: 'palette', polarity: 'avoid', focus, features: warm }]);
  assert.equal(avoid(cool, [{ focus, region, features: warm }]).score, 0);
  assert.equal(avoid(cool).cues[0].regionUnavailable, true);
});

test('only finite picture areas inside the original frame can become a crop', () => {
  assert.deepEqual(visualRegion([.15, .2, .48, .75]), [.15, .2, .48, .75]);
  for (const invalid of [[0, 0, 1, 1], [0, 0, .1, .9], [0, .9, .9, .5], [0, 0, 1.1, 1], [, 0, 1, 1], [0, 0, NaN, 1]]) {
    assert.equal(visualRegion(invalid), null);
  }
});

function picture(pixel) {
  const image = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const value = pixel(x, y);
    image.set([...value, 255], (y * 64 + x) * 4);
  }
  return describeVisuals(image);
}

test('palette and avoid references use separate evidence and keep the original cards intact', () => {
  const red = picture(() => [224, 26, 43]);
  const blue = picture(() => [14, 31, 219]);
  const entries = [{ item: { title: 'Blue' }, features: blue }, { item: { title: 'Red' }, features: red }];
  const positive = rankVisualMatches([{ role: 'palette', polarity: 'prefer', features: red }], entries);
  assert.equal(positive[0].item.title, 'Red');
  const negative = rankVisualMatches([{ role: 'palette', polarity: 'avoid', features: red }], entries);
  assert.equal(negative[0].item.title, 'Blue');
  assert.deepEqual(entries.map(item => item.item.title), ['Blue', 'Red']);
});

test('short clips sample early and late frames, refine the best moment, and release the media source', async () => {
  class FixtureVideo extends EventTarget {
    duration = 10;
    videoWidth = 640;
    videoHeight = 360;
    sources = [];
    set src(url) {
      this.sources.push(url);
      queueMicrotask(() => this.dispatchEvent(new Event(url.includes('transcode=true') ? 'error' : 'loadedmetadata')));
    }
    set currentTime(value) {
      this.position = value;
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    }
    get currentTime() { return this.position; }
    removeAttribute() { this.released = true; }
    load() { this.closed = true; }
  }
  const video = new FixtureVideo();
  const document = { createElement: name => name === 'video' ? video : {
    getContext: () => ({ fillRect() {}, drawImage() {}, getImageData: (_x, _y, width, height) => ({ data: new Uint8Array(width * height * 4) }) }),
  } };
  const score = visualScorer([{ role: 'composition', features: picture(() => [80, 80, 80]) }]);
  const frames = await samplePublicClip(document, 'https://image.civitai.com/fixture.mp4', new AbortController().signal, score);
  assert.deepEqual(frames.map(frame => Math.round(frame.timestamp * 100) / 100), [2, 5, 8, .5, 9.5, 1.25, 3.5]);
  assert.ok(frames.every(frame => frame.features.composition));
  assert.equal(video.muted, true);
  assert.ok(video.released && video.closed);
  const original = 'https://image.civitai.com/cdn/2b36f901-9c2e-4acd-ba3a-15bbd974ebea/original=true/clip.mp4';
  const preview = clipAnalysisUrl(original);
  assert.match(preview, /transcode=true,width=320,original=false,optimized=true/u);
  assert.equal(clipAnalysisUrl(original + '?signed=example'), original + '?signed=example');
  assert.equal(clipAnalysisUrl('https://outside.example/clip.mp4'), null);
  const fallback = await samplePublicClip(document, original, new AbortController().signal);
  assert.deepEqual(video.sources.slice(-2), [preview, original]);
  assert.equal(fallback.length, 5);
  assert.ok(fallback.every(frame => frame.stream === original));
  video.duration = 90;
  const longClip = 'https://image.civitai.com/long.mp4';
  assert.deepEqual(await samplePublicClip(document, longClip, new AbortController().signal), []);
  const motion = await samplePublicMotion(document, longClip, new AbortController().signal);
  assert.equal(video.preload, 'metadata');
  assert.deepEqual(motion.map(window => Number(window.seconds.toFixed(2))), [16.04, 44.84, 71.84]);
  assert.ok(motion.every(window => window.stream === longClip && window.motion === null));
});

test('small color shifts stay close and each requested cue contributes its own evidence', () => {
  const warm = picture(() => [184, 55, 53]);
  const nearby = picture(() => [185, 56, 60]);
  const cool = picture(() => [58, 74, 160]);
  const light = picture(() => [218, 218, 218]);
  const refs = [{ role: 'palette', features: warm }, { role: 'lighting', polarity: 'avoid', features: light }];
  const ranked = rankVisualMatches(refs, [{item: 'cool', features: cool}, {item: 'warm', features: nearby}]);
  assert.equal(ranked[0].item, 'warm');
  assert.ok(ranked[0].cues[0].score > .85);
  assert.equal(ranked[0].cues[1].polarity, 'avoid');
  assert.equal(visualScorer(refs)(light).score, 0);
});

test('multiple selected roles retain distinct lighting and spatial evidence', () => {
  const left = picture(x => x < 17 ? [15, 15, 15] : [200, 200, 200]);
  const right = picture(x => x > 46 ? [15, 15, 15] : [200, 200, 200]);
  const dark = picture(() => [15, 15, 15]);
  const entries = [{ item: 'right', features: right }, { item: 'dark', features: dark }, { item: 'left', features: left }];
  const ranked = rankVisualMatches([
    { role: 'composition', polarity: 'prefer', features: left },
    { role: 'lighting', polarity: 'avoid', features: dark },
  ], entries);
  assert.equal(ranked[0].item, 'left');
  assert.ok(ranked.every(({ score }) => score >= 0 && score <= 1));
  assert.throws(() => describeVisuals(new Uint8Array(2)), /normalized image pixels/u);
});

test('combining three references beats every two-cue shortcut on controlled hard negatives', () => {
  const palette = picture(() => [213, 17, 30]);
  const layout = picture(x => x < 32 ? [240, 240, 240] : [15, 15, 15]);
  const grating = picture(x => x % 6 < 3 ? [240, 240, 240] : [15, 15, 15]);
  const smooth = picture(() => [58, 67, 173]);
  const cues = [
    { role: 'palette', label: 'warm reference', features: palette },
    { role: 'composition', label: 'left-lit reference', features: layout },
    { role: 'texture', label: 'avoid grating', polarity: 'avoid', features: grating },
  ];
  // Isolate attribute differences so each shortcut has its own competing candidate.
  const correct = { ...smooth, palette: palette.palette, composition: layout.composition };
  const candidates = [
    { item: 'wrong color', features: { ...correct, palette: smooth.palette } },
    { item: 'wrong layout', features: { ...correct, composition: smooth.composition } },
    { item: 'excluded texture', features: { ...correct, texture: grating.texture } },
    { item: 'all requested traits', features: correct },
  ];
  for (const removed of [0, 1, 2]) {
    const baseline = rankVisualMatches(cues.filter((_cue, index) => index !== removed), candidates);
    assert.equal(baseline[0].item, candidates[removed].item);
  }
  const [match] = rankVisualMatches(cues, candidates);
  assert.equal(match.item, 'all requested traits');
  assert.deepEqual(match.cues.map(cue => [cue.role, cue.label]), cues.map(cue => [cue.role, cue.label]));
});
