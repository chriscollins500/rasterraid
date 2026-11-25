import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowSimulationClient } from '../mock/client.mjs';
import { createWorkflowSimulation } from '../mock/workflows.mjs';
import { appRunTransport } from '../src/workflow-client.mjs';
import { createWorkflowSession, historyResearchOutput, researchOutput, transcriptEvidence, workflowDelivery, workflowOutputPending } from '../src/workflow-session.mjs';
import { embeddingStep } from '../src/research.mjs';
import { workflowRecoveryStep } from '../src/workflow-recovery.mjs';
import { reportSynthesisPlan } from '../src/report-research.mjs';
import { workflowReportMarkdown } from '../src/workflow-results-view.js';
import { findTranscriptMatches, preparedTranscripts } from '../src/workflow-transcripts.mjs';

const origin = 'https://civitai.red';
const plan = {
  title: 'Cross-check report', body: { tier: 'paid', steps: [
    { $type: 'chatCompletion', name: 'report_source_check', input: { model: 'fixture' } },
    { $type: 'chatCompletion', name: 'report_fit', input: { model: 'fixture' } },
    { $type: 'transcription', name: 'report_transcript', input: { mediaUrl: 'https://image.civitai.com/sample.mp4' } },
  ] },
};
const sources = [{ title: 'Public source', link: origin + '/articles/8' },
  { title: 'Foreign source', link: 'https://civitai.com/articles/8' }];

test('transcription keeps valid time labels and distinguishes whole clips from repetitive output', () => {
  const sample = 'Words from the source recording.';
  assert.deepEqual(transcriptEvidence({ text: sample, timeStamps: [] }), { scope: 'clip', lines: [sample] });
  assert.deepEqual(transcriptEvidence({ text: sample, timeStamps: [{ startTime: 3, text: 'Words' }] }),
    { scope: 'timed', lines: ['0:03 · Words'] });
  assert.deepEqual(transcriptEvidence({ text: 'The unconfirmed output repeats once again. '.repeat(600), timeStamps: [] }),
    { scope: 'repetitive', lines: [] });
  assert.deepEqual(transcriptEvidence({ hasAudio: false }), { scope: 'silent', lines: [] });
  assert.deepEqual(transcriptEvidence({ text: '', hasAudio: true }), { scope: 'empty', lines: [] });
  assert.equal(transcriptEvidence({}), null);
});

test('matched speech retains the exact window through live delivery, export, and history alone', () => {
  const words = { name: 'scene_words_5000_10000', $type: 'transcription', status: 'succeeded',
    sourceLink: sources[0].link };
  const still = { name: 'written_scene_caption', $type: 'mediaCaptioning', status: 'succeeded',
    sourceLink: sources[0].link, seconds: 7.5 };
  const run = { title: 'Review the scene', status: 'succeeded', workflowId: 'fixture-run', steps: [words, still], sources,
    createdAt: 100, quote: { total: 3, authorFee: 0 } };
  const reply = { steps: [{ ...words, output: { text: 'Outside words', timeStamps: [
    { startTime: 4.95, endTime: 5.15, text: 'Crosses in' },
    { startTime: 5.125, endTime: 5.35, text: 'Useful' },
    { startTime: 5.35, endTime: 5.85, text: 'match' },
    { startTime: 7, text: 'Missing end' },
    { startTime: 9.8, endTime: 10, text: 'here' },
    { startTime: 9.9, endTime: 10.05, text: 'Crosses out' },
    { startTime: 10, endTime: 10.2, text: 'Outside words' },
  ] } }, { ...still, output: { caption: 'A verified frame.' } }],
  textOutputs: ['Outside words'] };
  const current = researchOutput(reply, run);
  assert.deepEqual(current.text, []);
  assert.deepEqual(current.steps.map(step => step.lines), [['0:05.125 · Useful match', '0:09.8 · here'], ['A verified frame.']]);
  assert.equal(workflowDelivery(run, current).resolved, 2);
  const track = preparedTranscripts(run, current);
  assert.equal(findTranscriptMatches([track], 'Useful match').matches[0].clock, '0:05.125');
  assert.equal(findTranscriptMatches([track], 'match here').count, 0);
  assert.equal(findTranscriptMatches([track], 'Outside words').count, 0);
  const markdown = workflowReportMarkdown([{ run, snapshot: current }]);
  assert.match(markdown, /Speech at 0:05–0:10/u);
  assert.match(markdown, /0:05\.125 · Useful match/u);
  assert.match(markdown, /0:09\.8 · here/u);
  assert.doesNotMatch(markdown, /Outside words|Crosses|Missing end/u);

  const history = historyResearchOutput({ ...reply, steps: [...reply.steps, { $type: 'transcription', name: 6 }] },
    { ...run, steps: [], sources: [] });
  assert.deepEqual(history.steps.map(step => step.lines), current.steps.map(step => step.lines));
  assert.deepEqual(history.text, []);
});

test('matched speech distinguishes an empty interval from missing evidence and keeps a delivered frame', () => {
  const words = { name: 'scene_words_5000_10000', $type: 'transcription', status: 'succeeded' };
  const still = { name: 'written_scene_caption', $type: 'mediaCaptioning', status: 'succeeded',
    output: { caption: 'The frame is available.' } };
  const run = { status: 'succeeded', steps: [words, still] };
  const output = {
    hasAudio: true, text: 'After the window.', timeStamps: [{ startTime: 10, endTime: 11, text: 'After the window.' }],
  };
  const none = researchOutput({ steps: [{ ...words, output }, still] }, run);
  assert.equal(none.steps[0].transcriptScope, 'empty-window');
  assert.equal(workflowDelivery(run, none).resolved, 2);
  assert.equal(workflowOutputPending(run, none), false);
  const untimed = researchOutput({ steps: [{ ...words, output: { ...output, timeStamps: [], segments: [{ start: 5, text: 'Loose' }] } }, still] }, run);
  assert.equal(untimed.steps[0].transcriptScope, 'untimed-window');
  assert.deepEqual(untimed.steps[0].lines, []);
  assert.equal(workflowOutputPending(run, untimed), true);
  assert.deepEqual(untimed.steps[1].lines, ['The frame is available.']);
  const silent = researchOutput({ steps: [{ ...words, output: { hasAudio: false } }, still] }, run);
  assert.equal(silent.steps[0].transcriptScope, 'silent');
  assert.equal(workflowDelivery(run, silent).resolved, 2);
});

