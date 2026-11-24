import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjustMediaOrder, personalMediaOrder, personalModelOrder, preferenceDocument, saveFeedback, saveMediaFeedback,
  visibleFeedback, visibleMediaFeedback } from '../src/preferences.mjs';
import { discover } from '../src/search.mjs';
import { configurePreferences } from '../src/preference-view.js';

const sample = (id, { creator = 'sample', tags = [], nameMatch = 0, match = 1, rank = .05 } = {}) => ({
  id, modelId: id + 200, creator, tags, nameMatch, match, phrase: true, rank, base: 'SDXL 1.0', type: 'LORA',
});
const media = (id, tags, value = {}) => ({ id, postId: id + 100, creator: 'creator-' + id, browsingLevel: 1,
  preferenceTags: tags, ...value });

test('model feedback stores one exact version vote and projects only visible, approved fields', () => {
  const card = { ...sample(3, { tags: ['Print', 'Ｐｒｉｎｔ'] }), token: 'fixture', query: 'my private brief' };
  const positive = saveFeedback(null, card, 1, 3);
  const negative = saveFeedback(positive, card, -1, 3);
  assert.deepEqual(visibleFeedback(negative, 1), []);
  assert.deepEqual(preferenceDocument({ ...negative, enabled: true }), { enabled: true, feedback: [
    { id: 3, modelId: 203, vote: -1, level: 3, creator: 'sample', tags: ['print'], base: 'sdxl 1.0', type: 'lora' },
  ] });
  assert.deepEqual(saveFeedback(negative, card, 0, 3).feedback, []);
});

test('explicit preferences move related peers while preserving exact names, relevance and creator variety', () => {
  const rows = [sample(11, { nameMatch: 2, creator: 'other' }), sample(12, { tags: ['studio'], creator: 'wood' }),
    sample(13, { tags: ['print'], creator: 'press' }), sample(14, { tags: ['print'], creator: 'other' }),
    sample(15, { tags: ['print'], creator: 'riso', match: .75, rank: .03 })];
  const positive = saveFeedback({ enabled: true }, sample(22, { tags: ['print'], creator: 'press' }), 1, 3);
  const reranked = personalModelOrder(rows, positive, 3);
  assert.deepEqual(reranked.map(row => row.id), [11, 13, 12, 14, 15]);
  assert.deepEqual(personalModelOrder(rows, { ...positive, enabled: false }, 3), rows);
  assert.deepEqual(personalModelOrder(rows, positive, 1), rows);

  const diverse = [sample(1, { creator: 'press', nameMatch: 2 }), sample(2, { creator: 'wood', match: .9 }),
    sample(3, { creator: 'riso', match: .7 }), sample(4, { creator: 'press', match: .7 })];
  const direct = saveFeedback({ enabled: true }, diverse[3], 1, 3);
  assert.deepEqual(personalModelOrder(diverse, direct, 3), diverse);
});

test('media ratings migrate old profiles without enabling them and store only a visible gallery projection', () => {
  const old = saveFeedback({ enabled: true }, sample(42), 1, 1);
  const item = media(25, [4, 4, -1, '5', 7], { browsingLevel: 2, prompt: 'private prompt', stream: 'private url', video: true });
  const saved = saveMediaFeedback(old, item, -1, 3);
  assert.deepEqual(saved.feedback, old.feedback);
  assert.equal(saved.mediaEnabled, undefined);
  assert.deepEqual(saved.mediaFeedback, [{ id: 25, postId: 125, type: 'video', vote: -1, level: 2, tags: [4, 7] }]);
  assert.deepEqual(visibleMediaFeedback(saved, 1), []);
  assert.throws(() => saveMediaFeedback(saved, item, 1, 1), /visible picture or clip/u);
  assert.throws(() => saveMediaFeedback(saved, { ...item, audio: true }, 1, 3), /visible picture or clip/u);
  assert.deepEqual(saveMediaFeedback(saved, item, 0, 3), old);
});

test('picture ratings guide clip order with bounded moves and keep verified intent and source variety', () => {
  const history = saveMediaFeedback({ mediaEnabled: true }, media(90, [1, 3], { browsingLevel: 2 }), 1, 3);
  const base = [media(4, [1, 2], { video: true }), media(5, [1, 3], { video: true }),
    media(6, [1, 3], { video: true }), media(7, [1, 2], { video: true })];
  assert.deepEqual(personalMediaOrder(base, history, 3).map(row => row.id), [5, 6, 4, 7]);
  assert.equal(personalMediaOrder(base, history, 1), base);
  assert.equal(personalMediaOrder(base, { ...history, mediaEnabled: false }, 3), base);

  const marked = [{ ...base[0], rankEvidence: { score: 6, subject: 2, terms: 4 } },
    { ...base[1], rankEvidence: { score: 5, subject: 1, terms: 3 } }];
  assert.deepEqual(personalMediaOrder(marked, history, 3), marked);

  const diverse = [base[0], base[1], base[3], { ...base[2], creator: base[1].creator }];
  assert.deepEqual(adjustMediaOrder(diverse, new Map([[base[2].id, 1]])), diverse);
  const samePost = [base[0], base[1], base[3], { ...base[2], postId: base[1].postId }];
  assert.deepEqual(adjustMediaOrder(samePost, new Map([[base[2].id, 1]])), samePost);
});

