import test from 'node:test';
import { blockFixtureToken } from '../mock/host-fixture.mjs';
import assert from 'node:assert/strict';
import { CATALOG, catalogUrl } from '../src/catalog.mjs';
import { discover, mediaUrl, queryVariants, rankVersions, readModelPage, searchTarget } from '../src/search.mjs';
import { quickSearchIntent, suggestedCatalogSearch } from '../src/search-intent.mjs';
import { mergeQuickCatalog, readQuickCatalog, sampleQuickCatalog } from '../src/quick-catalog.mjs';
import { isNativeModelNavigation, nativeModelSearchLink, readNativeModelSearch } from '../src/native-model-search.mjs';
import { translateCatalogTerms, translateOnDevice } from '../src/query-language.mjs';
import { researchPlans } from '../src/research.mjs';
import { orchestrationClient } from '../scripts/orchestration.mjs';
import { appEstimateBody, batchQuotePrices, estimateAppWorkflow, quotePrice } from '../src/quotes.mjs';
import { watchHost } from '../src/civitai-host.js';
import { createFilterFeed } from '../scripts/filter-feed.mjs';
import { FILTER_REFRESH_MS, applyFilterChoices, toolFilterChoices } from '../src/filter-sources.mjs';
import { createFilterHandler } from '../scripts/filter-feed.mjs';
import { fetchFilterMetadata } from '../src/filter-sources.mjs';
import { PUBLIC_FILTER_FEED } from '../src/runtime-config.mjs';
import { createProofreader, draftSuggestions, filterMatches, reviseDraft, searchStarts } from '../src/text-assist.mjs';
import { matchPreviewQuotes } from '../src/quotes.mjs';
import { createHash } from 'node:crypto';

const com = 'https://civitai.com';
const makeModel = (id, version, name, opts = {}) => ({
  id, name, type: opts.type ?? 'LORA', description: opts.description ?? '',
  modelVersions: [{ id: version, name: 'v1', baseModel: opts.base ?? 'SDXL 1.0' }],
});

test('exact references keep both IDs and reject other origins', () => {
  assert.deepEqual(searchTarget('https://civitai.red/models/25/demo?modelVersionId=91'),
    { kind: 'version', id: 91, modelId: 25 });
  assert.deepEqual(searchTarget('https://civitai.com/images/88'), { kind: 'image', id: 88 });
  assert.deepEqual(searchTarget('https://civitai.red/collections/18549055'), { kind: 'collection', id: 18549055 });
  assert.throws(() => searchTarget('https://civitai.com.example.org/images/88'));
  assert.throws(() => searchTarget('https://civitai.com/models/25?modelVersionId=91&modelVersionId=92'));
  assert.throws(() => catalogUrl(com, '/api/v1/blocks/workflows/submit'));
  assert.equal(mediaUrl('https://untrusted.example/sample.png'), null);
});

test('free search turns a descriptive brief into a focused style query and a synonym', () => {
  assert.deepEqual(queryVariants('Find me some textured linocut'), ['Find me some textured linocut', 'linocut', 'relief print']);
});

test('quick search recognizes explicit research tasks and preserves their exact references', () => {
  const cases = [
    ['Plan a short illustrated story about cyberpunk', 'stories', 'Plan a short illustrated story about cyberpunk'],
    ['Explore @Booyaka linocut', 'creator', '@Booyaka linocut'],
    ['What models were used in https://civitai.red/images/88', 'trace', 'https://civitai.red/images/88'],
    ['Follow this guide https://civitai.com/articles/1043', 'guide', 'https://civitai.com/articles/1043'],
    ['Explore the collection https://civitai.red/collections/18549055', 'collection', 'https://civitai.red/collections/18549055'],
    ['Explore model https://civitai.com/models/25/demo?modelVersionId=91', 'release', 'https://civitai.com/models/25/demo?modelVersionId=91'],
    ['https://civitai.com/images/201 https://civitai.red/images/202', 'examplePair', 'https://civitai.com/images/201 https://civitai.red/images/202'],
  ];
  for (const [input, reportType, query] of cases) {
    const action = quickSearchIntent(input);
    assert.equal(action.reportType, reportType);
    assert.equal(action.query, query);
    assert.equal(Boolean(action.literal), reportType !== 'examplePair');
  }
});

test('quick search leaves literal titles, exact lookups, and unsupported references on their original path', () => {
  for (const query of ['DreamShaper', '城市印刷', 'Linocut story', 'Plan a short illustrated story about', 'Follow the white rabbit',
    'https://civitai.red/images/88', 'https://civitai.com/models/25/demo?modelVersionId=91', 'version: 91', '201 202',
    'Explore @account@example.com', 'Trace https://civitai.com.example.net/images/88', 'Trace https://guest@civitai.com/images/88',
    'What made https://civitai.com/user/account', 'Follow https://civitai.red/models/160',
    'Plan a story about linocut https://civitai.com/user/account', 'https://civitai.com/images/88 https://civitai.red/images/88']) {
    assert.equal(quickSearchIntent(query), null, query);
  }
});

test('catalog phrases offer a focused public search without changing default submit behavior', () => {
  for (const [draft, scope, query] of [
    ['Show me videos of motorcycles without anime', 'videos', 'motorcycles without anime'],
    ['Guides for ComfyUI', 'articles', 'ComfyUI'],
    ['Buscar fotos de gatos', 'gallery', 'gatos'],
    ['Trouver des vidéos de moto', 'videos', 'moto'],
    ['Music like Citypop', 'audio', 'Citypop'],
    ['An AI service to extract stills from video', 'aiServices', 'extract stills from video'],
  ]) {
    const intent = suggestedCatalogSearch(draft);
    assert.equal(intent?.scope, scope);
    assert.equal(intent?.query, query);
    assert.equal(quickSearchIntent(draft), null, 'Enter must still submit the full draft');
  }
});

test('catalog suggestions skip exact links, unfinished phrases, and account commands', () => {
  for (const draft of ['DreamShaper', 'Videos of', 'Photos of ?', 'Search my downloads', 'Show me notifications',
    'Posts by https://civitai.red/user/artist', 'What made https://civitai.com/images/1', 'Tools for\nComfyUI',
    'Videos of ' + 'a'.repeat(300)]) assert.equal(suggestedCatalogSearch(draft), null, draft);
});