test('a succeeded snapshot can still be waiting for output from the same run', () => {
  const chat = { name: 'compare_evidence', $type: 'chatCompletion', status: 'succeeded' };
  const words = { name: 'transcript', $type: 'transcription', status: 'succeeded' };
  const run = { status: 'succeeded', steps: [chat, words] };
  const initial = researchOutput({ status: 'succeeded', steps: run.steps }, run);
  assert.equal(workflowOutputPending(run, initial), true);
  assert.equal(initial.steps[1].transcriptScope, undefined);
  const ready = researchOutput({ status: 'succeeded', textOutputs: ['Ranked sources.'], steps: [
    chat, { ...words, output: { text: '', hasAudio: true } },
  ] }, run, initial);
  assert.equal(workflowOutputPending(run, ready), false);
  assert.equal(ready.steps[1].transcriptScope, 'empty');
  assert.deepEqual(ready.steps[0].lines, ['Ranked sources.']);
  assert.equal(workflowOutputPending(run, { ...initial, withheld: 'Provider withheld output.' }), true);
});

test('grouped chat text remains readable without claiming named delivery', () => {
  const outcome = { workflowId: 'wf_fixture', title: 'Research', status: 'succeeded', sources: sources.slice(0, 1),
    quote: { total: 6, authorFee: 1 }, steps: plan.body.steps.slice(0, 2) };
  const rows = outcome.steps.map(step => ({ ...step, status: 'succeeded' }));
  const grouped = researchOutput({ steps: rows, textOutputs: ['First note.', 'Second note.'] }, outcome);
  assert.deepEqual(workflowDelivery(outcome, grouped).items.map(item => item.state), ['grouped', 'grouped']);
  assert.equal(workflowOutputPending(outcome, grouped), false);
  const output = workflowReportMarkdown([{ run: outcome, snapshot: grouped }]);
  assert.match(output, /0 of 2 result checks resolved\./u);
  assert.match(output, /2 notes together without step names/u);
  assert.match(output, /First note\.[\s\S]*Second note\./u);

  const duplicate = researchOutput({ steps: rows, textOutputs: ['First note.', 'First note.'] }, outcome);
  assert.equal(workflowOutputPending(outcome, duplicate), true);
  const recovered = researchOutput({ steps: rows.map((step, index) => ({ ...step, textOutputs: [grouped.text[index]] })) }, outcome, grouped);
  assert.equal(workflowDelivery(outcome, recovered).resolved, 2);
  assert.equal(workflowOutputPending(outcome, recovered), false);
  assert.deepEqual(recovered.text, []);
});

test('a new provider withhold removes stale chat text and preserves a clean result while another step arrives', () => {
  const outcome = { workflowId: 'wf_fixture', title: 'Research', status: 'succeeded', sources: sources.slice(0, 1),
    quote: { total: 8, authorFee: 1 }, steps: plan.body.steps };
  const steps = outcome.steps.map(step => ({ ...step, status: 'succeeded' }));
  const prior = researchOutput({ steps: [{ ...steps[0], textOutputs: ['Previously visible.'] }, ...steps.slice(1)],
    textOutputs: ['Old shared note.'] }, outcome);
  const current = researchOutput({ steps, textOutputs: ['Visible sibling.'], textOutputWithheld: { reason: 'Provider withheld text.' } }, outcome, prior);
  assert.deepEqual(current.text, ['Visible sibling.']);
  assert.deepEqual(workflowDelivery(outcome, current).items.map(item => item.state), ['unconfirmed', 'unconfirmed', 'waiting']);
  assert.equal(workflowOutputPending(outcome, current), true);
  const after = researchOutput({ steps: [...steps.slice(0, 2), { ...steps[2], output: { hasAudio: false } }] }, outcome, current);
  assert.equal(workflowOutputPending(outcome, after), false);
  const report = workflowReportMarkdown([{ run: outcome, snapshot: after }]);
  assert.match(report, /Quoted author fee · 1 Buzz/u);
  assert.match(report, /1 of 3 result checks resolved/u);
  assert.match(report, /Visible sibling\./u);
  assert.doesNotMatch(report, /Previously visible|Old shared note/u);
  const synthesis = reportSynthesisPlan(outcome, after);
  assert.equal(synthesis.title, 'Synthesize available research');
  const { resultCheck } = JSON.parse(synthesis.body.steps[0].input.messages[1].content);
  assert.equal(resultCheck.providerReportedTextUnavailable, true);
  assert.deepEqual(resultCheck.gaps.map(item => item.state), ['unconfirmed', 'unconfirmed', 'no-audio']);
  assert.doesNotMatch(workflowReportMarkdown([{ run: outcome, snapshot: after, restricted: true }]), /Visible sibling|Result check/u);
});

test('delivery cannot substitute an unrelated step or rank at the same position', () => {
  const source = { title: 'Exact target', link: origin + '/images/42' };
  const query = { name: 'anchor', $type: 'multimodalEmbedding' };
  const target = { name: 'known', $type: 'multimodalEmbedding' };
  const step = { name: 'caption', $type: 'mediaCaptioning', sourceLink: source.link };
  const outcome = { workflowId: 'wf_exact', title: 'Preview comparison', sources: [source], status: 'succeeded',
    steps: [query, target, step], similarity: { anchor: query.name, targets: [{ step: target.name, ...source }] } };
  const unmatched = { steps: [{ ...step, $type: 'chatCompletion', status: 'succeeded', lines: ['A different result.'] }],
    similarity: { ranked: [{ step: target.name, link: origin + '/images/44', score: 0.9 }] }, text: [] };
  assert.equal(workflowOutputPending(outcome, unmatched), true);
  assert.deepEqual(workflowDelivery(outcome, unmatched).items.map(item => item.state), ['waiting', 'waiting']);
  const matched = { ...unmatched, steps: [{ ...step, status: 'succeeded', lines: ['Test caption.'] }],
    similarity: { ranked: [{ step: target.name, link: source.link, score: 0.9 }] } };
  assert.equal(workflowOutputPending(outcome, matched), false);
  assert.equal(workflowDelivery(outcome, matched).resolved, 2);
  assert.equal(workflowDelivery(outcome, { ...matched, restricted: true }), null);
});

