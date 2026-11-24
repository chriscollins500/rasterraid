import assert from 'node:assert/strict';
import test from 'node:test';
import { watchHost } from '../src/civitai-host.js';
import { readDirectoryPage } from '../src/directory.mjs';
import { discover } from '../src/search.mjs';

const origin = 'https://civitai.red';
const context = { origin, hosted: true, browsingLevel: 3, token: 'fixture' };
const image = 'https://image.civitai.com/fixture/preview.jpg';
const pic = { id: 21, type: 'image', nsfwLevel: 1, url: image };
const article = (id, fields = {}) => ({
  id, title: 'A canvas guide', status: 'Published', availability: 'Public', nsfwLevel: 1,
  coverImage: pic, user: { username: 'Writer' }, tags: [{ name: 'workflow' }], ...fields,
});

test('article search fuses body matches and title results, honors author and tag, and keeps the provider cursors', async () => {
  const indexed = [article(41, { title: 'Body match', nsfwLevel: [1] }), article(42, { title: 'Canvas', nsfwLevel: [1] }),
    article(43, { title: 'Hidden course', nsfwLevel: [1, 4] }), article(44, { title: 'Unlisted', unlisted: true })];
  const observed = [];
  const fetcher = (url, config) => {
    assert.equal(config.headers.Authorization, undefined);
    if (url.pathname === '/api/search/multi-search') {
      const [query, facets] = JSON.parse(config.body).queries;
      assert.equal(query.indexUid, 'articles_v5');
      assert.deepEqual(query.filter, ['user.username = "Writer"', 'tags.name = "workflow"']);
      assert.deepEqual(facets.facets, ['tags.name']);
      return Response.json({ results: [{ hits: indexed }, { hits: [], facetDistribution: { 'tags.name': { workflow: 42, retired: 0 } } }] });
    }
    assert.equal(url.pathname, '/api/v1/articles');
    assert.equal(url.searchParams.get('username'), 'Writer');
    assert.equal(url.searchParams.get('nsfw'), 'true');
    observed.push(url.searchParams.get('cursor'));
    if (url.searchParams.has('cursor')) return Response.json({ items: [article(45)] });
    return Response.json({ items: [article(42, { title: 'Canvas', coverImageWithheld: true })], metadata: { nextCursor: 'opaque|42' } });
  };
  const result = await discover(context, { scope: 'articles', query: '@Writer canvas', articleTag: 'workflow' }, { fetcher });
  assert.deepEqual(result.related.articles.map(item => [item.id, item.preview]), [[42, null], [41, image]]);
  assert.deepEqual(result.directoryFacets['tags.name'], ['workflow']);
  assert.deepEqual(result.directory.nextCursor, { index: null, site: 'opaque|42' });
  const next = await readDirectoryPage(context, 'articles', result.directory.plan, { fetcher, cursor: result.directory.nextCursor });
  assert.deepEqual(next.items.map(item => item.id), [45]);
  assert.deepEqual(observed, [null, 'opaque|42']);
});

test('article date sorting keeps author and tag filters and continues on the same index', async () => {
  const requests = [];
  const rows = Array.from({ length: 13 }, (_, index) => article(index + 1, {
    createdAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), publishedAt: '2026-08-12',
  }));
  const fetcher = (url, config) => {
    assert.equal(url.pathname, '/api/search/multi-search');
    const [query, facets] = JSON.parse(config.body).queries;
    requests.push(query.offset);
    assert.deepEqual(query.sort, ['createdAt:asc', 'id:asc']);
    assert.deepEqual(query.filter, ['user.username = "Writer"', 'tags.name = "workflow"']);
    assert.deepEqual(query.attributesToCrop, ['content:36']);
    return Response.json({ results: [
      { hits: rows.slice(query.offset, query.offset + query.limit).reverse() },
      ...(facets ? [{ hits: [], facetDistribution: { 'tags.name': { workflow: 12 } } }] : []),
    ] });
  };
  const result = await discover(context, { scope: 'articles', query: 'canvas', articleAuthor: '@Writer', articleTag: 'workflow', catalogSort: 'oldest' }, { fetcher });
  assert.deepEqual(result.related.articles.map(item => item.id), rows.slice(0, 12).map(row => row.id));
  assert.match(result.related.articles[0].description, /Created.*2025/u);
  assert.deepEqual(result.directory.nextCursor, { index: 12, site: null });
  const more = await readDirectoryPage(context, 'articles', result.directory.plan, { fetcher, cursor: result.directory.nextCursor });
  assert.deepEqual(more.items.map(item => item.id), [13]);
  assert.deepEqual(requests, [0, 12]);
});

