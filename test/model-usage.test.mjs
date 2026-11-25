import assert from 'node:assert/strict';
import test from 'node:test';

const root = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { CATALOG } = await import(root + 'catalog.mjs');
const { watchHost } = await import(root + 'civitai-host.js');
const { matchesModelUse, modelUsage, modelLicenseLink, siteUseCondition } = await import(root + 'model-usage.mjs');
const { discover, rankVersions, readModelPage, readRecordedVersions } = await import(root + 'search.mjs');
const { reportConstraint, discoverReport, reportMarkdown } = await import(root + 'report.mjs');
const { workspaceFilters } = await import(root + 'workspace.mjs');

const origin = 'https://civitai.red';
const context = { origin, hosted: true, browsingLevel: 3, token: 'fixture' };
const meets = { allowCommercialUse: ['Image', 'SellMerge'], allowNoCredit: true, allowDerivatives: true, allowDifferentLicense: true };
const wants = ['Image', 'SellMerge', 'OptionalCredit'];
const version = id => ({ id, name: 'v1', baseModel: 'SDXL 1.0', browsingLevel: 1, availability: 'Public', trainedWords: [], files: [], images: [] });
const model = (id, usage = meets, name = 'Portrait ' + id) => ({
  id, name, type: 'LORA', availability: 'Public', browsingLevel: 1, modelVersions: [version(id + 100)], ...usage,
});
const output = items => Response.json({ items });
const filterQuery = { scope: 'models', query: 'Portrait', creatorUsage: wants };

test('creator usage checks require explicit listing settings for every selection', () => {
  assert.equal(siteUseCondition(wants), 'SellMerge');
  const records = [model(1), model(2, { ...meets, allowNoCredit: false }), model(3, { ...meets, allowCommercialUse: ['Image'] }),
    model(4, { ...meets, allowCommercialUse: ['None', 'Image', 'SellMerge'] }), model(5, { allowCommercialUse: meets.allowCommercialUse }),
    model(6, { ...meets, allowDerivatives: false }), model(7, { ...meets, allowCommercialUse: '{Image, SellMerge}' })];
  const lists = [{ label: 'Civitai model search', models: records }];
  assert.deepEqual(rankVersions(lists, '', filterQuery).map(row => row.modelId), [1, 7]);
  assert.equal(matchesModelUse(modelUsage({ ...meets, allowDerivatives: false }), ['DifferentLicense']), false);
  assert.equal(matchesModelUse(modelUsage({ allowCommercialUse: ['None'] }), ['None']), true);
  assert.equal(matchesModelUse(modelUsage({}), ['None']), false);
  assert.equal(matchesModelUse(modelUsage({}), ['UnverifiedRule']), false);
  assert.match(reportConstraint(['creatorUsage', wants]), /Sell generated images and Sell merges and Credit is optional/u);
  assert.deepEqual(workspaceFilters(filterQuery).creatorUsage, wants);
});

test('uses the Site filter for additional candidates and verifies the exact App version and its flags', async () => {
  const app = [model(1, meets, 'Portrait'), model(2, { ...meets, allowNoCredit: false })];
  const site = [model(3), model(4), model(5, { ...meets, allowCommercialUse: ['SellMerge'] })];
  const calls = [];
  const fetcher = (url, request) => {
    assert.equal(url.origin, origin);
    assert.equal(request.credentials, 'omit');
    if (url.pathname === CATALOG.tags) return output([]);
    if (url.pathname === CATALOG.models) {
      assert.deepEqual(url.searchParams.getAll('allowCommercialUse'), ['SellMerge']);
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(url.searchParams.has('allowNoCredit'), false);
      calls.push('site');
      return output(site);
    }
    assert.equal(url.pathname, CATALOG.blockModels);
    assert.equal(request.headers.Authorization, 'Bearer fixture');
    assert.equal(url.searchParams.has('allowCommercialUse'), false);
    assert.equal(url.searchParams.has('allowNoCredit'), false);
    const exact = url.searchParams.get('modelVersionIds');
    if (!exact) {
      calls.push('app');
      return output(app);
    }
    calls.push(exact);
    assert.equal(exact, '103,104');
    return output([model(3), model(4, { ...meets, allowNoCredit: false })]);
  };
  const result = await discover(context, filterQuery, { fetcher, catalogOnly: true });
  assert.deepEqual(result.candidates.map(row => row.id), [101, 103]);
  assert.equal(result.candidates[0].model, 'Portrait');
  assert.deepEqual(result.candidates[1].usageMatches, ['Sell generated images', 'Sell merges', 'Credit is optional']);
  assert.deepEqual(new Set(calls), new Set(['app', 'site', '103,104']));
  assert.equal(result.nativeModelUsage, true);
  assert.equal(new URL(result.nativeLink).searchParams.has('allowCommercialUse'), false);
});

