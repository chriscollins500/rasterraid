import assert from 'node:assert/strict';
import test from 'node:test';
import { appToolFacts, capabilitySchema, capabilityVersion, captureCapabilities,
  orchestrationSpecFacts, siteReferenceFacts } from '../scripts/catalog-capabilities.mjs';
import { capabilityAgreement, compareCapabilities } from '../scripts/compare-catalog-capabilities.mjs';
import { HOST_PROBES } from '../src/probe.mjs';
import { PUBLIC_FILTER_FEED } from '../src/runtime-config.mjs';

const com = 'https://civitai.com';
const red = 'https://civitai.red';
const siteReference = '| Resource | Endpoints |\n| --- | --- |\n| Images | `GET /images` |\n| Models | `GET /models/{id}`, `POST /model-versions/by-hash/ids` |';
const scopesReference = '| Scope | What it authorizes | Binding |\n| --- | --- | --- |\n| `models:read:self` | Catalog scope | Active |\n| `apps:storage:shared:read` | Old scope | Deprecated, off |';
const manifest = { $id: com + '/schemas/app-block/v1.json', properties: { contentRating: { type: 'string', enum: ['g', 'r'] } } };
const tools = { tools: [{ function: { name: 'search_models', parameters: {
  required: ['query'], properties: { query: { type: 'string' }, types: { type: 'array', items: { enum: ['LORA', 'Checkpoint'] } } },
} } }] };
const spec = { openapi: '3.1.1', paths: { '/v2/services': { get: {}, summary: 'Documentation' }, '/v2/consumer/example': { post: {} } } };
const enumPayload = { ModelType: ['Checkpoint', 'LORA'], BaseModel: ['SD1', 'SDXL'], ActiveBaseModel: ['SDXL'] };
const facts = { ...enumPayload, effectiveBaseModels: ['SD1', 'SDXL'] };
const relayFacts = { modelTypes: enumPayload.ModelType, baseModels: ['SD1', 'SDXL'], activeBaseModels: ['SDXL'] };
const credential = { ceiling: 3, viewerBrowsingLevel: 3, scopes: ['collections:read:self'] };
const snapshot = (sources, appCredentials = { [com]: credential, [red]: credential }) => ({
  schema: capabilitySchema, schemaVersion: capabilityVersion, capturedAt: '2026-11-23T18:30:00.000Z', sources, appCredentials,
});
const row = (id, inputs = {}) => ({ id, url: com + '/api/v1/enums', kind: 'live', state: 'ready', http: 200, ...inputs });

test('the audit extracts only declared endpoints and tool schema facts', () => {
  assert.deepEqual(siteReferenceFacts(siteReference).operations, [
    'GET /api/v1/images', 'GET /api/v1/models/{id}', 'POST /api/v1/model-versions/by-hash/ids',
  ]);
  assert.equal(siteReferenceFacts(siteReference + '\n| A truncated row | unavailable |'), null);
  assert.deepEqual(orchestrationSpecFacts(spec).operations, ['GET /v2/services', 'POST /v2/consumer/example']);
  assert.equal(orchestrationSpecFacts({ ...spec, paths: { '/v2/services': { get: 123 } } }), null);
  assert.deepEqual(appToolFacts(tools)['search_models/types/items/enum'], ['Checkpoint', 'LORA']);
  assert.deepEqual(appToolFacts(tools)['search_models/required'], ['query']);
  assert.equal(appToolFacts({ tools: [{ function: { name: 'search_models', parameters: { required: ['missing'] } } }] }), null);
});

test('complete observations report precise route and enum changes and ignore reordered values', () => {
  const definitions = row('site.reference', { kind: 'reference', facts: { operations: ['GET /api/v1/models', 'GET /api/v1/images'] } });
  const enums = row('com.site-enums', { facts });
  const before = snapshot([definitions, enums]);
  const after = snapshot([
    { ...enums, facts: { ...facts, BaseModel: ['SDXL', 'SD1'], ModelType: ['LoCon', 'Checkpoint'] } },
    { ...definitions, facts: { operations: ['GET /api/v1/models', 'GET /api/v1/asset-index'] } },
  ]);
  const changed = compareCapabilities(before, after);
  assert.deepEqual(changed.factsChanged, [{ id: 'com.site-enums', differences: [{ field: 'ModelType', added: ['LoCon'], removed: ['LORA'] }] },
    { id: 'site.reference', differences: [{ field: 'operations', added: ['GET /api/v1/asset-index'], removed: ['GET /api/v1/images'] }] }]);
  assert.ok(changed.requiresReview);
  assert.deepEqual(changed.accessChanged, []);
  assert.equal(compareCapabilities(before, snapshot([enums, definitions])).requiresReview, false);
  assert.throws(() => compareCapabilities(before, snapshot([enums, enums])), /Invalid capability source/u);
});

