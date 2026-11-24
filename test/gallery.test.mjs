import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOG } from '../src/catalog.mjs';
import { applyNativeGalleryFilters, readGalleryPage, readNativeGallerySearch } from '../src/gallery.mjs';
import { watchHost } from '../src/civitai-host.js';
import { discover, searchTarget } from '../src/search.mjs';
import { NATIVE_MODELS_INDEX } from '../src/runtime-config.mjs';
import { discoverVisualComposition, discoverVisualNeighbors, visualReferenceId, visualReferenceLink } from '../src/visual-discovery.mjs';
import { workspaceFilters } from '../src/workspace.mjs';

const cats = { id: 5132, name: 'cat' };
const landscape = { id: 8363, name: 'landscape' };
const car = { id: 111805, name: 'car' };
const motorcycle = { id: 111756, name: 'motorcycle' };
const clip = 'https://image.civitai.com/official/clip.mp4';
const poster = 'https://image.civitai.com/official/clip.jpeg';
const image = 'https://image.civitai.com/official/image.jpeg';
const contextFor = origin => ({ origin, hosted: true, token: 'read-only-test', browsingLevel: 3 });

test('the Civitai handoff preserves exact gallery filters and keeps other parameters out', () => {
  const origin = 'https://civitai.red';
  const messages = [];
  const parent = { postMessage(message, target) { messages.push({ message, target }); } };
  let receive;
  let host;
  watchHost({ parent, document: { body: { scrollHeight: 560 } },
    addEventListener(_type, listener) { receive = listener; } }, context => { host = context; });
  receive({ source: parent, origin, data: { type: 'BLOCK_INIT', payload: {
    blockId: 'rasterraid', blockInstanceId: 'gallery-link', renderMode: 'iframe', context: { slotId: 'app.page' },
  } } });
  const videos = new URL('/videos', origin);
  applyNativeGalleryFilters(videos, { baseModels: 'SD 1.5,SDXL 1.0', username: 'A-Creator', period: 'Week', modelVersionId: 128713 },
    'Newest', [5132, 111756]);
  host.open(videos.href);
  const photos = new URL('/images?similarTo=135405057', origin);
  applyNativeGalleryFilters(photos, { baseModels: 'Flux.1 D', period: 'Month' }, 'Most Reactions');
  host.open(photos.href);
  for (const path of ['/images?nsfw=true', '/images?browsingLevel=63', '/images?next=https%3A%2F%2Fexample.test',
    '/videos?similarTo=135405057', '/videos?modelVersionId=0', '/videos?modelVersionId=128713&modelVersionId=116881',
    '/images?tags=cat', '/images?periodMode=published', '/images?sort=Unexpected', '/images#login']) host.open(origin + path);
  host.open(videos.href.replace('civitai.red', 'civitai.com'));
  assert.deepEqual(messages.filter(row => row.message.type === 'NAVIGATE'), [videos, photos].map(url => ({ target: origin,
    message: { type: 'NAVIGATE', payload: { path: url.pathname + url.search, scope: 'site', target: 'new_tab' } } })));
});

function media(id, type, fields = {}) {
  return {
    id, type, browsingLevel: 1, username: 'a-creator',
    url: type === 'video' ? clip : image, ...(type === 'video' && { thumbnail: { url: poster } }),
    tags: [cats, landscape], ...fields,
  };
}

test('native image and video links preserve public choices and hold unsupported filters', () => {
  const host = 'https://civitai.red';
  const link = new URL('/videos', host);
  link.search = new URLSearchParams([['query', 'cat on a hill'], ['types', 'video'], ['view', 'feed'], ['utm_source', 'fixture']]);
  applyNativeGalleryFilters(link, { baseModels: 'SD 1.5,SDXL 1.0', username: 'a-creator', period: 'Week',
    modelId: 4384, modelVersionId: 128713, postId: 86 }, 'Newest', [cats.id, landscape.id]);
  const filters = { scope: 'videos', query: 'cat on a hill', mediaSort: 'Newest', mediaPeriod: 'Week', mediaCreator: 'a-creator',
    mediaBaseModels: 'SD 1.5,SDXL 1.0', mediaTags: '5132,8363', mediaModelId: '4384', mediaModelVersionId: '128713', mediaPostId: '86' };
  assert.deepEqual(readNativeGallerySearch(link), { origin: host, filters });
  assert.deepEqual(workspaceFilters(filters), filters);
  assert.equal(workspaceFilters({ ...filters, mediaTags: '5132,invalid' }), null);
  assert.deepEqual(readNativeGallerySearch(host + '/images?similarTo=135405057&tags=5132'), {
    origin: host, filters: { scope: 'gallery', query: host + '/images?similarTo=135405057', mediaTags: '5132' },
  });
  for (const path of ['/images?tags=cat', '/images?types=image&types=video', '/images?followed=true',
    '/videos?requiringMeta=true', '/images?period=Month&periodMode=stats', '/images?period=Week', '/images?similarTo=135405057&query=cat',
    '/images?baseModels=SDXL%201.0,SD%201.5', '/images?modelVersionId=1&modelVersionId=2', '/images#private']) {
    assert.ok(readNativeGallerySearch(host + path)?.reason, path);
  }
  assert.equal(readNativeGallerySearch(host + '/images/135405057'), null);
  assert.equal(readNativeGallerySearch('https://example.test/images?tags=5132'), null);
});

