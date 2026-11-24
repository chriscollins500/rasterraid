import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG, catalogPause, catalogRead, siteSearch } from '../src/catalog.mjs';
import { readDirectoryPage } from '../src/directory.mjs';
import { catalogResearchItems } from '../src/catalog-research.mjs';
import { discover, readModelPage } from '../src/search.mjs';

const origin = 'https://civitai.red';
const context = { origin, hosted: true, browsingLevel: 3, viewerUserId: 1, token: 'fixture' };
const preview = 'https://image.civitai.com/fixture/preview.jpg';
const listing = (slug, fields = {}) => ({
  slug, name: 'Picture helper', tagline: 'Depth maps for desktop wallpaper', coverUrl: preview,
  category: 'utility', contentRating: 'pg13', kind: 'onsite', ...fields,
});

test('App Store matches exact names first across provider pages and preserves a failed cursor for retry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T19:30:00Z') });
  const requests = [];
  let failed = false;
  const fetcher = (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.credentials, 'omit');
    assert.equal(url.pathname, '/api/v1/apps');
    assert.equal(url.searchParams.has('query'), false);
    const cursor = url.searchParams.get('cursor');
    requests.push(cursor);
    if (!cursor) return Response.json({ items: [listing('picture-helper')], metadata: { nextCursor: 'page_two' } });
    if (cursor === 'page_two') return Response.json({
      items: [listing('wallpaper', { name: 'Wallpaper' }), listing('mature-listing', { name: 'Depth Wallpaper', contentRating: 'r' })],
      metadata: { nextCursor: 'page_three' },
    });
    if (!failed) {
      failed = true;
      return Response.json({}, { status: 503 });
    }
    return Response.json({ items: [
      listing('depth-wallpaper', { name: 'Depth Wallpaper', coverUrl: 'https://example.com/pixel', iconUrl: preview }),
      listing('wallpaper', { name: 'Wallpaper' }),
    ], metadata: { nextCursor: 'page_three' } });
  };
  const result = await discover(context, { scope: 'apps', query: 'Depth Wallpaper' }, { fetcher });
  assert.deepEqual(result.related.apps.map(app => app.id), ['wallpaper', 'picture-helper']);
  assert.equal(result.directory.nextCursor, 'page_three');
  assert.equal(result.directoryFacetsPartial, true);
  t.mock.timers.tick(2_000);
  const page = await readDirectoryPage(context, 'apps', result.directory.plan, {
    fetcher, cursor: result.directory.nextCursor, excluded: new Set(result.related.apps.map(app => app.id)),
  });
  assert.deepEqual(page.items.map(item => [item.id, item.preview]), [['depth-wallpaper', preview]]);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(requests, [null, 'page_two', 'page_three', 'page_three']);

  const complete = await discover(context, { scope: 'apps', query: 'Depth Wallpaper' }, { fetcher });
  assert.equal(complete.related.apps[0].id, 'depth-wallpaper');
  assert.equal(complete.directoryFacetsPartial, false);
});

