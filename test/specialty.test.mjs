import test from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/search.mjs';
import { audioFamilies } from '../src/specialty.mjs';

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
      return json({ items: [media(124, 'video', { meta: { prompt: 'Upbeat citypop' } })] });
    },
  });
  assert.equal(result.gallery.nextCursor, 'next:audio');
  assert.deepEqual(result.related.audio.map(item => [item.title, item.audio, item.stream]), [['Night Train', true, host + '122.mp3']]);
  assert.equal(result.related.audioExamples[0].source, context.origin + '/models/41?modelVersionId=72');
  assert.equal(result.related.audioExamples[0].video, true);
  assert.equal(result.related.audioTools[0].preview, host + '124.jpg');
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