test('Civitai WeMM text and video preprocessing profiles compare within the same embedding space', () => {
  const link = origin + '/images/48';
  const anchor = 'search_embedding';
  const target = 'video_embedding_1';
  const similarity = { model: 'wemm-2b', dimensions: 64, anchor, targets: [{ step: target, title: 'Clip', link }] };
  const vector = (name, profile, modelRevision = 'fixture-revision', precision = 'float32') => ({ name,
    $type: 'multimodalEmbedding', status: 'succeeded', output: {
      ...{ model: similarity.model, dimensions: similarity.dimensions, modelRevision, precision, profile },
      embedding: [1, ...Array(63).fill(0)],
    } });
  const textProfile = 'wemm-2b-bf16-image262144-v1';
  const videoProfile = 'wemm-2b-bf16-video-fps2-frames16-pixels4194304-v1';
  const start = vector(anchor, textProfile);
  const rank = matching => researchOutput({ steps: [start, matching] }, { status: 'succeeded', steps: [start, matching], similarity }).similarity.ranked;
  assert.deepEqual(rank(vector(target, videoProfile)).map(row => [row.link, row.score]), [[link, 1]]);
  assert.deepEqual(rank(vector(target, videoProfile, 'different')), []);
  assert.deepEqual(rank(vector(target, videoProfile, 'fixture-revision', 'float16')), []);
  assert.deepEqual(rank(vector(target, 'unknown-profile')), []);
});

test('sound classifications summarize only valid segments using their analyzed durations', () => {
  const step = { name: 'scene_audio_1', $type: 'audioClassification', sourceLink: origin + '/images/48', status: 'succeeded' };
  const segments = [{ durationSeconds: 20, musicScore: 1, singingScore: .3, speechScore: 0 },
    { durationSeconds: 10, musicScore: .4, singingScore: 0, speechScore: .3 },
    { durationSeconds: 10, musicScore: 4, singingScore: 0, speechScore: 0 }];
  const run = { steps: [step], status: 'succeeded' };
  const snapshot = researchOutput({ steps: [{ ...step, output: { hasAudio: true, segments } }] }, run);
  assert.deepEqual(snapshot.steps[0].lines, ['Estimated music 80/100 · Singing 20/100 · Speech 10/100',
    'Analyzed 30 seconds across 2 segments.']);
  assert.equal(snapshot.steps[0].sourceLink, step.sourceLink);
  assert.equal(workflowOutputPending(run, snapshot), false);
});

test('a repeated transcript keeps its source link and cannot become synthesis evidence', () => {
  const source = { title: 'Exact public recording', link: origin + '/images/48' };
  const step = { name: 'report_transcript', $type: 'transcription', sourceLink: source.link };
  const run = { status: 'succeeded', title: 'Clip research', workflowId: 'workflow-fixture', sources: [source], steps: [step] };
  const frame = output => researchOutput({ steps: [{ ...step, status: 'succeeded', output }] }, run);
  const repeated = frame({ text: 'This unconfirmed content would be misleading. '.repeat(100), timeStamps: [] });
  assert.equal(reportSynthesisPlan(run, repeated), null);
  const exportText = workflowReportMarkdown([{ run, snapshot: repeated }]);
  assert.ok(exportText.includes(source.link));
  assert.match(exportText, /Repeated transcript · Check the source recording/u);
  assert.doesNotMatch(exportText, /unconfirmed content/u);
  const untimed = frame({ text: 'A short line of dialogue.', timeStamps: [] });
  const synthesis = reportSynthesisPlan(run, untimed);
  const { previousResearch } = JSON.parse(synthesis.body.steps[0].input.messages[1].content);
  assert.equal(previousResearch[0].transcriptScope, 'clip');
  assert.ok(workflowReportMarkdown([{ run, snapshot: untimed }]).includes('Whole recording · Times unavailable'));
});

test('Civitai-only history reopens media notes without assigning unverified sources', () => {
  const run = { status: 'succeeded', title: 'Civitai run', sources: [], steps: [] };
  const sourceLink = origin + '/images/48';
  const caption = { $type: 'mediaCaptioning', name: 'sample', status: 'succeeded', sourceLink, output: { caption: 'Carved linework.' } };
  const reply = { cost: { total: 4 }, textOutputs: ['Carved linework.', 'Catalog notes.'], steps: [caption,
    { ...caption, output: { caption: 'Duplicate caption.' } },
    { ...caption, name: '<invalid>', output: { caption: 'Invalid caption.' } },
    { name: 'clip_text', $type: 'transcription', status: 'succeeded', output: { segments: [{ start: 4, text: 'Starting here.' }] } },
    { name: 'music', $type: 'audioCaptioning', status: 'succeeded', output: { results: { track: { caption: 'Piano and bass.' } } } },
    { name: 'vector', $type: 'multimodalEmbedding', status: 'succeeded', output: { embedding: [0.25] } },
  ] };
  const output = historyResearchOutput(reply, run);
  assert.equal(output.cost, 4);
  assert.deepEqual(output.text, ['Catalog notes.']);
  assert.deepEqual(output.steps.map(step => [step.name, ...step.lines]), [
    ['sample', 'Carved linework.'], ['clip_text', '0:04 · Starting here.'], ['music', 'Piano and bass.'],
  ]);
  assert.equal(output.steps[0].sourceLink, undefined);
  assert.equal(output.similarity, undefined);
  const report = workflowReportMarkdown([{ run, snapshot: output }]);
  assert.match(report, /### Picture description[\s\S]+Carved linework\./u);
  assert.match(report, /Exact sources and itemized estimates use the saved RasterRaid receipt\./u);
  assert.match(report, /That receipt also links the visual comparisons to their pictures\./u);
  assert.doesNotMatch(report, /images\/48|0\.25|Duplicate caption|Invalid caption/u);
  const registered = { ...run, steps: [{ name: caption.name, $type: caption.$type, sourceLink }],
    sources: [{ title: 'Exact picture', link: sourceLink }] };
  const withReceipt = historyResearchOutput(reply, registered);
  assert.equal(withReceipt.steps.length, 1);
  assert.equal(withReceipt.steps[0].sourceLink, sourceLink);
  assert.equal(withReceipt.civitaiHistoryOnly, undefined);
});

function memoryJournal() {
  let entry;
  return { read: async () => structuredClone(entry), write: async value => { entry = structuredClone(value); } };
}

function simulation(now, onRequest = () => {}, failStep = null) {
  const handle = createWorkflowSimulation({ now, failStep });
  return createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
    const input = JSON.parse(request.body);
    const reply = handle(request.method, url.pathname, input);
    await onRequest(url.pathname, input, reply);
    return Response.json(reply.body, { status: reply.status });
  });
}

