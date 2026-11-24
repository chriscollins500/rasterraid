import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/search.mjs';
import { audioFamilies } from '../src/specialty.mjs';
import { catalogResearchItems } from '../src/catalog-research.mjs';

const context = { hosted: true, origin: 'https://civitai.red', browsingLevel: 3, token: 'fake-app-token' };
const host = 'https://image.civitai.com/rasterraid-fixture/';
const model = {
  id: 41, name: 'Citypop music kit', type: 'Workflows', creator: { username: 'sampler' },
  modelVersions: [{
    id: 72, name: 'R2', baseModel: 'New Music Suite', images: [
      { url: host + 'out-of-level.jpg', type: 'image', nsfwLevel: 8 },
    ],
  }, { id: 90, name: 'Image edition', baseModel: 'SDXL 1.0' }],
};
const media = (id, type, fields) => ({
  id, type, browsingLevel: 1, url: host + id + (type === 'audio' ? '.mp3' : '.mp4'),
  username: 'sampler', thumbnail: { url: host + id + '.jpg' }, ...fields,
});
const json = data => Response.json(data);

test('audio searches live families alongside the typed feed and plays only eligible media', async () => {
  const families = audioFamilies(['SDXL 1.0', 'Sonilo', 'New Music Suite']);
  assert.deepEqual(families, ['Sonilo', 'New Music Suite']);
  const result = await discover(context, { scope: 'audio', query: 'citypop', audioFamilies: families }, {
    async fetcher(url, config) {
      assert.equal(url.origin, context.origin);
      if (url.pathname === '/api/search/multi-search') {
        assert.equal(config.headers.Authorization, undefined);
        return json({ results: [{ hits: [{ tags: [{ id: 15, name: 'citypop' }] }] }] });
      }
      assert.equal(config.headers.Authorization, 'Bearer ' + context.token);
      if (url.pathname.endsWith('/models')) {
        assert.deepEqual(url.searchParams.getAll('baseModels'), families);
        assert.equal(url.searchParams.get('query'), 'citypop');
        return json({ items: [model] });
      }
      assert.ok(url.pathname.endsWith('/images'));
      if (url.searchParams.get('type') === 'audio') {
        assert.equal(url.searchParams.get('tags'), '15');
        return json({ items: [
          media(122, 'audio', { tags: [{ id: 15, name: 'citypop' }], meta: { title: 'Night Train' } }),
          media(123, 'audio', { tags: [{ id: 15, name: 'citypop' }], browsingLevel: 4 }),
        ], metadata: { nextCursor: 'next:audio' } });
      }
      assert.equal(url.searchParams.get('modelVersionId'), '72');
      assert.equal(url.searchParams.get('withMeta'), 'true');
      assert.equal(url.searchParams.has('type'), false);
      return json({ items: [media(124, 'video', { meta: { prompt: 'Upbeat citypop' } }),
        media(125, 'audio', { meta: { prompt: 'Upbeat citypop' } })] });
    },
  });
  assert.equal(result.gallery.nextCursor, 'next:audio');
  assert.deepEqual(result.related.audio.map(item => [item.title, item.audio, item.stream]), [['Night Train', true, host + '122.mp3']]);
  assert.equal(result.related.audioExamples[0].source, context.origin + '/models/41?modelVersionId=72');
  assert.equal(result.related.audioExamples[0].video, true);
  assert.deepEqual(result.related.audioExamples.map(item => item.category), ['Video example', 'Audio example']);
  assert.equal(result.related.audioTools[0].preview, host + '124.jpg');
});

test('a release full of pictures can recover both playable formats through bounded reads', async () => {
  const formats = [];
  const result = await discover(context, { scope: 'audio', query: 'Citypop', audioFamilies: ['New Music Suite'] }, { async fetcher(url, config) {
    if (url.pathname === '/api/search/multi-search') return json({ results: JSON.parse(config.body).queries.map(() => ({ hits: [] })) });
    if (url.pathname === '/api/v1/blocks/models') return json({ items: [model] });
    assert.equal(url.pathname, '/api/v1/blocks/images');
    if (!url.searchParams.has('modelVersionId')) return json({ items: [] });
    const type = url.searchParams.get('type');
    formats.push(type);
    if (type === 'video') return json({ items: [media(124, 'video')] });
    if (type === 'audio') return json({ items: [media(125, 'audio')] });
    return json({ items: [media(160, 'image', { url: host + '160.jpg' })], metadata: { nextCursor: 'more-examples' } });
  } });
  assert.deepEqual(formats, [null, 'video', 'audio']);
  assert.deepEqual(result.related.audioExamples.map(item => [item.id, item.category]), [[124, 'Video example'], [125, 'Audio example']]);
});

