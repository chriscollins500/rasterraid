import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowSimulationClient } from '../mock/client.mjs';
import { createWorkflowSimulation } from '../mock/workflows.mjs';
import { expandedQuoteOptions } from '../src/quotes.mjs';
import { reportSynthesisPlan } from '../src/report-research.mjs';
import { galleryCandidateResearch, galleryCompositionResearch, galleryCompositionSubjectSample, gallerySimilarityResearch, visualResearch } from '../src/visual-research.mjs';
import { createWorkflowSession, workflowRecord } from '../src/workflow-session.mjs';
import { workflowReportMarkdown } from '../src/workflow-results-view.js';

const origin = 'https://civitai.red';
const picture = { title: 'Public linocut', link: origin + '/images/11', cover: 'https://image.civitai.com/public/11.jpeg' };
const clip = { title: 'Public clip', link: origin + '/images/12', stream: 'https://image.civitai.com/public/12.mp4',
  cover: 'https://image.civitai.com/public/12.jpeg', video: true };
const model = { title: 'Recorded model version', link: origin + '/models/17?modelVersionId=18' };
const report = { rails: [], query: 'local-brief-canary', evidence: [picture, clip], localMatches: [{ detail: 'local-score-canary' }],
  connections: [{ label: 'This example records the exact model version', items: [picture, model] }] };
const selection = [{ link: clip.link, timestamp: .634, private: 'local-preview-canary' }, { link: picture.link, filename: 'local-name-canary.png' }];