test('imported gallery filters apply to every page and require the selected version to belong to the model', async () => {
  const host = 'https://civitai.com';
  const url = new URL('/images', host);
  applyNativeGalleryFilters(url, { modelId: 4384, modelVersionId: 128713, postId: 80,
    username: 'a-creator', baseModels: 'SDXL 1.0', period: 'Month' }, 'Newest', [cats.id, landscape.id]);
  const context = contextFor(host);
  const imported = readNativeGallerySearch(url);
  const requests = [];
  function fetcher(request, options) {
    assert.equal(request.origin, host);
    assert.equal(options.headers.Authorization, 'Bearer read-only-test');
    const values = Object.fromEntries(request.searchParams);
    requests.push([request.pathname, values]);
    if (request.pathname === CATALOG.blockModels) {
      assert.deepEqual(values, { modelVersionIds: '128713', limit: '1' });
      return Response.json({ items: [{ id: 4384, modelVersions: [{ id: 128713 }] }] });
    }
    assert.equal(request.pathname, CATALOG.blockImages);
    assert.deepEqual(values, { modelId: '4384', modelVersionId: '128713', postId: '80', username: 'a-creator',
      baseModels: 'SDXL 1.0', period: 'Month', sort: 'Newest', type: 'image', tags: '5132,8363', withTags: 'true', limit: '24',
      ...(values.cursor && { cursor: 'feed:native+next' }) });
    const match = media(values.cursor ? 22 : 11, 'image', { baseModel: 'SDXL 1.0', postId: 80 });
    return Response.json({ items: [match,
      { ...match, id: 60, tags: [cats] }, { ...match, id: 61, browsingLevel: 8 }, { ...match, id: 62, username: 'another' }],
      metadata: values.cursor ? {} : { nextCursor: 'feed:native+next' } });
  }
  const result = await discover(context, imported.filters, { fetcher });
  assert.deepEqual(result.related.gallery.map(item => item.id), [11]);
  assert.deepEqual(readNativeGallerySearch(result.gallery.nativeLink), imported);
  assert.deepEqual((await readGalleryPage(context, result.gallery.plan, { fetcher, cursor: result.gallery.nextCursor })).items.map(item => item.id), [22]);
  assert.deepEqual(requests.map(([path]) => path), [CATALOG.blockModels, CATALOG.blockImages, CATALOG.blockImages]);
  requests.length = 0;
  const wrong = await discover(context, { ...imported.filters, mediaModelId: '55330' }, { fetcher });
  assert.equal(wrong.gallery.status, 'source-conflict');
  assert.deepEqual(wrong.related.gallery, []);
  assert.equal(requests.length, 1);
});

test('reference-led gallery search keeps imported tags and source selectors on all lanes', async () => {
  const host = 'https://civitai.com';
  const context = contextFor(host);
  const url = host + '/images?similarTo=101&postId=50&modelVersionId=900&tags=5132';
  const { filters } = readNativeGallerySearch(url);
  const requests = [];
  const result = await discoverVisualNeighbors(context, { kind: 'similarMedia', id: 101 }, filters, {
    fetcher(request) {
      const params = Object.fromEntries(request.searchParams);
      requests.push(params);
      if (params.ids === '101') return Response.json({ items: [media(101, 'image', { postId: 60, modelVersionIds: [901] })] });
      assert.equal(params.postId, '50');
      assert.equal(params.modelVersionId, '900');
      assert.ok(params.tags.split(',').includes('5132'));
      return Response.json({ items: [media(102, 'image', { postId: 50 }), media(103, 'image', { postId: 50, tags: [landscape] })] });
    },
  });
  assert.ok(requests.length > 1);
  assert.deepEqual(result.related.gallery.map(item => item.id), [102]);
  assert.deepEqual(readNativeGallerySearch(result.gallery.nativeLink).filters, filters);
});

test('gallery queries resolve live tags and independently search the host media catalog', async () => {
  for (const [host, scope, type] of [
    ['https://civitai.com', 'gallery', 'image'],
    ['https://civitai.red', 'videos', 'video'],
  ]) {
    const requests = [];
    const result = await discover(contextFor(host), { scope, query: 'cat landscape' }, {
      fetcher(url, options) {
        assert.equal(url.origin, host);
        requests.push(url.pathname);
        if (url.pathname === '/api/search/multi-search') {
          assert.equal(options.method, 'POST');
          assert.equal(options.headers.Authorization, undefined);
          const { queries } = JSON.parse(options.body);
          assert.deepEqual(queries.filter(q => !q.filter).map(q => q.q), ['cat landscape', 'cat', 'landscape']);
          assert.deepEqual(queries.filter(q => q.filter).map(q => q.filter[0]),
            ['tags.name = "cat landscape"', 'tags.name = "cat"', 'tags.name = "landscape"']);
          assert.ok(queries.every(q => q.indexUid === NATIVE_MODELS_INDEX));
          assert.ok(queries.every(q => q.attributesToRetrieve.join() === 'tags'));
          return Response.json({ results: queries.map(() => ({ hits: [{ tags: [cats, landscape] }] })) });
        }
        assert.equal(url.pathname, CATALOG.blockImages);
        assert.equal(url.searchParams.get('type'), type);
        assert.equal(url.searchParams.get('tags'), '8363,5132');
        assert.equal(options.headers.Authorization, 'Bearer read-only-test');
        assert.equal(url.searchParams.has('modelId'), false);
        return Response.json({ items: [
          media(1, type), media(2, type, { browsingLevel: 8 }), media(3, type, { tags: [cats] }),
          media(4, type === 'video' ? 'image' : 'video'),
        ], metadata: { nextCursor: 'feed:abc+123' } });
      },
    });
    assert.deepEqual(requests, ['/api/search/multi-search', CATALOG.blockImages]);
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.related[scope].map(item => item.id), [1]);
    assert.equal(result.related[scope][0].preview, type === 'video' ? poster : image);
    assert.equal(result.related[scope][0].stream, type === 'video' ? clip : null);
    assert.equal(result.gallery.nextCursor, 'feed:abc+123');
    assert.equal(result.gallery.preferenceEligible, true);
    assert.deepEqual(result.related[scope][0].preferenceTags, [5132, 8363]);
    assert.equal(result.gallery.nativeLink, host + (type === 'video' ? '/videos' : '/images') + '?query=cat+landscape');
  }
});

test('an exact typed tag recovers an image or video query even when model text search misses it', async () => {
  for (const [type, scope] of [['image', 'gallery'], ['video', 'videos']]) {
    const host = 'https://civitai.com';
    const requests = [];
    const result = await discover(contextFor(host), { scope, query: 'car' }, {
      fetcher(url, options) {
        requests.push(url.pathname);
        if (url.pathname === '/api/search/multi-search') {
          assert.equal(options.headers.Authorization, undefined);
          const { queries } = JSON.parse(options.body);
          assert.deepEqual(queries.map(row => [row.q, row.filter]), [['car', undefined], ['', ['tags.name = "car"']]]);
          return Response.json({ results: [{ hits: [{ tags: [cats] }] }, { hits: [{ tags: [cats, car] }] }] });
        }
        assert.equal(url.searchParams.get('tags'), String(car.id));
        assert.equal(url.searchParams.get('type'), type);
        return Response.json({ items: [media(45, type, { tags: [car] }), media(46, type, { tags: [cats] })] });
      },
    });
    assert.deepEqual(result.gallery.tags, [car]);
    assert.deepEqual(result.related[scope].map(row => row.id), [45]);
    assert.deepEqual(requests, ['/api/search/multi-search', CATALOG.blockImages]);
  }
});

