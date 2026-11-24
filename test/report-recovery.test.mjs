import assert from 'node:assert/strict';
import test from 'node:test';
import { createReportRecovery, reportSourceFailure } from '../src/report-recovery.mjs';
import { discoverReport } from '../src/report.mjs';

const origin = 'https://civitai.red';
const viewer = { origin, hosted: true, signedIn: true, token: 'read-only-fixture', browsingLevel: 3, viewerUserId: 10, scopes: [] };
const filters = { scope: 'report', reportType: 'style', reportSources: ['collections', 'articles', 'tools'], query: 'Linocut' };
const links = { collections: '/collections/5', articles: '/articles/9' };
const row = scope => ({ scope, candidates: [], flows: [], related: links[scope]
  ? { [scope]: [{ id: Number(links[scope].split('/').at(-1)), title: scope, link: origin + links[scope] }] } : {} });

test('continuing a partial report rereads only the failed search and keeps original filters', async () => {
  const plan = createReportRecovery(viewer, filters);
  const calls = [];
  const options = {
    async discoverSource(_viewer, input) {
      calls.push([input.scope, input.query]);
      if (input.scope === 'articles' && calls.filter(([scope]) => scope === 'articles').length === 1) {
        throw Object.assign(new Error('Unavailable'), { status: 503 });
      }
      return row(input.scope);
    },
  };
  const initial = plan.begin(options);
  const partial = await discoverReport(viewer, plan.filters, { ...initial, followLinks: false });
  assert.equal(initial.retryable, true);
  assert.equal(partial.report.rails[1].status, 'unavailable');
  assert.equal(partial.report.rails[1].retryable, true);
  assert.deepEqual(partial.report.evidence.map(item => item.link), [origin + links.collections]);
  const continued = plan.begin(options);
  const complete = await discoverReport(viewer, plan.filters, { ...continued, followLinks: false });
  assert.equal(continued.reused, 2);
  assert.deepEqual(calls, [['collections', 'Linocut'], ['articles', 'Linocut'], ['tools', 'Linocut'], ['articles', 'Linocut']]);
  assert.deepEqual(complete.report.rails.map(rail => rail.status), ['ready', 'ready', 'empty']);
  assert.deepEqual(complete.report.evidence.map(item => item.link), [origin + links.collections, origin + links.articles]);
});

test('a stop inside the first batch retains settled evidence and rejects late responses', async () => {
  const controller = new AbortController();
  const checkpointReady = Promise.withResolvers();
  const hanging = Promise.withResolvers();
  const plan = createReportRecovery(viewer, filters);
  const calls = [];
  const options = { async discoverSource(_viewer, { scope }, { signal }) {
    calls.push(scope);
    if (signal === controller.signal && scope === 'tools') return hanging.promise;
    if (signal === controller.signal && scope === 'articles') return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return row(scope);
  } };
  let saved;
  const first = discoverReport(viewer, plan.filters, { ...plan.begin(options), signal: controller.signal, followLinks: false,
    onCheckpoint(snapshot) { saved = snapshot; checkpointReady.resolve(); },
  });
  await checkpointReady.promise;
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  hanging.resolve(row('tools'));
  assert.deepEqual(saved().report.rails.map(rail => rail.status), ['ready', 'waiting', 'waiting']);
  const continued = plan.begin(options);
  const complete = await discoverReport(viewer, plan.filters, { ...continued, followLinks: false });
  assert.deepEqual(calls, ['collections', 'articles', 'tools', 'articles', 'tools']);
  assert.equal(continued.reused, 1);
  assert.equal(complete.report.evidence.length, 2);
});

test('recovery checks viewer access, freshness, request settings, and result ownership before reusing work', async () => {
  let now = 20_000;
  let reads = 0;
  const plan = createReportRecovery(viewer, filters, undefined, { now: () => now });
  const options = { async discoverSource(_viewer, { scope }) { reads++; return row(scope); } };
  const read = plan.begin(options);
  const request = { scope: 'collections', query: filters.query };
  const original = await read.discoverSource(viewer, request, {});
  original.related.collections[0].title = 'Changed while assembling a report';
  const resumed = plan.begin(options);
  assert.equal((await resumed.discoverSource({ ...viewer, token: 'rotated' }, request, {})).related.collections[0].title, 'collections');
  assert.equal(resumed.reused, 1);
  await resumed.discoverSource(viewer, request, { catalogOnly: true });
  for (const changed of [{ origin: 'https://civitai.com' }, { browsingLevel: 1 }, { viewerUserId: 11 },
    { connectionLost: true }, { token: undefined }, { scopes: ['collections:read:private'] }]) {
    assert.equal(plan.matches({ ...viewer, ...changed }), false);
  }
  now += 120_000;
  assert.equal((await plan.begin(options).discoverSource(viewer, request, {})).related.collections[0].title, 'collections');
  assert.equal(reads, 3);
  plan.discard();
  assert.equal(plan.matches(viewer), false);
  assert.equal(createReportRecovery(viewer, { ...filters, reportType: 'portfolio' }), null);
  assert.equal(createReportRecovery(viewer, { ...filters, reportSources: ['models', 'saved'] }), null);
  assert.equal(reportSourceFailure({ library: { includesPrivate: true } }), 'unavailable');
});

test('exact public version reads are reusable and access refusals stay distinct from transient failures', async () => {
  const plan = createReportRecovery(viewer, filters);
  let reads = 0;
  const options = { async recordedSource() { reads++; return row('models'); } };
  const ids = { records: [{ versionId: 8 }] };
  await plan.begin(options).recordedSource(viewer, ids, {}, { withExamples: true });
  const continued = plan.begin(options);
  await continued.recordedSource(viewer, ids, {}, { withExamples: true });
  await continued.recordedSource(viewer, ids, {}, { withExamples: false });
  assert.equal(continued.reused, 1);
  assert.equal(reads, 2);
  assert.equal(reportSourceFailure({ gallery: { status: 'gallery-unavailable' } }), 'retryable');
  assert.equal(reportSourceFailure({ flows: [{ status: 429 }] }), 'retryable');
  assert.equal(reportSourceFailure({ flows: [{ status: 403 }] }), 'unavailable');
  assert.equal(reportSourceFailure({ ownerStatus: 'ready', flows: [] }), null);
  assert.equal(reportSourceFailure(row('tools')), null);
});