test('an ambiguous workflow submission restores the same operation and rejects a modified workflow', async () => {
  let now = 1000;
  const journal = memoryJournal();
  const submits = [];
  const backend = simulation(() => now, async (route, body, reply) => {
    if (!route.endsWith('/submit')) return;
    assert.equal((await journal.read()).operationId, body.idempotencyKey);
    submits.push([body.idempotencyKey, reply.body.snapshot.workflowId]);
    if (submits.length === 1) throw new Error('Response lost');
  });
  let estimates = 0;
  const client = { ...backend, async estimate(body, signal) {
    const reply = await backend.estimate(body, signal);
    if (++estimates >= 3) reply.cost.total += estimates === 3 ? 2 : 4;
    return reply;
  }, list: undefined, inspect: undefined };
  const settings = { client, journal, origin, now: () => now, operationId: () => 'rasterraid-fixture' };
  const first = createWorkflowSession(settings);
  await first.prepare(plan, sources);
  assert.equal(first.state().quote.price.authorFee, 1);
  assert.equal(await journal.read(), undefined);
  await assert.rejects(first.confirm(), /Response lost/u);
  assert.equal(first.state().run.status, 'unknown');
  assert.equal((await journal.read()).body, undefined);
  const resumed = createWorkflowSession(settings);
  await resumed.restore();
  assert.deepEqual(resumed.state().run.sources, [sources[0]]);
  const wrong = { ...plan, body: { ...plan.body, steps: plan.body.steps.slice(0, 1) } };
  await assert.rejects(resumed.prepareRetry(wrong), /original workflow/u);
  await resumed.prepareRetry(plan);
  assert.equal(submits.length, 1);
  assert.equal(resumed.state().quote.retry, true);
  assert.equal(resumed.state().quote.price.total, resumed.state().run.quote.total + 2);
  assert.equal((await journal.read()).retryQuote, undefined);
  await resumed.confirm();
  assert.equal(resumed.state().quote.retry, true);
  assert.equal(resumed.state().quote.revised, true);
  assert.equal(resumed.state().quote.price.total, resumed.state().run.quote.total + 4);
  assert.equal((await journal.read()).retryQuote, undefined);
  assert.equal(submits.length, 1);
  await resumed.confirm();
  assert.equal((await journal.read()).retryQuote.total, (await journal.read()).quote.total + 4);
  assert.deepEqual(submits[0], submits[1]);
  now += 2500;
  await resumed.refresh();
  assert.equal(resumed.state().run.status, 'succeeded');
  assert.match(resumed.state().snapshot.steps[2].lines[0], /^0:00/u);
  const reopened = createWorkflowSession(settings);
  await reopened.restore();
  await reopened.refresh();
  assert.deepEqual(reopened.state().snapshot, resumed.state().snapshot);
});

test('confirmation requires fresh review for a changed total or author fee', async () => {
  const journal = memoryJournal();
  const bodies = [];
  const prices = [{ total: 6, authorFee: 2 }, { total: 7, authorFee: 2 }, { total: 7, authorFee: 1 },
    { total: 7 }, { total: 7, authorFee: 0 }, { total: 7, authorFee: 0 }];
  const client = {
    estimate(body) {
      bodies.push(structuredClone(body));
      return { status: 'pending', cost: prices[bodies.length - 1] };
    },
    async submit(body, operationId) {
      assert.deepEqual(body, bodies[0]);
      assert.equal(operationId, 'price-fixture');
      assert.deepEqual((await journal.read()).quote, prices.at(-1));
      return { workflowId: 'wf_fixture', status: 'pending', cost: prices.at(-1) };
    },
  };
  const session = createWorkflowSession({ client, journal, origin, now: () => 1000, operationId: () => 'price-fixture' });
  await session.prepare(plan, sources);
  assert.equal(session.state().quote.revised, false);
  for (const { total, authorFee = null } of prices.slice(1, -1)) {
    await session.confirm();
    assert.equal(await journal.read(), undefined);
    assert.equal(session.state().run, undefined);
    assert.equal(session.state().quote.revised, true);
    assert.deepEqual(session.state().quote.price, { total, authorFee });
  }
  await session.confirm();
  assert.equal(session.state().run.workflowId, 'wf_fixture');
  assert.equal(session.state().quote, null);
  assert.deepEqual(bodies, prices.map(() => bodies[0]));
});