test('spelling recovery confirms the Civitai tag ID and offers verified choices when counts are close', async () => {
  const context = contextFor('https://civitai.red');
  const other = { id: 15, name: 'motorcylex' };
  const facetPath = '/api/search/indexes/' + NATIVE_MODELS_INDEX + '/facet-search';
  for (const secondCount of [1, 80]) {
    const observed = [];
    const found = await discover(context, { scope: 'videos', query: 'motorcyle' }, {
      fetcher(url, options) {
        observed.push(url.pathname);
        if (url.pathname === facetPath) {
          assert.equal(options.headers.Authorization, undefined);
          assert.deepEqual(JSON.parse(options.body), { facetName: 'tags.name', facetQuery: 'moto' });
          return Response.json({ facetHits: [{ value: motorcycle.name, count: 83 }, { value: other.name, count: secondCount }] });
        }
        if (url.pathname === '/api/search/multi-search') {
          const { queries } = JSON.parse(options.body);
          return Response.json({ results: queries.map(row => ({
            hits: row.filter?.[0] === 'tags.name = "motorcycle"' ? [{ tags: [motorcycle] }]
              : row.filter?.[0] === 'tags.name = "motorcylex"' ? [{ tags: [other] }] : [],
          })) });
        }
        assert.equal(url.searchParams.get('tags'), String(motorcycle.id));
        return Response.json({ items: [media(96, 'video', { tags: [motorcycle] })] });
      },
    });
    assert.equal(new URL(found.gallery.nativeLink).searchParams.get('query'), 'motorcyle');
    assert.deepEqual(observed.slice(0, 3), ['/api/search/multi-search', facetPath, '/api/search/multi-search']);
    if (secondCount === 1) {
      assert.equal(found.gallery.correctedTag, 'motorcycle');
      assert.deepEqual(found.related.videos.map(row => row.id), [96]);
      assert.equal(found.gallery.preferenceEligible, true);
    } else {
      assert.deepEqual(found.gallery.suggestions, [motorcycle, other]);
      assert.equal(found.gallery.status, 'no-tag');
      assert.equal(observed.length, 3);
    }
  }
});

test('an old exact-filter contract falls back to lexical tag search once', async () => {
  const observed = [];
  const result = await discover(contextFor('https://civitai.red'), { scope: 'gallery', query: 'cat' }, {
    fetcher(url, options) {
      observed.push(url.pathname);
      if (url.pathname !== '/api/search/multi-search') return Response.json({ items: [media(1, 'image')] });
      const { queries } = JSON.parse(options.body);
      if (queries.some(row => row.filter)) return Response.json({ code: 'invalid_filter' }, { status: 400 });
      return Response.json({ results: [{ hits: [{ tags: [cats] }] }] });
    },
  });
  assert.deepEqual(observed, ['/api/search/multi-search', '/api/search/multi-search', CATALOG.blockImages]);
  assert.equal(result.related.gallery[0].id, 1);
});

test('spelling falls back to public tag names after a facet refusal and respects a facet rate limit', async () => {
  const context = contextFor('https://civitai.com');
  for (const refusal of [403, 429]) {
    const paths = [];
    const result = await discover(context, { scope: 'videos', query: 'motorcyle' }, {
      fetcher(url, options) {
        paths.push(url.pathname);
        if (url.pathname.endsWith('/facet-search')) return Response.json({}, { status: refusal, headers: { 'Retry-After': '60' } });
        if (url.pathname === CATALOG.tags) {
          assert.equal(url.searchParams.get('query'), 'moto');
          assert.equal(options.headers.Authorization, undefined);
          return Response.json({ items: [{ name: 'motorcycle', id: 999 }] });
        }
        if (url.pathname === '/api/search/multi-search') {
          const requests = JSON.parse(options.body).queries;
          return Response.json({ results: requests.map(row => ({
            hits: row.filter?.[0] === 'tags.name = "motorcycle"' ? [{ tags: [motorcycle] }] : [],
          })) });
        }
        assert.equal(url.searchParams.get('tags'), String(motorcycle.id));
        return Response.json({ items: [media(90, 'video', { tags: [motorcycle] })] });
      },
    });
    if (refusal === 429) {
      assert.equal(result.gallery.status, 'tag-unavailable');
      assert.equal(paths.length, 2);
    } else {
      assert.deepEqual(result.gallery.tags, [motorcycle]);
      assert.equal(result.related.videos[0].id, 90);
      assert.deepEqual(paths.slice(2), [CATALOG.tags, '/api/search/multi-search', CATALOG.blockImages]);
    }
  }
});

test('exclusions apply to a sorted page and its cursor without becoming positive tags', async () => {
  const context = contextFor('https://civitai.com');
  const anime = { id: 72, name: 'anime' };
  const ids = [];
  const fetcher = (url, options) => {
    if (url.pathname === '/api/search/multi-search') {
      const { queries } = JSON.parse(options.body);
      assert.ok(queries.every(row => row.q === 'car' || row.filter?.[0] === 'tags.name = "car"'));
      return Response.json({ results: queries.map(() => ({ hits: [{ tags: [anime, car] }] })) });
    }
    assert.equal(url.searchParams.get('tags'), String(car.id));
    assert.equal(url.searchParams.get('sort'), 'Newest');
    assert.equal(url.searchParams.get('withMeta'), 'true');
    const cursor = url.searchParams.get('cursor');
    ids.push(cursor);
    return Response.json({ items: cursor ? [
      media(90, 'image', { tags: [car], meta: { title: 'Anime look' } }),
      media(89, 'image', { tags: [car] }),
    ] : [
      media(94, 'image', { tags: [car] }),
      media(92, 'image', { tags: [anime, car] }),
      media(93, 'image', { tags: [car] }),
      media(91, 'image', { tags: [car], meta: { prompt: 'Anime car' } }),
    ], metadata: { nextCursor: cursor ? null : 'newest:page+two' } });
  };
  const first = await discover(context, { scope: 'gallery', query: 'car without anime', mediaSort: 'Newest' }, { fetcher });
  assert.deepEqual(first.related.gallery.map(row => row.id), [94, 93]);
  assert.equal(first.gallery.preferenceEligible, false);
  const page = await readGalleryPage(context, first.gallery.plan, { cursor: first.gallery.nextCursor, fetcher });
  assert.deepEqual(page.items.map(row => row.id), [89]);
  assert.deepEqual(ids, [null, 'newest:page+two']);
});

