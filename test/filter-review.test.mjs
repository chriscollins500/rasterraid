import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { canReviewGalleryFilters, canReviewModelFilters, reviewGalleryFilters, reviewModelFilters } = await import(root + 'filter-review.js');
const origin = 'https://civitai.red';
const context = { origin, hosted: true, token: 'read-only-fixture', browsingLevel: 3, signedIn: true, viewerUserId: 42 };
const title = 'Studio Watercolor';
const makeSearch = (filters, candidates = []) => ({
  context, phase: 'complete', filters: { scope: 'models', query: title, ...filters },
  result: { target: { kind: 'text', value: title }, candidates },
});
const release = (id, {
  base = 'SDXL 1.0', type = 'LORA', format = 'SafeTensor', generation = true, author = 'Creator', name = title,
  download = null, availability = 'Public', tags = ['watercolor'],
} = {}) => ({
  id, name, type, browsingLevel: 1, availability, tags, creator: { username: author },
  modelVersions: [{ id: 100 + id, name: 'v1', baseModel: base, browsingLevel: 1, availability,
    paidAccess: download, supportsGeneration: generation, files: format === null ? [] : [
      { id: 300 + id, name: 'model.safetensors', metadata: { format } },
    ] }],
});
const json = data => Response.json({ items: data });

test('filter checks propose exact one-field changes and keep the original model choices', async () => {
  const search = makeSearch({ baseModel: ['SDXL 1.0', 'Pony'], resourceType: 'LORA', fileFormat: 'SafeTensor',
    supportsGeneration: 'true', exclude: 'Furniture' }, [{ modelId: 9 }]);
  const observed = [];
  const results = [release(1, { base: 'SD 1.5' }), release(2, { type: 'Checkpoint' }),
    release(3, { format: 'Diffusers' }), release(4, { generation: false }),
    release(5, { generation: null }), release(6, { format: null }),
    release(7, { name: 'Furniture Studio Watercolor', base: 'SD 1.5' }),
    release(8, { name: 'Sunset', base: 'SD 1.5' }), release(9, { base: 'SD 1.5' }),
    release(10, { base: 'SD 1.5', type: 'Checkpoint' }), release(11, { base: 'SD 1.5', availability: 'Private' })];
  const { options, tested, incomplete } = await reviewModelFilters(search, { async fetcher(url, request) {
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/api/v1/blocks/models');
    assert.equal(request.headers.Authorization, 'Bearer read-only-fixture');
    assert.equal(request.credentials, 'omit');
    assert.equal(url.searchParams.get('query'), title);
    assert.equal(url.searchParams.get('limit'), '12');
    observed.push([url.searchParams.getAll('baseModels'), url.searchParams.get('types'), url.searchParams.get('supportsGeneration')]);
    return json(results);
  } });
  assert.deepEqual(observed, [
    [[], 'LORA', 'true'], [['SDXL 1.0', 'Pony'], null, 'true'],
    [['SDXL 1.0', 'Pony'], 'LORA', 'true'], [['SDXL 1.0', 'Pony'], 'LORA', null],
  ]);
  assert.deepEqual(options.map(row => [row.field, row.count, row.example.id, row.filters[row.field]]), [
    ['baseModel', 1, 101, ['SDXL 1.0', 'Pony', 'SD 1.5']],
    ['resourceType', 1, 102, ['LORA', 'Checkpoint']],
    ['fileFormat', 1, 103, ''], ['supportsGeneration', 1, 104, ''],
  ]);
  assert.ok(options.every(row => row.example.link === origin + '/models/' + row.example.modelId + '?modelVersionId=' + row.example.id));
  for (const option of options) {
    assert.deepEqual(Object.entries(option.filters).filter(([field, value]) => search.filters[field] !== value).map(([field]) => field), [option.field]);
  }
  assert.deepEqual(search.filters.baseModel, ['SDXL 1.0', 'Pony']);
  assert.equal(tested, 4);
  assert.equal(incomplete, false);
});

test('filter checks keep source filters and recheck Site leads through the hosted catalog', async () => {
  const search = makeSearch({ scope: 'all', baseModel: 'SD 1.5', resourceType: 'Checkpoint', modelAuthor: 'Creator', category: 'watercolor',
    checkpointType: 'Inpainting', sort: 'Newest', fromPlatform: 'true' });
  const requests = [];
  const { options } = await reviewModelFilters(search, { async fetcher(url, request) {
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/models') {
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(url.searchParams.get('types'), 'Checkpoint');
      assert.equal(url.searchParams.get('tag'), 'watercolor');
      assert.equal(url.searchParams.get('username'), 'Creator');
      assert.equal(url.searchParams.get('checkpointType'), 'Inpainting');
      assert.equal(url.searchParams.get('sort'), 'Newest');
      assert.equal(url.searchParams.get('fromPlatform'), 'true');
      return json([release(1, { type: 'Checkpoint' }), release(2, { type: 'Checkpoint' })]);
    }
    assert.equal(url.pathname, '/api/v1/blocks/models');
    assert.equal(request.headers.Authorization, 'Bearer read-only-fixture');
    assert.equal(url.searchParams.get('modelVersionIds'), '101,102');
    return json([release(2, { type: 'Checkpoint' })]);
  } });
  assert.deepEqual(requests, ['/api/v1/models', '/api/v1/blocks/models']);
  assert.deepEqual(options.map(row => [row.example.id, row.count]), [[102, 1]]);
  assert.equal(options[0].filters.modelAuthor, 'Creator');
  assert.equal(options[0].filters.checkpointType, 'Inpainting');
});