test('the anonymous audio route uses an exact public post to verify each eligible clip independently of the model listing', async () => {
  const guest = { ...context, token: undefined, browsingLevel: 1 };
  const released = { ...model, nsfwLevel: 3, availability: 'Public', modelVersions: [
    { ...model.modelVersions[0], nsfwLevel: 3, availability: 'Public' },
    { ...model.modelVersions[0], id: 73, availability: 'Private' },
  ] };
  const hiddenModel = { ...released, id: 901, modelVersions: [{ ...released.modelVersions[0], id: 98 }], availability: 'Private' };
  const first = media(124, 'video', { postId: 701, meta: { prompt: 'Citypop with hidden model settings' } });
  const second = media(125, 'video', { postId: 702, meta: { prompt: 'Citypop' } });
  const denied = media(126, 'video', { postId: 703, browsingLevel: 2, meta: { prompt: 'Citypop' } });
  const reads = [];
  const result = await discover(guest, { scope: 'audio', query: 'Citypop', audioFamilies: ['New Music Suite'] }, {
    async fetcher(url, config) {
      assert.equal(config.headers.Authorization, undefined);
      assert.equal(config.credentials, 'omit');
      reads.push([url.pathname, url.searchParams.get('modelVersionId')]);
      if (url.pathname === '/api/search/multi-search') return json({ results: JSON.parse(config.body).queries.map(() => ({ hits: [] })) });
      if (url.pathname === '/api/v1/models') return json([released, hiddenModel]);
      if (url.pathname === '/api/v1/images') {
        assert.equal(url.searchParams.get('browsingLevel'), '1');
        assert.equal(url.searchParams.get('modelVersionId'), '72');
        return json({ items: [first, second, denied] });
      }
      const id = Number(url.pathname.split('/').at(-1));
      assert.ok(id === 701 || id === 702);
      return json({ id, publishedAt: '2025-02-01T00:00:00Z', nsfwLevel: 1, modelVersionId: id === 701 ? 72 : 91,
        images: id === 701 ? [first] : [second] });
    },
  });
  assert.deepEqual(result.related.audioTools, []);
  assert.deepEqual(result.related.audioExamples.map(item => [item.id, item.source, item.prompt]), [[124, guest.origin + '/posts/701', '']]);
  assert.deepEqual(catalogResearchItems(result, result.related, 'audioExamples', guest.origin).map(item => item.source), [guest.origin + '/posts/701']);
  assert.doesNotMatch(JSON.stringify(result.related), /Citypop music kit|\/models\/41|hidden model settings/u);
  assert.ok(!reads.some(([path, version]) => path.startsWith('/api/v1/blocks/') || ['73', '98'].includes(version) || path.endsWith('/703')));
});

