import assert from 'node:assert/strict';
import test from 'node:test';
import { articlePassageCards, articlePassageLimit, rankArticlePassages, readArticlePassageSources } from '../src/article-passages.mjs';
import { watchHost } from '../src/civitai-host.js';
import { isDirectoryNavigation } from '../src/directory.mjs';

const origin = 'https://civitai.red';
const context = { origin, hosted: true, browsingLevel: 3, token: 'fixture' };
const link = id => origin + '/articles/' + id;
const card = id => ({ id, title: 'Guide ' + id, link: link(id) });
const text = text => ({ type: 'text', text });
const paragraph = (...content) => ({ type: 'paragraph', content });
const heading = (value, id = null) => ({ type: 'heading', attrs: { id, level: 2 }, content: [text(value)] });
const article = (id, part = {}, ...content) => ({
  id, title: 'Guide ' + id, status: 'Published', availability: 'Public', nsfwLevel: 1, unlisted: false,
  user: { username: 'writer' }, tags: [{ id: 44, name: 'Workflow' }], isOfficial: true, updatedAt: '2026-11-21T10:04:00Z',
  contentJson: { type: 'doc', content: content.length ? content : [paragraph(text('Use sparse steps to keep the canvas clear.'))] },
  ...part,
});
const idFor = url => Number(url.pathname.split('/').at(-1));

test('ranks a useful passage ahead of topic repetition and cites its published heading', async () => {
  const returned = new Map([
    [4, article(4, {}, heading('Memory setup', 'memory-setup'), paragraph(text('Memory '.repeat(30) + 'allocation is optional.')))],
    [5, article(5, {}, paragraph(text('Opening remarks. '.repeat(28))), heading('Reserving memory', 'reserving-memory-1'),
      paragraph(text('Keep a '), text('memory'), text(' reserve of at least 2 GB before you load the second model.')),
      { type: 'media', content: [text('A hidden memory reserve phrase')] },
      heading('Other notes', 'other-notes'), paragraph(text('A cache makes startup faster.')))],
  ]);
  const calls = [];
  const reading = await readArticlePassageSources(context, [card(4), card(5)], {}, {
    fetcher(url, options) {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      assert.equal(url.origin, origin);
      assert.equal(url.search, '');
      const id = idFor(url);
      calls.push(id);
      return Response.json(returned.get(id));
    },
  });
  const ranked = rankArticlePassages(reading.sources, 'How much memory reserve?');
  assert.deepEqual(calls, [4, 5]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 5);
  assert.equal(ranked[0].heading, 'Reserving memory');
  assert.equal(ranked[0].sectionLink, link(5) + '#reserving-memory');
  assert.equal(ranked[0].updatedAt, '2026-11-21T10:04:00.000Z');
  assert.match(ranked[0].excerpt, /reserve of at least 2 GB/u);
  assert.deepEqual(ranked[0].matches.map(([a, b]) => ranked[0].excerpt.slice(a, b)), ['memory', 'reserve']);
  assert.equal(rankArticlePassages(reading.sources, 'hidden memory reserve phrase').some(row => row.excerpt.includes('hidden')), false);
});

test('keeps unlinked headings as titles, handles multilingual terms and bounds long excerpts', async () => {
  const rows = [
    heading('風景の水彩画'),
    paragraph(text('下絵を描いたあと、綺麗な風景の水彩画を描きます。')),
    heading('Geometry', 'geometry-1'),
    paragraph(text(('a separate workflow step without useful evidence ').repeat(52) + ' Keep the precision slot identifiers.')),
  ];
  const reading = await readArticlePassageSources(context, [card(5)], {}, {
    fetcher: () => Response.json(article(5, {}, ...rows)),
  });
  const [japanese] = rankArticlePassages(reading.sources, '水彩画');
  assert.equal(japanese.heading, '風景の水彩画');
  assert.equal(japanese.sectionLink, null);
  assert.equal(japanese.articleLink, link(5));
  const [long] = rankArticlePassages(reading.sources, 'precision slot identifiers');
  assert.equal(long.heading, 'Geometry');
  assert.equal(long.sectionLink, link(5) + '#geometry');
  assert.ok(long.excerpt.length <= 302 && long.excerpt.startsWith('…'));
  assert.match(long.excerpt, /precision slot identifiers/u);
  assert.deepEqual(rankArticlePassages(reading.sources, 'why what'), []);
});

test('keeps a plain-text fallback for older article responses', async () => {
  const reading = await readArticlePassageSources(context, [card(3)], {}, { fetcher: () =>
    Response.json(article(3, { contentJson: null, content: '<p>Intro</p><p>Keep the sampler seed &amp; original steps.</p>' })) });
  const [row] = rankArticlePassages(reading.sources, 'sampler seed');
  assert.match(row.excerpt, /sampler seed & original steps/u);
  assert.equal(row.sectionLink, null);
});