test('video paging uses the original gallery filters and opaque cursor', async () => {
  const context = contextFor('https://civitai.red');
  const first = await discover(context, { scope: 'videos', query: 'cat', mediaSort: 'Newest', selectedMediaTag: cats }, {
    fetcher(url) {
      assert.equal(url.pathname, CATALOG.blockImages);
      assert.equal(url.searchParams.get('tags'), '5132');
      return Response.json({ items: [media(1, 'video')], metadata: { nextCursor: '125:opaque|next+' } });
    },
  });
  assert.equal(first.gallery.preferenceEligible, false);
  assert.equal(first.gallery.rateable, true);
  const reply = await readGalleryPage(context, first.gallery.plan, {
    cursor: first.gallery.nextCursor,
    fetcher(url) {
      assert.equal(url.searchParams.get('cursor'), '125:opaque|next+');
      assert.equal(url.searchParams.get('sort'), 'Newest');
      assert.equal(url.searchParams.get('type'), 'video');
      assert.equal(url.searchParams.get('tags'), '5132');
      return Response.json({ items: [
        media(2, 'video'),
        media(3, 'video', { url: 'https://unrelated.example/video.mp4' }),
      ], metadata: { nextCursor: '125:opaque|next+' } });
    },
  });
  assert.deepEqual(reply.items.map(item => [item.id, item.stream]), [[2, clip], [3, null]]);
  assert.equal(reply.nextCursor, null);
});

test('unmapped media text offers the native search without sending an unfiltered gallery request', async () => {
  const requested = [];
  const result = await discover(contextFor('https://civitai.com'), { scope: 'videos', query: 'a cloud shaped like a teapot' }, {
    fetcher(url, options) {
      requested.push(url.pathname);
      if (url.pathname === CATALOG.blockModels) return Response.json({ items: [] });
      return Response.json({ results: JSON.parse(options.body).queries.map(() => ({ hits: [{ tags: [cats] }] })) });
    },
  });
  assert.deepEqual(requested, ['/api/search/multi-search', CATALOG.blockModels]);
  assert.equal(result.gallery.status, 'no-tag');
  assert.deepEqual(result.related.videos, []);
  assert.equal(new URL(result.gallery.nativeLink).searchParams.get('query'), 'a cloud shaped like a teapot');
});

test('sparse video search follows an exact model into its eligible releases and carries filters through paging', async () => {
  const host = 'https://civitai.red';
  const context = contextFor(host);
  const tag = { id: 901, name: 'dreamshaper' };
  const anime = { id: 902, name: 'anime' };
  const reads = [];
  const row = (id, fields = {}) => media(id, 'video', { baseModel: 'SD 1.5', meta: { prompt: 'forest' }, ...fields });
  const fetcher = (url, options) => {
    assert.equal(url.origin, host);
    if (url.pathname === '/api/search/multi-search') {
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({ results: JSON.parse(options.body).queries.map(() => ({ hits: [{ tags: [tag] }] })) });
    }
    assert.equal(options.headers.Authorization, 'Bearer read-only-test');
    if (url.pathname === CATALOG.blockModels) {
      assert.equal(url.searchParams.get('query'), 'DreamShaper');
      return Response.json({ items: [{ id: 4384, name: 'DreamShaper', nsfwLevel: 15, modelVersions: [
        { id: 999, name: 'Private', availability: 'Private', baseModel: 'SD 1.5' },
        { id: 888, name: 'Another family', baseModel: 'Flux.1 D' },
        { id: 128713, name: '8', baseModel: 'SD 1.5' }, { id: 109123, name: '7', baseModel: 'SD 1.5' },
      ] }] });
    }
    assert.equal(url.pathname, CATALOG.blockImages);
    const params = Object.fromEntries(url.searchParams);
    reads.push(params);
    if (params.modelVersionId !== '109123') return Response.json({ items: [] });
    if (params.cursor) return Response.json({ items: [row(12)] });
    return Response.json({ items: [row(11), row(21, { browsingLevel: 8 }), row(22, { tags: [anime] }),
      row(23, { baseModel: 'Flux.1 D' }), row(24, { username: 'other' }), row(25, { meta: {} }),
      row(26, { blockedFor: 'policy' }), media(27, 'image')], metadata: { nextCursor: 'release:2' } });
  };
  const result = await discover(context, { scope: 'videos', query: 'DreamShaper without anime', mediaSort: 'Newest',
    mediaCreator: 'a-creator', mediaBaseModels: 'SD 1.5,SDXL 1.0', mediaPublishedPrompt: 'true', mediaPeriod: 'Week' }, { fetcher });
  const source = { title: 'DreamShaper', version: '7', modelId: 4384, versionId: 109123, link: host + '/models/4384?modelVersionId=109123' };
  assert.deepEqual(result.related.videos.map(({ id, exampleSource }) => [id, exampleSource]), [[11, source]]);
  assert.deepEqual(result.gallery.modelSource, source);
  assert.equal(result.gallery.preferenceEligible, false);
  const native = new URL(result.gallery.nativeLink);
  assert.equal(native.pathname, '/videos');
  assert.deepEqual(native.searchParams.getAll('baseModels'), ['SD 1.5', 'SDXL 1.0']);
  assert.deepEqual(Object.fromEntries([...native.searchParams].filter(([key]) => key !== 'baseModels')), {
    modelVersionId: '109123', period: 'Week', periodMode: 'published', sort: 'Newest', username: 'a-creator',
  });
  const next = await readGalleryPage(context, result.gallery.plan, { cursor: result.gallery.nextCursor, fetcher });
  assert.deepEqual(next.items.map(item => [item.id, item.exampleSource.versionId]), [[12, 109123]]);
  assert.deepEqual(reads.map(params => [params.tags, params.modelVersionId, params.cursor]), [
    ['901', undefined, undefined], [undefined, '128713', undefined], [undefined, '109123', undefined], [undefined, '109123', 'release:2'],
  ]);
  assert.ok(reads.every(params => params.username === 'a-creator' && params.baseModels === 'SD 1.5,SDXL 1.0' &&
    params.type === 'video' && params.period === 'Week' && params.sort === 'Newest' && params.withMeta === 'true'));
});

test('short or duplicate model names offer exact release choices without automatically opening a gallery', async () => {
  const context = contextFor('https://civitai.com');
  for (const titles of [['DynaVision XL - Studio release', 'DynaVision XL (Photo edition)'], ['DynaVision XL', 'DynaVision XL']]) {
    const requested = [];
    const result = await discover(context, { scope: 'gallery', query: 'DynaVision XL' }, {
      fetcher(url, options) {
        requested.push(url.pathname);
        if (url.pathname === '/api/search/multi-search') {
          return Response.json({ results: JSON.parse(options.body).queries.map(() => ({ hits: [] })) });
        }
        const model = (id, name, fields = {}) => ({ id, name, modelVersions: [{ id: 100 + id, name: 'First release' }], ...fields });
        return Response.json({ items: [model(1, titles[0]), model(2, titles[1]), model(3, 'DynaVision XL', { availability: 'Private' }),
          model(4, 'DynaVision XL', { status: 'Draft' }), model(5, 'DynaVision XL field guide')] });
      },
    });
    assert.deepEqual(requested, ['/api/search/multi-search', CATALOG.blockModels]);
    assert.deepEqual(result.gallery.modelChoices.map(choice => [choice.title, choice.link]), titles.map((title, index) =>
      [title, context.origin + '/models/' + (index + 1) + '?modelVersionId=' + (101 + index)]));
    assert.deepEqual(result.related.gallery, []);
  }
});