test('partial and stale responses and different author contexts do not become removals', () => {
  const relay = row('com.filter-feed', { facts: relayFacts, cors: 'permitted' });
  const service = row('orchestration.services', { facts: { services: ['image/example', 'audio/example'] } });
  const source = row('com.site-enums', { facts });
  const declaration = row('com.app-tools', { origin: com, credential: 'app', facts: appToolFacts(tools) });
  const refused = row('com.probe.collections', { credential: 'app', origin: com, state: 'denied', http: 403 });
  const before = snapshot([relay, service, source, declaration, refused]);
  const after = snapshot([
    { ...relay, state: 'stale', facts: { ...relayFacts, modelTypes: ['Checkpoint'] } },
    { ...service, state: 'partial', facts: { services: ['image/example'] } }, source,
    { ...declaration, facts: { tools: [] } }, refused,
  ], { [com]: { ceiling: 1, viewerBrowsingLevel: 1 } });
  const report = compareCapabilities(before, after);
  assert.deepEqual(report.factsChanged, []);
  assert.ok(report.unverified.some(entry => entry.id === 'com.app-tools' && entry.reason));
  assert.equal(report.agreement.find(entry => entry.id === 'com.site-to-filter-feed').state, 'indeterminate');
  assert.ok(report.requiresReview);
  assert.equal(compareCapabilities(before, before).requiresReview, false);
  assert.ok(compareCapabilities(after, after).requiresReview, 'Sustained partial evidence needs review');
  const missingContext = snapshot([declaration], { [com]: { ceiling: 3, viewerBrowsingLevel: 3 } });
  assert.ok(compareCapabilities(missingContext, missingContext).requiresReview, 'Author reads need recorded scope evidence');
});

test('the relay can fall behind the current Site enum list and an opaque origin needs an allow header', () => {
  const site = row('com.site-enums', { facts });
  const relay = row('com.filter-feed', { facts: { ...relayFacts, modelTypes: ['Checkpoint'] }, cors: 'permitted' });
  const observed = capabilityAgreement(snapshot([site, relay])).find(item => item.id === 'com.site-to-filter-feed');
  assert.deepEqual(observed.differences, [{ field: 'modelTypes', added: [], removed: ['LORA'] }]);
  const blocked = capabilityAgreement(snapshot([site, { ...relay, facts: relayFacts, cors: 'absent' }]));
  assert.equal(blocked.find(item => item.id === observed.id).state, 'different');
});

test('the capture sends only catalog reads and keeps the author token out of the snapshot', async () => {
  const requests = [];
  const token = 'fixture.redacted.author';
  const audit = await captureCapabilities({ cli: 'fixture-cli',
    mint: async () => ({ token, credential }),
    probe: async (_origin, { onResult }) => {
      for (const probe of HOST_PROBES) onResult({ name: probe.name, status: 200, cors: '*', count: 1, metadataPresent: false });
    },
    fetcher: async (url, options) => {
      const headers = new Headers(options.headers);
      assert.equal(options.credentials, 'omit');
      const method = options.method ?? 'GET';
      requests.push([url.pathname, method]);
      if (url.pathname === '/api/v1/blocks/tools') assert.equal(headers.get('authorization'), 'Bearer ' + token);
      else assert.equal(headers.get('authorization'), null);
      if (url.pathname === '/api/search/multi-search') {
        assert.equal(method, 'POST');
        assert.equal(headers.get('origin'), 'null');
        assert.equal(JSON.parse(options.body).queries[0].q, 'linocut');
        return Response.json({ results: [{ hits: [] }] }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      }
      assert.equal(method, 'GET');
      if (url.href.startsWith(PUBLIC_FILTER_FEED)) return Response.json({ ...relayFacts,
        source: (url.searchParams.get('domain') === 'com' ? com : red) + '/api/v1/enums', checkedAt: Date.now(), stale: false,
      }, { headers: { 'Access-Control-Allow-Origin': '*' } });
      if (url.pathname === '/api/v1/enums') return Response.json(enumPayload);
      if (url.pathname === '/api/v1/blocks/tools') return Response.json(tools);
      if (url.pathname === '/schemas/app-block/v1.json') return Response.json(manifest);
      if (url.pathname.endsWith('/site/reference/index.md')) return new Response(siteReference);
      if (url.pathname.endsWith('/apps/reference/scopes.md')) return new Response(scopesReference);
      if (url.pathname.endsWith('/model.schema.ts')) return new Response('export const getAllModelsSchema = z.object({\n  query: z.string(),\n});');
      if (url.pathname === '/openapi/v2-consumers.json') return Response.json(spec);
      assert.equal(url.pathname, '/v2/services');
      return Response.json({ totalCount: 1, offset: 0, items: [{ id: 'image/example', category: 'image', modalities: { input: ['text'], output: ['image'] } }] });
    },
  });
  assert.ok(audit.sources.every(source => source.state === 'ready'));
  assert.equal(requests.filter(([, method]) => method === 'POST').length, 2);
  assert.ok(requests.every(([path]) => !/workflows|estimate|storage/u.test(path)));
  assert.ok(!JSON.stringify(audit).includes(token));
  assert.equal(audit.buzzSpent, 0);
  assert.ok(capabilityAgreement(audit).every(row => row.state === 'match'));
});