test('the filter check stops after throttling and retains verified results from the completed pair', async () => {
  const search = makeSearch({ baseModel: 'Pony', resourceType: 'LORA', fileFormat: 'SafeTensor' });
  let calls = 0;
  const state = await reviewModelFilters(search, { async fetcher(url) {
    calls++;
    if (url.searchParams.has('types')) return json([release(1)]);
    return Response.json({}, { status: 429, headers: { 'Retry-After': '6' } });
  } });
  assert.equal(calls, 2);
  assert.equal(state.tested, 1);
  assert.equal(state.incomplete, true);
  assert.match(state.pause, /Civitai/u);
  assert.deepEqual(state.options.map(row => row.field), ['baseModel']);
});

test('the sale check verifies the listings before suggesting a change to download access', async () => {
  const search = makeSearch({ downloadAccess: 'sale' });
  const paid = { permanent: true, endsAt: null };
  const models = [release(1, { download: paid }), release(2, { download: paid })];
  const allowSales = expected => async (url, request) => {
    if (url.pathname === '/api/v1/blocks/models') return json(models);
    assert.equal(url.pathname, '/api/v1/models');
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(url.searchParams.get('onSale'), 'true');
    assert.equal(url.searchParams.get('ids'), '1,2');
    return expected ? json([models[0]]) : Response.json({}, { status: 503 });
  };
  const read = await reviewModelFilters(search, { fetcher: allowSales(true) });
  assert.deepEqual(read.options.map(row => [row.field, row.example.id, row.filters.downloadAccess]), [['downloadAccess', 102, '']]);
  const failed = await reviewModelFilters(search, { fetcher: allowSales(false) });
  assert.equal(failed.incomplete, true);
  assert.deepEqual(failed.options, []);
});

test('sparse public model searches offer the check only while their viewer context is current', () => {
  const search = makeSearch({ baseModel: 'Pony' });
  assert.ok(canReviewModelFilters(search, context));
  assert.equal(canReviewModelFilters(search, { ...context }), false);
  assert.equal(canReviewModelFilters({ ...search, catalogFailure: 'retryable' }, context), false);
  assert.equal(canReviewModelFilters(makeSearch({ scope: 'ownedModels', baseModel: 'Pony' }), context), false);
  assert.equal(canReviewModelFilters(makeSearch({ baseModel: 'Pony' }, [{ id: 1 }, { id: 2 }, { id: 3 }]), context), false);
});

const cat = { id: 5132, name: 'cat' };
const window = { id: 112359, name: 'window' };
const landscape = { id: 8363, name: 'landscape' };
const makeGallerySearch = (plan = {}, scope = 'videos') => ({
  context, phase: 'complete',
  filters: { scope, query: 'cat on a window ledge without anime', mediaBaseModels: 'SD 1.5', mediaPeriod: 'Week',
    mediaPublishedPrompt: 'true', mediaCreator: 'Creator', mediaTags: String(landscape.id), mediaSort: 'Newest',
    mediaModelId: '12', mediaModelVersionId: '44', mediaPostId: '120' },
  result: { gallery: { scope, status: 'ready', plan: { type: scope === 'videos' ? 'video' : 'image', tags: [cat.id],
    requiredTags: [landscape.id], baseModels: 'SD 1.5', period: 'Week', hasPublishedPrompt: true, username: 'Creator',
    sort: 'Newest', modelId: 12, modelVersionId: 44, postId: 120, ...plan } }, related: { [scope]: [{ id: 9 }] } },
});
const older = new Date(Date.now() - 35 * 86_400_000).toISOString();
const recent = new Date().toISOString();
const clip = (id, changes) => ({ id, postId: 120, type: 'video', browsingLevel: 2, username: 'Creator',
  baseModel: 'SD 1.5', tags: [cat, window, landscape], meta: { prompt: 'A cat' }, createdAt: recent,
  url: 'https://image.civitai.com/example/clip.webm', thumbnail: 'https://image.civitai.com/example/cover.jpeg', ...changes });

