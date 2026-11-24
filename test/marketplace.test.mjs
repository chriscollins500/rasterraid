import assert from 'node:assert/strict';
import test from 'node:test';
import { watchHost } from '../src/civitai-host.js';
import { discover } from '../src/search.mjs';

const origin = 'https://civitai.red';
const context = { origin, hosted: true, browsingLevel: 3, token: 'fixture' };
const cover = (id, nsfwLevel) => ({ id, type: 'image', nsfwLevel, url: 'https://image.civitai.com/fixture/' + id + '.jpg' });
const article = (id, title, content, options = {}) => ({
  id, title, content, status: 'Published', availability: 'Public', nsfwLevel: 2, coverImage: cover(id, 1),
  publishedAt: '2026-11-18T00:00:00Z', ...options,
});

test('Creator Services combines free article reads, preserving source provenance and host visibility', async () => {
  const fixture = new Map([
    [38740, article(38740, 'Creator Services: Commission a LoRA', [
      '<p>Training and images.</p><a href="/user/CivChan/shop#service-48">Sample storefront</a>',
      '<a href="/services/48/lora-training">LoRA training</a><a href="/services/48">Duplicate</a>',
      '<a href="/services/deals/1">Deal details</a><a href="/user/CivChan/shop/manage">Manage</a>',
      '<a href="https://example.com/services/54">External listing</a>',
      '<a href="https://civitai.com/services/61">Other domain</a>',
    ].join(''), { isOfficial: true })],
    [42, article(42, 'Custom LoRA commissions', 'I train LoRA models.', { coverImage: cover(42, 4) })],
    [44, article(44, 'LoRA training commissions', '<a href="/services/50">Unpublished link</a>', { status: 'Draft' })],
  ]);
  const found = await discover(context, { scope: 'services', query: 'LoRA training' }, {
    fetcher(url, config) {
      assert.equal(url.origin, origin);
      assert.equal(config.headers.Authorization, undefined);
      if (url.pathname === '/api/search/multi-search') {
        assert.equal(config.method, 'POST');
        assert.equal(JSON.parse(config.body).queries[0].indexUid, 'articles_v5');
        return Response.json({ results: [{ hits: [{ id: 42, nsfwLevel: [1] }] }] });
      }
      assert.equal(config.method ?? 'GET', 'GET');
      if (url.pathname === '/api/v1/articles') return Response.json({ items: [{ id: 44, nsfwLevel: 1 }, { id: 45, nsfwLevel: 4 }] });
      const row = fixture.get(Number(url.pathname.split('/').at(-1)));
      assert.ok(row, url.pathname);
      return Response.json(row);
    },
  });
  assert.equal(found.nativeLink, origin + '/services?query=LoRA+training');
  assert.deepEqual(found.related.services.map(item => [item.link, item.source]), [
    [origin + '/user/CivChan/shop#service-48', origin + '/articles/38740'],
    [origin + '/services/48', origin + '/articles/38740'],
  ]);
  assert.equal(found.related.services[0].preview, cover(38740, 1).url);
  assert.deepEqual(found.related.serviceArticles.map(item => [item.id, item.preview]),
    [[38740, cover(38740, 1).url], [42, null]]);
});

test('Buzz search returns verified official articles and keeps the Marketplace link read-only', async () => {
  const oldKey = '6cb0914e-0430-47c4-8876-f2e09c8c98bc';
  const found = await discover(context, { scope: 'marketplace', query: 'Blue Buzz' }, {
    fetcher(url, config) {
      assert.equal(config.headers.Authorization, undefined);
      if (url.pathname === '/api/search/multi-search') {
        const [query] = JSON.parse(config.body).queries;
        assert.deepEqual(query.filter, ['tags.name = "civitai official"']);
        return Response.json({ results: [{ hits: [{ id: 14, nsfwLevel: [1] }, { id: 15, nsfwLevel: [1] }] }] });
      }
      if (url.pathname === '/api/v1/articles') {
        assert.equal(url.searchParams.get('tags'), '831959');
        return Response.json({ items: [{ id: 14, nsfwLevel: 1 }, { id: 16, nsfwLevel: 1 }] });
      }
      const id = Number(url.pathname.split('/').at(-1));
      const candidate = id === 2579 ? article(id, 'Civitai Buzz', 'Credits and rewards.', { isOfficial: true })
        : article(id, 'Blue Buzz guide ' + id, 'Blue Buzz details.', {
          isOfficial: id !== 15, tags: [{ id: 831959, name: 'civitai official' }], coverImageWithheld: id === 16,
          coverImage: { ...cover(id, 1), name: oldKey, url: oldKey },
        });
      return Response.json(candidate);
    },
  });
  assert.equal(found.nativeLink, origin + '/buzz/marketplace');
  assert.deepEqual(found.related.marketplace.map(item => [item.id, item.category]), [
    [14, 'Official Civitai article'], [16, 'Official Civitai article'],
  ]);
  assert.ok(found.related.marketplace[0].preview.endsWith('/' + oldKey + '.jpeg'));
  assert.equal(found.related.marketplace[1].preview, null);
  assert.ok(found.related.marketplace.every(item => !Object.hasOwn(item, 'price')));
});

test('direct service and storefront references open the active domain and reject deal and purchase routes', async () => {
  const noRead = { fetcher() { assert.fail('Direct native reference should make zero catalog requests'); } };
  const detail = await discover(context, { query: 'https://civitai.com/services/48/training?request=1' }, noRead);
  const storefront = await discover(context, { query: 'https://civitai.com/user/CivChan/shop#service-48' }, noRead);
  assert.equal(detail.nativeLink, origin + '/services/48');
  assert.equal(storefront.nativeLink, origin + '/user/CivChan/shop#service-48');
  const parent = { postMessage: message => sent.push(message) };
  const sent = [];
  let receive;
  let host;
  watchHost({ parent, document: { body: { scrollHeight: 700 } },
    addEventListener(_name, callback) { receive = callback; } }, ready => { host = ready; });
  receive({ source: parent, origin, data: { type: 'BLOCK_INIT', payload: {
    blockId: 'rasterraid', blockInstanceId: 'fixture', context: { slotId: 'app.page' }, renderMode: 'iframe',
  } } });
  for (const path of [
    '/services?query=music+video', '/services/48', '/user/CivChan/shop#service-48', '/buzz/marketplace',
    '/services/deals', '/services/deals/1', '/services/48?request=1', '/services?query=foo&query=bar',
    '/user/CivChan/shop/manage', '/user/CivChan/shop#checkout', '/buzz/marketplace?buy=1', '/purchase/buzz',
  ]) host.open(origin + path);
  assert.deepEqual(sent.filter(item => item.type === 'NAVIGATE').map(item => item.payload.path),
    ['/services?query=music+video', '/services/48', '/user/CivChan/shop#service-48', '/buzz/marketplace']);
});