test('gallery similarity keeps a stable, varied sample of safe public previews and restores its ranked results', async () => {
  const media = (id, postId, extra = {}) => ({ id, postId, title: 'Civitai result ' + id, link: origin + '/images/' + id,
    preview: 'https://image.civitai.com/public/' + id + '.jpeg', video: true, visualSources: ['Shared tag · linocut'], ...extra });
  const anchor = media(10, 90, { stream: 'https://image.civitai.com/public/clip.mp4?private=canary' });
  const candidates = [media(11, 90), media(12, 90), media(13, 91), media(14, 92), media(15, 93), media(16, 94), media(17, 95),
    media(18, 97, { preview: 'https://image.civitai.com/public/18.jpeg?private=canary' }), media(19, 98, { preview: anchor.preview }),
    media(20, 99, { link: 'https://civitai.com/images/20' })];
  const result = { target: { kind: 'similarMedia', id: 10 }, gallery: { scope: 'videos' }, reference: anchor,
    visualSearch: { order: [18, 19, 20, 11, 12, 13, 14, 15, 16, 17], region: 'local-crop-canary' }, related: { videos: candidates } };
  const first = gallerySimilarityResearch(result, origin);
  const reshuffled = gallerySimilarityResearch({ ...result, related: { videos: candidates.toReversed() } }, origin);
  assert.deepEqual(reshuffled, first);
  const [quick, audit] = first.plans;
  const ids = plan => plan.inputs.map(source => Number(source.link.split('/').at(-1)));
  assert.deepEqual(ids(quick), [10, 11, 13, 14]);
  assert.deepEqual(ids(audit), [10, 11, 13, 14, 15, 16, 17]);
  assert.deepEqual(first.plans.map(plan => plan.body.steps.length), [4, 8]);
  assert.ok(audit.inputs.every(item => item.kind === 'Video poster'));
  assert.ok(audit.body.steps.slice(0, 7).every(step => step.$type === 'multimodalEmbedding' && step.input.imageUrl && !step.input.videoUrl));
  const catalog = audit.body.steps.at(-1);
  assert.equal(catalog.$type, 'chatCompletion');
  assert.ok(JSON.parse(catalog.input.messages[1].content).candidates.every(item => item.catalogMatches[0] === 'Shared tag · linocut'));
  assert.doesNotMatch(JSON.stringify(first.plans), /canary/u);
  assert.equal(gallerySimilarityResearch({ ...result, library: {} }, origin), null);
  assert.equal(audit.similarity.targets.some(row => row.previewRank), false);
  const ranked = candidates.toReversed().map((item, index) => ({ ...item, visualMatch: { score: 1 - index / 20 } }));
  const samePreviews = { ...result, visualSearch: { order: result.visualSearch.order }, related: { videos: ranked } };
  const paired = gallerySimilarityResearch(samePreviews, origin).plans[1];
  assert.deepEqual(paired.body, audit.body);
  assert.deepEqual(paired.similarity.targets.map(row => row.previewRank), [6, 5, 4, 3, 2, 1]);
  const subjectOrder = [13, 14, 16, 17, 15, 11];
  const [learnedQuick, shortlist, learnedAudit] = gallerySimilarityResearch(samePreviews, origin, subjectOrder).plans;
  assert.deepEqual(learnedQuick.body, quick.body);
  assert.deepEqual(learnedAudit.body, paired.body);
  assert.equal(shortlist.id, 'neighborshortlist');
  assert.deepEqual(ids(shortlist), [10, 13, 14, 17, 16]);
  assert.equal(shortlist.body.steps.filter(step => step.$type === 'multimodalEmbedding').length, 5);
  assert.equal(shortlist.body.steps.at(-1).$type, 'chatCompletion');
  assert.deepEqual(expandedQuoteOptions([shortlist, learnedAudit], [{ total: 9 }, { total: 11 }]), [
    { title: 'Rank more and check sources', previews: 2, difference: 2 }, null,
  ]);
  assert.doesNotMatch(JSON.stringify(shortlist.body), /subjectRank|previewRank|canary/u);
  assert.deepEqual(learnedAudit.similarity.targets.map(row => row.subjectRank), [6, 1, 2, 5, 3, 4]);
  assert.equal(gallerySimilarityResearch(samePreviews, origin, subjectOrder.slice(1)).plans.length, 2);
  assert.equal(gallerySimilarityResearch(result, origin, subjectOrder).plans.some(plan => plan.similarity.targets.some(row => row.subjectRank)), false);
  const frameSearch = { ...samePreviews, related: { videos: ranked.map(item => item.id === 17
    ? { ...item, visualMatch: { ...item.visualMatch, frames: 3 } } : item) } };
  const framePlans = gallerySimilarityResearch(frameSearch, origin, subjectOrder).plans;
  assert.equal(framePlans.length, 2);
  assert.equal(framePlans[1].similarity.targets.some(row => row.previewRank), false);

  let time = 1_000;
  let stored;
  const service = createWorkflowSimulation({ now: () => time });
  const client = createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
    const reply = service(request.method, url.pathname, JSON.parse(request.body));
    return Response.json(reply.body, { status: reply.status });
  });
  const config = { client, origin, now: () => time, journal: {
    read: async () => structuredClone(stored), write: async row => { stored = structuredClone(row); },
  } };
  const session = createWorkflowSession(config);
  await session.prepare(shortlist, shortlist.sources);
  assert.deepEqual(session.state().quote.price, { total: 9, authorFee: 1 });
  assert.equal(stored, undefined);
  await session.confirm();
  time += 5_000;
  await session.refresh();
  const reduced = session.state();
  assert.equal(reduced.run.status, 'succeeded');
  assert.equal(reduced.snapshot.similarity.ranked.length, 4);
  assert.equal(reduced.snapshot.steps.find(step => step.name === 'neighbor_catalog_check').status, 'succeeded');
  await session.prepare(learnedAudit, learnedAudit.sources);
  assert.deepEqual(session.state().quote.price, { total: 11, authorFee: 1 });
  assert.equal(stored.workflowId, reduced.run.workflowId);
  await session.confirm();
  time += 5_000;
  const recovered = createWorkflowSession(config);
  await recovered.restore();
  await recovered.refresh();
  const { run, snapshot } = recovered.state();
  assert.equal(run.status, 'succeeded');
  assert.equal(snapshot.steps[0].sourceLink, anchor.link);
  assert.equal(snapshot.similarity.targetCount, 6);
  assert.equal(snapshot.similarity.ranked.length, 6);
  assert.equal(snapshot.similarity.previewBasis, 'posters');
  assert.equal(snapshot.similarity.ranked.at(-1).previewRank, 6);
  assert.ok(snapshot.similarity.ranked[0].score > snapshot.similarity.ranked.at(-1).score);
  assert.equal(snapshot.similarity.ranked.at(-1).link, origin + '/images/11');
  assert.equal(stored.body, undefined);
  assert.match(workflowReportMarkdown([{ run, snapshot }]), /Free preview rank 6/u);
  assert.match(workflowReportMarkdown([{ run, snapshot }]), /On-device subject rank 6/u);
  assert.match(workflowReportMarkdown([{ run, snapshot }]), /still previews for video clips/u);
  const invalidRanks = structuredClone(stored);
  invalidRanks.similarity.targets[0].previewRank = invalidRanks.similarity.targets[1].previewRank;
  assert.equal(workflowRecord(invalidRanks, origin).similarity.targets.some(row => row.previewRank), false);
  invalidRanks.similarity.targets[0].subjectRank = invalidRanks.similarity.targets[1].subjectRank;
  assert.equal(workflowRecord(invalidRanks, origin).similarity.targets.some(row => row.subjectRank), false);
});