test('gallery reviews preserve ranked routes, exact sources, selected tags, and the other filters', async () => {
  const search = makeGallerySearch({ ranking: { routes: [[cat.id, window.id], [cat.id]], terms: ['cat', 'window'],
    subject: 'cat', excluded: [['anime']] } });
  const calls = [];
  const result = await reviewGalleryFilters(search, { async fetcher(url, request) {
    assert.equal(url.origin + url.pathname, origin + '/api/v1/blocks/images');
    assert.equal(request.headers.Authorization, 'Bearer read-only-fixture');
    assert.equal(request.credentials, 'omit');
    const params = url.searchParams;
    for (const [key, value] of Object.entries({ type: 'video', modelId: '12', modelVersionId: '44', postId: '120',
      username: 'Creator', sort: 'Newest', limit: '6', withMeta: 'true', withTags: 'true' })) {
      assert.equal(params.get(key), value, key);
    }
    calls.push([params.get('baseModels'), params.get('period'), params.get('tags')]);
    if (!params.has('baseModels')) return json([clip(1, { baseModel: 'LTXV 2.3' }), clip(2, { baseModel: 'LTXV 2.3' }),
      clip(3, { baseModel: 'Veo 3' }), clip(9, { baseModel: 'LTXV 2.3' }), clip(4, { baseModel: null }),
      clip(5, { baseModel: 'LTXV 2.3', browsingLevel: 4 }), clip(6, { baseModel: 'LTXV 2.3', needsReview: true }),
      clip(7, { baseModel: 'LTXV 2.3', username: 'Other' }), clip(8, { baseModel: 'LTXV 2.3', tags: [cat, window] }),
      clip(10, { baseModel: 'LTXV 2.3', meta: { prompt: 'Anime cat' } }), clip(11, { baseModel: 'LTXV 2.3', meta: null })]);
    if (params.get('period') === 'AllTime') return json([clip(20, { createdAt: older }), clip(21),
      clip(22, { createdAt: '2025' }), clip(23, { createdAt: older, meta: null }), clip(24, { createdAt: older, type: 'image' })]);
    return json([clip(30, { meta: null }), clip(31, { meta: { meta: { prompt: ' ' } } }),
      clip(32, { meta: undefined }), clip(33, { meta: { prompt: 'Cat' } }), clip(34, { meta: null, baseModel: 'Veo 3' })]);
  } });
  assert.deepEqual(calls, [null, 'SD 1.5', 'SD 1.5'].flatMap((base, index) =>
    ['8363,5132,112359', '8363,5132'].map(tags => [base, index === 1 ? 'AllTime' : 'Week', tags])));
  assert.equal(result.tested, 3);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.options.map(({ field, count, example, filters }) => [field, count, example.id, filters[field]]), [
    ['mediaBaseModels', 2, 1, 'SD 1.5,LTXV 2.3'], ['mediaPeriod', 1, 20, ''], ['mediaPublishedPrompt', 2, 30, ''],
  ]);
  for (const { field, example, filters } of result.options) {
    assert.equal(example.link, origin + '/images/' + example.id);
    assert.ok(example.preview);
    assert.deepEqual(Object.keys(filters).filter(key => filters[key] !== search.filters[key]), [field]);
  }
});

test('gallery review stops at rate limits and carries verified samples from the earlier change', async () => {
  const search = makeGallerySearch();
  const calls = [];
  const state = await reviewGalleryFilters(search, { async fetcher(url) {
    calls.push(url.searchParams.get('period'));
    return calls.length === 1 ? json([clip(1, { baseModel: 'LTXV 2.3' })])
      : Response.json({}, { status: 429, headers: { 'Retry-After': '6' } });
  } });
  assert.deepEqual(calls, ['Week', 'AllTime']);
  assert.equal(state.tested, 1);
  assert.equal(state.incomplete, true);
  assert.match(state.pause, /Civitai/u);
  assert.deepEqual(state.options.map(({ field }) => field), ['mediaBaseModels']);
});

test('unconfirmed gallery results and interrupted catalog samples stay out of the review', async () => {
  const search = makeGallerySearch();
  const { gallery } = search.result;
  assert.ok(canReviewGalleryFilters(search, context));
  assert.equal(canReviewGalleryFilters(search, { ...context }), false);
  for (const state of [{ plan: undefined }, { plan: { ...gallery.plan, userId: 42 } }, { status: 'creator-conflict' },
    { incomplete: true }, { modelSource: { versionId: 44 } }]) {
    assert.equal(canReviewGalleryFilters({ ...search, result: { ...search.result, gallery: { ...gallery, ...state } } }, context), false);
  }
  assert.equal(canReviewGalleryFilters({ ...search, result: { ...search.result, visualComposition: {} } }, context), false);
  assert.equal(canReviewGalleryFilters({ ...search, groups: { videos: [{ id: 1 }, { id: 2 }, { id: 3 }] } }, context), false);
  const controller = new AbortController();
  await assert.rejects(reviewGalleryFilters(search, { signal: controller.signal, async fetcher(_url, { signal }) {
    controller.abort();
    signal.throwIfAborted();
  } }), { name: 'AbortError' });
});