test('failed, expired, and discarded confirmation checks leave the workflow unsubmitted', async () => {
  let now = 1000;
  const journal = memoryJournal();
  const estimate = { status: 'pending', cost: { total: 6, authorFee: 2 } };
  let nextEstimate = () => estimate;
  const client = { estimate: () => nextEstimate(), submit() { assert.fail('The price was not cleared for submission'); } };
  const session = createWorkflowSession({ client, journal, origin, now: () => now });
  await session.prepare(plan, sources);
  nextEstimate = () => { throw new Error('Estimate temporarily unavailable'); };
  await assert.rejects(session.confirm(), /temporarily unavailable/u);
  assert.deepEqual(session.state().quote.price, estimate.cost);
  nextEstimate = () => { now += 120_000; return estimate; };
  await assert.rejects(session.confirm(), /expired during the price check/u);
  assert.equal(session.state().quote, null);

  nextEstimate = () => estimate;
  await session.prepare(plan, sources);
  const update = Promise.withResolvers();
  nextEstimate = () => update.promise;
  const pending = session.confirm();
  assert.equal(session.discardQuote(), true);
  update.resolve(estimate);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(session.state().quote, null);
  assert.equal(await journal.read(), undefined);
});

test('quote expiry, a failed journal, and an expired retry cannot start another operation', async () => {
  let now = 1500;
  const journal = memoryJournal();
  let submissions = 0;
  const client = simulation(() => now, path => {
    if (path.endsWith('/submit')) {
      submissions++;
      throw new Error('Connection interrupted');
    }
  });
  const expired = createWorkflowSession({ client, journal, origin, now: () => now });
  await expired.prepare(plan, sources);
  now += 120_100;
  await assert.rejects(expired.confirm(), /current quote/u);
  const badJournal = createWorkflowSession({ client, journal: { ...journal, async write() { throw new Error('Write refused'); } }, origin });
  await badJournal.prepare(plan, sources);
  await assert.rejects(badJournal.confirm(), /Write refused/u);
  assert.equal(submissions, 0);
  const unknown = createWorkflowSession({ client, journal, origin, now: () => now });
  await unknown.prepare(plan, sources);
  await assert.rejects(unknown.confirm(), /Connection interrupted/u);
  now += 480_100;
  await assert.rejects(unknown.prepareRetry(plan), /no longer be retried safely/u);
  assert.equal(submissions, 1);
});

test('initial and recovery estimates are rechecked after private storage writes', async () => {
  let now = 1_000;
  const journal = memoryJournal();
  let pauseWrite = 0;
  const delayed = { ...journal, async write(record) {
    await journal.write(record);
    now += pauseWrite;
    pauseWrite = 0;
  } };
  let submitCount = 0;
  const client = simulation(() => now, path => {
    if (path.endsWith('/submit')) {
      submitCount++;
      throw new Error('Response interrupted');
    }
  });
  // The provider history is still behind the accepted submission.
  client.list = async () => ({ workflows: [], cursor: null });
  const session = createWorkflowSession({ origin, now: () => now, client, journal: delayed });
  await session.prepare(plan, sources);
  pauseWrite = 121_000;
  await assert.rejects(session.confirm(), /expired before submission/u);
  assert.equal(submitCount, 0);
  assert.equal((await journal.read()).status, 'not-started');

  await session.prepare(plan, sources);
  await assert.rejects(session.confirm(), /Response interrupted/u);
  assert.equal(session.state().originalInTab, true);
  now += 470_000;
  await session.prepareRetry();
  pauseWrite = 11_000;
  await assert.rejects(session.confirm(), /retry estimate expired/u);
  assert.equal(submitCount, 1);
  assert.equal((await journal.read()).status, 'unknown');
  assert.equal(session.state().retryAvailable, false);
});

test('only the initial definite refusal supplies a no-charge receipt', async () => {
  const priced = { workflowId: 'failed', status: 'failed', cost: { total: 9, authorFee: 2 } };
  const backend = simulation(() => 200);
  const initial = createWorkflowSession({ origin, now: () => 200, journal: memoryJournal(), client: {
    ...backend, async submit() { return priced; },
  } });
  await initial.prepare(plan, sources);
  await initial.confirm();
  assert.equal(initial.state().run.status, 'refused');
  assert.deepEqual(initial.state().run.refusalPrice, { total: 9, authorFee: 2, observedAt: 200 });
  assert.equal(initial.state().run.receipt, undefined);

  const journal = memoryJournal();
  let submissions = 0;
  const unresolved = createWorkflowSession({ origin, now: () => 200, journal, client: {
    ...backend, async submit() { return ++submissions === 1 ? { ...priced, submissionUnconfirmed: true } : priced; },
  } });
  await unresolved.prepare(plan, sources);
  await assert.rejects(unresolved.confirm(), /could not confirm the submission outcome/u);
  assert.equal(unresolved.state().run.status, 'unknown');
  assert.equal(unresolved.state().run.refusalPrice, undefined);
  await unresolved.prepareRetry();
  await assert.rejects(unresolved.confirm(), /original submission is still unconfirmed/u);
  assert.equal((await journal.read()).status, 'unknown');
  assert.ok((await journal.read()).retryQuote);
  await unresolved.archiveUnconfirmed();
  assert.equal((await journal.read()).status, 'unconfirmed');
  assert.equal(submissions, 2);
});

test('a lost receipt write can be saved again without resubmitting an accepted workflow', async () => {
  for (const committed of [false, true]) {
    const backing = memoryJournal();
    let submitted = 0;
    let interrupted = false;
    const journal = { read: backing.read, async write(value) {
      if (value.workflowId && !interrupted) {
        interrupted = true;
        if (committed) await backing.write(value);
        throw new Error('Receipt save interrupted');
      }
      await backing.write(value);
    } };
    const provider = simulation(() => 1_000);
    const client = { ...provider, submit(...args) { submitted++; return provider.submit(...args); } };
    const session = createWorkflowSession({ client, journal, origin, now: () => 1_000 });
    await session.prepare(plan, sources);
    await assert.rejects(session.confirm(), /Receipt save interrupted/u);
    const confirmedId = session.state().run.workflowId;
    assert.ok(confirmedId);
    assert.equal(session.state().receiptPending, true);
    assert.equal((await backing.read()).workflowId, committed ? confirmedId : null);
    await assert.rejects(session.prepare(plan, sources), /Save the current receipt/u);
    await session.saveReceiptAgain();
    assert.equal((await backing.read()).workflowId, confirmedId);
    assert.equal(session.state().receiptPending, false);
    assert.equal(submitted, 1);
  }
});

