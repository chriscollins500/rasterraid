import assert from 'node:assert/strict';
import test from 'node:test';
import { clipAnalysisUrl } from '../src/catalog.mjs';
import { selectWrittenClipFrames } from '../src/visual-analysis.mjs';
import { rankWrittenScenes, rankWrittenSceneSounds, writtenSceneReview, writtenSceneSample, writtenSceneSoundEvidence,
  writtenSceneSpeechSamples } from '../src/written-scenes.mjs';
import { writtenSoundBrief, writtenSoundRate } from '../src/written-sound.mjs';

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

test('joined written cues favor the same interval and reject a different rendition or timeline', () => {
  const split = video(101);
  const aligned = video(102);
  const other = video(103);
  const shifted = video(104);
  const last = video(105);
  const frame = (id, clip, timestamp, stream = clipAnalysisUrl(clip.stream)) => ({ id, clip, timestamp, stream, duration: 15 });
  const frames = [frame(1, split, 2.5), frame(2, split, 7.5), frame(3, aligned, 5),
    frame(4, other, 7.5, other.stream), frame(5, shifted, 7.5), frame(6, last, 10)];
  const matches = [.99, .1, .8, 1, 1, 1].map((score, index) => ({ id: index + 1, score }));
  const audio = (item, scores, duration = 15) => ({ item, rendition: clipAnalysisUrl(item.stream), duration,
    checked: scores.map((score, slot) => ({ start: slot * 5, end: (slot + 1) * 5, scores: [score] })) });
  const recordings = [audio(split, [.1, .99]), audio(aligned, [.3, .85]), audio(other, [1, 1]), audio(shifted, [1, 1], 16), audio(last, [1, 1])];
  const evidence = writtenSceneSoundEvidence({ frames, matches }, recordings, writtenSoundBrief('dog barking'));
  assert.deepEqual(evidence.map(row => [row.clip.id, row.timestamp, row.soundStart, row.soundEnd]), [
    [101, 2.5, 0, 5], [101, 7.5, 5, 10], [102, 5, 5, 10],
  ]);
  const ranked = rankWrittenSceneSounds(evidence);
  assert.deepEqual(ranked.map(row => row.clip.id), [102, 101]);
  assert.equal(ranked[0].soundScore, .85);
  const [framePlan, speechPlan] = writtenSceneReview(ranked[0], origin).plans;
  assert.equal(framePlan.body.steps[0].input.startTime, 5);
  const [speech, ...framesAgain] = speechPlan.body.steps;
  assert.deepEqual(speech, { $type: 'transcription', name: 'scene_words_5000_10000',
    input: { mediaUrl: framePlan.body.steps[0].input.videoUrl, returnTimeStamps: true } });
  assert.deepEqual(framesAgain, framePlan.body.steps);
  assert.equal(speechPlan.stepEvidence[speech.name].sourceLink, aligned.link);
  assert.equal(writtenSceneReview({ ...ranked[0], soundStart: '5' }, origin).plans.length, 1);
  assert.equal(writtenSceneReview({ ...ranked[0], soundEnd: 5 }, origin).plans.length, 1);
});

test('scene speech reads the selected audio interval from the same rendition', () => {
  const clip = video(24);
  const wave = new Float32Array(writtenSoundRate * 15);
  wave.fill(9, 0, writtenSoundRate * 5);
  wave.fill(.25, writtenSoundRate * 5, writtenSoundRate * 10);
  wave.fill(8, writtenSoundRate * 10);
  const stream = clipAnalysisUrl(clip.stream);
  const frame = { clip, stream, timestamp: 7.5, duration: 15, soundStart: 5, soundEnd: 10 };
  const recording = { item: clip, rendition: stream, duration: 15, samples: wave };
  const selected = writtenSceneSpeechSamples(frame, recording);
  assert.equal(selected.length, 5 * writtenSoundRate);
  assert.ok(selected.every(value => value === .25));
  assert.notEqual(selected.buffer, wave.buffer);
  assert.equal(writtenSceneSpeechSamples(frame, { ...recording, rendition: clip.stream }), null);
  assert.equal(writtenSceneSpeechSamples(frame, { ...recording, duration: 13 }), null);
  assert.equal(writtenSceneSpeechSamples(frame, { ...recording, item: video(25) }), null);
  assert.equal(writtenSceneSpeechSamples({ ...frame, soundEnd: 11 }, recording), null);
});