test('quick catalog batches eligible areas and reads only media that proves the exact matching tag', async () => {
  const calls = [];
  const context = { origin: com, hosted: true, token: 'browse-fixture', browsingLevel: 3 };
  const rated = { id: 81, type: 'image', browsingLevel: 1, postId: 412, url: 'https://image.civitai.com/fixture/sample.png',
    tags: [{ id: 77, name: 'landscape' }] };
  const article = { id: 61, title: 'Landscape lighting', status: 'Published', availability: 'Public', nsfwLevel: [1] };
  const byIndex = {
    articles_v5: [article, { ...article, id: 62, unlisted: true }, { ...article, id: 63, nsfwLevel: [4] },
      { ...article, id: 64, availability: 'Private' }],
    tools_v2: [{ id: 67, name: 'Unrelated sound utility' }],
    comics_v1: [{ id: 14, name: 'Landscape legends', nsfwLevel: [1] }],
    users_v3: [{ id: 11, username: 'landscape' }, { id: 12, username: 'landscape_builder' }],
    bounties_v3: [{ id: 71, name: 'Landscape illustration', nsfwLevel: [1] }, { id: 72, name: 'Unrelated challenge', nsfwLevel: [1] }],
    models_v9: [{ tags: [{ id: 77, name: 'landscape' }, { id: 78, name: 'ink' }] }],
  };
  const options = {
    async fetcher(url, request) {
      assert.equal(url.origin, com);
      assert.equal(request.credentials, 'omit');
      calls.push(url.pathname);
      let data;
      if (url.pathname === '/api/search/multi-search') {
        assert.equal(request.headers.Authorization, undefined);
        const { queries } = JSON.parse(request.body);
        assert.deepEqual(queries.map(({ indexUid }) => indexUid), Object.keys(byIndex));
        data = { results: queries.map(({ indexUid }) => ({ indexUid, hits: byIndex[indexUid] })) };
      } else {
        assert.equal(request.headers.Authorization, 'Bearer browse-fixture');
        assert.equal(url.pathname, CATALOG.blockImages);
        assert.equal(url.searchParams.get('tags'), '77');
        const video = url.searchParams.get('type') === 'video';
        data = { items: video ? [{ ...rated, id: 85, type: 'video', url: 'https://image.civitai.com/fixture/clip.mp4' }]
          : [rated, { ...rated, id: 82, needsReview: true }, { ...rated, id: 83, tags: [] }, { ...rated, id: 84, browsingLevel: 4 }] };
      }
      return Response.json(data);
    },
  };
  const index = await readQuickCatalog(context, 'Landscape', options);
  const exact = await sampleQuickCatalog(context, index, [{ nameMatch: 2 }], options);
  assert.equal(exact.groups.gallery, undefined);
  assert.deepEqual(calls, ['/api/search/multi-search']);
  const result = await sampleQuickCatalog(context, index, [], options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['/api/search/multi-search', CATALOG.blockImages, CATALOG.blockImages]);
  assert.deepEqual(Object.fromEntries(Object.entries(result.groups).map(([group, cards]) => [group, cards.map(item => item.id)])),
    { guides: [61], tools: [], comics: [14], creators: [11], bounties: [71], gallery: [81], videos: [85] });
});

test('a quick search promotes an exact tool only when an exact model did not match', () => {
  const guide = { title: 'ComfyUI guide', link: com + '/articles/2' };
  const tool = { title: 'ComfyUI', link: com + '/tools/comfyui' };
  const overview = { status: 'ready', exact: 'tools', areas: [], groups: { tools: [tool], guides: [guide] } };
  const primary = { guides: [guide] };
  assert.deepEqual(mergeQuickCatalog(primary, overview, [{ nameMatch: 2 }], 'ComfyUI').quickCatalog.lead, null);
  const result = mergeQuickCatalog(primary, overview, [{ nameMatch: 0 }], 'ComfyUI');
  assert.equal(result.quickCatalog.lead, 'tools');
  assert.deepEqual(result.related.guides, [guide]);
  assert.deepEqual(result.related.tools, [tool]);
});

test('an unavailable cross-area sample keeps the original free catalog results', async () => {
  const context = { origin: com, hosted: true, browsingLevel: 3 };
  const unavailable = await readQuickCatalog(context, 'ComfyUI', {
    fetcher: async () => Response.json({ message: 'Search is unavailable' }, { status: 503 }),
  });
  const sampled = await sampleQuickCatalog(context, unavailable, []);
  const original = { guides: [{ title: 'ComfyUI guide', link: com + '/articles/2' }] };
  const result = mergeQuickCatalog(original, sampled, [], 'ComfyUI');
  assert.equal(result.quickCatalog.status, 'unavailable');
  assert.deepEqual(result.related, original);
});

test('combined ranking preserves base, type and exclusion constraints', () => {
  const sources = [
    { label: 'Civitai model search', models: [
      makeModel(11, 31, 'Linocut'),
      makeModel(12, 32, 'Linocut film', { description: 'Designed for photorealistic rendering.' }),
      makeModel(13, 33, 'Linocut', { base: 'Flux.1 D' }),
      makeModel(14, 34, 'Linocut', { type: 'Checkpoint' }),
    ] },
    { label: 'Query expansion 1', models: [
      makeModel(16, 36, 'Relief print'),
      makeModel(11, 31, 'Linocut'),
    ] },
  ];
  const result = rankVersions(sources, 'linocut',
    { baseModel: 'SDXL 1.0', resourceType: 'LORA', exclude: 'photorealistic' });
  assert.deepEqual(result.map(candidate => candidate.id), [31, 36]);
  assert.equal(result[0].retrieval.length, 2);
});

test('model selections use OR within facets and require generation support from the exact displayed release', async () => {
  const selected = { scope: 'models', query: '', baseModel: ['SD 1.5', 'SDXL 1.0'],
    resourceType: ['Checkpoint', 'LORA'], supportsGeneration: 'true' };
  const context = { origin: com, hosted: true, token: 'fixture', browsingLevel: 3 };
  const record = (id, type, releases) => ({
    id, type, name: 'Catalog model ' + id, supportsGeneration: true,
    modelVersions: releases.map(([id, baseModel, supportsGeneration]) => ({ id, baseModel, supportsGeneration, trainedWords: [] })),
  });
  const first = record(1, 'Checkpoint', [[81, 'SD 1.5', false], [80, 'SD 1.5', true]]);
  const second = record(2, 'LORA', [[82, 'SDXL 1.0', true]]);
  const wrongType = record(3, 'Controlnet', [[83, 'SDXL 1.0', true]]);
  const wrongFamily = record(4, 'LORA', [[84, 'Flux.1 D', true]]);
  const unknown = record(5, 'LORA', [[85, 'SDXL 1.0']]);
  const remaining = record(6, 'Checkpoint', [[86, 'SD 1.5', true]]);
  const calls = [];
  const fetcher = async url => {
    if (url.pathname === CATALOG.blockImages) return Response.json({ items: [] });
    assert.equal(url.pathname, CATALOG.blockModels);
    if (url.searchParams.has('modelVersionIds')) {
      assert.equal(url.searchParams.get('modelVersionIds'), '81');
      return Response.json({ items: [first] });
    }
    assert.deepEqual(url.searchParams.getAll('baseModels'), selected.baseModel);
    assert.deepEqual(url.searchParams.getAll('types'), selected.resourceType);
    assert.equal(url.searchParams.get('supportsGeneration'), 'true');
    const cursor = url.searchParams.get('cursor');
    calls.push(cursor);
    return cursor ? Response.json({ items: [unknown, remaining] }) : Response.json({
      items: [first, second, wrongType, wrongFamily], metadata: { nextCursor: 'next-civitai-page' },
    });
  };
  const results = await discover(context, selected, { fetcher, catalogOnly: true });
  assert.deepEqual(results.candidates.map(row => row.id), [80, 82]);
  const page = await readModelPage(context, results.modelPager.nextCursor, { fetcher });
  assert.deepEqual(page.items.map(row => row.id), [86]);
  assert.deepEqual(calls, [null, 'next-civitai-page']);
  const exact = com + '/models/1?modelVersionId=81';
  const hidden = await discover(context, { ...selected, query: exact }, { fetcher, catalogOnly: true });
  assert.deepEqual(hidden.candidates, []);
  const visible = await discover(context, { ...selected, query: exact, supportsGeneration: '' }, { fetcher, catalogOnly: true });
  assert.equal(visible.candidates[0].id, 81);
});