test('a partial failure retains completed work and a canceled simulation never advances', async () => {
  let now = 0;
  const state = createWorkflowSession({ client: simulation(() => now, () => {}, 1), journal: memoryJournal(), origin, now: () => now });
  await state.prepare(plan, sources);
  await state.confirm();
  now = 2200;
  await state.refresh();
  assert.equal(state.state().run.status, 'failed');
  assert.equal(state.state().snapshot.cost, 3);
  assert.ok(state.state().snapshot.steps[0].lines.length);
  assert.equal(state.state().snapshot.steps[1].status, 'failed');
  const kept = researchOutput({ steps: [] }, state.state().run, state.state().snapshot);
  assert.deepEqual(kept, state.state().snapshot);

  const canceled = createWorkflowSession({ client: simulation(() => now), journal: memoryJournal(), origin, now: () => now });
  await canceled.prepare(plan, sources);
  await canceled.confirm();
  now += 850;
  await canceled.cancel();
  const status = canceled.state().snapshot;
  now += 10_000;
  await canceled.refresh();
  assert.equal(canceled.state().run.status, 'canceled');
  assert.deepEqual(canceled.state().snapshot, status);
});

test('the hosted transport fixes the API routes, sends an idempotency key, and refuses a different viewer', async () => {
  const calls = [];
  let context = { origin, viewerUserId: 42, signedIn: true, hosted: true, token: 'fixture', scopes: ['ai:write:budgeted'] };
  const client = appRunTransport(context, () => context, { fetcher: async (url, request) => {
    calls.push([url.href, request.credentials, JSON.parse(request.body)]);
    return Response.json({ snapshot: { status: 'pending', workflowId: 'fixture-run' } });
  } });
  const body = { kind: 'workflow', steps: plan.body.steps };
  await client.submit(body, 'fixture-op');
  assert.deepEqual(calls, [[origin + '/api/v1/blocks/workflows/submit', 'omit', { body, idempotencyKey: 'fixture-op' }]]);
  context = { ...context, viewerUserId: 93 };
  assert.throws(() => client.poll('fixture-run'), /original Civitai account/u);
  assert.equal(calls.length, 1);
});

test('a hosted response cannot leave its original access, and an unconfirmed submit flag survives REST', async () => {
  const binding = { origin, viewerUserId: 42, hosted: true, signedIn: true, token: 'original', browsingLevel: 3,
    scopes: ['ai:write:budgeted'] };
  let context = binding;
  const delayed = Promise.withResolvers();
  const client = appRunTransport(binding, () => context, { fetcher(url) {
    return url.pathname.endsWith('/poll') ? delayed.promise : Response.json({ submissionUnconfirmed: true,
      snapshot: { status: 'failed', workflowId: 'failed', cost: { total: 9 } } });
  } });
  const submit = await client.submit({ kind: 'workflow', steps: plan.body.steps }, 'fixture-submission');
  assert.equal(submit.submissionUnconfirmed, true);
  const pending = client.poll('fixture-run');
  context = { ...binding, browsingLevel: 1, token: 'new' };
  delayed.resolve(Response.json({ snapshot: { status: 'succeeded', workflowId: 'fixture-run', textOutputs: ['withheld'] } }));
  await assert.rejects(pending, /original Civitai account/u);
  assert.throws(() => client.poll('fixture-run'), /original Civitai account/u);
});

test('a restored receipt retains the reported cost when notes require broader browsing access', async () => {
  let now = 1000;
  const journal = memoryJournal();
  const backend = simulation(() => now);
  const settings = { client: backend, journal, origin, now: () => now };
  const original = createWorkflowSession({ ...settings, browsingLevel: 3 });
  await original.prepare(plan, sources);
  await original.confirm();
  now += 2200;
  await original.refresh();
  assert.equal(original.state().run.receipt.total, 8);
  assert.equal(original.state().run.receipt.authorFee, null);
  assert.equal(original.state().run.quote.authorFee, 1);
  assert.ok(original.state().snapshot.steps[0].lines.length);

  const restricted = createWorkflowSession({ ...settings, browsingLevel: 1 });
  await restricted.restore();
  assert.equal(restricted.state().outputsAccessible, false);
  assert.equal(restricted.state().run.receipt.total, 8);
  await restricted.refresh();
  assert.deepEqual(restricted.state().snapshot, { steps: [], text: [], cost: 8, restricted: true });
  await assert.rejects(restricted.prepare(plan, sources, { continueRun: true }), /prior results/u);
});

test('a provider that throttles cancellation leaves the original operation running', async () => {
  const underlying = simulation(() => 500);
  const state = createWorkflowSession({ journal: memoryJournal(), origin, client: {
    ...underlying,
    async cancel(workflowId) { return { workflowId, status: 'pending', throttled: true }; },
  } });
  await state.prepare(plan, sources);
  await state.confirm();
  await assert.rejects(state.cancel(), /did not issue the cancellation/u);
  assert.equal(state.state().run.status, 'pending');
});