test('Site article order translates live tag names to IDs and keeps its cursor and native order', async () => {
  const requests = [];
  const fetcher = (url, config) => {
    if (url.pathname === '/api/search/multi-search') {
      const [query] = JSON.parse(config.body).queries;
      const result = query.facets ? { hits: [], facetDistribution: { 'tags.name': { workflow: 3 } } }
        : { hits: [{ tags: [{ id: 61, name: 'workflow' }] }] };
      return Response.json({ results: [result] });
    }
    assert.equal(url.pathname, '/api/v1/articles');
    assert.equal(url.searchParams.get('sort'), 'Most Reactions');
    assert.equal(url.searchParams.get('tags'), '61');
    const cursor = url.searchParams.get('cursor');
    requests.push(cursor);
    return Response.json(cursor ? { items: [article(18)] }
      : { items: [article(17), article(16, { title: 'Canvas' })], metadata: { nextCursor: 'next|16' } });
  };
  const result = await discover(context, { scope: 'articles', query: 'canvas', articleTag: 'workflow', catalogSort: 'reactions' }, { fetcher });
  assert.deepEqual(result.related.articles.map(item => item.id), [17, 16]);
  assert.deepEqual(result.directoryFacets, { 'tags.name': ['workflow'] });
  const more = await readDirectoryPage(context, 'articles', result.directory.plan, { fetcher, cursor: result.directory.nextCursor });
  assert.equal(more.items[0].id, 18);
  assert.deepEqual(requests, [null, 'next|16']);
});

test('Collections keeps the Site route by default and uses public typed results for sort and type', async () => {
  const calls = [];
  const fetcher = (url, config) => {
    assert.equal(config.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/collections') {
      const cursor = url.searchParams.get('cursor');
      calls.push(cursor);
      return Response.json({ items: [{ id: cursor ? 21 : 20, name: 'Gallery', isPublic: true, nsfwLevel: 1 }],
        metadata: cursor ? {} : { nextCursor: 20 } });
    }
    const facets = { hits: [], facetDistribution: { type: { Image: 10, Model: 7, Retired: 0 } } };
    const [query] = JSON.parse(config.body).queries;
    assert.equal(query.indexUid, 'collections_v3');
    if (query.facets) return Response.json({ results: [facets] });
    assert.deepEqual(query.sort, ['metrics.followerCount:desc', 'id:desc']);
    assert.deepEqual(query.filter, ['user.username = "Curator"', 'type = "Image"']);
    const row = { name: 'Gallery', type: 'Image', nsfwLevel: [1], image: pic };
    return Response.json({ results: [{ hits: [{ ...row, id: 10, read: 'Private' }, { ...row, id: 11, read: 'Public' }] }, facets] });
  };
  const plain = await discover(context, { scope: 'collections', query: 'Gallery' }, { fetcher });
  assert.deepEqual(plain.related.collections.map(item => item.id), [20]);
  assert.equal(plain.directory.nextCursor, 20);
  const next = await readDirectoryPage(context, 'collections', plain.directory.plan, { fetcher, cursor: 20 });
  assert.deepEqual(next.items.map(item => item.id), [21]);
  assert.deepEqual(calls, [null, '20']);
  const typed = await discover(context, { scope: 'collections', query: 'Gallery', collectionAuthor: 'Curator', collectionType: 'Image', catalogSort: 'followers' }, { fetcher });
  assert.deepEqual(typed.directoryFacets.collectionType, ['Image', 'Model']);
  assert.deepEqual(typed.related.collections.map(({ id, preview }) => [id, preview]), [[11, image]]);
});

test('unmatched collection searches keep the Site route during language recovery and pagination', async () => {
  const observed = [];
  const fetcher = url => {
    if (url.pathname === '/api/search/multi-search') return Response.json({ results: [{ hits: [] }] });
    assert.equal(url.pathname, '/api/v1/collections');
    const query = url.searchParams.get('query');
    observed.push(query);
    return Response.json(query === 'linocut' ? { items: [{ id: 19, isPublic: true, nsfwLevel: 1, name: 'Linocut' }],
      metadata: { nextCursor: 19 } } : { items: [] });
  };
  const query = 'grabado en linóleo';
  const result = await discover(context, { scope: 'collections', query }, { fetcher });
  assert.equal(result.target.value, query);
  assert.deepEqual(result.alternateQueries, ['linocut']);
  assert.equal(result.related.collections[0].id, 19);
  await readDirectoryPage(context, 'collections', result.directory.plan, { fetcher, cursor: result.directory.nextCursor });
  assert.deepEqual(observed, [query, 'linocut', 'linocut']);
});

