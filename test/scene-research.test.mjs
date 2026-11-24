import assert from 'node:assert/strict';
import test from 'node:test';
import { clipAnalysisUrl } from '../src/catalog.mjs';
import { appEstimateBody } from '../src/quotes.mjs';
import { rankSceneMatches, sceneResearch } from '../src/scene-research.mjs';

const origin = 'https://civitai.red';
const clip = (id, title) => ({ link: origin + '/images/' + id, title, video: true,
  stream: `https://image.civitai.com/covers/aa00bb11-cc22-dd33-ee44-ff00aa11bb${id}/original=true/clip.mp4` });
const split = clip(10, 'Split cues');
const together = { ...clip(11, 'Together'), music: true };
const mismatched = clip(12, 'Different source');
const unrelated = clip(13, 'Unlisted clip');
const frame = (item, timestamp, score) => ({ item, stream: clipAnalysisUrl(item.stream), timestamp, score, cues: [] });
const audio = (item, early, late, stream = clipAnalysisUrl(item.stream)) => ({ item, stream, excerpts: [
  { start: 0, duration: 8, score: early, cues: [] }, { start: 12, duration: 8, score: late, cues: [] },
] });

test('synchronized scene ranking beats independent maxima when the cues occur in different shots', () => {
  const frames = [frame(split, 2, 1), frame(split, 15, .25), frame(together, 4, .82), frame(together, 15, .3),
    frame(mismatched, 4, 1), frame(unrelated, 8, 1)];
  const recordings = [audio(split, .22, 1), audio(together, .82, .4), audio(mismatched, 1, 1, mismatched.stream), audio(unrelated, 1, 1)];
  const independent = recordings.slice(0, 2).map(row => [row.item.title,
    Math.sqrt(Math.max(...row.excerpts.map(item => item.score)) * Math.max(...frames.filter(item => item.item === row.item).map(item => item.score)))]);
  assert.equal(independent.sort((a, b) => b[1] - a[1])[0][0], 'Split cues');
  const ranked = rankSceneMatches(frames, recordings);
  assert.deepEqual(ranked.map(row => [row.item.title, row.start, row.timestamp]), [['Together', 0, 4], ['Split cues', 12, 15]]);
  assert.ok(ranked.every(row => row.timestamp >= row.start && row.timestamp < row.start + row.duration));
});

test('scene quotes bind the frame and audio to the same measured public stream and retain linked exact versions', () => {
  const post = { title: 'Public post', link: origin + '/posts/20' };
  const version = { title: 'Linked file release', link: origin + '/models/3?modelVersionId=90' };
  const report = { evidence: [together, split, mismatched], rails: [], connections: [
    { kind: 'post-media', label: 'Listed in this post', items: [post, together] },
    { kind: 'post-model', label: 'This post records a version', items: [post, version] },
  ] };
  const moment = item => ({ link: item.link, timestamp: 4.1234, start: 1, duration: 8, stream: clipAnalysisUrl(item.stream), privateNote: 'private-reference' });
  const result = sceneResearch(report, origin, [moment(together), moment(split), moment(mismatched)]);
  assert.deepEqual(result.sources.map(item => item.link), [together.link, split.link, post.link, version.link]);
  assert.deepEqual(result.plans.map(({ id, body }) => [id, body.steps.length]), [['sceneframes', 4], ['scenestudy', 8]]);
  const [frames, study] = result.plans.map(appEstimateBody);
  assert.equal(frames.steps[0].input.startTime, 4.1234);
  assert.equal(frames.steps[1].input.mediaUrl.$ref, 'scene_frame_1');
  assert.equal(study.steps[4].$type, 'audioClassification');
  assert.equal(study.steps[4].input.mediaUrl, frames.steps[0].input.videoUrl);
  assert.equal(study.steps[6].input.returnTimeStamps, true);
  assert.doesNotMatch(JSON.stringify(study), /private-reference/u);
  assert.equal(sceneResearch(report, origin, [{ ...moment(together), stream: 'https://outside.example/clip.mp4' }]), null);
  assert.equal(sceneResearch(report, origin, [{ ...moment(together), stream: clipAnalysisUrl(split.stream) }]), null);
  assert.equal(sceneResearch(report, origin, [{ ...moment(together), timestamp: 9 }]), null);
  const late = sceneResearch(report, origin, [{ ...moment(together), timestamp: 72, start: 68 }]);
  assert.equal(appEstimateBody(late.plans[0]).steps[0].input.startTime, 72);
  const lateStudy = appEstimateBody(late.plans[1]);
  assert.equal(lateStudy.steps.length, 7);
  assert.equal(lateStudy.steps.find(step => step.name === 'scene_music_audio').input.elements[0].url, clipAnalysisUrl(together.stream));
  assert.deepEqual(lateStudy.steps.find(step => step.name === 'scene_music').input.mediaUrl,
    { $ref: 'scene_music_audio', path: 'output.audioBlob.url' });
  assert.equal(sceneResearch(report, origin, [{ ...moment(together), timestamp: 240, start: 236 }]), null);
  assert.equal(sceneResearch(report, 'https://civitai.com', [moment(together)]), null);
  assert.equal(sceneResearch({ ...report, rails: [{ status: 'waiting' }] }, origin, [moment(together)]), null);
});
