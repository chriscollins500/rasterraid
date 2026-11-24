import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogResearch } from '../src/catalog-research.mjs';
import { appEstimateBody } from '../src/quotes.mjs';

const origin = 'https://civitai.red';
const publicResult = (scope, value = 'citypop') => ({ scope, target: { kind: 'text', value } });
const image = id => 'https://image.civitai.com/fixture/' + id + '.jpeg';
const clip = id => ({ id, link: origin + '/images/' + id, title: 'Sample ' + id, video: true, width: 720, height: 720,
  stream: 'https://image.civitai.com/fixture/' + id + '.mp4', preview: image(id) });

test('catalog research prices a specific public selection, with a combined music workflow', () => {
  const groups = { audioExamples: [clip(11), clip(12), clip(13), clip(14)], articles: [
    { title: 'An article', link: origin + '/articles/37', preview: image(37), summary: 'Source excerpt' },
  ] };
  const selected = new Set([groups.audioExamples[1].link, groups.audioExamples[3].link]);
  const audio = catalogResearch(publicResult('audio'), groups, 'audioExamples', origin, selected);
  assert.deepEqual(audio.picks.map(item => item.title), ['Sample 12', 'Sample 14']);
  assert.deepEqual(audio.plans.map(plan => plan.id), [
    'catalog', 'catalogvision', 'catalogsimilar', 'catalogtranscript', 'catalogmusic', 'catalogmusicnotes',
  ]);
  const vision = audio.plans[1];
  assert.deepEqual(vision.body.steps.map(step => [step.$type, step.input.mediaUrl]), [
    ['mediaCaptioning', image(12)], ['mediaCaptioning', image(14)],
  ]);
  assert.deepEqual(vision.inputs.map(({ link, kind }) => [link, kind]), audio.picks.map(({ link }) => [link, 'Video poster']));
  assert.equal(vision.stepEvidence.catalog_picture_2.sourceLink, groups.audioExamples[3].link);
  const [extract, caption, transcript] = appEstimateBody(audio.plans.at(-1)).steps;
  assert.equal(audio.plans.at(-1).inputs[0].link, groups.audioExamples[1].link);
  assert.equal(audio.plans.at(-1).stepEvidence.transcript.sourceLink, groups.audioExamples[1].link);
  assert.equal(extract.$type, 'composeMedia');
  assert.equal(extract.input.elements[0].url, groups.audioExamples[1].stream);
  assert.deepEqual(extract.input.output, { type: 'audio', container: 'mp3' });
  assert.deepEqual(caption.input.mediaUrl, { $ref: extract.name, path: 'output.audioBlob.url' });
  assert.equal(transcript.input.mediaUrl, groups.audioExamples[1].stream);
  assert.equal(transcript.input.returnTimeStamps, true);
  assert.equal(audio.plans.at(-1).dependentInputs, true);
  assert.equal(audio.plans[2].similarity.previewBasis, 'posters');
  assert.deepEqual(audio.plans[2].inputs.map(({ link }) => link), audio.picks.map(({ link }) => link));
  const textPlan = catalogResearch(publicResult('articles'), groups, 'articles', origin);
  assert.deepEqual(textPlan.plans.map(plan => plan.id), ['catalog']);
  assert.match(textPlan.plans[0].body.steps[0].input.messages[1].content, /Source excerpt/u);
  const video = catalogResearch(publicResult('videos'), { videos: [clip(11)] }, 'videos', origin);
  assert.equal(video.plans.at(-1).id, 'catalogmotion');
  assert.equal(video.plans.at(-1).body.steps[1].input.videoUrl, groups.audioExamples[0].stream);
  assert.equal(video.plans.at(-1).inputs[0].kind, 'Video clip');
});

test('quotes exclude viewer-owned data, foreign listings and signed or unapproved media URLs', () => {
  const safe = clip(1);
  const signed = { ...clip(2), preview: image(2) + '?signature=private', stream: 'https://image.civitai.com/fixture/2.mp4?token=private' };
  const foreign = { ...clip(3), link: safe.link.replace('civitai.red', 'civitai.com') };
  const privateLink = { ...clip(4), link: origin + '/images/4?token=private' };
  const group = { gallery: [signed, foreign, privateLink, safe], libraryMedia: [clip(5)] };
  const catalog = catalogResearch(publicResult('gallery'), group, 'all', origin);
  assert.deepEqual(catalog.picks.map(item => item.link), [signed.link, safe.link]);
  assert.equal(catalog.picks[0].cover, null);
  assert.equal(catalog.picks[0].stream, null);
  assert.deepEqual(catalog.plans.find(plan => plan.id === 'catalogvision').inputs.map(item => item.link), [safe.link]);
  assert.doesNotMatch(JSON.stringify(catalog.plans), /token=|signature=|images\/5/u);
  for (const result of [{ ...publicResult('saved'), library: { includesPrivate: true } }, publicResult('creations'), publicResult('notifications'), publicResult('messages')]) {
    assert.deepEqual(catalogResearch(result, group, 'all', origin), { available: [], picks: [], plans: [] });
  }
});
