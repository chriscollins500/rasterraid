import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkflowSimulationClient } from '../mock/client.mjs';
import { createWorkflowSimulation } from '../mock/workflows.mjs';
import { appEstimateBody, expandedQuoteOptions } from '../src/quotes.mjs';
import { spokenClipResearch } from '../src/sound-research.mjs';
import { speechRate, spokenRegions } from '../src/spoken-regions.mjs';
import { spokenWordHits } from '../src/spoken-view.js';
import { createWorkflowSession } from '../src/workflow-session.mjs';

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

const origin = 'https://civitai.com';
const clip = { title: 'Speech control', link: origin + '/images/100',
  stream: 'https://image.civitai.com/speech/control.mp4', video: true, group: 'videos' };
const anchor = { link: clip.link, stream: clip.stream, seconds: 4.388 };

test('clip quotes bind their transcript, frame, and source to the actual selected rendition', () => {
  const { plans } = spokenClipResearch([clip], anchor, origin);
  const [transcript, frame, combined] = plans.map(plan => appEstimateBody(plan).steps);
  assert.deepEqual(transcript.map(step => step.$type), ['transcription']);
  assert.deepEqual(transcript[0].input, { mediaUrl: clip.stream, returnTimeStamps: true });
  assert.equal(frame[0].input.videoUrl, clip.stream);
  assert.equal(frame[0].input.startTime, 4.388);
  assert.deepEqual(frame[1].input.mediaUrl, { $ref: frame[0].name, path: 'output.frames[0].url' });
  assert.deepEqual(combined, [...transcript, ...frame]);
  assert.deepEqual(plans[2].stepEvidence[frame[1].name], { sourceLink: clip.link, seconds: 4.388, purpose: 'Sampled scene' });
  assert.deepEqual(expandedQuoteOptions(plans, [{ total: 1 }, { total: 2 }, { total: 3 }]).map(row => row?.difference), [2, 1, undefined]);
  for (const invalid of [{ stream: 'https://image.civitai.com/other.mp4' }, { link: 'https://civitai.red/images/100' },
    { seconds: -1 }, { seconds: 240 }, { seconds: NaN }]) {
    assert.equal(spokenClipResearch([clip], { ...anchor, ...invalid }, origin), null);
  }
  assert.equal(spokenClipResearch([{ ...clip, group: 'private' }], anchor, origin), null);
});

test('audio results carry audio plans even when Civitai delivers the sound in a video container', () => {
  const { hasFrame, plans } = spokenClipResearch([{ ...clip, group: 'audioExamples' }], anchor, origin);
  assert.equal(hasFrame, false);
  assert.deepEqual(plans.map(plan => plan.id), ['spokenclipwords', 'spokenclipsound']);
  assert.deepEqual(plans[1].body.steps[1], { $type: 'audioClassification', name: 'spoken_clip_sound', input: { mediaUrl: clip.stream } });
  assert.deepEqual(plans[1].stepEvidence.spoken_clip_sound, { sourceLink: clip.link, purpose: 'Whole-recording sound classification' });
});

test('the combined workflow delivers the transcript with exact provenance even when its frame step fails', async () => {
  const review = spokenClipResearch([clip], anchor, origin);
  for (const failStep of [null, 1]) {
    let now = 1000;
    let saved;
    let submissions = 0;
    const handle = createWorkflowSimulation({ now: () => now, failStep });
    const client = createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
      if (url.pathname.endsWith('/submit')) submissions++;
      const reply = handle(request.method, url.pathname, JSON.parse(request.body));
      return Response.json(reply.body, { status: reply.status });
    });
    const session = createWorkflowSession({ client, origin, now: () => now, operationId: () => 'spoken-review-fixture',
      journal: { read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); } } });
    await session.prepare(review.plans[2], review.sources);
    assert.equal(session.state().quote.price.authorFee, 1);
    assert.equal(submissions, 0);
    await session.confirm();
    now += 2500;
    await session.refresh();
    const { run, snapshot } = session.state();
    assert.equal(submissions, 1);
    assert.deepEqual(run.sources, [{ link: clip.link, title: clip.title }]);
    assert.equal(snapshot.steps[0].sourceLink, clip.link);
    assert.match(snapshot.steps[0].lines.join(' '), /Simulated words/u);
    assert.equal(snapshot.steps[0].transcriptScope, 'timed');
    assert.equal(run.status, failStep ? 'failed' : 'succeeded');
    const caption = snapshot.steps.find(step => step.$type === 'mediaCaptioning');
    if (!failStep) {
      assert.equal(caption.sourceLink, clip.link);
      assert.equal(caption.seconds, anchor.seconds);
      assert.match(caption.lines[0], /near 4\.388 seconds/u);
    } else {
      assert.equal(caption.status, 'canceled');
      assert.deepEqual(caption.lines, []);
    }
  }
});