test('user ID lookup sends no credentials, keeps the exact public identity and prefers a rated profile picture', async () => {
  const result = await discover(context, { scope: 'users', query: '7665867' }, { fetcher(url, config) {
    assert.equal(config.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/users') {
      assert.equal(url.searchParams.get('ids'), '7665867');
      return Response.json({ items: [{ id: 7665867, username: 'CivChan', avatarUrl: image, avatarNsfw: 1 }] });
    }
    assert.deepEqual(JSON.parse(config.body).queries[0].filter, ['id = 7665867']);
    return Response.json({ results: [{ hits: [
      { id: 7665867, username: 'CivChan', profilePicture: pic, metrics: { uploadCount: 2 } },
      { id: 9, username: 'CivChanOld' },
    ] }] });
  } });
  assert.deepEqual(result.related.users.map(item => [item.id, item.preview]), [[7665867, image]]);
  assert.equal(result.nativeLink, origin + '/user/CivChan');
  assert.equal(result.related.users[0].actions[2].link, origin + '/user/CivChan/articles');
});

test('tools keep exact titles first and refresh category facets from the tool directory', async () => {
  const result = await discover(context, { scope: 'tools', query: 'Image MetaHub', toolType: 'Editor' }, { fetcher(_url, config) {
    const [query, facets] = JSON.parse(config.body).queries;
    assert.equal(query.indexUid, 'tools_v2');
    assert.deepEqual(query.filter, ['type = "Editor"']);
    assert.deepEqual(facets.facets, ['type', 'company']);
    return Response.json({ results: [
      { hits: [{ id: 66, name: 'A related editor' }, { id: 308, name: 'Image MetaHub', icon: image }] },
      { hits: [], facetDistribution: { type: { Editor: 4, Audio: 0 }, company: { MetaHub: 1 } } },
    ] });
  } });
  assert.deepEqual(result.directoryFacets, { type: ['Editor'], company: ['MetaHub'] });
  assert.equal(result.related.tools[0].link, origin + '/tools/image-metahub');
  assert.equal(result.related.tools[0].preview, image);
});

test('comic chapter previews keep eligible pages in native reading order and use no download route', async () => {
  const result = await discover(context, { query: 'https://civitai.com/comics/5/new-horizon/1/the-newbie' }, {
    fetcher(url, config) {
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, '/api/v1/comics/5/chapters/1');
      assert.equal(config.headers.Authorization, undefined);
      assert.equal(config.method ?? 'GET', 'GET');
      return Response.json({ comicId: 5, series: 'New Horizon', number: 1, name: 'The Newbie', nsfwLevel: 3,
        allowDownload: false, url: 'https://civitai.com/comics/5/new-horizon/1/the-newbie', pages: [
          { number: 1, url: image, nsfwLevel: 1 }, { number: 2, url: image, nsfwLevel: 4 },
          { number: 3, url: null, nsfwLevel: 2 }, { number: 4, url: image, nsfwLevel: 2 },
        ] });
    },
  });
  assert.deepEqual(result.related.comicPages.map(item => item.id), [1, 4]);
  assert.equal(result.nativeLink, origin + '/comics/5/new-horizon/1/the-newbie');
});

test('site navigation supports discovery routes while leaving bid, prize and edit actions native', async () => {
  const mine = await discover(context, { query: origin + '/prizes/19' }, { fetcher() { assert.fail('Private prize read'); } });
  const auction = await discover(context, { query: origin + '/auctions/featured-checkpoints' }, { fetcher() { assert.fail('Native auction read'); } });
  assert.equal(mine.nativeLink, origin + '/prizes/19');
  assert.equal(auction.nativeLink, origin + '/auctions/featured-checkpoints');
  const messages = [];
  const parent = { postMessage: message => messages.push(message) };
  let receive;
  let host;
  watchHost({ parent, document: { body: { scrollHeight: 700 } },
    addEventListener(_event, receiveMessage) { receive = receiveMessage; } }, context => { host = context; });
  receive({ source: parent, origin, data: { type: 'BLOCK_INIT', payload: {
    blockId: 'rasterraid', blockInstanceId: 'fixture', context: { slotId: 'app.page' }, renderMode: 'iframe',
  } } });
  const reads = ['/auctions/featured-checkpoints', '/prizes', '/prizes/19', '/user/CivChan/articles', '/articles?query=canvas',
    '/search/users?query=CivChan', '/tools/image-metahub', '/search/tools?type=Editor', '/comics/5/new-horizon/1/the-newbie'];
  for (const path of [...reads, '/auctions/my-bids', '/auctions/featured-checkpoints?bid=10', '/prizes/19?claim=1',
    '/user/CivChan/account', '/articles/42/edit', '/search/tools?query=one&query=two']) host.open(origin + path);
  assert.deepEqual(messages.filter(message => message.type === 'NAVIGATE').map(message => message.payload.path), reads);
});