test('visual trait estimates attach only whole Civitai references and preserve all match and avoid roles', async () => {
  const media = (id, extra) => ({ id, postId: 80 + id, title: 'Fixture #' + id, link: origin + '/images/' + id,
    preview: 'https://image.civitai.com/public/' + id + '.jpeg', ...extra });
  const cues = [{ role: 'palette', public: media(1) }, { role: 'composition', public: media(2) },
    { role: 'texture', polarity: 'avoid', public: media(3, { video: true }) }];
  const rows = [media(4, { visualSources: ['A verified Civitai catalog lead'] }), media(5, { preview: media(1).preview }),
    media(6, { preview: media(6).preview + '?private=canary' }),
    media(7), media(8)];
  const result = { gallery: { scope: 'gallery' }, visualComposition: { cues, order: rows.map(row => row.id) }, related: { gallery: rows } };
  const [quick, audit] = galleryCompositionResearch(result, origin).plans;
  assert.deepEqual(quick.body.steps.map(step => [step.$type, step.input.mediaUrl]),
    quick.inputs.map(input => ['mediaCaptioning', input.preview]));
  assert.deepEqual(audit.body.steps, [...quick.body.steps, audit.body.steps.at(-1)]);
  assert.equal(audit.body.steps.at(-1).name, 'visual_catalog_check');
  const purposes = ['Match color palette', 'Match layout', 'Avoid texture', 'Candidate', 'Candidate', 'Candidate'];
  assert.deepEqual(audit.inputs.map(row => row.purpose), purposes);
  assert.deepEqual(quick.inputs.map(row => row.link), [1, 2, 3, 4, 7, 8].map(id => media(id).link));
  const [subject, subjectAudit] = galleryCompositionResearch(result, origin, [8, 6, 7, 8, 4]).plans;
  assert.deepEqual(subject.inputs.map(row => row.link), [1, 2, 3, 8, 7, 4].map(id => media(id).link));
  assert.match(subject.work, /on-device subject order/u);
  assert.equal(subjectAudit.body.steps.at(-1).name, 'visual_catalog_check');
  assert.doesNotMatch(JSON.stringify(subjectAudit.body), /private=canary|subjectScore|subjectRank/u);
  assert.deepEqual(galleryCompositionResearch(result, origin, [8, 6]).plans[0].body, quick.body);
  assert.match(quick.body.steps[2].input.customInstructions, /only the visible texture/u);
  assert.doesNotMatch(quick.body.steps[2].input.customInstructions, /palette|layout/u);
  assert.match(quick.body.steps[3].input.customInstructions, /color palette, layout, texture/u);
  assert.doesNotMatch(JSON.stringify([quick, audit]), /canary/u);
  for (const reference of [{ ...cues[0], region: [.2, .2, .8, .8] }, { role: 'palette', label: 'local-file-canary.png' }]) {
    assert.equal(galleryCompositionResearch({ ...result, visualComposition: { ...result.visualComposition, cues: [reference, ...cues.slice(1)] } }, origin), null);
  }
  assert.equal(galleryCompositionResearch({ ...result, visualComposition: { ...result.visualComposition, unavailableReferences: 1 } }, origin), null);
  const noLeads = { ...result, related: { gallery: rows.map(({ visualSources, ...item }) => item) } };
  assert.deepEqual(galleryCompositionResearch(noLeads, origin).plans.map(plan => plan.id), ['composevisual']);
  const late = media(9, { visualSources: ['Model version #120 from reference #2'] });
  const matchedBrief = { ...noLeads, visualComposition: { ...result.visualComposition,
    order: [...result.visualComposition.order, late.id], referenceMatchesAdded: 1 },
    related: { gallery: [...noLeads.related.gallery, late] } };
  const matchedPlans = galleryCompositionResearch(matchedBrief, origin).plans;
  assert.deepEqual(matchedPlans.map(plan => plan.id), ['composevisual', 'composeaudit']);
  assert.equal(matchedPlans[0].inputs[3].link, late.link);
  assert.match(matchedPlans[1].body.steps.at(-1).input.messages.at(-1).content, /Model version #120 from reference #2/u);
  const fourth = { role: 'palette', public: media(10) };
  const maximum = galleryCompositionResearch({ ...result, visualComposition: { ...result.visualComposition,
    cues: [...cues, fourth] } }, origin);
  assert.deepEqual(maximum.plans.map(plan => plan.body.steps.length), [7, 8]);

  let time = 1000;
  let stored;
  const service = createWorkflowSimulation({ now: () => time });
  const client = createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
    const reply = service(request.method, url.pathname, JSON.parse(request.body));
    return Response.json(reply.body, { status: reply.status });
  });
  const config = { client, origin, now: () => time, journal: {
    read: async () => structuredClone(stored), write: async row => { stored = structuredClone(row); },
  } };
  const session = createWorkflowSession(config);
  await session.prepare(audit, audit.sources);
  assert.ok(session.state().quote.price.total > 0);
  await session.confirm();
  time += 5000;
  const recovered = createWorkflowSession(config);
  await recovered.restore();
  await recovered.refresh();
  const { run, snapshot } = recovered.state();
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.sources.map(row => row.link), audit.inputs.map(row => row.link));
  assert.deepEqual(snapshot.steps.slice(0, 6).map(step => [step.sourceLink, step.purpose]),
    audit.inputs.map(item => [item.link, item.purpose]));
  const synthesis = reportSynthesisPlan(run, snapshot);
  const [instructions, material] = synthesis.body.steps[0].input.messages;
  assert.match(instructions.content, /For an Avoid trait, look for a difference/u);
  assert.deepEqual(JSON.parse(material.content).previousResearch.slice(0, 6).map(step => step.purpose), purposes);
  assert.equal(reportSynthesisPlan(run, { ...snapshot, restricted: true }), null);
  assert.equal(stored.body, undefined);
});