test('public Civitai model search links carry the verified facets in both directions', () => {
  const filters = { scope: 'models', query: 'DreamShaper', modelAuthor: 'Lykon', baseModel: ['SD 1.5', 'SDXL 1.0'],
    resourceType: ['Checkpoint', 'LORA'], supportsGeneration: 'true', downloadAccess: 'free', fileFormat: 'SafeTensor', sort: 'Newest' };
  for (const origin of [com, 'https://civitai.red']) {
    const link = nativeModelSearchLink(origin, { kind: 'text', value: filters.query }, { ...filters, exclude: 'test term' });
    const url = new URL(link);
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/models');
    assert.deepEqual(url.searchParams.getAll('baseModels'), filters.baseModel);
    assert.deepEqual(url.searchParams.getAll('types'), filters.resourceType);
    assert.equal(url.searchParams.get('fileFormats'), 'SafeTensor');
    assert.equal(url.searchParams.get('hidePaid'), 'true');
    assert.equal(url.searchParams.has('exclude'), false);
    assert.deepEqual(readNativeModelSearch(url), { origin, filters });
    assert.equal(isNativeModelNavigation(url), true);
    url.searchParams.set('utm_source', 'test');
    assert.deepEqual(readNativeModelSearch(url), { origin, filters });
    assert.equal(isNativeModelNavigation(url), false);
  }
  const old = com + '/search/models?query=DreamShaper&baseModel=SD+1.5&modelType=Checkpoint&modelType=LORA&users=Lykon';
  assert.deepEqual(readNativeModelSearch(old)?.filters, { scope: 'models', query: 'DreamShaper', modelAuthor: 'Lykon',
    baseModel: 'SD 1.5', resourceType: ['Checkpoint', 'LORA'] });
  assert.deepEqual(readNativeModelSearch(com + '/models?tag=linocut&period=Week&sort=Most+Liked')?.filters,
    { scope: 'models', query: '', category: 'linocut', period: 'Week', sort: 'Most Liked' });
  assert.equal(readNativeModelSearch('https://civitai.com.invalid/models?query=DreamShaper'), null);
  for (const search of ['?favorites=true', '?query=linocut&query=another', '?query=linocut&period=Day', '?hidePaid=true&paidAccess=true',
    '?fileFormats=GGUF&fileFormats=ONNX', '?query=https%3A%2F%2Fcivitai.com%2Fmodels%2F4', '?redirect=https%3A%2F%2Fexample.com']) {
    const url = new URL(com + '/models' + search);
    assert.ok(readNativeModelSearch(url)?.reason);
    assert.equal(isNativeModelNavigation(url), false);
  }
});

test('creator searches use the public Site filter and verify the creator of the exact App result', async () => {
  const filters = { scope: 'models', query: '', modelAuthor: '@Lykon', sort: 'Newest' };
  const good = { ...makeModel(4, 8, 'DreamShaper'), creator: { username: 'Lykon' } };
  const other = { ...makeModel(9, 10, 'Other'), creator: { username: 'Different' } };
  const changed = { ...makeModel(12, 13, 'Updated creator'), creator: good.creator };
  const paths = [];
  const result = await discover({ origin: com, hosted: true, token: 'fixture', browsingLevel: 3 }, filters, {
    catalogOnly: true,
    fetcher(url, options) {
      paths.push(url.pathname);
      if (url.pathname === CATALOG.models) {
        assert.equal(url.searchParams.get('username'), 'Lykon');
        assert.equal(options.headers.Authorization, undefined);
        return Response.json({ items: [good, other, changed] });
      }
      assert.equal(url.pathname, CATALOG.blockModels);
      assert.equal(url.searchParams.get('modelVersionIds'), '8,13');
      assert.equal(options.headers.Authorization, 'Bearer fixture');
      return Response.json({ items: [good, { ...changed, creator: other.creator }] });
    },
  });
  assert.deepEqual(paths, [CATALOG.models, CATALOG.blockModels]);
  assert.deepEqual(result.candidates.map(candidate => [candidate.id, candidate.creator]), [[8, 'Lykon']]);
  assert.equal(new URL(result.nativeLink).searchParams.get('username'), 'Lykon');
  const exact = await discover({ origin: com, hosted: false, browsingLevel: 1 }, {
    ...filters, query: com + '/models/4?modelVersionId=8',
  }, {
    catalogOnly: true, fetcher(url) {
      if (url.pathname === '/api/v1/model-versions/8') return Response.json({ ...good.modelVersions[0], modelId: 4, model: { name: good.name, type: good.type } });
      assert.equal(url.pathname, '/api/v1/models/4');
      return Response.json(good);
    },
  });
  assert.deepEqual(exact.candidates.map(candidate => [candidate.id, candidate.creator]), [[8, 'Lykon']]);
});

test('exact titles and explicit releases beat repeated hits while ties keep catalog order', () => {
  const named = makeModel(40, 41, 'Réalisme Visuel V6.0 B1');
  const duplicate = makeModel(49, 59, 'Réalisme Visuel V6.0 B1');
  const derivative = makeModel(50, 60, 'Réalisme Visuel ULTRA');
  const others = [derivative, duplicate];
  const lists = [
    { label: 'Civitai model search', models: [named, ...others] },
    { label: 'Query expansion 1', models: others },
    { label: 'Query expansion 2', models: others },
    { label: 'Catalog tag matches', models: others },
  ];
  assert.deepEqual(rankVersions(lists, 'Realisme Visuel').map(row => row.id), [41, 59, 60]);
  assert.equal(rankVersions(lists, 'RÉALISME VISUEL V6.0 B1')[0].id, 41);
  assert.equal(rankVersions(lists, 'Realisme Visuel', { baseModel: 'Flux.1 D' }).length, 0);
  assert.equal(rankVersions(lists, '')[0].id, 60);
  const exact = makeModel(51, 61, 'Réalisme Visuel');
  lists[2].models = [derivative, exact];
  assert.equal(rankVersions(lists, 'réalisme visuel')[0].id, 61);
});