test('read-only recovery restores the exact lost run after the retry window', async () => {
  let now = 30_000;
  const journal = memoryJournal();
  const requests = [];
  let originalId;
  let estimatedBody;
  const backend = simulation(() => now, (path, input, reply) => {
    requests.push(path.split('/').at(-1));
    if (path.endsWith('/estimate')) estimatedBody = input.body;
    if (!path.endsWith('/submit')) return;
    assert.deepEqual(input.body, estimatedBody);
    originalId = reply.body.snapshot.workflowId;
    throw new Error('Accepted, then response lost');
  });
  const inspected = [];
  const client = { ...backend,
    async list(input, signal) {
      const history = await backend.list(input, signal);
      return { ...history, workflows: [{ ...history.workflows[0], workflowId: 'another-run' }, ...history.workflows] };
    },
    async inspect(id, signal) {
      inspected.push(id);
      const reply = await backend.inspect(originalId, signal);
      if (id === originalId) return reply;
      const steps = reply.steps.map(step => ({ ...step }));
      // Equal time, amount and name alone are insufficient with another step type.
      steps.at(-1).$type = 'mediaCaptioning';
      return { ...reply, workflowId: id, steps };
    },
  };
  const settings = { client, journal, origin, now: () => now, browsingLevel: 3 };
  const first = createWorkflowSession(settings);
  await first.prepare(plan, sources);
  await assert.rejects(first.confirm(), /Accepted, then response lost/u);
  const saved = await journal.read();
  assert.equal(saved.recoveryStep, await workflowRecoveryStep(saved.operationId));
  assert.equal(saved.recoveryStep, estimatedBody.steps.at(-1).name);
  assert.equal(saved.steps.at(-1).name, 'report_transcript');
  assert.equal(saved.body, undefined);
  now += 600_000;

  const restricted = createWorkflowSession({ ...settings, browsingLevel: 1 });
  await restricted.restore();
  assert.equal(restricted.state().recoveryAvailable, false);
  await assert.rejects(restricted.recoverOriginal(), /unavailable for automatic recovery/u);
  const resumed = createWorkflowSession(settings);
  await resumed.restore();
  assert.equal(resumed.state().retryAvailable, false);
  assert.equal(resumed.state().recoveryAvailable, true);
  await resumed.recoverOriginal();
  assert.deepEqual(inspected, ['another-run', originalId]);
  assert.equal(resumed.state().run.workflowId, originalId);
  assert.equal(resumed.state().run.status, 'succeeded');
  assert.equal((await journal.read()).receipt.total, 8);
  assert.match(resumed.state().snapshot.steps.at(-1).lines[0], /^0:00/u);
  assert.deepEqual(requests, ['estimate', 'estimate', 'submit', 'query', 'poll', 'poll']);
});

test('retry review and confirmation check again for the accepted workflow', async () => {
  for (const presentOnReview of [true, false]) {
    const requests = [];
    const backend = simulation(() => 1000, route => {
      requests.push(route.split('/').at(-1));
      if (route.endsWith('/submit')) throw new Error('Response lost');
    });
    let listed = presentOnReview;
    const client = { ...backend, list: (input, signal) => listed ? backend.list(input, signal) : { workflows: [], cursor: null } };
    const session = createWorkflowSession({ client, journal: memoryJournal(), origin, now: () => 1000 });
    await session.prepare(plan, sources);
    await assert.rejects(session.confirm(), /Response lost/u);
    await session.prepareRetry(plan);
    if (!presentOnReview) {
      assert.equal(session.state().quote.retry, true);
      listed = true;
      await session.confirm();
    }
    assert.equal(session.state().run.status, 'pending');
    assert.equal(session.state().quote, null);
    assert.equal(session.state().run.retryQuote, undefined);
    assert.deepEqual(requests, ['estimate', 'estimate', 'submit', ...(!presentOnReview ? ['estimate'] : []), 'query', 'poll']);
  }
});

async function lostHistoryRun() {
  const requests = [];
  const reads = [];
  const cursors = [];
  const journal = memoryJournal();
  const now = () => 1000;
  let accepted;
  const backend = simulation(now, (route, _input, reply) => {
    requests.push(route.split('/').at(-1));
    if (!route.endsWith('/submit')) return;
    accepted = reply.body.snapshot;
    throw new Error('Response lost');
  });
  const history = {
    rows: cursor => ({ ids: cursor ? ['second-match'] : [accepted.workflowId, ...Array.from({ length: 8 }, (_, index) => 'other-' + index)],
      cursor: cursor ? null : 'second-page' }),
    status: (id, reply) => id.startsWith('other-') ? { ...reply, steps: [] } : reply,
  };
  const client = { ...backend,
    async list({ cursor, limit }) {
      assert.equal(limit, 24);
      cursors.push(cursor);
      const page = history.rows(cursor);
      return { cursor: page.cursor, workflows: page.ids.map(workflowId => ({ workflowId, createdAt: now(), status: 'pending' })) };
    },
    async inspect(id) {
      reads.push(id);
      return history.status(id, { ...structuredClone(accepted), workflowId: id });
    },
  };
  const session = createWorkflowSession({ client, journal, origin, now, browsingLevel: 3 });
  await session.prepare(plan, sources);
  await assert.rejects(session.confirm(), /Response lost/u);
  return { session, journal, history, firstId: accepted.workflowId, requests, reads, cursors };
}

test('recovery waits for the rest of the history before accepting an early match', async () => {
  const { session, journal, firstId, requests, reads, cursors } = await lostHistoryRun();
  await session.prepareRetry(plan);
  assert.equal((await journal.read()).status, 'unknown');
  assert.equal(session.state().quote, null);
  assert.equal(session.state().recoveryContinuing, true);
  assert.equal(session.state().retryAvailable, false);
  assert.deepEqual(reads, [firstId, ...Array.from({ length: 7 }, (_, index) => 'other-' + index)]);
  const saved = await journal.read();
  await journal.write({ ...saved, submissionUntil: saved.createdAt + 7000 });
  await session.checkSavedRun();
  assert.equal(session.state().recoveryContinuing, true);
  await assert.rejects(session.recoverOriginal(), /multiple runs/u);
  assert.deepEqual(cursors, [undefined, 'second-page']);
  assert.deepEqual(reads.slice(8), ['other-7', 'second-match']);
  assert.equal((await journal.read()).status, 'unknown');
  assert.equal(session.state().recoveryConflict, true);
  assert.equal(session.state().retryAvailable, false);
  assert.deepEqual(requests, ['estimate', 'estimate', 'submit']);
});

test('a lost run discovered during retry confirmation still needs the full history check', async () => {
  const { session, journal, history, firstId, requests, reads } = await lostHistoryRun();
  const full = history.rows;
  history.rows = () => ({ ids: [], cursor: null });
  await session.prepareRetry(plan);
  assert.equal(Boolean(session.state().quote?.retry), true);
  history.rows = full;
  await session.confirm();
  assert.equal((await journal.read()).workflowId, null);
  assert.equal(session.state().recoveryContinuing, true);
  assert.equal(session.state().retryAvailable, false);
  assert.equal(session.state().quote, null);
  assert.equal(reads[0], firstId);
  await assert.rejects(session.recoverOriginal(), /multiple runs/u);
  assert.deepEqual(requests, ['estimate', 'estimate', 'submit', 'estimate']);
});