test('public preview captions use the written search and the same public matches for both paths', () => {
  const search = 'textured ink without cartoon';
  for (const host of [origin, 'https://civitai.com']) {
    const media = (id, postId = id, extra = {}) => ({ id, postId, title: 'Public result ' + id, link: host + '/images/' + id,
      preview: 'https://image.civitai.com/public/' + id + '.jpeg', visualSources: ['private-version-canary'],
      visualMatch: { score: .098321 }, prompt: 'catalog-prompt-canary', ...extra });
    const reference = media(1);
    const rows = [media(30), reference, media(2, 2, { preview: reference.preview }),
      media(3, 3, { preview: media(3).preview + '?private=canary' }), media(4, 4, { link: 'https://example.test/images/4' }),
      media(5, 5, { preview: 'blob:local-picture-canary' }), media(6, 6, { link: host + '/user/vault' }),
      media(10, 70, { video: true, stream: 'https://image.civitai.com/public/private-stream-canary.mp4' }),
      media(11, 70), media(12, 74), media(13, 75), media(14, 76)];
    const result = { target: { kind: 'text', value: search }, gallery: { scope: 'videos', query: search },
      visualComposition: { cues: [{ label: 'local-file-canary.png', role: 'lighting', region: [.23, .17, .99, .58] },
        { label: 'public-crop-canary', role: 'texture', public: reference }], order: rows.slice(1).map(row => row.id) }, related: { videos: rows } };
    const review = galleryCandidateResearch(result, host);
    const [compare, rank] = review.plans;
    assert.equal(review.writtenSearch, search);
    assert.deepEqual(compare.inputs.map(row => row.link), [10, 12, 13].map(id => host + '/images/' + id));
    assert.deepEqual(compare.inputs.map(row => row.kind), ['Video poster', 'Picture', 'Picture']);
    assert.equal(rank.similarity.previewBasis, 'posters');
    assert.deepEqual(rank.inputs, compare.inputs);
    const captions = compare.body.steps;
    assert.deepEqual(captions.map(({ $type, input }) => [$type, input.mediaUrl]), compare.inputs.map(row => ['mediaCaptioning', row.preview]));
    assert.ok(captions.every(({ input }) => input.customInstructions.includes('visible conflicts') && input.customInstructions.includes(search)));
    assert.deepEqual(captions.map(({ name }) => compare.stepEvidence[name].sourceLink), compare.inputs.map(row => row.link));
    assert.equal(rank.body.steps.length, 7);
    assert.deepEqual(rank.body.steps.slice(0, 3), captions);
    assert.equal(rank.body.steps[3].input.text, 'textured ink');
    assert.deepEqual(rank.body.steps.slice(4).map(({ input }) => input.imageUrl), compare.inputs.map(row => row.preview));
    assert.doesNotMatch(JSON.stringify(review), /canary|0\.098321|0\.23/u);
    assert.deepEqual(galleryCompositionSubjectSample(result, host).map(({ id }) => id), [10, 12, 13, 14, 11]);
    const subjectReview = galleryCandidateResearch(result, host, [30, 6, 4, 14, 14, 11, 12, 1]);
    assert.deepEqual(subjectReview.plans.slice(0, 2), review.plans);
    const subject = subjectReview.plans.at(-1);
    assert.equal(subject.id, 'publicsubjectreview');
    assert.deepEqual(subject.inputs.map(row => row.link), [14, 11, 12].map(id => host + '/images/' + id));
    assert.deepEqual(subject.body.steps.map(({ $type, input }) => [$type, input.mediaUrl]),
      subject.inputs.map(row => ['mediaCaptioning', row.preview]));
    assert.doesNotMatch(JSON.stringify(subject), /canary|0\.098321|0\.23/u);
    assert.deepEqual(galleryCandidateResearch(result, host, [10, 12, 13]).plans, review.plans);

    const noWords = galleryCandidateResearch({ ...result, gallery: { ...result.gallery, query: '' } }, host);
    assert.deepEqual(noWords.plans.map(({ id }) => id), ['publicpreviewreview']);
    assert.ok(noWords.plans[0].body.steps.every(({ input }) => !input.customInstructions.includes('this search')));
    assert.equal(galleryCandidateResearch({ ...result, library: {} }, host), null);
    assert.equal(galleryCandidateResearch({ ...result, related: { videos: [rows.at(-1)] } }, host), null);
    assert.equal(galleryCandidateResearch({ ...result, visualComposition: { ...result.visualComposition, unavailableReferences: 1 } }, host), null);
  }
});