test('typed typos and multilingual terms recover model results under the same hosted filters', async () => {
  for (const [origin, input, expanded, goodTitle] of [
    [com, 'lincout', 'linocut', 'Linocut Relief Print'],
    ['https://civitai.red', '水彩画', 'watercolor', 'Watercolor Wash XL'],
  ]) {
    const calls = [];
    const result = await discover({ origin, hosted: true, token: 'test', browsingLevel: 3 }, {
      query: input, scope: 'models', baseModel: 'SDXL 1.0', resourceType: 'LORA', exclude: 'photo',
    }, { fetcher(url, options) {
      assert.equal(url.origin, origin);
      assert.equal(options.method ?? 'GET', 'GET');
      if (url.pathname !== CATALOG.blockModels) return Response.json({ items: [] });
      const query = url.searchParams.get('query');
      calls.push(query);
      assert.equal(url.searchParams.get('baseModels'), 'SDXL 1.0');
      assert.equal(url.searchParams.get('types'), 'LORA');
      if (query !== expanded) return Response.json({ items: [] });
      return Response.json({ items: [
        makeModel(40, 41, goodTitle, { base: 'Flux.1 D' }),
        makeModel(51, 52, goodTitle, { description: 'Photo-style prompting' }),
        makeModel(60, 61, goodTitle),
      ] });
    } });
    assert.deepEqual(calls, [input, expanded]);
    assert.equal(result.target.value, input);
    assert.deepEqual(result.candidates.map(row => row.id), [61]);
    assert.deepEqual(result.alternateQueries, [expanded]);
  }
});

test('long style briefs keep both focused searches and leave valid words alone', async () => {
  const query = 'find a carved block print style like linocut';
  const catalogQueries = [];
  const result = await discover({ origin: com, hosted: true, token: 'test', browsingLevel: 3 },
    { query, scope: 'models' }, { fetcher(url) {
      if (url.pathname !== CATALOG.blockModels) return Response.json({ items: [] });
      const search = url.searchParams.get('query');
      catalogQueries.push(search);
      return Response.json({ items: [search === query
        ? makeModel(40, 41, 'Finding the right workflow')
        : makeModel(50, 51, 'Linocut Relief Print')] });
    } });
  assert.deepEqual(catalogQueries, [query, 'linocut', 'relief print']);
  assert.equal(result.candidates[0].id, 51);
  assert.deepEqual(result.alternateQueries, []);
});

test('descriptive model searches reach the final phrase within the existing budget and rerank only eligible models', async () => {
  const context = { origin: com, hosted: true, token: 'test', browsingLevel: 3 };
  const query = 'Old folktale black ink illustrations with rough carved lines, woodcut engraving';
  const requests = [];
  const general = [makeModel(40, 41, 'Old studio layout'), makeModel(45, 46, 'Old print catalog')];
  const candidates = [makeModel(55, 56, 'Woodcut engraving press', { description: 'Black ink, rough carved lines, folktale illustrations' }),
    makeModel(65, 66, query, { base: 'Flux.1 D' }), makeModel(75, 76, query, { description: 'This is an anime style.' })];
  const filters = { scope: 'models', query, baseModel: 'SDXL 1.0', resourceType: 'LORA', exclude: 'anime' };
  const search = (options = {}, nextFilters = {}) => discover(context, { ...filters, ...nextFilters }, {
    catalogOnly: true,
    fetcher(url, init) {
      assert.equal(init.method ?? 'GET', 'GET');
      if (url.pathname !== CATALOG.blockModels) return Response.json({ items: [] });
      assert.equal(url.searchParams.get('baseModels'), 'SDXL 1.0');
      assert.equal(url.searchParams.get('types'), 'LORA');
      const phrase = url.searchParams.get('query');
      requests.push(phrase);
      return Response.json({ items: phrase === 'woodcut engraving' ? candidates : general });
    }, ...options,
  });
  const old = await search({ rankModelEvidence: false, focusModelBrief: false });
  const count = requests.length;
  requests.length = 0;
  const ranked = await search();
  assert.equal(requests.length, count);
  assert.equal(requests.at(-1), 'woodcut engraving');
  assert.deepEqual(old.candidates.map(row => row.id), [41, 46]);
  assert.equal(ranked.candidates[0].id, 56);
  assert.ok(ranked.candidates[0].matchedCatalogTerms.includes('engraving'));
  assert.deepEqual(ranked.candidates.map(row => row.id).sort(), [41, 46, 56]);
  general.unshift(makeModel(80, 81, query));
  const named = await search();
  assert.equal(named.candidates[0].id, 81);
  requests.length = 0;
  const newest = await search({}, { sort: 'Newest' });
  assert.ok(!requests.includes('woodcut engraving'));
  assert.ok(newest.candidates.every(row => !row.matchedCatalogTerms));
});

test('empty catalog results can recover an unlisted typo with one validated prefix lookup', async () => {
  const context = { origin: com, hosted: true, token: 'test', browsingLevel: 3 };
  const model = makeModel(40, 41, 'FogBrush V2');
  const unrelated = makeModel(50, 51, 'FogBringer V2');
  const catalogQueries = [];
  const result = await discover(context, { query: 'FogBrsh', scope: 'models' }, { fetcher(url) {
    if (url.pathname !== CATALOG.blockModels) return Response.json({ items: [] });
    const query = url.searchParams.get('query');
    catalogQueries.push(query);
    return Response.json({ items: query === 'fogb' ? [unrelated, model] : [] });
  } });
  assert.deepEqual(catalogQueries, ['FogBrsh', 'fogb']);
  assert.deepEqual(result.candidates.map(row => row.id), [41]);
});

test('localized concepts preserve native queries and expand public article titles only when needed', async () => {
  assert.deepEqual(translateCatalogTerms('Paisaje en acuarela'), { focus: 'landscape watercolor', brief: 'landscape en watercolor' });
  assert.deepEqual(translateCatalogTerms('風景の水彩画'), { focus: 'landscape watercolor', brief: 'landscape の watercolor' });
  assert.equal(translateCatalogTerms('https://civitai.com/models/24/acuarela'), null);
  const seen = [];
  const result = await discover({ origin: com, hosted: true, token: 'test', browsingLevel: 3 },
    { query: 'dessin au fusain', scope: 'guides' }, { fetcher(url) {
      assert.equal(url.pathname, CATALOG.articles);
      const query = url.searchParams.get('query');
      seen.push(query);
      return Response.json({ items: query === 'charcoal sketch'
        ? [{ id: 42, title: 'Charcoal sketch guide', nsfwLevel: 1 }] : [] });
    } });
  assert.deepEqual(seen, ['dessin au fusain', 'charcoal sketch']);
  assert.equal(result.related.guides[0].title, 'Charcoal sketch guide');
  assert.deepEqual(result.alternateQueries, ['charcoal sketch']);
});

test('optional browser translation uses installed models and never starts a download', async () => {
  const used = [];
  const detector = {
    detect: async () => [{ confidence: .95, detectedLanguage: 'fr' }],
    destroy: () => used.push('detector closed'),
  };
  const tools = {
    LanguageDetector: { availability: async () => 'available', create: async () => detector },
    Translator: {
      availability: async () => 'downloadable',
      create: async () => { used.push('translator initialized'); },
    },
  };
  const input = 'Une ville nocturne sous les étoiles';
  assert.equal(await translateOnDevice(input, undefined, tools), null);
  assert.deepEqual(used, ['detector closed']);
  tools.Translator.availability = async () => 'available';
  tools.Translator.create = async ({ sourceLanguage, targetLanguage }) => {
    assert.deepEqual([sourceLanguage, targetLanguage], ['fr', 'en']);
    return {
      translate: async value => value === input ? 'A city at night under the stars' : '',
      destroy: () => used.push('translator closed'),
    };
  };
  assert.equal(await translateOnDevice(input, undefined, tools), 'A city at night under the stars');
  assert.deepEqual(used, ['detector closed', 'translator closed', 'detector closed']);
});

