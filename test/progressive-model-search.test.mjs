import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG } from '../src/catalog.mjs';
import { discover } from '../src/search.mjs';

const origin = 'https://civitai.red';
const context = { origin, hosted: true, token: 'fixture-token', browsingLevel: 3 };
const query = 'Color Plates for Old Woodcuts';
const filters = { scope: 'models', query };
const model = (id, name) => ({ id, name, type: 'LORA', availability: 'Public', nsfw: false, nsfwLevel: 1,
  status: 'Published', modelVersions: [{ id: 100 + id, name: 'v1', baseModel: 'SDXL 1.0', status: 'Published', availability: 'Public',
    images: [{ id: 9000 + id, browsingLevel: 4, url: 'https://image.civitai.com/fixture/withheld.jpeg' },
      { id: 1000 + id, browsingLevel: 1, url: 'https://image.civitai.com/fixture/visible.jpeg' }], trainedWords: [] }] });
const exact = model(1, query);
const alternatives = [model(2, 'Old Woodcut Color Plates'), model(3, 'Aged Woodcut Plates')];

function catalogFixture(url, config) {
  assert.equal(url.origin, origin);
  assert.equal(config.credentials, 'omit');
  if (url.pathname === CATALOG.blockModels) assert.equal(config.headers.Authorization, 'Bearer fixture-token');
  if (![CATALOG.blockModels, CATALOG.models].includes(url.pathname)) return Response.json({ items: [] });
  const requested = url.searchParams.get('query');
  return Response.json({ items: requested === query ? [exact] : alternatives });
}

test('literal App search opens the exact visible title while local language detection is pending', { timeout: 2000 }, async t => {
  const availability = Promise.withResolvers();
  const initial = Promise.withResolvers();
  const originalDetector = globalThis.LanguageDetector;
  const originalTranslator = globalThis.Translator;
  t.after(() => {
    globalThis.LanguageDetector = originalDetector;
    globalThis.Translator = originalTranslator;
  });
  globalThis.LanguageDetector = { availability: () => availability.promise };
  globalThis.Translator = {};
  const calls = [];
  const search = discover(context, filters, {
    fetcher(url, config) { calls.push([url.pathname, url.searchParams.get('query')]); return catalogFixture(url, config); },
    onExactModel: initial.resolve,
  });
  try {
    assert.deepEqual(calls, [[CATALOG.blockModels, query]], 'the literal read must start before language detection returns');
    const preview = await initial.promise;
    assert.equal(preview.exactTitleReady, true);
    assert.deepEqual(preview.shortlisted, []);
    assert.equal(preview.candidates[0].link, origin + '/models/1?modelVersionId=101');
    assert.deepEqual(preview.candidates[0].examples.map(image => image.id), [1001]);
    assert.equal(calls.length, 1, 'the other query lanes are still waiting');
  } finally {
    availability.resolve('unavailable');
    await search;
  }
  const result = await search;
  assert.equal(result.exactTitleReady, undefined);
  assert.deepEqual(result.shortlisted.map(item => item.id), [101, 102, 103]);
});

test('early exact titles respect filters, ordering, local ranking, and App visibility', async () => {
  for (const [viewer, modified, options, expected] of [
    [context, { baseModel: ['SDXL 1.0'] }, {}, true],
    [context, { baseModel: ['Flux.1 D'] }, {}, false],
    [context, { exclude: 'old woodcuts' }, {}, false],
    [context, { sort: 'Newest' }, {}, false],
    [context, { query: 'Color Plates for Old Woodcuts v1' }, {}, false],
    [context, {}, { catalogOnly: true }, false],
    [context, {}, { preferences: { enabled: true } }, false],
    [{ ...context, token: undefined }, {}, {}, false],
  ]) {
    const shown = [];
    await discover(viewer, { ...filters, ...modified }, { ...options, fetcher: catalogFixture, onExactModel: value => shown.push(value) });
    assert.equal(Boolean(shown.length), expected, JSON.stringify({ modified, options, hasToken: Boolean(viewer.token) }));
  }
});

test('a listing with an added release suffix stays in the full ranking', async () => {
  const shown = [];
  const result = await discover(context, filters, { onExactModel: item => shown.push(item), fetcher(url, config) {
    if (url.pathname === CATALOG.blockModels && url.searchParams.get('query') === query) {
      return Response.json({ items: [{ ...exact, name: query + ' v1' }] });
    }
    return catalogFixture(url, config);
  } });
  assert.deepEqual(shown, []);
  assert.equal(result.candidates[0].id, 101);
  assert.equal(result.candidates[0].nameMatch, 1);
});

test('a literal response arriving after cancellation never opens its model link', { timeout: 2000 }, async () => {
  const ready = Promise.withResolvers();
  const held = Promise.withResolvers();
  const controller = new AbortController();
  const shown = [];
  const search = discover(context, filters, { signal: controller.signal, onExactModel: item => shown.push(item),
    async fetcher(url, config) {
      if (url.pathname === CATALOG.blockModels && url.searchParams.get('query') === query) {
        ready.resolve();
        await held.promise;
      }
      return catalogFixture(url, config);
    },
  });
  await ready.promise;
  controller.abort();
  held.resolve();
  await assert.rejects(search, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shown, []);
});