test('a transient failure resumes a tentative match and rechecks its current status before recording it', async () => {
  const { session, journal, history, firstId, requests, reads } = await lostHistoryRun();
  let failed = false;
  history.rows = () => ({ ids: [firstId, 'other-0'], cursor: null });
  history.status = (id, reply) => {
    if (id === 'other-0' && !failed) {
      failed = true;
      throw Object.assign(new Error('Temporarily unavailable'), { status: 503 });
    }
    if (id === 'other-0') return { ...reply, steps: [] };
    return failed ? { ...reply, status: 'succeeded', cost: { total: 8, authorFee: 1 } } : reply;
  };
  await assert.rejects(session.prepareRetry(plan), /Temporarily unavailable/u);
  assert.equal(session.state().recoveryContinuing, true);
  assert.equal(session.state().retryAvailable, false);
  const original = await journal.read();
  assert.equal(original.status, 'unknown');
  await session.recoverOriginal();
  const recovered = await journal.read();
  assert.equal(recovered.workflowId, firstId);
  assert.equal(recovered.operationId, original.operationId);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.receipt.authorFee, 1);
  assert.deepEqual(reads, [firstId, 'other-0', 'other-0', firstId]);
  assert.deepEqual(requests, ['estimate', 'estimate', 'submit']);
});

test('a repeated history cursor cannot certify an earlier match as unique', async () => {
  const { session, journal, history, firstId, requests } = await lostHistoryRun();
  history.rows = cursor => ({ ids: cursor ? [] : [firstId], cursor: 'same-page' });
  await assert.rejects(session.recoverOriginal(), /repeated a history page/u);
  assert.equal((await journal.read()).workflowId, null);
  assert.equal(session.state().retryAvailable, false);
  assert.equal(session.state().recoveryContinuing, true);
  history.rows = cursor => ({ ids: cursor ? [] : [firstId], cursor: cursor ? null : 'same-page' });
  await session.recoverOriginal();
  assert.equal((await journal.read()).workflowId, firstId);
  assert.deepEqual(requests, ['estimate', 'estimate', 'submit']);
});

test('conflicting matches and temporary history failures keep a lost run unconfirmed', async () => {
  const journal = memoryJournal();
  let submits = 0;
  let estimates = 0;
  let queryMode = 'throttled';
  let accepted;
  const backend = simulation(() => 2500, (route, input, reply) => {
    if (route.endsWith('/estimate')) estimates++;
    if (!route.endsWith('/submit')) return;
    submits++;
    accepted = reply.body.snapshot;
    throw new Error('Response lost');
  });
  const client = { ...backend, async list(input, signal) {
    if (queryMode === 'throttled') throw Object.assign(new Error('History is temporarily unavailable'), { status: 429 });
    if (queryMode === 'empty') return { workflows: [], cursor: null };
    const { workflows } = await backend.list(input, signal);
    return { workflows: [...workflows, { ...workflows[0], workflowId: 'second-match' }], cursor: null };
  }, inspect: async workflowId => ({ ...accepted, workflowId }) };
  const session = createWorkflowSession({ client, journal, origin, now: () => 2500 });
  await session.prepare(plan, sources);
  await assert.rejects(session.confirm(), /Response lost/u);
  await assert.rejects(session.prepareRetry(plan), /temporarily unavailable/u);
  queryMode = 'empty';
  await assert.rejects(session.recoverOriginal(), /remains unresolved/u);
  queryMode = 'duplicate';
  await assert.rejects(session.recoverOriginal(), /multiple runs/u);
  assert.equal(session.state().recoveryConflict, true);
  await assert.rejects(session.prepareRetry(plan), /no longer be retried safely/u);
  assert.equal((await journal.read()).status, 'unknown');
  assert.equal(session.state().quote, null);
  assert.equal(submits, 1);
  assert.equal(estimates, 2);
});

test('multi-step similarity recovers ranked exact sources without journaling vector values', async () => {
  let now = 1000;
  const journal = memoryJournal();
  const settings = { client: simulation(() => now), journal, origin, now: () => now };
  const first = { link: origin + '/images/10', title: 'First public picture' };
  const second = { link: origin + '/images/11', title: 'Second public picture' };
  const similarity = { title: 'Compare selected pictures', body: { tier: 'paid', steps: [
    embeddingStep('query_vector', { text: 'print texture' }),
    embeddingStep('example_1', { imageUrl: 'https://image.civitai.com/fixture/a.webp' }),
    embeddingStep('example_2', { imageUrl: 'https://image.civitai.com/fixture/b.webp' }),
  ] }, similarity: { anchor: 'query_vector', targets: [{ step: 'example_1', ...first }, { step: 'example_2', ...second }] } };
  const session = createWorkflowSession(settings);
  await session.prepare(similarity, [first, second]);
  await session.confirm();
  now += 2200;
  await session.refresh();
  const ranked = session.state().snapshot.similarity.ranked;
  assert.deepEqual(ranked.map(item => item.link), [first.link, second.link]);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal((await journal.read()).similarity.model, 'wemm-2b');
  assert.equal((await journal.read()).similarity.embeddings, undefined);
  const refreshed = createWorkflowSession(settings);
  await refreshed.restore();
  await refreshed.refresh();
  assert.deepEqual(refreshed.state().snapshot.similarity.ranked, ranked);

  const expected = session.state().run;
  const values = Array(256).fill(0);
  values[0] = 1;
  const vector = (name, modelRevision) => ({ name, status: 'succeeded', $type: 'multimodalEmbedding',
    output: { model: 'wemm-2b', profile: 'fixture', modelRevision, dimensions: 256, precision: 'float32', embedding: values } });
  const incompatible = researchOutput({ steps: [vector('query_vector', 'one'), vector('example_1', 'different')] }, expected);
  assert.equal(incompatible.similarity.ranked.length, 0);
});
