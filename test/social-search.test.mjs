import assert from 'node:assert/strict';
import test from 'node:test';
import { watchHost } from '../src/civitai-host.js';
import { discover } from '../src/search.mjs';

const origin = 'https://civitai.red';
const context = { origin, hosted: true, browsingLevel: 3, token: 'app-fixture' };
const preview = 'https://image.civitai.com/sample/artwork.jpg';
const image = { id: 21, type: 'image', url: preview, nsfwLevel: 1 };
const article = { id: 34441, title: 'How Hubs work', nsfwLevel: 1, status: 'Published', availability: 'Public', coverImage: image };

test('hub discovery follows public article references and passes direct hub links back to Civitai', async () => {
  const reference = { ...article, id: 52, title: 'Shared Hubs', content: [
    '<a href="https://civitai.com/hubs/E6imWTja/the-comedy-club">The Comedy Club</a>',
    '<a href="https://civitai.com/hubs/bad88KEY?edit=true">An edit link</a>',
    '<a href="https://example.com/hubs/ab123456">Unrelated</a>',
  ].join(' ') };
  const result = await discover(context, { scope: 'hubs', query: 'how hubs work' }, { fetcher(url, options) {
    assert.equal(url.origin, origin);
    assert.equal(options.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/articles/34441') return Response.json(article);
    if (url.pathname === '/api/v1/articles/52') return Response.json(reference);
    if (url.pathname === '/api/v1/articles') return Response.json({ items: [reference] });
    assert.equal(url.pathname, '/api/search/multi-search');
    return Response.json({ results: [{ hits: [] }, { hits: [] }] });
  } });
  assert.deepEqual(result.related.hubs.map(card => [card.title, card.link, card.source, card.preview]), [
    ['The Comedy Club', origin + '/hubs/E6imWTja/the-comedy-club', origin + '/articles/52', preview],
  ]);
  assert.equal(result.related.hubGuides[0].id, 34441);
  assert.equal(result.nativeLink, origin + '/hubs');
  const direct = await discover(context, { query: 'https://civitai.com/hubs/E6imWTja/the-comedy-club' }, {
    fetcher() { assert.fail('Shared hubs should open with Civitai’s access check'); },
  });
  assert.equal(direct.nativeLink, origin + '/hubs/E6imWTja/the-comedy-club');
});

test('topics fuse real tag results and public collection search with a bounded verified gallery sample', async () => {
  const cat = { id: 61, name: 'cat' };
  const collection = { id: 101, name: 'Cat pictures', isPublic: true, nsfwLevel: 1, coverImage: image };
  const result = await discover(context, { query: 'https://civitai.com/tag/cat' }, { fetcher(url, options) {
    assert.equal(url.origin, origin);
    if (url.pathname === '/api/v1/blocks/images') {
      assert.equal(options.headers.Authorization, 'Bearer app-fixture');
      assert.equal(url.searchParams.get('tags'), '61');
      assert.equal(url.searchParams.get('limit'), '3');
      return Response.json({ items: [{ ...image, tags: [cat] }, { ...image, id: 22, tags: [] }] });
    }
    assert.equal(options.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/tags') return Response.json({ items: [{ name: 'cats' }, { name: 'cat' }] });
    if (url.pathname === '/api/v1/collections') return Response.json({ items: [collection] });
    if (url.pathname === '/api/v1/collections/102') return Response.json({ ...collection, id: 102, isPublic: false });
    assert.equal(url.pathname, '/api/search/multi-search');
    const queries = JSON.parse(options.body).queries;
    return Response.json({ results: queries.map(q => ({ hits: q.indexUid === 'models_v9' ? [{ tags: [cat] }] : [{ id: 102 }] })) });
  } });
  assert.equal(result.nativeLink, origin + '/tag/cat');
  assert.deepEqual(result.related.topics.map(card => card.title), ['cat', 'cats']);
  assert.deepEqual(result.related.collections.map(card => card.id), [101]);
  assert.deepEqual(result.related.topicImages.map(card => card.id), [21]);
});

test('review links preserve the version and native filter and never preview an ineligible version', async () => {
  const model = { id: 4384, name: 'DreamShaper', availability: 'Public', nsfwLevel: 15, modelVersions: [
    { id: 128713, name: '8', nsfwLevel: 11, images: [image] },
    { id: 131004, name: '8-inpainting', nsfwLevel: 1, stats: { thumbsUpCount: 90, thumbsDownCount: 0 }, images: [image] },
  ] };
  const fetcher = (url, options) => {
    assert.equal(url.origin, origin);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(url.pathname, '/api/v1/models/4384');
    return Response.json(model);
  };
  const target = origin + '/models/4384/reviews?modelVersionId=131004&filter=images';
  const exact = await discover(context, { query: target }, { fetcher });
  assert.deepEqual(exact.related.reviews.map(card => [card.id, card.link, card.preview]), [[131004, target, preview]]);
  assert.match(exact.related.reviews[0].description, /90 thumbs up/u);
  const all = await discover(context, { scope: 'reviews', query: origin + '/models/4384' }, { fetcher });
  assert.deepEqual(all.related.reviews.map(card => card.id), [131004]);
  const ineligible = await discover(context, { scope: 'reviews', query: origin + '/models/4384?modelVersionId=128713' }, { fetcher });
  assert.deepEqual(ineligible.related.reviews, []);
});

test('comments open the exact native anchors and keep the host bridge read-only', async () => {
  const exact = await discover(context, { scope: 'comments', query: 'Article #34441' }, { fetcher(url) {
    assert.equal(url.pathname, '/api/v1/articles/34441');
    return Response.json({ ...article, stats: { commentCountAllTime: 49 } });
  } });
  assert.equal(exact.nativeLink, origin + '/articles/34441#comments');
  assert.equal(exact.related.articleDiscussions[0].description, '49 comments');
  const comment = await discover(context, { query: 'https://civitai.com/comments/v2/987' }, {
    fetcher() { assert.fail('Permalinks open natively'); },
  });
  assert.equal(comment.nativeLink, origin + '/comments/987');

  const messages = [];
  const parent = { postMessage: message => messages.push(message) };
  let receive;
  let host;
  watchHost({ parent, document: { body: { scrollHeight: 700 } },
    addEventListener(_event, listener) { receive = listener; } }, next => { host = next; });
  receive({ source: parent, origin, data: { type: 'BLOCK_INIT', payload: {
    blockId: 'rasterraid', blockInstanceId: 'fixture', context: { slotId: 'app.page' }, renderMode: 'iframe',
  } } });
  const reads = ['/hubs', '/hubs/E6imWTja/the-comedy-club', '/tag/cat',
    '/models/4384/reviews?modelVersionId=131004&filter=images', '/articles/34441#comments', '/comments/987'];
  const rejected = ['/hubs/E6imWTja?follow=1', '/hubs/new', '/comments/987?delete=true',
    '/models/4384/reviews?modelVersionId=131004&filter=invalid', '/search/models?query=a&query=b'];
  for (const path of [...reads, ...rejected]) host.open(origin + path);
  assert.deepEqual(messages.filter(message => message.type === 'NAVIGATE').map(message => message.payload.path), reads);
});