test('hosted model URL lookup revalidates exact versions under the App credential', async () => {
  const requests = [];
  const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  const context = { origin: com, hosted: true, token: 'synthetic-app-credential', browsingLevel: 3 };
  const filters = { query: 'https://civitai.com/models/40', baseModel: 'SDXL 1.0', resourceType: 'LORA' };
  const model = makeModel(40, 41, 'Linocut');
  const visible = await discover(context, filters, { fetcher(url, init) {
    requests.push([url.pathname, url.searchParams, init.headers]);
    if (url.pathname === '/api/v1/models/40') return response(model);
    if (url.pathname === CATALOG.blockModels) return response({ items: [model] });
    if (url.pathname === CATALOG.blockResources) return response({ items: [] });
    if (url.pathname === CATALOG.blockImages) return response({ items: [] });
    throw new Error('Unexpected test request');
  } });
  assert.deepEqual(visible.shortlisted.map(candidate => candidate.id), [41]);
  assert.equal(requests[0][2].Authorization, undefined);
  assert.equal(requests[1][1].get('modelVersionIds'), '41');
  assert.equal(requests[1][2].Authorization, 'Bearer synthetic-app-credential');

  const hidden = await discover(context, filters, { fetcher(url) {
    if (url.pathname === '/api/v1/models/40') return response(model);
    if (url.pathname === CATALOG.blockModels) return response({ items: [] });
    throw new Error('An unavailable version must not proceed to examples');
  } });
  assert.deepEqual(hidden.shortlisted, []);
});

test('a public version lookup proves the requested ID and its eligible parent without an App token', async () => {
  const context = { origin: com, hosted: true, browsingLevel: 1 };
  const filters = { query: com + '/models/40?modelVersionId=41', scope: 'models' };
  const version = id => ({ id, modelId: 40, nsfwLevel: 1, status: 'Published', baseModel: 'SDXL 1.0' });
  async function lookup(detail, parent) {
    const routes = [];
    const result = await discover(context, filters, { catalogOnly: true, fetcher(url, options) {
      routes.push(url.pathname);
      assert.equal(options.headers.Authorization, undefined);
      if (url.pathname === '/api/v1/model-versions/41') return Response.json(detail);
      assert.equal(url.pathname, '/api/v1/models/40');
      return Response.json(parent);
    } });
    return { routes, ids: result.candidates.map(row => row.id) };
  }
  const parent = { id: 40, name: 'Linocut', type: 'LORA', nsfwLevel: 1, modelVersions: [version(41), version(42)] };
  assert.deepEqual(await lookup(version(41), parent), { routes: ['/api/v1/model-versions/41', '/api/v1/models/40'], ids: [41] });
  assert.deepEqual(await lookup(version(42), parent), { routes: ['/api/v1/model-versions/41'], ids: [] });
  assert.deepEqual((await lookup(version(41), { ...parent, nsfwLevel: 2 })).ids, []);
  assert.deepEqual((await lookup(version(41), { ...parent, modelVersions: [version(42)] })).ids, []);
  assert.deepEqual((await lookup({ ...version(41), availability: 'Private' }, parent)).ids, []);
});

test('collection-only search uses the Site route, keeps public results, and applies the host ceiling to covers', async () => {
  const origin = 'https://civitai.red';
  const cover = 'https://image.civitai.com/key/22b36de2-61e3-4f94-aba9-f8974614257a/original=true/cat.jpeg';
  const result = await discover({ origin, hosted: true, token: 'synthetic-token', browsingLevel: 3 },
    { query: 'linocut', scope: 'collections' }, { fetcher(url, options) {
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, CATALOG.collections);
      assert.equal(url.searchParams.get('query'), 'linocut');
      assert.equal(url.searchParams.get('nsfw'), 'true');
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({ items: [
        { id: 15, name: 'Linocut', nsfwLevel: 1, isPublic: true, itemCount: 9, coverImage: { url: cover, nsfwLevel: 2 } },
        { id: 16, name: 'Collection without an available cover', nsfwLevel: 2, isPublic: true, coverImage: { url: cover, nsfwLevel: 8 } },
        { id: 17, name: 'Private', nsfwLevel: 1, isPublic: false },
        { id: 18, name: 'Outside preview ceiling', nsfwLevel: 8, isPublic: true },
      ] });
    } });
  assert.deepEqual(result.related.collections.map(item => [item.link, Boolean(item.preview)]), [
    ['https://civitai.red/collections/15', true],
    ['https://civitai.red/collections/16', false],
  ]);
  assert.deepEqual(result.candidates, []);
});

test('tag results from the Site rail cannot surface a version withheld by the App catalog', async () => {
  const found = await discover({ origin: com, hosted: true, token: 'tag-test', browsingLevel: 3 },
    { query: 'tag: linocut print' }, { fetcher(url, options) {
      if (url.pathname === CATALOG.models) {
        assert.equal(url.searchParams.get('tag'), 'linocut print');
        assert.equal(options.headers.Authorization, undefined);
        return Response.json({ items: [makeModel(40, 41, 'Result from Site')] });
      }
      assert.equal(url.pathname, CATALOG.blockModels);
      assert.equal(url.searchParams.get('modelVersionIds'), '41');
      assert.equal(options.headers.Authorization, 'Bearer tag-test');
      return Response.json({ items: [] });
    } });
  assert.deepEqual(found.candidates, []);
});

test('ranked cards and pictures start before unrelated results, and known App versions avoid rechecks', { timeout: 2_000 }, async () => {
  const modelImages = id => [{ id: id + 500, url: 'https://image.civitai.com/preview.jpeg', nsfwLevel: 1 }];
  const models = Array.from({ length: 6 }, (_, index) => {
    const model = makeModel(index + 1, index + 21, index === 0 ? 'Linocut' : 'Linocut print ' + index);
    Object.assign(model.modelVersions[0], { images: modelImages(index), trainedWords: [] });
    return model;
  });
  delete models[5].modelVersions[0].trainedWords;
  const unverified = makeModel(7, 27, 'Linocut unverified');
  const lateCollections = Promise.withResolvers();
  const gallery = Promise.withResolvers();
  const startedGallery = Promise.withResolvers();
  const first = Promise.withResolvers();
  const checks = [];
  const resourceReads = [];
  let imageReadCount = 0;
  const search = discover({ origin: com, hosted: true, token: 'test', browsingLevel: 3 }, {
    query: 'linocut', scope: 'all',
  }, {
    onRanked: first.resolve,
    async fetcher(url) {
      if (url.pathname === CATALOG.collections) return lateCollections.promise;
      if (url.pathname === CATALOG.tags) return Response.json({ items: [{ name: 'linocut' }] });
      if (url.pathname === CATALOG.models) return Response.json({ items: [...models, unverified] });
      if (url.pathname === CATALOG.blockModels) {
        const ids = url.searchParams.get('modelVersionIds');
        if (!ids) return Response.json({ items: models });
        checks.push(ids);
        return Response.json({ items: [] });
      }
      if (url.pathname === CATALOG.blockResources) {
        resourceReads.push(url.searchParams.get('ids'));
        return Response.json({ items: [{ modelId: 6, versionId: 26, trainedWords: ['verified trigger'] }] });
      }
      if (url.pathname === CATALOG.blockImages) {
        const versionId = Number(url.searchParams.get('modelVersionId'));
        if (++imageReadCount === 6) startedGallery.resolve();
        await gallery.promise;
        return Response.json({ items: [{
          id: versionId + 1_000, url: 'https://image.civitai.com/catalog.jpeg',
          meta: { civitaiResources: [{ modelVersionId: versionId }] },
        }] });
      }
      return Response.json({ items: [] });
    },
  });
  const ranked = await Promise.race([first.promise, search]);
  assert.equal(ranked.candidates[0].examples[0].id, 500);
  assert.deepEqual(ranked.candidates[0].examples[0].recorded, []);
  assert.equal(ranked.related.collections, undefined);
  assert.deepEqual(checks, ['27']);
  await startedGallery.promise;
  assert.deepEqual(resourceReads, ['26']);

  gallery.resolve();
  lateCollections.resolve(Response.json({ items: [{ id: 42, name: 'Linocut', isPublic: true, nsfwLevel: 1 }] }));
  const complete = await search;
  assert.deepEqual(complete.combined, ranked.combined);
  assert.deepEqual(complete.candidates[0].examples[0].recorded, [21]);
  assert.deepEqual(complete.candidates.find(row => row.id === 26).triggers, ['verified trigger']);
  assert.equal(complete.related.collections[0].title, 'Linocut');
});