test('public preview comparison runs, resumes and exports the same sources in simulation', async () => {
  const ids = [11, 12, 13];
  const items = ids.map(id => ({ id, title: 'Result ' + id, link: origin + '/images/' + id,
    preview: 'https://image.civitai.com/public/' + id + '.jpeg' }));
  const [ , plan, subject] = galleryCandidateResearch({ target: { kind: 'text' }, gallery: { scope: 'gallery', query: 'linocut' },
    visualComposition: { cues: [{ role: 'texture', label: 'local-file-canary.png' }], order: ids }, related: { gallery: items } }, origin, [13, 11, 12]).plans;
  let time = 1000;
  let saved;
  const calls = [];
  const service = createWorkflowSimulation({ now: () => time });
  const client = createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
    const body = JSON.parse(request.body);
    assert.doesNotMatch(request.body, /canary/u);
    calls.push(url.pathname.split('/').at(-1));
    const reply = service(request.method, url.pathname, body);
    return Response.json(reply.body, { status: reply.status });
  });
  const config = { client, origin, now: () => time, journal: {
    read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); },
  } };
  const session = createWorkflowSession(config);
  await session.prepare(plan, plan.sources);
  assert.deepEqual(session.state().quote.price, { total: 8, authorFee: 1 });
  assert.deepEqual(calls, ['estimate']);
  assert.equal(saved, undefined);
  await session.confirm();
  time += 5000;
  const reopened = createWorkflowSession(config);
  await reopened.restore();
  await reopened.refresh();
  const { run, snapshot } = reopened.state();
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.sources.map(row => row.link), items.map(row => row.link));
  assert.equal(snapshot.similarity.ranked.length, 3);
  assert.match(workflowReportMarkdown([{ run, snapshot }], { simulated: true }), /Preview description 1/u);
  const synthesis = reportSynthesisPlan(run, snapshot);
  const [instructions, data] = synthesis.body.steps[0].input.messages;
  assert.match(instructions.content, /Compare the linked preview descriptions/u);
  assert.deepEqual(JSON.parse(data.content).previousResearch.filter(row => row.sourceLink).map(row => row.sourceLink), items.map(row => row.link));
  assert.equal(calls.filter(route => route === 'submit').length, 1);
  await reopened.prepare(subject, subject.sources);
  assert.deepEqual(reopened.state().quote.price, { total: 4, authorFee: 1 });
  await reopened.confirm();
  time += 5000;
  await reopened.refresh();
  const subjectResult = reopened.state();
  assert.equal(subjectResult.run.status, 'succeeded');
  assert.deepEqual(subjectResult.run.sources.map(row => row.link), [13, 11, 12].map(id => origin + '/images/' + id));
  assert.equal(subjectResult.snapshot.steps.filter(step => step.$type === 'mediaCaptioning' && step.status === 'succeeded').length, 3);
  const exported = workflowReportMarkdown([subjectResult], { simulated: true });
  assert.match(exported, /Preview description 3/u);
  assert.doesNotMatch(exported, /canary/u);
  const subjectSynthesis = reportSynthesisPlan(subjectResult.run, subjectResult.snapshot);
  await reopened.prepare(subjectSynthesis, subjectResult.run.sources, { continueRun: true });
  assert.deepEqual(reopened.state().quote.price, { total: 4, authorFee: 1 });
  assert.equal(calls.filter(route => route === 'submit').length, 2);
  await reopened.confirm();
  time += 3000;
  const final = createWorkflowSession(config);
  await final.restore();
  await final.refresh();
  await final.refreshPrevious();
  assert.equal(final.state().run.previous.workflowId, subjectResult.run.workflowId);
  assert.equal(final.state().run.status, 'succeeded');
  assert.deepEqual(final.state().previousSnapshot.steps.map(step => step.sourceLink), subjectResult.run.sources.map(row => row.link));
  assert.equal(calls.filter(route => route === 'submit').length, 3);
  assert.equal(saved.body, undefined);
});

