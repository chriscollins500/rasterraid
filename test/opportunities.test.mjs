import assert from 'node:assert/strict';
import test from 'node:test';
import { readBountyPage } from '../src/bounties.mjs';
import { watchHost } from '../src/civitai-host.js';
import { discover } from '../src/search.mjs';

const context = { origin: 'https://civitai.red', hosted: true, browsingLevel: 3, token: 'fixture' };
const cover = (id, nsfwLevel) => ({
  id, type: 'image', nsfwLevel, url: 'https://image.civitai.com/fixture/' + id + '.jpg',
});
const day = 24 * 60 * 60 * 1000;
const today = Date.now();
const start = new Date(today - day).toISOString();
const end = new Date(today + day).toISOString();
const bounty = (id, fields) => ({
  id, name: 'Landscape ' + id, nsfwLevel: [1, 4], type: 'ImageCreation', complete: false,
  startsAt: start, expiresAt: end, images: [cover(1, 1), cover(2, 4)],
  stats: { unitAmountCountAllTime: 2500, entryCountAllTime: 3 }, ...fields,
});

test('bounties use live typed facets, exclude closed requests from Open now, and cap each preview', async () => {
  const result = await discover(context, { scope: 'bounties', query: '@creator landscape', bountyType: 'ImageCreation',
    bountyBase: 'SDXL 1.0', bountyStatus: 'open', bountySort: 'buzz' }, {
    fetcher(url, config) {
      assert.equal(url.href, context.origin + '/api/search/multi-search');
      assert.equal(config.headers.Authorization, undefined);
      const [search, facets] = JSON.parse(config.body).queries;
      assert.equal(search.q, 'landscape');
      assert.deepEqual(search.filter, ['nsfwLevel IN [1, 2]', 'type = "ImageCreation"', 'details.baseModel = "SDXL 1.0"',
        'user.username = "creator"', 'complete = false']);
      assert.deepEqual(search.sort, ['stats.unitAmountCountAllTime:desc', 'id:desc']);
      assert.deepEqual(facets.facets, ['type', 'details.baseModel']);
      return Response.json({ results: [
        { hits: [bounty(41), bounty(42, { expiresAt: start }), bounty(43, { complete: true }), bounty(44, { nsfwLevel: [4] })] },
        { hits: [], facetDistribution: { type: { ImageCreation: 42, FutureType: 4, RetiredType: 0 }, 'details.baseModel': { 'SDXL 1.0': 12 } } },
      ] });
    },
  });
  assert.deepEqual(result.bountyFacets, { types: ['FutureType', 'ImageCreation'], bases: ['SDXL 1.0'] });
  const [first] = result.related.bounties;
  assert.equal(result.related.bounties.length, 1);
  assert.deepEqual([first.id, first.status, first.reward], [41, 'Open', 2500]);
  assert.deepEqual(first.previews.map(item => item.id), [1]);
});

test('bounty paging preserves the provider offset and exact lookup ignores browse filters', async () => {
  const options = { fetcher(_url, config) {
    const [search] = JSON.parse(config.body).queries;
    if (search.filter.includes('id = 2047')) {
      assert.equal(search.q, '');
      assert.equal(search.offset, 0);
      assert.equal(search.limit, 1);
      assert.equal(search.filter.includes('complete = false'), false);
      return Response.json({ results: [{ hits: [bounty(2047, { complete: true })] }] });
    }
    assert.equal(search.offset, 12);
    assert.equal(search.q, 'character');
    return Response.json({ results: [{ hits: [bounty(24)] }] });
  } };
  const page = await readBountyPage(context, { query: 'character' }, { ...options, cursor: 12 });
  assert.deepEqual(page.items.map(item => item.id), [24]);
  assert.equal(page.nextCursor, null);
  const exact = await discover(context, { query: 'https://civitai.com/bounties/2047/test', bountyStatus: 'open' }, options);
  assert.equal(exact.related.bounties[0].link, context.origin + '/bounties/2047');
});

test('challenge search distinguishes article references and guides and opens events on the active host', async () => {
  const result = await discover(context, { scope: 'challenges', query: 'community challenge' }, {
    fetcher(url, config) {
      assert.equal(url.origin, context.origin);
      assert.equal(config.headers.Authorization, undefined);
      const id = Number(url.pathname.split('/').at(-1));
      if (!id) return Response.json({ items: [{ id: 42, nsfwLevel: 1 }, { id: 43, nsfwLevel: 1 }] });
      return Response.json({
        id, status: 'Published', availability: 'Public', nsfwLevel: 1,
        title: id === 42 ? 'My community challenge' : 'Community challenges are now live',
        tags: [{ name: 'announcement' }],
        content: id === 42 ? '<a href="https://civitai.com/challenges/events/15/bright-gardens">Bright Gardens</a><a href="/challenges/create">Create</a>' : '',
        coverImage: cover(1, 1),
      });
    },
  });
  assert.deepEqual(result.related.challenges.map(item => [item.title, item.link, item.source]), [
    ['Bright Gardens', context.origin + '/challenges/events/15', context.origin + '/articles/42'],
  ]);
  assert.equal(result.related.guides[0].preview, cover(1, 1).url);
  assert.ok(result.nativeActions.some(item => item.link === context.origin + '/challenges?status=completed'));
  assert.ok(result.nativeActions.some(item => item.link === context.origin + '/challenges/winners'));
  const exact = await discover(context, { query: 'https://civitai.com/challenges/events/15/bright-gardens' }, {
    fetcher() { assert.fail('Exact native links do not require a catalog read'); },
  });
  assert.equal(exact.nativeLink, context.origin + '/challenges/events/15');
});