test('gallery supports direct posts and creators and respects Civitai gallery failure', async () => {
  const context = contextFor('https://civitai.com');
  const fromPost = await discover(context, { scope: 'gallery', query: 'https://civitai.red/posts/42' }, {
    fetcher(url) {
      assert.equal(url.origin, context.origin);
      assert.equal(url.searchParams.get('postId'), '42');
      return Response.json({ items: [media(1, 'image')] });
    },
  });
  assert.equal(fromPost.related.gallery[0].id, 1);
  assert.equal(fromPost.gallery.preferenceEligible, undefined);
  const refused = await discover(context, { scope: 'videos', query: '@a-creator' }, {
    fetcher(url) {
      assert.equal(url.pathname, CATALOG.blockImages);
      assert.equal(url.searchParams.get('username'), 'a-creator');
      return Response.json({ error: 'Gallery access unavailable' }, { status: 403 });
    },
  });
  assert.equal(refused.gallery.status, 'gallery-unavailable');
  assert.equal(new URL(refused.gallery.nativeLink).searchParams.get('username'), 'a-creator');
});

test('descriptive discovery combines distinct tag searches with metadata ranking and independent page cursors', async () => {
  const host = 'https://civitai.red';
  const context = contextFor(host);
  const gingerCat = { id: 197319, name: 'ginger cat' };
  const window = { id: 112359, name: 'window' };
  const sunny = { id: 119357, name: 'sunny' };
  const tags = [cats, gingerCat, window, sunny];
  const expected = ['197319,112359,119357', '5132,112359', '5132,119357', '112359,119357'];
  const observed = [];
  const fetcher = (url, options) => {
    assert.equal(url.origin, host);
    if (url.pathname === '/api/search/multi-search') {
      const queries = JSON.parse(options.body).queries;
      assert.ok(queries.some(q => q.q === 'window'));
      assert.ok(queries.some(q => q.q === 'sun'));
      assert.ok(queries.every(q => !q.q.includes('anime')));
      return Response.json({ results: queries.map(() => ({ hits: [{ tags }] })) });
    }
    assert.equal(url.pathname, CATALOG.blockImages);
    const rid = url.searchParams.get('tags');
    const cursor = url.searchParams.get('cursor');
    assert.equal(url.searchParams.get('withMeta'), 'true');
    assert.equal(url.searchParams.get('username'), 'a-creator');
    assert.equal(url.searchParams.get('type'), 'image');
    observed.push([rid, cursor]);
    const shared = media(10, 'image', { tags: [cats, window, sunny], meta: { prompt: 'Ginger cat on a window ledge.' } });
    const weak = media(11, 'image', { tags: [cats, window], meta: { prompt: 'A cat in a window.' } });
    if (cursor === 'pair:+one') return Response.json({ items: [weak] });
    if (rid === '5132,112359') return Response.json({ items: [weak, shared, media(12, 'image', { tags, browsingLevel: 8 }),
      media(13, 'image', { tags, needsReview: true }), media(14, 'image', { tags, meta: { prompt: 'Anime' } })],
      metadata: { nextCursor: 'pair:+one' } });
    if (rid === '112359,119357') return Response.json({ items: [shared, media(15, 'video', { tags })] });
    return Response.json({ items: [] });
  };
  const result = await discover(context, { scope: 'gallery', query: '@a-creator ginger cat on a sunny window ledge without anime' }, { fetcher });
  assert.deepEqual(observed.map(([rid]) => rid), expected);
  assert.deepEqual(result.related.gallery.map(item => item.id), [10, 11]);
  assert.deepEqual(result.related.gallery[0].mediaMatch, { tags: ['cat', 'window', 'sunny'], description: ['ginger', 'ledge'] });
  assert.equal(new URL(result.gallery.nativeLink).searchParams.get('username'), 'a-creator');
  assert.match(result.gallery.nativeLink, /without\+anime/u);
  const next = await readGalleryPage(context, result.gallery.plan, { cursor: result.gallery.nextCursor, fetcher });
  assert.deepEqual(observed.at(-1), ['5132,112359', 'pair:+one']);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(next.items.map(item => item.id), [11]);
});

test('gallery filters survive every ranked lane, explicit sort, and pagination without widening visibility', async () => {
  for (const [scope, type, mediaSort] of [['gallery', 'image', ''], ['videos', 'video', 'Oldest']]) {
    const context = contextFor('https://civitai.red');
    const window = { id: 112359, name: 'window' };
    const sunny = { id: 119357, name: 'sunny' };
    const tags = [cats, window, sunny];
    const settings = { scope, mediaSort, query: 'cat on a sunny window ledge', mediaCreator: '@a-creator',
      mediaPeriod: 'Month', mediaBaseModels: 'SDXL 1.0, Illustrious,SDXL 1.0', mediaPublishedPrompt: 'true' };
    const pages = [];
    const good = { tags, baseModel: 'SDXL 1.0', meta: { meta: { prompt: 'Cat on a sunny window ledge.' } } };
    const fetcher = (url, options) => {
      if (url.pathname === '/api/search/multi-search') {
        return Response.json({ results: JSON.parse(options.body).queries.map(() => ({ hits: [{ tags }] })) });
      }
      assert.equal(url.pathname, CATALOG.blockImages);
      const read = Object.fromEntries(url.searchParams);
      assert.equal(read.baseModels, 'SDXL 1.0,Illustrious');
      assert.equal(read.username, 'a-creator');
      assert.equal(read.period, 'Month');
      assert.equal(read.type, type);
      assert.equal(read.sort, mediaSort || 'Most Reactions');
      assert.equal(read.withMeta, 'true');
      for (const key of ['requiringMeta', 'hasPublishedPrompt', 'browsingLevel', 'nsfw']) assert.equal(read[key], undefined);
      assert.equal(options.headers.Authorization, 'Bearer read-only-test');
      pages.push(read);
      return Response.json({ items: read.cursor ? [media(31, type, good)] : [
        media(22, type, good), media(21, type, { ...good, baseModel: 'Illustrious' }),
        media(23, type, { ...good, baseModel: 'SD 1.5' }), media(24, type, { ...good, browsingLevel: 8 }),
        media(25, type, { ...good, username: 'other-user' }), media(26, type, { ...good, blockedFor: 'AiNotVerified' }),
        media(27, type, { ...good, meta: { title: 'Title without prompt' } }),
        media(28, type, { ...good, meta: { meta: { prompt: '  ' } } }),
      ], metadata: { nextCursor: read.cursor ? null : 'keep:+exact' } });
    };
    const first = await discover(context, settings, { fetcher });
    assert.ok(mediaSort ? pages.length === 1 : pages.length > 1);
    assert.equal(first.gallery.preferenceEligible, !mediaSort);
    assert.deepEqual(first.related[scope].map(row => row.id).sort(), [21, 22]);
    assert.equal(first.related[scope][0].id, 22, 'The original result order is preserved for equal matches.');
    const next = await readGalleryPage(context, first.gallery.plan, { cursor: first.gallery.nextCursor, fetcher });
    assert.deepEqual(next.items.map(row => row.id), [31]);
    assert.equal(pages.at(-1).cursor, 'keep:+exact');
    assert.equal(next.nextCursor, null);
  }
  const conflict = await discover(contextFor('https://civitai.com'), {
    scope: 'gallery', query: '@other-user cat', mediaCreator: 'a-creator',
  }, { fetcher() { assert.fail('Conflicting creators must not search a broader pool.'); } });
  assert.equal(conflict.gallery.status, 'creator-conflict');
});