test('public selections bind exact moment, evidence and comparison anchor while excluding local data', () => {
  const focus = visualResearch(report, origin, selection);
  assert.deepEqual(focus.sources, [clip, picture, model].map(({ link, title }) => ({ title, link })));
  assert.deepEqual(focus.plans.map(row => [row.id, row.body.steps.length]), [
    ['visualdescribe', 3], ['visualsimilarity', 3], ['visualscene', 5],
  ]);
  const [frame, caption, compare, transcript] = focus.plans.at(-1).body.steps;
  assert.equal(frame.input.startTime, .63);
  assert.equal(frame.suppressOutput, true);
  assert.deepEqual(caption.input.mediaUrl, { $ref: frame.name, path: 'output.frames[0].url' });
  assert.equal(transcript.input.mediaUrl, clip.stream);
  assert.equal(compare.$type, 'mediaCaptioning');
  assert.equal(compare.input.mediaUrl, picture.cover);
  assert.equal(focus.plans.at(-1).stepEvidence.visual_picture_1.sourceLink, picture.link);
  assert.deepEqual(focus.plans.at(-1).inputs.map(({ purpose }) => purpose), ['Frame near 0.63 s', 'Visual evidence', 'Full transcript']);
  assert.equal(focus.plans[1].body.steps[0].input.videoUrl, clip.stream);
  assert.equal(focus.plans[1].similarity.targets[0].link, picture.link);
  assert.doesNotMatch(JSON.stringify(focus), /local-.*canary/u);
  assert.notDeepEqual(visualResearch(report, origin, selection.toReversed()).plans[1].body, focus.plans[1].body);
});