test('combined research plans price only exact candidates and an explicit tier', async () => {
  const input = {
    shortlisted: [{
      id: 41, modelId: 40, model: 'Linocut', base: 'SDXL 1.0',
      link: 'https://civitai.com/models/40?modelVersionId=41',
      examples: [{ id: 51, url: 'https://image.civitai.com/sample.png', associated: [41], recorded: [] }],
    }],
  };
  const plans = researchPlans(input, { query: 'linocut' }, {
    model: 'openai/gpt-6-luna', freeModel: 'civitai/qwen3.8',
  });
  assert.deepEqual(plans.map(plan => plan.id), ['evidence', 'verify', 'visual', 'embedding', 'free']);
  const visual = plans.find(plan => plan.id === 'visual');
  assert.deepEqual(visual.body.steps.map(step => step.$type), ['chatCompletion', 'mediaCaptioning']);
  assert.equal(visual.body.steps[1].input.mediaUrl, 'https://image.civitai.com/sample.png');
  assert.deepEqual(visual.stepEvidence, { model_picture_1: { sourceLink: 'https://civitai.com/images/51' } });
  assert.deepEqual(visual.sources.map(source => source.link), ['https://civitai.com/models/40?modelVersionId=41', 'https://civitai.com/images/51']);
  assert.equal(visual.inputs[0].preview, visual.body.steps[1].input.mediaUrl);
  assert.doesNotMatch(JSON.stringify(visual.body), /image_url/u);
  const requests = [];
  const client = orchestrationClient('synthetic-credential', async (url, options) => {
    requests.push({ url, options });
    return new Response('{"status":"unassigned","cost":{"total":0}}', {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  for (const plan of plans) await client.estimate(plan.body);
  for (const { url, options } of requests) {
    assert.equal(url.origin, 'https://orchestration.civitai.com');
    assert.equal(url.pathname, '/v2/consumer/workflows');
    assert.equal(url.searchParams.get('whatif'), 'true');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
  }
  assert.equal(JSON.parse(requests.at(-1).options.body).tier, 'free');
  assert.equal(client.submit, undefined);
});

test('native App pricing sends a fixed estimate-only request', async () => {
  const chat = { $type: 'chatCompletion', name: 'compare', input: { model: 'model' } };
  const oneStep = appEstimateBody({ body: { tier: 'paid', steps: [chat] } });
  const workflow = appEstimateBody({ body: { tier: 'paid', steps: [chat, chat] } });
  assert.deepEqual(oneStep, { kind: 'workflow', steps: [chat] });
  assert.deepEqual(workflow, { kind: 'workflow', steps: [chat, chat] });
  assert.throws(() => appEstimateBody({ body: { tier: 'free', steps: [chat] } }));

  let called = false;
  const quote = await estimateAppWorkflow(com, 'synthetic-token', workflow, async (url, options) => {
    called = true;
    assert.equal(url.href, 'https://civitai.com/api/v1/blocks/workflows/estimate');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { body: workflow });
    return Response.json({ snapshot: { status: 'pending', cost: { total: 6, authorFee: 1 } } });
  });
  assert.equal(called, true);
  assert.deepEqual(quote.cost, { total: 6, authorFee: 1 });
});

test('quote rendering distinguishes zero author fee, missing author fee, and a refusal', () => {
  assert.deepEqual(quotePrice({ status: 'pending', cost: { total: 3, authorFee: 0 } }), { total: 3, authorFee: 0 });
  assert.deepEqual(quotePrice({ status: 'pending', cost: { total: 3 } }), { total: 3, authorFee: null });
  assert.equal(quotePrice({ status: 'failed', cost: { total: 30, authorFee: 2 } }), null);
  assert.equal(quotePrice({ status: 'pending', cost: { total: null } }), null);
});

test('batch estimates retain order, itemized fees, and individually unavailable options', () => {
  const result = { snapshots: [
    { workflowId: 'whatif', status: 'pending', cost: { total: 3, authorFee: 0 } },
    { workflowId: 'failed', status: 'failed', cost: { total: 10, authorFee: 2 } },
    { workflowId: 'whatif', status: 'pending', cost: { total: 7, authorFee: 2 } },
    { workflowId: 'whatif', status: 'pending', cost: { total: 5 } },
  ], aggregate: { total: 15, pricedCells: 3, cellCount: 4 } };
  assert.deepEqual(batchQuotePrices(result, 4), [
    { total: 3, authorFee: 0 }, null, { total: 7, authorFee: 2 }, { total: 5, authorFee: null },
  ]);
  assert.equal(batchQuotePrices({ error: 'unsupported on this host' }, 4), null);
  assert.throws(() => batchQuotePrices({ error: 'Rate limit exceeded' }, 4));
  assert.throws(() => batchQuotePrices(result, 3));
  assert.throws(() => batchQuotePrices({ ...result, aggregate: { ...result.aggregate, total: 25 } }, 4));
});

test('the batch bridge accepts only a correlated parent reply under the current quote grant', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let receive;
  let context;
  const sent = [];
  const parent = { postMessage(message, origin) { sent.push({ ...message, origin }); } };
  const stop = watchHost({ parent, atob, document: { body: { scrollHeight: 560 } },
    addEventListener(_type, handler) { receive = handler; }, removeEventListener() {} }, update => { context = update; });
  const deliver = (type, payload, { source = parent, origin = com } = {}) => receive({ source, origin, data: { type, payload } });
  const signed = scopes => blockFixtureToken({ viewerId: 24, instance: 'batch-fixture', scopes });
  const body = appEstimateBody({ body: { tier: 'paid', steps: [{ $type: 'chatCompletion', name: 'compare', input: {} }] } });
  const bodies = [body, body];
  const signal = new AbortController().signal;
  try {
    deliver('BLOCK_INIT', { blockId: 'rasterraid', blockInstanceId: 'batch-fixture', renderMode: 'iframe',
      viewer: { id: 24, signedIn: true }, context: { slotId: 'app.page' }, token: signed([]) });
    assert.throws(() => context.requestQuoteBatch(bodies, signal), /quote access changed/u);
    assert.equal(sent.some(message => message.type === 'ESTIMATE_WORKFLOW_BATCH'), false);
    deliver('TOKEN_REFRESH', { token: signed(['ai:write:budgeted']) });
    const pending = context.requestQuoteBatch(bodies, signal);
    const { requestId } = sent.at(-1).payload;
    assert.deepEqual(sent.at(-1), { type: 'ESTIMATE_WORKFLOW_BATCH', origin: com, payload: { requestId, bodies } });
    const reply = { requestId, snapshots: [3, 6].map(total => ({ workflowId: 'whatif', status: 'pending', cost: { total, authorFee: 1 } })),
      aggregate: { total: 9, pricedCells: 2, cellCount: 2 } };
    deliver('ESTIMATE_BATCH_RESULT', { requestId, error: 'unsupported on this host' }, { origin: 'https://civitai.red' });
    deliver('ESTIMATE_BATCH_RESULT', { requestId, error: 'unsupported on this host' }, { source: {} });
    deliver('ESTIMATE_BATCH_RESULT', { requestId: 'stale-id', error: 'unsupported on this host' });
    deliver('ESTIMATE_BATCH_RESULT', reply);
    assert.deepEqual(await pending, [{ total: 3, authorFee: 1 }, { total: 6, authorFee: 1 }]);

    const wholeRefusal = context.requestQuoteBatch(bodies, signal);
    deliver('ESTIMATE_BATCH_RESULT', { requestId: sent.at(-1).payload.requestId, error: 'Rate limit exceeded' });
    await assert.rejects(wholeRefusal, /could not price/u);

    const slow = context.requestQuoteBatch(bodies, signal);
    const timedOut = assert.rejects(slow, { name: 'TimeoutError' });
    t.mock.timers.tick(40_000);
    await timedOut;

    const replacing = new AbortController();
    const canceled = context.requestQuoteBatch(bodies, replacing.signal);
    const canceledId = sent.at(-1).payload.requestId;
    replacing.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    const next = context.requestQuoteBatch(bodies, signal);
    deliver('ESTIMATE_BATCH_RESULT', { ...reply, requestId: canceledId });
    deliver('TOKEN_REFRESH', { token: signed([]) });
    await assert.rejects(next, { name: 'AbortError' });
  } finally {
    stop();
  }
});

test('the quote request waits for a same-origin token refresh or a host refusal', async () => {
  const listeners = new Map();
  const messages = [];
  const win = {
    parent: { postMessage(message, origin) { messages.push({ message, origin }); } },
    document: { body: { scrollHeight: 560 }, documentElement: { dataset: {} } },
    atob,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const deliver = (type, payload, origin = com) => listeners.get('message')({ source: win.parent, origin, data: { type, payload } });
  const signed = scopes => blockFixtureToken({ viewerId: 123, instance: 'test-instance', viewerLevel: 31, scopes });
  let context;
  watchHost(win, current => { context = current; });
  deliver('BLOCK_INIT', {
    blockId: 'rasterraid', blockInstanceId: 'test-instance', renderMode: 'iframe',
    context: { slotId: 'app.page', viewerUserId: 123 }, token: signed([]), effectiveBrowsingLevel: 1,
  });
  assert.equal(context.browsingLevel, 1);
  const signal = new AbortController().signal;
  const refused = context.requestQuoteAccess(signal);
  assert.deepEqual(messages.at(-1), { origin: com, message: { type: 'REQUEST_CONSENT', payload: { scopes: ['ai:write:budgeted'] } } });
  deliver('CONSENT_UNAVAILABLE', {});
  assert.equal(await refused, null);

  const pending = context.requestQuoteAccess(signal);
  const token = signed(['ai:write:budgeted']);
  deliver('TOKEN_REFRESH', { token }, 'https://civitai.red');
  assert.deepEqual(context.scopes, []);
  deliver('TOKEN_REFRESH', { token });
  assert.deepEqual((await pending).scopes, ['ai:write:budgeted']);
  assert.equal(context.browsingLevel, 1);
});

test('credential rotation replaces the expiry and reconnects only to the bound viewer and host', async t => {
  const started = new Date('2026-11-23T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: started });
  const firstExpiry = started.getTime() / 1000 + 3;
  const token = (exp, options = {}) => blockFixtureToken({ exp, instance: 'refresh-fixture', ...options });
  const messages = [];
  const parent = { postMessage: (message, origin) => messages.push({ ...message, origin }) };
  let receive;
  let context;
  const stop = watchHost({ parent, atob, document: { body: { scrollHeight: 560 } },
    addEventListener(_type, handler) { receive = handler; }, removeEventListener() {} }, update => { context = update; });
  const red = 'https://civitai.red';
  const send = (type, payload, origin = red) => receive({ source: parent, origin, data: { type, payload } });
  try {
    send('BLOCK_INIT', { blockId: 'rasterraid', blockInstanceId: 'refresh-fixture', renderMode: 'iframe',
      viewer: { id: 21, signedIn: true }, context: { slotId: 'app.page' }, maxBrowsingLevel: 63,
      effectiveBrowsingLevel: 3, token: token(firstExpiry) });
    assert.equal(context.browsingLevel, 3);
    t.mock.timers.tick(1_000);
    send('TOKEN_REFRESH', { token: token(firstExpiry + 2, { viewerLevel: 63, maxLevel: 63 }) });
    assert.equal(context.browsingLevel, 3);
    t.mock.timers.tick(3_000);
    assert.equal(context.signedIn, true);

    const signal = new AbortController().signal;
    const permission = context.requestQuoteAccess(signal);
    const pictures = context.pickCreations('generated', signal);
    send('SUSPEND');
    t.mock.timers.tick(1_000);
    assert.equal(context.connectionLost, true);
    assert.equal(context.viewerUserId, null);
    assert.equal(context.token, undefined);
    assert.deepEqual(context.scopes, []);
    assert.equal(await permission, null);
    assert.equal(await pictures, null);
    assert.equal(messages.some(message => message.type === 'REQUEST_TOKEN'), false);

    send('RESUME');
    const request = messages.at(-1);
    assert.equal(request.type, 'REQUEST_TOKEN');
    assert.equal(request.origin, red);
    assert.equal(request.payload.blockInstanceId, 'refresh-fixture');
    const { requestId } = request.payload;
    const fresh = token(firstExpiry + 10, { scopes: ['ai:write:budgeted'], viewerLevel: 1 });
    send('TOKEN_REFRESH_RESPONSE', { requestId: 'unrelated', token: fresh });
    send('TOKEN_REFRESH_RESPONSE', { requestId, token: fresh }, com);
    send('RESUME');
    context.requestSignIn();
    assert.equal(context.connectionLost, true);
    assert.equal(messages.filter(message => message.type === 'REQUEST_TOKEN').length, 1);
    assert.equal(messages.some(message => message.type === 'REQUEST_SIGN_IN'), false);
    send('TOKEN_REFRESH_RESPONSE', { requestId, token: fresh });
    assert.equal(context.connectionLost, false);
    assert.equal(context.viewerUserId, 21);
    assert.equal(context.browsingLevel, 1);
    assert.deepEqual(context.scopes, ['ai:write:budgeted']);
  } finally {
    stop();
  }
});

test('a signed-out viewer can request Civitai sign-in and cannot request owned or spending scopes', async () => {
  const messages = [];
  const parent = { postMessage(message, origin) { messages.push({ message, origin }); } };
  let receive;
  let context;
  watchHost({ parent, document: { body: { scrollHeight: 560 } }, atob,
    addEventListener(_type, listener) { receive = listener; } }, value => { context = value; });
  const deliver = (type, payload) => receive({ source: parent, origin: com, data: { type, payload } });
  const scopes = ['ai:write:budgeted', 'apps:storage', 'collections:read:self', 'collections:read:private'];
  deliver('BLOCK_INIT', { blockId: 'rasterraid', blockInstanceId: 'guest', renderMode: 'iframe', viewer: null,
    context: { slotId: 'app.page' }, token: blockFixtureToken({ instance: 'guest', scopes, viewerId: null, viewerLevel: 1 }) });
  assert.equal(context.signedIn, false);
  assert.equal(context.browsingLevel, 1);
  assert.deepEqual(context.scopes, []);
  const { signal } = new AbortController();
  assert.equal(await context.requestQuoteAccess(signal), null);
  assert.equal(await context.requestPrivateCollections(signal), null);
  assert.equal(await context.requestWorkflowHistoryAccess(signal), null);
  context.requestSignIn();
  deliver('SUSPEND', {});
  context.requestSignIn();
  assert.deepEqual(messages.slice(1), [{ origin: com, message: { type: 'REQUEST_SIGN_IN', payload: {} } }]);
});

test('Civitai enum refresh replaces additions and removals and labels the last good list on outage', async () => {
  let time = 0;
  let model = 'Old Model';
  let offline = false;
  let calls = 0;
  const feed = createFilterFeed({ now: () => time, read: async (origin, route) => {
    assert.equal(origin, 'https://civitai.red');
    assert.equal(route, CATALOG.enums);
    calls++;
    if (offline) throw new Error('Unavailable');
    return { data: { ModelType: ['LORA'], ActiveBaseModel: [model], BaseModel: ['Other', model] } };
  } });
  assert.deepEqual((await feed('red')).data.baseModels, ['Old Model', 'Other']);
  model = 'New Model';
  assert.deepEqual((await feed('red')).data.baseModels, ['Old Model', 'Other']);
  assert.equal(calls, 1);
  time += FILTER_REFRESH_MS;
  assert.deepEqual((await feed('red')).data.baseModels, ['New Model', 'Other']);
  offline = true;
  time += FILTER_REFRESH_MS;
  const prior = await feed('red');
  assert.equal(prior.data.stale, true);
  assert.deepEqual(prior.data.baseModels, ['New Model', 'Other']);
  assert.equal((await feed('example.org')).status, 400);
});

test('filter choices respect newly declared types and retired sorts from Civitai', () => {
  const { modelTypes, sorts, periods } = toolFilterChoices({ tools: [{ function: {
    name: 'search_models', parameters: { properties: {
      types: { items: { enum: ['LORA', 'NewType'] } }, sort: { enum: ['Newest'] }, period: { enum: ['Week'] },
    } },
  } }] });
  const updated = applyFilterChoices({ modelTypes: ['LORA', 'Retired'], baseModels: ['Still Current'],
    sorts: ['Old Sort', 'Newest'], periods: ['Day', 'Week'] }, { types: modelTypes, sorts, periods });
  assert.deepEqual(updated, { modelTypes: ['LORA', 'NewType'], baseModels: ['Still Current'], sorts: ['Newest'], periods: ['Week'] });
});

test('published Worker serves only fixed, anonymous enum reads, and the app uses its scoped source', async () => {
  const worker = createFilterHandler(async domain => ({ status: 200, data: {
    modelTypes: ['LoRA'], activeBaseModels: ['New'], baseModels: ['New', 'Older'],
    source: `https://civitai.${domain}/api/v1/enums`, checkedAt: Date.now(), stale: false,
  } }));
  const origin = 'https://civitai.red';
  const received = await fetchFilterMetadata(origin, { fetcher(url, options) {
    assert.equal(url.href, PUBLIC_FILTER_FEED + '?domain=red');
    assert.equal(options.credentials, 'omit');
    return worker(new Request(url));
  } });
  assert.deepEqual(received.activeBaseModels, ['New']);
  assert.deepEqual(received.baseModels, ['New', 'Older']);
  const rejected = await worker(new Request(PUBLIC_FILTER_FEED + '?domain=red&query=extra'));
  assert.equal(rejected.status, 400);
  const write = await worker(new Request(PUBLIC_FILTER_FEED + '?domain=red', { method: 'POST' }));
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('access-control-allow-origin'), '*');
});

test('completion and proofreading preserve exact references and only propose edits', async () => {
  assert.equal(reviseDraft('An watercolor with with teal', searchStarts), 'A watercolor with teal');
  assert.equal(reviseDraft('teh linocutt', searchStarts), 'the linocut');
  const reference = 'https://civitai.com/models/2744788?modelVersionId=3087275';
  assert.deepEqual(draftSuggestions(reference, searchStarts, 'query'), []);
  assert.equal(draftSuggestions('3D, photor', searchStarts, 'exclude')[0]?.value, '3D, photorealistic');
  assert.equal(filterMatches('Illustroius', [{ label: 'Illustrious', value: 'Illustrious' }])[0]?.value, 'Illustrious');
  const optional = createProofreader({ availability: async () => 'downloadable', create() { assert.fail('No model download'); } });
  assert.equal(await optional('An watercolor with with teal', AbortSignal.timeout(500)), null);
});

test('recorded preview quotes match the exact plan and host and preserve the author fee', async () => {
  const plan = { id: 'visual', body: { tier: 'paid', steps: [{ name: 'exact-choice' }] } };
  const bodySha256 = createHash('sha256').update(JSON.stringify(appEstimateBody(plan))).digest('hex');
  const receipt = { origin: 'https://civitai.red', capturedAt: new Date().toISOString(), quotes: [
    { id: 'visual', bodySha256, total: 7, authorFee: 0 },
  ] };
  assert.deepEqual((await matchPreviewQuotes(receipt, receipt.origin, [plan])).prices, [{ total: 7, authorFee: 0 }]);
  assert.equal(await matchPreviewQuotes(receipt, 'https://civitai.com', [plan]), null);
  assert.equal(await matchPreviewQuotes(receipt, receipt.origin, [{ ...plan, body: { ...plan.body, steps: [{ name: 'different-choice' }] } }]), null);
  assert.equal(await matchPreviewQuotes(receipt, receipt.origin, [plan], { now: Date.now() + 7_200_000 }), null);
});