test('App Store sends real filters, refreshes observed categories, and reports exact off-site details through Civitai', async () => {
  const exact = listing('wallpaper-helper', {
    name: 'Wallpaper Helper', kind: 'offsite', description: '<p>Download a depth map for your wallpaper.</p>',
    kindData: { launchUrl: 'https://outside.example/' },
  });
  const fetcher = (url, config) => {
    assert.equal(config.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/apps/wallpaper-helper') return Response.json(exact);
    assert.equal(url.pathname, '/api/v1/apps');
    if (!url.searchParams.has('kind')) return Response.json({
      items: [exact, listing('new-kind', { category: 'new-category' }), listing('hidden', { category: 'hidden-category', contentRating: 'r' })],
    });
    assert.equal(url.searchParams.get('sort'), 'name');
    assert.equal(url.searchParams.get('kind'), 'offsite');
    assert.equal(url.searchParams.get('category'), 'utility');
    return Response.json({ items: [exact, listing('wrong-kind')] });
  };
  const result = await discover(context, { scope: 'apps', query: 'wallpaper', appKind: 'offsite', appCategory: 'utility', catalogSort: 'name' }, { fetcher });
  const url = origin + '/apps/store-preview/wallpaper-helper';
  assert.deepEqual(result.directoryFacets.appCategory, ['new-category', 'utility']);
  assert.deepEqual(result.related.apps.map(({ link }) => link), [url]);
  assert.equal(result.related.apps[0].lookup.link, url);
  const exactResult = await discover(context, { query: 'https://civitai.com/apps/run/wallpaper-helper' }, { fetcher });
  assert.equal(exactResult.scope, 'apps');
  assert.equal(exactResult.related.apps[0].summary, 'Download a depth map for your wallpaper.');
  assert.equal(exactResult.nativeLink, url);
  assert.ok(!JSON.stringify(exactResult).includes('outside.example'));
  const [source] = catalogResearchItems(exactResult, exactResult.related, 'apps', origin);
  assert.equal(source.link, url);
  assert.equal(source.cover, null);
  assert.match(source.facts.join(' '), /External app/u);
});

const model = (i, name = 'Portrait ' + i) => ({
  id: i, name, type: 'LORA', modelVersions: [{ id: i + 100, baseModel: 'SDXL 1.0', trainedWords: [], images: [] }],
});

test('free model paging preserves the first ranking, validated filters, and pick IDs in the hosted rail', async () => {
  const modelRequests = [];
  const fixture = [...Array.from({ length: 9 }, (_, index) => model(index + 1)), model(10, 'Portrait')];
  const fetcher = (url, config) => {
    if (url.pathname === '/api/v1/tags') return Response.json({ items: [] });
    assert.equal(config.headers.Authorization, 'Bearer fixture');
    if (url.pathname === '/api/v1/blocks/images') return Response.json({ items: [] });
    assert.equal(url.pathname, '/api/v1/blocks/models');
    assert.equal(url.searchParams.get('query'), 'Portrait');
    assert.equal(url.searchParams.get('baseModels'), 'SDXL 1.0');
    assert.equal(url.searchParams.get('types'), 'LORA');
    const cursor = url.searchParams.get('cursor');
    modelRequests.push(cursor);
    return Response.json(cursor
      ? { items: [model(9), model(11), model(12), model(13)], metadata: {} }
      : { items: fixture, metadata: { nextCursor: 'portrait|cursor' } });
  };
  const result = await discover(context, { scope: 'models', query: 'Portrait', baseModel: 'SDXL 1.0', resourceType: 'LORA' }, { fetcher });
  assert.equal(result.candidates[0].id, 110);
  assert.equal(result.candidates.length, 6);
  assert.deepEqual(modelRequests, [null]);
  const next = await readModelPage(context, result.modelPager.nextCursor, { fetcher });
  const last = await readModelPage(context, next.nextCursor, { fetcher });
  assert.deepEqual(modelRequests, [null, 'portrait|cursor']);
  assert.equal(next.items.length, 6);
  assert.equal(last.items.length, 1);
  assert.equal(last.nextCursor, null);
  assert.equal(new Set([...result.candidates, ...next.items, ...last.items].map(item => item.modelId)).size, 13);
  assert.deepEqual(result.shortlisted.map(row => row.id), result.candidates.slice(0, 3).map(row => row.id));
  await assert.rejects(readModelPage({ ...context, viewerUserId: 2 }, result.modelPager.nextCursor, { fetcher }), /access changed/u);
  await assert.rejects(readModelPage({ ...context, browsingLevel: 1 }, result.modelPager.nextCursor, { fetcher }), /access changed/u);
  await assert.rejects(readModelPage(context, {}, { fetcher }), /access changed/u);
});

test('hosted model search without an App token uses the public catalog on every page', async () => {
  const guest = { origin, hosted: true, browsingLevel: 1 };
  const requests = [];
  const listed = (id, parent = {}, release = {}) => {
    const entry = { ...model(id), nsfwLevel: 1, ...parent };
    entry.modelVersions = [{ ...entry.modelVersions[0], nsfwLevel: 1, status: 'Published', ...release }];
    return entry;
  };
  const fetcher = (url, options) => {
    requests.push([url.pathname, url.searchParams.get('cursor'), options.headers.Authorization, options.credentials]);
    if (url.pathname === CATALOG.tags) return Response.json({ items: [] });
    if (url.pathname === CATALOG.images) {
      assert.equal(url.searchParams.get('browsingLevel'), '1');
      return Response.json({ items: [
        { id: 70, url: preview, browsingLevel: 1, needsReview: true },
        { id: 71, url: preview, browsingLevel: 2 },
        { id: 72, url: preview, browsingLevel: 1 },
      ] });
    }
    assert.equal(url.pathname, CATALOG.models);
    assert.equal(url.searchParams.get('nsfw'), 'true');
    return Response.json(url.searchParams.has('cursor')
      ? { items: [listed(1), listed(10), listed(11, {}, { availability: 'EarlyAccess' })] }
      : { items: [listed(1), listed(2, { nsfwLevel: 3 }), listed(3, { nsfwLevel: undefined }),
        listed(4, {}, { nsfwLevel: 2 }), listed(5, {}, { status: 'Draft' }), listed(6, { mode: 'TakenDown' })],
      metadata: { nextCursor: 'public-next' } });
  };
  const result = await discover(guest, { scope: 'models', query: 'Portrait' }, { fetcher });
  assert.deepEqual(result.candidates.map(row => [row.id, row.examples.map(example => example.id)]), [[101, [72]]]);
  const next = await readModelPage(guest, result.modelPager.nextCursor, { fetcher });
  assert.deepEqual(next.items.map(row => row.id), [110]);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(requests.filter(([path]) => path === CATALOG.models).map(([, cursor]) => cursor), [null, 'public-next']);
  assert.ok(requests.every(([path, , auth, credentials]) => !path.startsWith('/api/v1/blocks/') && !auth && credentials === 'omit'));
  await assert.rejects(readModelPage({ ...guest, token: 'connected' }, result.modelPager.nextCursor, { fetcher }), /access changed/u);
});

test('Site model continuations retain the cursor during a shared pause and resume App verification', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-22T15:00:00Z') });
  let failVerification = false;
  const sitePositions = [];
  const fetcher = (url, config) => {
    if (url.pathname === '/api/v1/tags') return Response.json({ items: [] });
    if (url.pathname === '/api/v1/models') {
      assert.equal(config.headers.Authorization, undefined);
      assert.equal(url.searchParams.get('tag'), 'portrait');
      assert.equal(url.searchParams.get('sort'), 'Newest');
      const cursor = url.searchParams.get('cursor');
      sitePositions.push(cursor);
      return Response.json(cursor ? { items: [model(2), model(3)] }
        : { items: [model(1)], metadata: { nextCursor: 'allowed-first-page' } });
    }
    if (url.pathname === '/api/v1/blocks/images') return Response.json({ items: [] });
    assert.equal(url.pathname, '/api/v1/blocks/models');
    assert.equal(config.headers.Authorization, 'Bearer fixture');
    const ids = url.searchParams.get('modelVersionIds');
    if (ids === '101') return Response.json({ items: [model(1)] });
    assert.equal(ids, '102,103');
    if (!failVerification) {
      failVerification = true;
      return Response.json({}, { status: 429 });
    }
    return Response.json({ items: [model(3)] });
  };
  const first = await discover(context, { scope: 'models', query: 'Portrait', category: 'portrait', sort: 'Newest' }, { fetcher });
  assert.deepEqual(first.candidates.map(row => row.id), [101]);
  const retry = await readModelPage(context, first.modelPager.nextCursor, { fetcher });
  assert.equal(retry.partial, true);
  assert.deepEqual(retry.items, []);
  assert.equal(catalogPause(origin, fetcher)?.retryAfter, '15');
  await assert.rejects(siteSearch(origin, [{ indexUid: 'articles', q: 'Portrait' }], { fetcher }), { status: 429, retryAfter: '15' });
  assert.deepEqual(sitePositions, [null, 'allowed-first-page']);
  t.mock.timers.tick(15_000);
  const second = await readModelPage(context, retry.nextCursor, { fetcher });
  assert.equal(second.partial, false);
  assert.deepEqual(second.items.map(row => row.id), [103]);
  assert.deepEqual(sitePositions, [null, 'allowed-first-page', 'allowed-first-page']);
  assert.equal(second.nextCursor, null);
});