test('only eligible same-host matches get quotes and three clips stay within the eight-step limit', () => {
  const other = { ...picture, link: 'https://civitai.com/images/9' };
  const privateLink = { ...picture, link: origin + '/user/vault' };
  const signed = { ...clip, link: origin + '/images/95', stream: clip.stream + '?credential=fixture', cover: null };
  const poster = visualResearch(report, origin, [{ link: clip.link, timestamp: 60 }]);
  assert.equal(poster.picks[0].kind, 'poster');
  assert.deepEqual(poster.plans.map(row => row.id), ['visualdescribe']);
  assert.equal(visualResearch({ ...report, evidence: [other, privateLink, signed] }, origin,
    [other, privateLink, signed].map(({ link }) => ({ link, timestamp: 1 }))), null);
  const clips = [12, 13, 14].map(id => ({ ...clip, link: origin + '/images/' + id, stream: 'https://image.civitai.com/public/' + id + '.mp4', music: true }));
  const maximum = visualResearch({ evidence: clips }, origin, clips.map(({ link }) => ({ link, timestamp: 1 })));
  assert.equal(maximum.plans.at(-1).body.steps.length, 8);
  const music = visualResearch({ evidence: [clips[0]] }, origin, [{ link: clips[0].link, timestamp: 1 }]);
  assert.ok(music.plans.at(-1).body.steps.some(row => row.$type === 'audioCaptioning'));
});

test('a selected image follows its verified source post to the exact model version', () => {
  const post = { title: 'Source post', link: origin + '/posts/22' };
  const other = { ...picture, link: origin + '/images/23' };
  const noVersion = { ...model, link: origin + '/models/24' };
  const result = visualResearch({ ...report, connections: [
    { kind: 'post-model', label: 'Post lists this version', items: [post, model] },
    { kind: 'post-media', label: 'Picture is in this post', items: [picture, post] },
    { kind: 'post-media', label: 'Another picture is in this post', items: [other, post] },
    { kind: 'post-model', label: 'Unpinned model', items: [post, noVersion] },
  ] }, origin, selection);
  assert.deepEqual(result.sources.map(item => item.link), [clip.link, picture.link, post.link, model.link]);
  const audit = result.plans.at(-1).body.steps.at(-1);
  assert.deepEqual(JSON.parse(audit.input.messages[1].content).recordedConnections.map(edge => edge.sources),
    [[picture.link, post.link], [post.link, model.link]]);
});

