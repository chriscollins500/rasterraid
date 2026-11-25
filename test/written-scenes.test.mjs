import assert from 'node:assert/strict';
import test from 'node:test';
import { clipAnalysisUrl } from '../src/catalog.mjs';
import { selectWrittenClipFrames } from '../src/visual-analysis.mjs';
import { rankWrittenScenes, writtenSceneReview, writtenSceneSample } from '../src/written-scenes.mjs';

const origin = 'https://civitai.red';
const video = id => ({ id, video: true, link: origin + '/images/' + id, browsingLevel: 1, postId: id, title: 'Clip ' + id,
  stream: 'https://image.civitai.com/x/00000000-0000-0000-0000-000000000001/original=true/clip-' + id + '.mp4' });
const result = { target: { kind: 'text' }, gallery: { scope: 'videos', query: 'Road without rain' } };

test('written scenes sample only the visible same-host clips with eligible streams', () => {
  const rows = [video(1), { ...video(2), browsingLevel: 4 }, { ...video(3), audio: true },
    { ...video(4), link: 'https://civitai.com/images/4' }, { ...video(5), stream: video(5).stream + '?private' },
    { ...video(6), needsReview: true }, video(1), { ...video(8), stream: video(1).stream },
    ...[9, 10, 11, 12, 13, 14].map(video)];
  const sample = writtenSceneSample(result, rows, { origin, browsingLevel: 3 });
  assert.equal(sample.description, 'Road');
  assert.equal(sample.clipFrames, true);
  assert.deepEqual(sample.sample.map(row => row.id), [1, 9, 10, 11, 12, 13]);
  assert.equal(writtenSceneSample(result, rows, { origin, browsingLevel: 3, connectionLost: true }), null);
  assert.equal(writtenSceneSample({ ...result, library: true }, rows, { origin, browsingLevel: 3 }), null);
  assert.equal(writtenSceneSample({ ...result, target: { kind: 'similarMedia' } }, rows, { origin, browsingLevel: 3 }), null);
});

test('the sampler keeps the start, midpoint, end, and one visually different probe', () => {
  const frames = [0, 4, 10, 20, 23, 180, 30].map((shade, probe) => ({ probe, colors: new Uint8ClampedArray([shade]) }));
  assert.deepEqual(selectWrittenClipFrames(frames).map(frame => frame.probe), [0, 3, 5, 6]);
  assert.deepEqual(selectWrittenClipFrames(frames.slice(0, 3)), frames.slice(0, 3));
});

test('ranking returns one real time per clip and discards another stream or an out-of-range frame', () => {
  const one = video(1);
  const two = video(2);
  const preview = clipAnalysisUrl(one.stream);
  const frames = [{ id: 1, clip: one, stream: preview, timestamp: 3.45, duration: 5 },
    { id: 2, clip: one, stream: preview, timestamp: .5, duration: 5 },
    { id: 3, clip: one, stream: two.stream, timestamp: 1, duration: 5 },
    { id: 4, clip: two, stream: two.stream, timestamp: 5, duration: 5 },
    { id: 5, clip: two, stream: clipAnalysisUrl(two.stream), timestamp: 2, duration: 5 }];
  const matches = [{ id: 3, score: 1 }, { id: 4, score: .9 }, { id: 99, score: .8 }, { id: 1, score: .5 },
    { id: 2, score: .5 }, { id: 5, score: .4 }];
  assert.deepEqual(rankWrittenScenes({ frames, matches }).map(row => [row.clip.id, row.timestamp]), [[1, .5], [2, 2]]);
});

test('sampled frame quote carries its exact public source and never includes the local description', () => {
  const clip = video(21);
  const frame = { clip, timestamp: 3.1234, duration: 5, stream: clipAnalysisUrl(clip.stream), description: 'private search' };
  const { plans: [plan] } = writtenSceneReview(frame, origin);
  assert.deepEqual(plan.sources, [{ title: clip.title, link: clip.link }]);
  assert.deepEqual(plan.body.steps[0].input, { videoUrl: frame.stream, frameRate: 1, maxFrames: 1, startTime: 3.123 });
  assert.deepEqual(plan.body.steps[1].input.mediaUrl, { $ref: 'written_scene_frame', path: 'output.frames[0].url' });
  assert.deepEqual(plan.stepEvidence.written_scene_caption, { sourceLink: clip.link, seconds: 3.123, purpose: 'Sampled scene' });
  assert.doesNotMatch(JSON.stringify(plan), /private search/u);
  assert.equal(writtenSceneReview(frame, 'https://civitai.com'), null);
  assert.equal(writtenSceneReview({ ...frame, stream: video(20).stream }, origin), null);
});