test('a native search limit honors both Retry-After forms across catalog reads while in-flight reads can finish', async t => {
  const now = Date.parse('2026-11-22T15:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const calls = [];
  const alreadyRunning = Promise.withResolvers();
  const concurrentLimit = Promise.withResolvers();
  let limited = true;
  const fetcher = url => {
    calls.push(url.origin + url.pathname);
    if (url.pathname === CATALOG.articles) return alreadyRunning.promise;
    if (url.pathname === CATALOG.collections) return concurrentLimit.promise;
    if (url.pathname === CATALOG.tags) return Response.json({}, { status: 429, headers: { 'Retry-After': '2' } });
    if (url.pathname === '/api/search/multi-search') {
      return limited ? Response.json({}, { status: 429, headers: { 'Retry-After': new Date(now + 420_000).toUTCString() } })
        : Response.json({ results: [{ hits: [] }] });
    }
    return Response.json({ items: [] });
  };
  const articles = catalogRead(origin, CATALOG.articles, {}, { fetcher });
  const collections = assert.rejects(catalogRead(origin, CATALOG.collections, {}, { fetcher }), { status: 429, retryAfter: '420' });
  const queries = [{ indexUid: 'articles', q: 'Palette' }];
  await assert.rejects(siteSearch(origin, queries, { fetcher }), { status: 429, retryAfter: '420' });
  concurrentLimit.resolve(Response.json({}, { status: 429, headers: { 'Retry-After': '2' } }));
  await collections;
  alreadyRunning.resolve(Response.json({ items: [{ id: 1 }] }));
  assert.deepEqual((await articles).data.items, [{ id: 1 }]);
  await assert.rejects(catalogRead(origin, CATALOG.blockModels, {}, { fetcher, token: 'fixture' }), { status: 429, retryAfter: '420' });
  await assert.rejects(catalogRead(origin, CATALOG.models, {}, { fetcher, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls.length, 3);
  await catalogRead('https://civitai.com', CATALOG.models, {}, { fetcher });
  assert.equal(calls.length, 4);
  t.mock.timers.tick(419_999);
  await assert.rejects(siteSearch(origin, queries, { fetcher }), { status: 429, retryAfter: '1' });
  assert.equal(calls.length, 4);
  t.mock.timers.tick(1);
  limited = false;
  assert.deepEqual(await siteSearch(origin, queries, { fetcher }), [{ hits: [] }]);
  assert.equal(catalogPause(origin, fetcher), null);
  assert.equal(calls.length, 5);
  await assert.rejects(catalogRead(origin, CATALOG.tags, {}, { fetcher }), { status: 429, retryAfter: '2' });
  t.mock.timers.tick(2_000);
  assert.equal(catalogPause(origin, fetcher), null);
});

test('a busy catalog source observes its own cooldown while other sources and hosts keep answering', async t => {
  const now = Date.parse('2026-11-24T19:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const calls = [];
  const fetcher = url => {
    calls.push(url.origin + url.pathname);
    if (url.origin === origin && url.pathname === CATALOG.models && !url.searchParams.has('query') && Date.now() < now + 5_000) {
      return Response.json({}, { status: 503, headers: { 'Retry-After': new Date(now + 5_000).toUTCString() } });
    }
    return Response.json({ items: [] });
  };
  await assert.rejects(catalogRead(origin, CATALOG.models, {}, { fetcher }), { status: 503 });
  assert.equal(catalogPause(origin, fetcher), null);
  await assert.rejects(catalogRead(origin, CATALOG.models, { limit: 20 }, { fetcher }), { status: 503, retryAfter: '5' });
  await catalogRead(origin, CATALOG.models, { query: 'Second brief' }, { fetcher });
  await catalogRead(origin, CATALOG.articles, {}, { fetcher });
  await catalogRead('https://civitai.com', CATALOG.models, {}, { fetcher });
  t.mock.timers.tick(4_999);
  await assert.rejects(catalogRead(origin, CATALOG.models, {}, { fetcher }), { status: 503, retryAfter: '1' });
  assert.deepEqual(calls, [origin + CATALOG.models, origin + CATALOG.models, origin + CATALOG.articles, 'https://civitai.com' + CATALOG.models]);
  t.mock.timers.tick(1);
  assert.deepEqual((await catalogRead(origin, CATALOG.models, {}, { fetcher })).data, { items: [] });
  assert.equal(calls.at(-1), origin + CATALOG.models);
  assert.equal(calls.length, 5);
});

test('a busy source without a readable retry header has a brief local cooldown', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T19:30:00Z') });
  let attempts = 0;
  const fetcher = async () => ++attempts === 1 ? Response.json({}, { status: 503 }) : Response.json({ items: [] });
  await assert.rejects(catalogRead(origin, CATALOG.models, {}, { fetcher }), { status: 503 });
  await assert.rejects(catalogRead(origin, CATALOG.models, {}, { fetcher }), { status: 503, retryAfter: '2' });
  assert.equal(attempts, 1);
  t.mock.timers.tick(2_000);
  assert.deepEqual((await catalogRead(origin, CATALOG.models, {}, { fetcher })).data.items, []);
  assert.equal(attempts, 2);
});

test('malformed successful HTTP responses cannot masquerade as empty catalog results', async () => {
  const responseFor = value => () => Promise.resolve(Response.json(value));
  for (const value of [{}, { items: 'pending' }, null, 50]) {
    await assert.rejects(catalogRead(origin, CATALOG.models, {}, { fetcher: responseFor(value) }), { name: 'CatalogError', status: null });
  }
  await assert.rejects(catalogRead(origin, CATALOG.images, {}, { fetcher: async () => new Response('Busy') }),
    { name: 'CatalogError', status: null });
  assert.deepEqual((await catalogRead(origin, CATALOG.models, {}, { fetcher: responseFor({ items: [] }) })).data.items, []);
  assert.deepEqual((await catalogRead(origin, CATALOG.collections, {}, { fetcher: responseFor([]) })).data, []);
});