test('Crucible title recovery keeps real article references, host-specific links, and rated covers', async () => {
  const result = await discover(context, { scope: 'crucibles', query: 'Fantays Unleashed' }, {
    fetcher(url, options) {
      assert.equal(url.origin, context.origin);
      assert.equal(options.method ?? 'GET', 'GET');
      assert.equal(options.headers.Authorization, undefined);
      const id = Number(url.pathname.split('/').at(-1));
      if (!id) return Response.json({ items: [{ id: 42, nsfwLevel: 1 }, { id: 43, nsfwLevel: 1 }, { id: 44, nsfwLevel: 4 }] });
      assert.notEqual(id, 44);
      return Response.json({
        id, title: 'A Civitai Crucible series', status: 'Published', availability: 'Public', nsfwLevel: 1,
        content: id === 42 ? [
          '<a data-href="/crucibles/1" href="/crucibles/414/fantasy-unleashed">Fantasy <strong>Unleashed</strong></a>',
          '<a href="/crucibles/414">Fantasy Unleashed</a>',
          '<a href="/crucibles/412/judge">Judge Fantasy Unleashed</a>',
          '<a href="https://civitai.com/crucibles/413">Fantasy Unleashed</a>',
          '<a href="https://example.com/crucibles/415">Fantasy Unleashed</a>',
        ].join('') : '<a href="/crucibles/416">Fantasy Unleashed Too</a>',
        coverImage: cover(id, id === 42 ? 2 : 4),
      });
    },
  });
  assert.deepEqual(result.related.crucibles.map(item => [item.id, item.link, item.preview]), [
    [414, context.origin + '/crucibles/414', cover(42, 2).url],
    [416, context.origin + '/crucibles/416', null],
  ]);
  assert.equal(result.related.crucibles[0].source, context.origin + '/articles/42');
  assert.equal(new URL(result.nativeLink).searchParams.get('query'), 'Fantays Unleashed');
  assert.equal(result.nativeActions.find(action => action.label === 'Upcoming').link,
    context.origin + '/crucibles?query=Fantays+Unleashed&status=Pending');
  const exact = await discover(context, { query: 'Crucible #414' }, {
    fetcher() { assert.fail('Direct native handoff should use no API calls'); },
  });
  assert.equal(exact.nativeLink, context.origin + '/crucibles/414');
});

test('leaderboard shortcuts respect domain-specific boards and preserve season, legacy and shared positions', async () => {
  const options = { fetcher() { assert.fail('Leaderboard shortcuts should use no API calls'); } };
  const result = await discover(context, { scope: 'leaderboards', query: 'Crucible rankings' }, options);
  assert.deepEqual(result.related.leaderboards.map(item => item.id), ['crucible-judges', 'crucible-competitors', 'crucible-hosts']);
  const [judges] = result.related.leaderboards;
  assert.equal(judges.link, context.origin + '/leaderboard/crucible-judges');
  assert.equal(judges.legacyLink, context.origin + '/leaderboard/crucible-judges?board=legend');
  const red = await discover(context, { scope: 'leaderboards', query: 'mature' }, options);
  assert.deepEqual(red.related.leaderboards.map(item => item.id), ['overall_nsfw', 'images-nsfw']);
  const blue = await discover({ ...context, origin: 'https://civitai.com' }, { scope: 'leaderboards', query: 'mature' }, options);
  assert.equal(blue.related.leaderboards.length, 0);
  const position = await discover(context, { query: 'https://civitai.com/leaderboard/flux?position=35&date=2026-11-01' }, options);
  assert.equal(position.nativeLink, context.origin + '/leaderboard/flux?date=2026-11-01#35');
  const legacy = await discover(context, { query: 'https://civitai.com/leaderboard/flux?board=legend#35' }, options);
  assert.equal(legacy.nativeLink, context.origin + '/leaderboard/flux?board=legend');
});

test('host bridge forwards Crucible read paths and board positions while excluding contest actions', () => {
  const parent = { postMessage: message => messages.push(message) };
  const messages = [];
  let receive;
  let host;
  const win = {
    parent, document: { body: { scrollHeight: 700 } },
    addEventListener(_name, callback) { receive = callback; },
  };
  watchHost(win, context => { host = context; });
  receive({ source: parent, origin: context.origin, data: { type: 'BLOCK_INIT', payload: {
    blockId: 'rasterraid', blockInstanceId: 'fixture', context: { slotId: 'app.page' }, renderMode: 'iframe',
  } } });
  for (const path of [
    '/crucibles/414', '/crucibles?query=neon+dreams&status=Completed', '/crucibles?contentType=video',
    '/leaderboard/flux?date=2026-11-01#35', '/leaderboard/crucible-judges?board=legend',
    '/crucibles/414?submit=1', '/crucibles/414/judge', '/crucibles/create', '/crucibles?status=Cancelled',
    '/crucibles?status=Active&status=Pending', '/leaderboard/crucible-judges?board=invalid',
    '/leaderboard/flux#bad', '/leaderboard/crucible-judges?redirect=https://example.com',
  ]) host.open(context.origin + path);
  host.open('https://civitai.com/leaderboard/flux');
  assert.deepEqual(messages.filter(message => message.type === 'NAVIGATE').map(message => message.payload.path), [
    '/crucibles/414', '/crucibles?query=neon+dreams&status=Completed', '/crucibles?contentType=video',
    '/leaderboard/flux?date=2026-11-01#35', '/leaderboard/crucible-judges?board=legend',
  ]);
  assert.deepEqual(messages.at(-1).payload, {
    path: '/leaderboard/crucible-judges?board=legend', scope: 'site', target: 'new_tab',
  });
});