test('a sorted continuation preserves creator checks, version identity and the Site cursor', async () => {
  const cursors = [];
  const fetcher = (url, request) => {
    if (url.pathname === CATALOG.models) {
      assert.equal(url.searchParams.get('sort'), 'Newest');
      assert.equal(url.searchParams.get('allowCommercialUse'), 'SellMerge');
      assert.equal(request.headers.Authorization, undefined);
      const cursor = url.searchParams.get('cursor');
      cursors.push(cursor);
      return Response.json(cursor ? { items: [model(2), model(3, { ...meets, allowNoCredit: null })] }
        : { items: [model(1)], metadata: { nextCursor: 'mixed-policy|2' } });
    }
    if (url.pathname === CATALOG.blockImages) return output([]);
    assert.equal(url.pathname, CATALOG.blockModels);
    const id = Number(url.searchParams.get('modelVersionIds'));
    assert.ok(id === 101 || id === 102);
    return output([model(id - 100)]);
  };
  const result = await discover(context, { scope: 'models', sort: 'Newest', creatorUsage: wants }, { fetcher });
  assert.deepEqual(result.candidates.map(row => row.id), [101]);
  const second = await readModelPage(context, result.modelPager.nextCursor, { fetcher });
  assert.deepEqual(second.items.map(row => row.id), [102]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(cursors, [null, 'mixed-policy|2']);
});

test('exact Site version lookup binds a qualifying creator setting to the verified parent', async () => {
  const requests = [];
  const fetcher = url => {
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/model-versions/101') return Response.json({ ...version(101), modelId: 1, model: { name: 'Portrait', type: 'LORA' } });
    assert.equal(url.pathname, '/api/v1/models/1');
    return Response.json(model(1));
  };
  const result = await discover({ origin }, { ...filterQuery, query: 'version: 101' }, { fetcher, catalogOnly: true });
  assert.deepEqual(result.candidates.map(row => row.id), [101]);
  assert.deepEqual(requests, ['/api/v1/model-versions/101', '/api/v1/models/1']);
  const mismatched = await discover({ origin }, { ...filterQuery, query: 'version: 101' }, {
    catalogOnly: true, fetcher: url => url.pathname.startsWith('/api/v1/model-versions/')
      ? Response.json({ ...version(101), modelId: 1 }) : Response.json(model(2)),
  });
  assert.deepEqual(mismatched.candidates, []);
});

test('recorded versions keep creator requirements when used as evidence', async () => {
  const evidence = await readRecordedVersions(context, { records: [
    { modelId: 1, versionId: 101, fields: [] }, { modelId: 2, versionId: 102, fields: [] },
  ] }, { creatorUsage: wants }, { fetcher(url) {
    assert.equal(url.pathname, CATALOG.blockModels);
    return output([model(1), model(2, { ...meets, allowNoCredit: false })]);
  } });
  assert.deepEqual(evidence.verified.map(row => row.versionId), [101]);
  assert.equal(evidence.filtered, 1);
});

test('a free report carries the selected creator settings and exact model link', async () => {
  const report = await discoverReport(context, { ...filterQuery, scope: 'report', reportSources: ['models', 'articles'] }, {
    followLinks: false,
    fetcher(url) {
      if (url.pathname === '/api/search/multi-search') return Response.json({ results: [{ hits: [] }, { hits: [], facetDistribution: {} }] });
      if (url.pathname === CATALOG.blockModels) return output([model(1), model(2, { ...meets, allowNoCredit: false })]);
      if (url.pathname === CATALOG.models) return output([model(1), model(2)]);
      return output([]);
    },
  });
  assert.deepEqual(report.candidates.map(row => row.id), [101]);
  assert.deepEqual(report.report.constraints.find(([key]) => key === 'creatorUsage')?.[1], wants);
  const markdown = reportMarkdown(report.report);
  assert.match(markdown, /Creator usage settings/u);
  assert.ok(markdown.includes(origin + '/models/1?modelVersionId=101'));
  assert.ok(!markdown.includes(origin + '/models/2?modelVersionId=102'));
});

test('the host opens only a same-domain version license path', () => {
  const messages = [];
  let receive;
  let current;
  const parent = { postMessage: data => messages.push(data) };
  watchHost({ parent, document: { body: { scrollHeight: 700 }, documentElement: { dataset: {} } },
    addEventListener(_name, handle) { receive = handle; } }, context => { current = context; });
  receive({ origin, source: parent, data: { type: 'BLOCK_INIT', payload: {
    blockId: 'rasterraid', blockInstanceId: 'test', context: { slotId: 'app.page' }, renderMode: 'iframe',
  } } });
  const link = modelLicenseLink(origin, 101, 'SDXL 1.0');
  assert.equal(modelLicenseLink(origin, 101, 'Flux.1 D'), null);
  current.open(link);
  current.open(link + '?edit=true');
  current.open(link.replace('civitai.red', 'civitai.com'));
  assert.deepEqual(messages.filter(row => row.type === 'NAVIGATE').map(row => row.payload.path), ['/models/license/101']);
});