test('an unavailable lane keeps its cursor while a successful lane continues to return results', async () => {
  const context = contextFor('https://civitai.com');
  const plan = { type: 'video', tags: [cats.id], sort: 'Most Reactions', ranking: {
    routes: [[cats.id], [landscape.id]], terms: ['cat', 'landscape'], subject: 'cat', excluded: [],
  } };
  const requested = [];
  const fetcher = url => {
    const tag = url.searchParams.get('tags');
    const cursor = url.searchParams.get('cursor');
    requested.push([tag, cursor]);
    if (requested.length === 2) return new Response(null, { status: 503 });
    return Response.json({ items: [media(7, 'video')] });
  };
  const first = await readGalleryPage(context, plan, { cursor: { positions: ['a:0', 'b:2'] }, fetcher });
  assert.deepEqual(first.items.map(item => item.id), [7]);
  assert.equal(first.partial, true);
  assert.deepEqual(first.nextCursor, { positions: [false, 'b:2'] });
  const next = await readGalleryPage(context, plan, { cursor: first.nextCursor, fetcher });
  assert.deepEqual(requested, [[String(cats.id), 'a:0'], [String(landscape.id), 'b:2'], [String(landscape.id), 'b:2']]);
  assert.equal(next.nextCursor, null);
});

test('explicit gallery sorting and direct tag picks keep their single filtered catalog path', async () => {
  const query = 'ginger cat on a sunny window ledge';
  const context = contextFor('https://civitai.com');
  const chosen = { id: 100, name: query };
  for (const filters of [{ mediaSort: 'Newest' }, { selectedMediaTag: chosen }]) {
    let mediaCalls = 0;
    const result = await discover(context, { scope: 'gallery', query, ...filters }, { fetcher(url, options) {
      if (url.pathname === '/api/search/multi-search') {
        assert.equal(filters.selectedMediaTag, undefined);
        return Response.json({ results: JSON.parse(options.body).queries.map(() => ({ hits: [{ tags: [chosen] }] })) });
      }
      mediaCalls++;
      assert.equal(url.searchParams.get('sort'), filters.mediaSort ?? 'Most Reactions');
      assert.equal(url.searchParams.get('tags'), String(chosen.id));
      assert.equal(url.searchParams.has('withMeta'), false);
      return Response.json({ items: [media(5, 'image', { tags: [chosen] })] });
    } });
    assert.equal(mediaCalls, 1);
    assert.equal(result.gallery.plan.ranking, undefined);
    assert.equal(result.related.gallery[0].id, 5);
  }
});

test('a public visual reference joins independent catalog leads after an eligible exact lookup', async () => {
  const context = contextFor('https://civitai.red');
  const anchor = media(101, 'image', { postId: 82, modelVersionIds: [], meta: { prompt: 'A cat in a landscape' } });
  const rows = [media(102, 'video', { postId: 82 }), media(103, 'video', { postId: 88 }),
    media(104, 'video', { postId: 82, browsingLevel: 8 }), media(105, 'image', { postId: 82 }),
    media(106, 'video', { postId: 82, blockedFor: 'fixture' })];
  const read = [];
  const progressive = [];
  const target = searchTarget(visualReferenceLink('https://civitai.com', 101));
  assert.deepEqual(target, { kind: 'similarMedia', id: 101 });
  assert.throws(() => searchTarget('https://civitai.com/images?similarTo=1&similarTo=2'), /one valid reference/u);
  const findings = await discoverVisualNeighbors(context, target, { scope: 'videos', mediaSort: 'Newest' }, {
    onRanked(result) { progressive.push(result); },
    fetcher(url, options) {
      assert.equal(url.origin, context.origin);
      if (url.pathname === '/api/v1/posts/82') {
        assert.equal(options.headers.Authorization, undefined);
        read.push('public post');
        return Response.json({ id: 82, modelVersionId: 121 });
      }
      assert.equal(url.pathname, CATALOG.blockImages);
      assert.equal(options.headers.Authorization, 'Bearer read-only-test');
      const filters = Object.fromEntries(url.searchParams);
      assert.equal(filters.withTags, 'true');
      if (filters.ids === '101') {
        assert.equal(options.cache, 'no-store');
        read.push('reference');
        return Response.json({ items: [anchor] });
      }
      assert.equal(filters.type, 'video');
      assert.equal(filters.sort, 'Newest');
      assert.equal(filters.limit, '8');
      if (filters.modelVersionId === '121') {
        read.push('model version');
        return Response.json({ items: [rows[1], rows[0]] });
      }
      if (filters.postId === '82') {
        read.push('post media');
        return Response.json({ items: [anchor, ...rows] });
      }
      read.push('tags ' + filters.tags);
      return filters.tags === '5132' ? new Response(null, { status: 503 }) : Response.json({ items: [rows[1]] });
    },
    compare(reference, candidates, { onPosters }) {
      assert.equal(reference.id, 101);
      assert.deepEqual(candidates.map(candidate => [candidate.id, candidate.visualSources]), [
        [102, ['Same post', 'Model version #121']], [103, ['Model version #121', 'Shared tags · cat, landscape']],
      ]);
      onPosters({ items: candidates, compared: 2, sampled: 0 });
      return { items: candidates.toReversed(), compared: 2, sampled: 1 };
    },
  });
  assert.equal(read[0], 'reference');
  assert.deepEqual(new Set(read.slice(1)), new Set(['public post', 'post media', 'model version', 'tags 5132,8363', 'tags 5132']));
  assert.deepEqual(findings.related.videos.map(item => item.id), [103, 102]);
  assert.deepEqual(progressive[0].related.videos.map(item => item.id), [102, 103]);
  assert.equal(progressive[0].visualSearch.sampled, 0);
  assert.equal(findings.gallery.incomplete, true);
  assert.equal(findings.visualSearch.unavailable, 1);
  assert.equal(findings.visualSearch.compared, 2);
  assert.equal(new URL(findings.gallery.nativeLink).searchParams.get('query'), 'cat landscape');
  assert.equal(findings.reference.link, context.origin + '/images/101');
});