test('linked simulation preserves caption provenance after reload and a separately quoted synthesis', async () => {
  let time = 1000;
  let stored;
  const calls = [];
  const handle = createWorkflowSimulation({ now: () => time });
  const client = createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push(url.pathname.split('/').at(-1));
    const reply = handle(request.method, url.pathname, body);
    return Response.json(reply.body, { status: reply.status });
  });
  const journal = { read: async () => structuredClone(stored), write: async row => { stored = structuredClone(row); } };
  const config = { client, journal, origin, now: () => time };
  const session = createWorkflowSession(config);
  const focus = visualResearch(report, origin, selection);
  const plan = focus.plans.at(-1);
  await session.prepare(plan, plan.sources);
  assert.equal(session.state().quote.price.authorFee, 1);
  assert.equal(stored, undefined);
  await session.confirm();
  time += 4000;
  await session.refresh();
  const done = session.state();
  assert.deepEqual(done.snapshot.steps.map(row => row.status), Array(5).fill('succeeded'));
  assert.equal(done.snapshot.steps[1].sourceLink, clip.link);
  assert.equal(done.snapshot.steps[1].seconds, .63);
  assert.match(done.snapshot.steps[1].lines[0], /0.63 seconds/u);
  assert.match(done.snapshot.steps[3].lines[0], /0:00 · Simulated words from the selected clip/u);
  assert.equal(stored.body, undefined);
  const final = reportSynthesisPlan(done.run, done.snapshot);
  assert.match(final.body.steps[0].input.messages[1].content, /"seconds":0.63/u);
  await session.prepare(final, done.run.sources, { continueRun: true });
  assert.equal(calls.filter(route => route === 'submit').length, 1);
  await session.confirm();
  time += 2000;
  const recovered = createWorkflowSession(config);
  await recovered.restore();
  await recovered.refresh();
  await recovered.refreshPrevious();
  assert.equal(recovered.state().run.previous.workflowId, done.run.workflowId);
  assert.match(recovered.state().previousSnapshot.steps[1].lines[0], /0.63 seconds/u);
  assert.equal(calls.filter(route => route === 'submit').length, 2);
});

test('new selections discard unconfirmed quotes and a failed sampled frame leaves independent evidence', async () => {
  const focus = visualResearch(report, origin, selection);
  const plan = focus.plans.at(-1);
  let finishQuote;
  let requested;
  const estimating = new Promise(resolve => { requested = resolve; });
  const pending = createWorkflowSession({ origin, journal: {}, client: { estimate() {
    requested();
    return new Promise(resolve => { finishQuote = resolve; });
  } } });
  const preparing = pending.prepare(plan, plan.sources);
  await estimating;
  assert.equal(pending.discardQuote(), true);
  finishQuote({ status: 'pending', cost: { total: 4 } });
  await assert.rejects(preparing, { name: 'AbortError' });
  assert.equal(pending.state().quote, null);
  await assert.rejects(pending.confirm(), /current quote/u);

  let time = 0;
  const handle = createWorkflowSimulation({ now: () => time, failStep: 0 });
  const client = createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
    const reply = handle(request.method, url.pathname, JSON.parse(request.body));
    return Response.json(reply.body, { status: reply.status });
  });
  const partial = createWorkflowSession({ client, origin, journal: { write: async () => {} }, now: () => time });
  await partial.prepare(plan, plan.sources);
  await partial.confirm();
  time += 4000;
  await partial.refresh();
  const state = partial.state();
  assert.equal(state.run.status, 'failed');
  assert.deepEqual(state.snapshot.steps.map(row => row.status), ['failed', 'canceled', 'succeeded', 'succeeded', 'succeeded']);
  assert.ok(reportSynthesisPlan(state.run, state.snapshot));
});
