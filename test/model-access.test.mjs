import assert from 'node:assert/strict';
import test from 'node:test';

const root = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { CATALOG } = await import(root + 'catalog.mjs');
const { discover, galleryModelSources, rankVersions, readModelPage, readRecordedVersions } = await import(root + 'search.mjs');
const { matchesModelDownload, modelVersionDownload } = await import(root + 'model-access.mjs');
const { workspaceFilters } = await import(root + 'workspace.mjs');

const origin = 'https://civitai.red';
const context = { origin, hosted: true, token: 'fixture', browsingLevel: 3 };
const permanent = { permanent: true, endsAt: null };
const timed = { permanent: false, endsAt: new Date(Date.now() + 60 * 60_000).toISOString() };
const version = (id, paidAccess) => ({ id, name: 'Release ' + id, baseModel: 'SDXL 1.0', availability: 'Public',
  trainedWords: [], images: [], files: [], ...(paidAccess !== undefined && { paidAccess }) });
const model = (id, name, ...modelVersions) => ({ id, name, type: 'LORA', availability: 'Public', modelVersions });
const mixed = model(1, 'Mixed print model', version(101, permanent), version(102, timed), version(103, null));
const other = model(2, 'Second print model', version(201, null), version(202, permanent));

test('download access selects the qualifying version of a mixed listing and preserves an unknown gate', () => {
  const models = [mixed, model(3, 'Unknown old response', version(301))];
  const lists = [{ label: 'Civitai model search', models }];
  for (const [downloadAccess, id] of [['free', 103], ['paid', 101], ['early', 102]]) {
    assert.deepEqual(rankVersions(lists, '', { downloadAccess }).map(candidate => candidate.id), [id]);
  }
  assert.deepEqual(rankVersions(lists, '', { downloadAccess: 'sale' }), []);
  assert.equal(matchesModelDownload(modelVersionDownload(version(102, timed)), 'early', Date.parse(timed.endsAt)), false);
  assert.deepEqual(modelVersionDownload(version(301)), {});
  assert.equal(workspaceFilters({ scope: 'models', downloadAccess: 'early' }).downloadAccess, 'early');
  assert.equal(workspaceFilters({ scope: 'models', downloadAccess: 'checkout' }).downloadAccess, undefined);
});

test('all pages preserve the native filter and recheck the selected version through the App catalog', async () => {
  const nativeCursor = '2026-11-23 18:29:13.915|3059513';
  const requests = [];
  const fetcher = async (url, options) => {
    const params = Object.fromEntries(url.searchParams);
    assert.equal(url.origin, origin);
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.credentials, 'omit');
    requests.push([url.pathname, params]);
    if (url.pathname === CATALOG.models) {
      assert.equal(params.hidePaid, 'true');
      assert.equal(options.headers.Authorization, undefined);
      return Response.json(params.cursor ? { items: [other] }
        : { items: [mixed], metadata: { nextCursor: nativeCursor } });
    }
    if (url.pathname === CATALOG.blockModels) {
      assert.equal(options.headers.Authorization, 'Bearer fixture');
      const result = params.modelVersionIds === '103' ? mixed : params.modelVersionIds === '201' ? other : null;
      assert.ok(result, 'Only the matching version may be rechecked');
      return Response.json({ items: [result] });
    }
    assert.equal(url.pathname, CATALOG.blockImages);
    return Response.json({ items: [] });
  };
  const first = await discover(context, { scope: 'models', sort: 'Newest', downloadAccess: 'free' }, { fetcher });
  assert.deepEqual(first.candidates.map(row => [row.id, row.downloadAccess]), [[103, 'free']]);
  const next = await readModelPage(context, first.modelPager.nextCursor, { fetcher });
  assert.deepEqual(next.items.map(row => [row.id, row.downloadAccess]), [[201, 'free']]);
  assert.equal(next.nextCursor, null);
  assert.equal(requests.filter(([path]) => path === CATALOG.models).at(-1)[1].cursor, nativeCursor);
});

test('named and recorded reports use the same exact download access evidence', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url.origin, origin);
    if (url.pathname === CATALOG.models) {
      assert.equal(url.searchParams.get('earlyAccess'), 'true');
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({ items: [mixed] });
    }
    assert.equal(url.pathname, CATALOG.blockModels);
    return Response.json({ items: [mixed] });
  };
  const release = await galleryModelSources(context, mixed.name, { downloadAccess: 'early' }, { fetcher });
  assert.deepEqual(release.releases.map(row => row.versionId), [102]);
  const plan = { records: [{ versionId: 101, modelId: 1, fields: [] }, { versionId: 103, modelId: 1, fields: [] }] };
  const evidence = await readRecordedVersions(context, plan, { downloadAccess: 'free' }, { fetcher });
  assert.deepEqual(evidence.verified.map(row => row.versionId), [103]);
  assert.equal(evidence.filtered, 1);
});

test('a sale needs the Site listing and a verified permanent paid version', async () => {
  for (const [status, listed] of [[200, true], [200, false], [503, false]]) {
    let saleChecks = 0;
    const result = await discover(context, { scope: 'models', query: origin + '/models/1?modelVersionId=101', downloadAccess: 'sale' }, {
      catalogOnly: true,
      fetcher: async (url, options) => {
        if (url.pathname === CATALOG.blockModels) return Response.json({ items: [mixed] });
        assert.equal(url.pathname, CATALOG.models);
        assert.equal(url.searchParams.get('ids'), '1');
        assert.equal(url.searchParams.get('onSale'), 'true');
        assert.equal(options.headers.Authorization, undefined);
        saleChecks++;
        return Response.json({ items: listed ? [mixed] : [] }, { status });
      },
    });
    assert.equal(saleChecks, 1);
    assert.deepEqual(result.candidates.map(row => [row.id, row.downloadAccess, row.listingOnSale]), listed ? [[101, 'paid', true]] : []);
  }
});