test('shared search tags and repeated votes from one post leave weak media order alone', () => {
  const none = [media(1, [4, 8]), media(2, [4, 9, 10])];
  const positive = saveMediaFeedback({ mediaEnabled: true }, media(81, [4], { postId: 15 }), 1, 3);
  assert.deepEqual(personalMediaOrder(none, positive, 3), none);
  const duplicate = saveMediaFeedback(positive, media(82, [4, 9], { postId: 15 }), 1, 3);
  const sameEvidence = saveMediaFeedback({ mediaEnabled: true }, media(82, [4, 9], { postId: 15 }), 1, 3);
  assert.deepEqual(personalMediaOrder(none, duplicate, 3), personalMediaOrder(none, sameEvidence, 3));
});

test('normal discovery applies feedback after hard filters and honors explicit sort order', async () => {
  const model = (id, title, baseModel, tags) => ({ id, name: title, type: 'LORA', browsingLevel: 1, tags,
    creator: { username: 'sample' }, modelVersions: [{ id: id + 200, baseModel, trainedWords: [] }] });
  const versions = [model(1, 'Print Light', 'SDXL 1.0', ['studio']), model(2, 'Print Bold', 'SDXL 1.0', ['press']),
    model(3, 'Print Ink', 'Flux.1 D', ['press'])];
  const paths = [];
  const fetcher = url => {
    paths.push(url.pathname);
    const models = url.pathname === '/api/v1/blocks/models';
    const exact = url.searchParams.get('modelVersionIds');
    return Response.json({ items: models ? exact ? versions.filter(row => exact.split(',').includes(String(row.id + 200))) : versions : [] });
  };
  const context = { origin: 'https://civitai.red', hosted: true, token: 'fixture', browsingLevel: 3 };
  const filters = { query: 'print', scope: 'models', baseModel: 'SDXL 1.0' };
  const state = saveFeedback({ enabled: true }, { ...sample(202), modelId: 2 }, 1, 3);
  const baseline = await discover(context, filters, { fetcher });
  const baselinePaths = [...paths].sort();
  paths.length = 0;
  const ranked = await discover(context, filters, { fetcher, preferences: state });
  assert.deepEqual([...paths].sort(), baselinePaths);
  assert.deepEqual(baseline.candidates.map(row => row.id), [201, 202]);
  assert.deepEqual(ranked.candidates.map(row => row.id), [202, 201]);
  assert.equal(ranked.preferenceChanges, 2);
  const ordered = await discover(context, { ...filters, sort: 'Newest' }, { fetcher, preferences: state });
  assert.deepEqual(ordered.candidates.map(row => row.id), [201, 202]);
  assert.equal(ordered.preferenceMode, undefined);
});

test('preference controls restore tab rankings and remove feedback access when viewers change', async () => {
  const nodes = new Map();
  const session = new Map();
  const window = {
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, new EventTarget());
      return nodes.get(id);
    } },
    sessionStorage: { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) },
  };
  const owner = { viewerUserId: 4, origin: 'https://civitai.com', browsingLevel: 3, storageMode: 'local-preview', scopes: [] };
  let context = owner;
  const make = () => configurePreferences(window, {
    getContext: () => context, getSearch: () => undefined, isSearching: () => false, rerun() {}, onReady() {},
  });
  const ready = () => new Promise(resolve => setImmediate(resolve));
  const first = make();
  first.bind(owner);
  await ready();
  const rated = first.feedback(owner);
  assert.equal(await rated.save(sample(5), 1), true);
  const setting = nodes.get('personalize-models');
  setting.checked = true;
  setting.dispatchEvent(new Event('change'));
  await ready();
  assert.equal(first.forSearch(owner).enabled, true);
  const restored = make();
  restored.bind(owner);
  await ready();
  assert.equal(restored.feedback(owner).vote(sample(5)), 1);
  assert.equal(restored.forSearch(owner).enabled, true);
  context = { ...owner, viewerUserId: 9 };
  restored.bind(context);
  await ready();
  assert.equal(restored.forSearch(owner), undefined);
  assert.equal(restored.feedback(context).vote(sample(5)), 0);
  assert.equal(await rated.save(sample(6), 1), false);
});