test('an exact guest audio lookup binds the model and version before opening its examples', async () => {
  const guest = { ...context, token: undefined, browsingLevel: 1 };
  const version = { ...model.modelVersions[0], modelId: 41, nsfwLevel: 1, availability: 'Public', status: 'Published' };
  const released = { ...model, nsfwLevel: 1, availability: 'Public', modelVersions: [version] };
  const paths = [];
  const run = modelId => discover(guest, { scope: 'audio', query: guest.origin + '/models/' + modelId + '?modelVersionId=72',
    audioFamilies: ['New Music Suite'] }, { async fetcher(url, config) {
    paths.push(url.pathname);
    assert.equal(config.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/model-versions/72') return json(version);
    if (url.pathname === '/api/v1/models/41') return json(released);
    if (url.pathname === '/api/v1/images') {
      return json({ items: url.searchParams.get('type') === 'audio' ? [] : [media(124, 'video')] });
    }
    assert.fail('Unexpected request');
  } });
  const found = await run(41);
  assert.deepEqual(found.related.audioTools.map(item => item.link), [guest.origin + '/models/41?modelVersionId=72']);
  assert.deepEqual(found.related.audioExamples.map(item => item.id), [124]);
  assert.ok(paths.includes('/api/v1/models/41'));
  paths.length = 0;
  const mismatched = await run(95);
  assert.deepEqual(mismatched.related.audio, []);
  assert.deepEqual(mismatched.related.audioTools, []);
  assert.deepEqual(mismatched.related.audioExamples, []);
  assert.ok(!paths.includes('/api/v1/images'));
});

test('an App catalog refusal does not reroute audio discovery through anonymous model reads', async () => {
  const calls = [];
  const result = await discover(context, { scope: 'audio', query: 'Citypop', audioFamilies: ['New Music Suite'] }, { async fetcher(url, config) {
    calls.push(url.pathname);
    if (url.pathname === '/api/search/multi-search') return json({ results: JSON.parse(config.body).queries.map(() => ({ hits: [] })) });
    assert.ok(url.pathname.startsWith('/api/v1/blocks/'));
    assert.equal(config.headers.Authorization, 'Bearer ' + context.token);
    return Response.json({ error: 'Access denied' }, { status: 403 });
  } });
  assert.ok(calls.includes('/api/v1/blocks/models'));
  assert.deepEqual(result.related.audioTools, []);
  assert.deepEqual(result.related.audioExamples, []);
  assert.ok(result.flows.some(flow => flow.status === 403));
});

test('music search can match the recorded example prompt when model names miss', async () => {
  const result = await discover(context, { scope: 'audio', query: 'warm piano', audioFamilies: ['New Music Suite'] }, {
    async fetcher(url, config) {
      if (url.pathname === '/api/search/multi-search') {
        return json({ results: JSON.parse(config.body).queries.map(() => ({ hits: [] })) });
      }
      if (url.pathname.endsWith('/models')) return json({ items: url.searchParams.has('query') ? [] : [model] });
      return json({ items: [
        media(124, 'video', { meta: { prompt: 'Warm jazz piano on tape' } }),
        media(125, 'video', { meta: { prompt: 'Organ and synth' } }),
      ] });
    },
  });
  assert.deepEqual(result.related.audioExamples.map(item => item.id), [124]);
  assert.deepEqual(result.related.audioTools, []);
});

test('3D discovery merges typed public collection sources and keeps the native asset route', async () => {
  const row = (id, fields) => ({
    id, type: 'Model3D', name: 'Sculpture collection ' + id, read: 'Public', isPublic: true, nsfwLevel: 1, ...fields,
  });
  const result = await discover(context, { scope: 'assets3d', query: 'sculpture' }, {
    async fetcher(url, config) {
      assert.equal(url.origin, context.origin);
      assert.equal(config.headers.Authorization, undefined);
      if (url.pathname === '/api/v1/collections') {
        assert.equal(url.searchParams.get('query'), 'sculpture');
        return json({ items: [
          row(3, { itemCount: 2, coverImage: { nsfwLevel: 2, url: host + 'sculpt.jpg' } }),
          row(4, { type: 'Model' }), row(5, { isPublic: false }), row(6, { nsfwLevel: 4 }),
        ] });
      }
      assert.deepEqual(JSON.parse(config.body).queries[0].filter, 'type = "Model3D"');
      return json({ results: [{ hits: [
        row(3, { nsfwLevel: [1, 2] }), row(7, { nsfwLevel: [1], metrics: { itemCount: 4 } }), row(8, { nsfwLevel: [1, 4] }),
      ] }] });
    },
  });
  assert.deepEqual(result.related.assets3d.map(item => [item.link, item.description, item.preview]), [
    [context.origin + '/collections/3', '2 items', host + 'sculpt.jpg'],
    [context.origin + '/collections/7', '4 items', null],
  ]);
  assert.equal(result.nativeLink, context.origin + '/3d-models');
  const exact = await discover(context, { scope: 'assets3d', query: 'https://civitai.com/3d-models/19/robot' }, {
    fetcher() { assert.fail('Native detail links do not call a restricted endpoint'); },
  });
  assert.equal(exact.nativeLink, context.origin + '/3d-models/19');
  assert.deepEqual(exact.related.assets3d, []);
});