test('a withheld reference stops visual discovery before catalog expansion and pixel reads', async () => {
  const origin = 'https://civitai.com';
  const queried = [];
  const result = await discover(contextFor(origin), { scope: 'gallery', query: visualReferenceLink(origin, 101) }, { fetcher(url) {
    queried.push(url.searchParams.get('ids'));
    return Response.json({ items: [media(101, 'image', { browsingLevel: 8 }), media(102, 'image')] });
  } });
  assert.deepEqual(queried, ['101']);
  assert.equal(result.gallery.status, 'visual-reference-unavailable');
  assert.equal(result.reference, null);
  assert.deepEqual(result.related.gallery, []);
});

test('visual composition checks exact references, combines two positive leads, and keeps exclusions out of retrieval', async () => {
  const context = contextFor('https://civitai.red');
  const cover = id => 'https://image.civitai.com/official/' + id + '.jpeg';
  const first = media(101, 'image', { url: cover(101), postId: 80, modelVersionIds: [120], tags: [cats] });
  const second = media(102, 'image', { url: cover(102), postId: 81, modelVersionIds: [121], tags: [cats] });
  const avoid = media(103, 'image', { url: cover(103), postId: 82, modelVersionIds: [122], tags: [motorcycle] });
  const withheld = media(104, 'image', { url: cover(104), modelVersionIds: [123], browsingLevel: 8 });
  const cues = [first, second, avoid, withheld].map((row, index) => ({
    role: 'texture', polarity: index === 2 ? 'avoid' : 'prefer', label: 'Picture #' + row.id, mediaId: row.id,
    publicPreview: row.url, features: { texture: index === 2 ? [0, 1] : [1, 0] },
  }));
  const candidates = [
    media(201, 'image', { url: cover(201), baseModel: 'SDXL 1.0', postId: 90 }),
    media(202, 'image', { url: cover(202), baseModel: 'SDXL 1.0', postId: 91 }),
    media(203, 'image', { url: cover(203), baseModel: 'Flux.1 D' }),
    media(204, 'image', { url: cover(103), baseModel: 'SDXL 1.0' }),
  ];
  const queries = [];
  const result = await discoverVisualComposition(context, { kind: 'text', value: '' },
    { scope: 'gallery', mediaBaseModels: 'SDXL 1.0', mediaSort: 'Newest', mediaPeriod: 'Month' }, cues, {
      searchCatalog() { throw new Error('Explicit catalog leads are available'); },
      fetcher(url, options) {
        assert.equal(url.origin, context.origin);
        assert.equal(url.pathname, CATALOG.blockImages);
        const q = Object.fromEntries(url.searchParams);
        if (q.ids) {
          assert.equal(options.cache, 'no-store');
          assert.equal(q.ids, '101,102,103,104');
          return Response.json({ items: [first, second, avoid, withheld] });
        }
        assert.equal(q.type, 'image');
        assert.equal(q.baseModels, 'SDXL 1.0');
        assert.equal(q.sort, 'Newest');
        assert.equal(q.period, 'Month');
        const lane = q.modelVersionId ?? q.tags;
        queries.push(lane);
        if (lane === '120') return Response.json({ items: [first, candidates[0], candidates[2]] });
        if (lane === '121') return Response.json({ items: [second, candidates[1]] });
        return Response.json({ items: [candidates[1], candidates[3]] });
      },
      rank(items, score) {
        const compared = items.map(item => ({ ...item, visualMatch: score({ texture: item.id === 202 ? [0, 1] : [1, 0] }) }));
        return { items: compared, compared: compared.length, sampled: 0 };
      },
    });
  assert.deepEqual(queries.toSorted(), ['120', '121', '5132']);
  assert.equal(result.visualComposition.unavailableReferences, 1);
  assert.deepEqual(result.visualComposition.cues.map(cue => cue.public.id), [101, 102, 103]);
  assert.deepEqual(result.related.gallery.map(item => item.id).toSorted(), [201, 202]);
  assert.equal(result.related.gallery.find(item => item.id === 201).visualMatch.score, 1);
  assert.equal(result.related.gallery.find(item => item.id === 202).visualMatch.score, 0);
  assert.equal(result.related.gallery.find(item => item.id === 202).visualSources.length, 3);
  assert.equal(result.gallery.nextCursor, null);
  assert.equal(visualReferenceId('https://civitai.com/images/101?ref=example'), 101);
  assert.equal(visualReferenceId('https://civitai.com.example/images/101'), null);
});

test('text keeps the normal catalog filters and accepts local visual traits without sending their details', async () => {
  const context = contextFor('https://civitai.com');
  const searches = [];
  const filters = { scope: 'gallery', query: 'cat without motorcycle', mediaCreator: 'a-creator',
    mediaBaseModels: 'SDXL 1.0', mediaSort: 'Newest' };
  const result = await discover(context, filters, {
    visualBrief: [{ label: 'local-name-fixture.png', role: 'lighting', region: [.2, .2, .8, .8], features: { lighting: [1] } }],
    fetcher(url, options) {
      searches.push(url.pathname + url.search + (options.body ?? ''));
      if (url.pathname === '/api/search/multi-search') {
        return Response.json({ results: JSON.parse(options.body).queries.map(() => ({ hits: [{ tags: [cats, motorcycle] }] })) });
      }
      assert.equal(url.searchParams.get('tags'), '5132');
      assert.equal(url.searchParams.get('username'), 'a-creator');
      return Response.json({ items: [
        media(5, 'image', { tags: [cats], baseModel: 'SDXL 1.0' }),
        media(6, 'image', { tags: [cats, motorcycle], baseModel: 'SDXL 1.0' }),
        media(7, 'image', { tags: [cats], baseModel: 'Flux.1 D' }),
      ] });
    },
  });
  assert.deepEqual(result.related.gallery.map(item => item.id), [5]);
  assert.equal(result.visualComposition.cues[0].label, 'local-name-fixture.png');
  assert.doesNotMatch(searches.join('\n'), /local-name-fixture|0\.2/u);
  assert.ok(searches.every(url => !url.includes('ids=')));
});