test('falls back from duplicate native heading slugs and skips excerpts containing spoilers', async () => {
  const marked = { ...text('hidden outcome'), marks: [{ type: 'spoiler' }] };
  const reading = await readArticlePassageSources(context, [card(1), card(2)], {}, { fetcher: url =>
    Response.json(idFor(url) === 1 ? article(1, {},
      heading('First steps', 'stored-first'), paragraph(text('Use a tiny batch.')),
      heading('First steps?', 'stored-second'), paragraph(text('Set a deterministic seed.')),
      paragraph(text('This has a '), marked),
      { type: 'spoilerBlock', content: [paragraph(text('secret final outcome'))] })
      : article(2, { contentJson: null, content: '<p><span data-type = " SPOILER ">hidden outcome</span></p>' })) });
  const [step] = rankArticlePassages(reading.sources, 'deterministic seed');
  assert.equal(step.heading, 'First steps?');
  assert.equal(step.sectionLink, null);
  assert.deepEqual(reading.sources.map(row => row.id), [1]);
  assert.deepEqual(rankArticlePassages(reading.sources, 'secret final outcome'), []);
  assert.deepEqual(rankArticlePassages(reading.sources, 'hidden outcome'), []);
});

test('rechecks exact identity, visibility, current article filters and selected links', async () => {
  const claimed = [card(1), card(2), card(3), card(4), card(5), card(6), card(7),
    { ...card(3), link: 'https://civitai.com/articles/3' }, { ...card(4), link: link(4) + '#some-target' }];
  assert.equal(articlePassageCards(claimed, origin).length, 7);
  const fetched = [];
  const records = new Map([
    [1, article(1)], [2, article(21)], [3, article(3, { availability: 'Private' })],
    [4, article(4, { nsfwLevel: 4 })], [5, article(5, { user: { username: 'wrong-writer' } })],
    [6, article(6, { tags: [{ id: 97, name: 'unrelated' }] })],
  ]);
  const reading = await readArticlePassageSources(context, claimed, { author: 'Writer', tag: 'workflow', official: true }, {
    fetcher(url) {
      const id = idFor(url);
      fetched.push(id);
      return Response.json(records.get(id));
    },
  });
  assert.equal(reading.attempted, articlePassageLimit);
  assert.deepEqual(fetched, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(reading.sources.map(source => source.id), [1]);
});

test('stops new article reads on a rate limit and keeps completed passages', async () => {
  const calls = [];
  const reading = await readArticlePassageSources(context, [card(1), card(2), card(3)], {}, { fetcher(url) {
    const id = idFor(url);
    calls.push(id);
    return id === 2 ? Response.json({ error: 'rate limit' }, { status: 429, headers: { 'Retry-After': '4' } })
      : Response.json(article(id));
  } });
  assert.equal(reading.paused, true);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(reading.attempted, 2);
  assert.deepEqual(rankArticlePassages(reading.sources, 'sparse steps').map(row => row.id), [1]);
});

test('drops replies that arrive after passage search cancellation', async () => {
  const controller = new AbortController();
  const response = Promise.withResolvers();
  const started = Promise.withResolvers();
  const calls = [];
  const reading = readArticlePassageSources(context, [card(1), card(2), card(3)], {}, {
    signal: controller.signal,
    fetcher(url) {
      calls.push(idFor(url));
      if (calls.length === 2) started.resolve();
      return response.promise;
    },
  });
  await started.promise;
  controller.abort();
  response.resolve(Response.json(article(1)));
  await assert.rejects(reading, { name: 'AbortError' });
  assert.deepEqual(calls, [1, 2]);
});

test('passes a native heading through the host bridge with a same-domain article path', () => {
  const articleLink = link(9);
  const section = '#auctions:-redux-bbiut5el1';
  assert.equal(isDirectoryNavigation(new URL(articleLink + section)), true);
  for (const suffix of ['#%zz', '#:~:text=anything', '#%2Fmodels%2F1', '?edit=1#heading', '/edit#heading']) {
    assert.equal(isDirectoryNavigation(new URL(articleLink + suffix)), false);
  }
  const messages = [];
  const parent = { postMessage: message => messages.push(message) };
  let receive;
  let host;
  watchHost({ parent, document: { body: { scrollHeight: 700 } },
    addEventListener(_event, receiveMessage) { receive = receiveMessage; } }, next => { host = next; });
  receive({ source: parent, origin, data: { type: 'BLOCK_INIT', payload: {
    blockId: 'rasterraid', blockInstanceId: 'fixture', context: { slotId: 'app.page' }, renderMode: 'iframe',
  } } });
  host.open(articleLink + section);
  host.open(articleLink + '#:~:text=anything');
  host.open('https://civitai.com/articles/9#heading');
  assert.deepEqual(messages.filter(message => message.type === 'NAVIGATE').map(message => message.payload.path),
    ['/articles/9' + section, '/articles/9']);
});