test('visual references expand descriptive search within the same subject, filters, and candidate limit', async () => {
  const context = contextFor('https://civitai.red');
  const cover = id => 'https://image.civitai.com/official/' + id + '.jpeg';
  const ref = (id, versionId) => media(id, 'image', { url: cover(id), modelVersionIds: [versionId], tags: [cats] });
  const references = [ref(110, 120), ref(111, 121), ref(112, 122)];
  const cues = references.map((item, i) => ({ role: 'texture', mediaId: item.id, publicPreview: item.url,
    label: 'Picture #' + item.id, polarity: i === 2 ? 'avoid' : 'prefer', features: { texture: [1, 0] } }));
  const textRows = Array.from({ length: 24 }, (_, i) => ({ id: 200 + i, preview: cover(200 + i) }));
  const found = (id, fields = {}) => media(id, 'image', { url: cover(id), baseModel: 'SDXL 1.0', postId: id + 1_000,
    tags: [cats], meta: { prompt: 'ginger cat on a sunny window' }, ...fields });
  const plan = { type: 'image', tags: [cats.id], sort: 'Most Reactions', username: 'a-creator', baseModels: 'SDXL 1.0',
    period: 'Month', hasPublishedPrompt: true, ranking: { routes: [[cats.id]], subject: 'cat',
      terms: ['ginger', 'cat', 'sun', 'window'], excluded: [['cartoon']] } };
  const lanes = [];
  const query = 'ginger cat on a sunny window without cartoon';
  const result = await discoverVisualComposition(context, { kind: 'text', value: query }, { scope: 'gallery' }, cues, {
    searchCatalog: () => ({ gallery: { status: 'ready', partial: true, plan }, related: { gallery: textRows } }),
    fetcher(url) {
      assert.equal(url.origin, context.origin);
      assert.equal(url.pathname, CATALOG.blockImages);
      const q = Object.fromEntries(url.searchParams);
      if (q.ids) {
        assert.equal(q.ids, '110,111,112');
        return Response.json({ items: references });
      }
      lanes.push(q.modelVersionId);
      assert.equal(q.username, 'a-creator');
      assert.equal(q.baseModels, 'SDXL 1.0');
      assert.equal(q.period, 'Month');
      assert.equal(q.sort, 'Most Reactions');
      assert.equal(q.withMeta, 'true');
      return Response.json({ items: q.modelVersionId === '120' ? [found(200), found(901),
        found(902, { tags: [landscape], meta: { prompt: 'sunny window with ginger decoration' } }),
        found(903, { meta: { prompt: 'cartoon ginger cat' } }), found(904, { browsingLevel: 8 })] : [found(905),
        found(906, { username: 'different-creator' }), found(907, { baseModel: 'SD 1.5' }), found(908, { meta: {} }),
        found(909, { url: cover(211) })] });
    },
    rank: items => ({ items, compared: items.length, sampled: 0 }),
  });
  assert.deepEqual(lanes.toSorted(), ['120', '121']);
  assert.deepEqual(result.visualComposition.order, [...textRows.slice(0, 22).map(item => item.id), 905, 901]);
  assert.equal(result.visualComposition.referenceMatchesAdded, 2);
  assert.ok(result.related.gallery[0].visualSources[0].includes('reference #110'));
  assert.equal(result.related.gallery.at(-1).rankEvidence.subject, 2);
  assert.equal(result.gallery.nextCursor, null);
});

test('an exact tag and exclusion stay in the reference request and a failed lead leaves the search results usable', async () => {
  const context = contextFor('https://civitai.com');
  const reference = media(110, 'image', { tags: [cats], modelVersionIds: [120] });
  const plan = { type: 'image', tags: [cats.id], sort: 'Newest', exclusions: [['motorcycle']] };
  const original = [{ id: 201, preview: 'https://image.civitai.com/official/201.jpeg' }];
  const requests = [];
  const result = await discoverVisualComposition(context, { kind: 'text', value: 'cat without motorcycle' }, { scope: 'gallery' },
    [{ role: 'texture', mediaId: 110, publicPreview: reference.url, features: { texture: [1, 0] } }], {
      searchCatalog: () => ({ gallery: { status: 'ready', plan }, related: { gallery: original } }),
      fetcher(url) {
        const query = Object.fromEntries(url.searchParams);
        if (query.ids) return Response.json({ items: [reference] });
        requests.push(query);
        return Response.json({}, { status: 429 });
      },
      rank: items => ({ items, compared: 0, sampled: 0 }),
    });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].modelVersionId, '120');
  assert.equal(requests[0].tags, String(cats.id));
  assert.equal(requests[0].sort, 'Newest');
  assert.equal(requests[0].withMeta, 'true');
  assert.deepEqual(result.related.gallery, original);
  assert.equal(result.gallery.incomplete, true);
});

test('a reference continues the exact tag lane on its existing cursor when the clip pool has room', async () => {
  const context = contextFor('https://civitai.red');
  const reference = media(110, 'video', { tags: [motorcycle] });
  const plan = { type: 'video', tags: [motorcycle.id], sort: 'Most Reactions', ranking: {
    routes: [[motorcycle.id], [cats.id]], subject: 'motorcycle', terms: ['motorcycle', 'rain', 'night'], excluded: [],
  } };
  const first = { id: 200, video: true, preview: 'https://image.civitai.com/official/200.jpeg' };
  const reads = [];
  const result = await discoverVisualComposition(context, { kind: 'text', value: 'motorcycle in rain at night' }, { scope: 'videos' },
    [{ role: 'texture', mediaId: 110, publicPreview: poster, features: { texture: [1, 0] } }], {
      searchCatalog: () => ({ gallery: { status: 'ready', plan, nextCursor: { positions: ['next-motorcycle', 'other-lane'] } },
        related: { videos: [first] } }),
      fetcher(url) {
        const query = Object.fromEntries(url.searchParams);
        if (query.ids) return Response.json({ items: [reference] });
        reads.push(query);
        return Response.json({ items: [media(201, 'video', { tags: [motorcycle], meta: { prompt: 'motorcycle in rain' },
          thumbnail: { url: 'https://image.civitai.com/official/201.jpeg' } })] });
      },
      rank: items => ({ items, compared: 0, sampled: 0 }),
    });
  assert.deepEqual(reads.map(({ tags, cursor }) => [tags, cursor]), [[String(motorcycle.id), 'next-motorcycle']]);
  assert.deepEqual(result.visualComposition.order, [200, 201]);
  assert.equal(result.visualComposition.referenceMatchesAdded, 1);
  assert.equal(result.gallery.nextCursor, null);
});
