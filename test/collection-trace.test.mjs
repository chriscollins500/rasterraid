import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverReport, reportMarkdown } from '../src/report.mjs';
import { reportResearchPlans } from '../src/report-research.mjs';

const origin = 'https://civitai.red';
const collection = { id: 11, type: 'Image', name: 'Print examples', isPublic: true, nsfwLevel: 1 };
const picture = id => 'https://image.civitai.com/public/' + id + '.jpeg';
const user = { origin, hosted: true, signedIn: true, browsingLevel: 3, token: 'fixture', scopes: ['collections:read:self', 'collections:read:private'] };
const filters = { reportType: 'collection', query: 'https://civitai.com/collections/11', baseModel: 'SDXL 1.0',
  reportSources: ['models', 'gallery', 'collections', 'videos', 'posts'] };
const member = (mediaId, nsfwLevel = 1) => ({ mediaId, type: 'image', nsfwLevel, url: picture(mediaId) });
const image = (id, options = {}) => ({ id, postId: 31, type: 'image', browsingLevel: 1, url: picture(id), ...options });
const model = (id, version, baseModel = 'SDXL 1.0') => ({ id, type: 'LORA', name: 'Model ' + id, modelVersions: [
  { id: version, baseModel, name: 'v1', images: [], files: [] },
] });

test('the public collection path follows a bounded second page and keeps member, post and recorded version identities exact', async () => {
  const reads = [];
  const progress = [];
  const result = await discoverReport(user, filters, {
    onRanked: state => progress.push(state.report),
    async fetcher(url, config) {
      assert.equal(url.origin, origin);
      reads.push([url.pathname, url.search]);
      if (url.pathname.startsWith('/api/v1/blocks/')) {
        assert.equal(config.headers.Authorization, 'Bearer fixture');
        if (!url.pathname.endsWith('/models')) assert.equal(config.cache, 'no-store');
      } else assert.equal(config.headers.Authorization, undefined);
      if (url.pathname === '/api/v1/collections/11') return Response.json(collection);
      if (url.pathname === '/api/v1/blocks/collections/11') {
        assert.equal(url.searchParams.get('limit'), '8');
        const cursor = url.searchParams.get('cursor');
        assert.ok(cursor == null || cursor === 'opaque-page-2');
        return Response.json({ collection, items: cursor ? [member(22), member(23, 8), member(24)] : [member(21)],
          nextCursor: cursor ? 'unread-page-3' : 'opaque-page-2' });
      }
      if (url.pathname === '/api/v1/blocks/images') {
        assert.equal(url.searchParams.get('ids'), '21,22,24');
        assert.equal(url.searchParams.get('withMeta'), 'true');
        return Response.json({ items: [image(99), image(22, { meta: { meta: { civitaiResources: [{ versionId: 41 }] } } }), image(21)] });
      }
      if (url.pathname === '/api/v1/posts/31') return Response.json({ id: 31, title: 'Verified source post', nsfwLevel: 1,
        publishedAt: '2026-11-01', modelVersionId: 42, images: [image(21), image(22), image(99)] });
      if (url.pathname === '/api/v1/blocks/models') {
        assert.equal(url.searchParams.get('modelVersionIds'), '42,41');
        return Response.json({ items: [model(51, 41), model(52, 42, 'Flux.1 D'), model(53, 43)] });
      }
      assert.fail('Unexpected catalog request: ' + url.pathname);
    },
  });
  assert.ok(progress[0].anchor.some(item => item.link === origin + '/collections/11'));
  assert.deepEqual(result.report.rails.map(rail => rail.scope), ['collections', 'gallery', 'videos', 'posts', 'models']);
  assert.equal(reads.length, 6);
  assert.deepEqual(result.related.gallery.map(item => item.id), [21, 22]);
  assert.deepEqual(result.candidates.map(item => item.id), [41]);
  assert.deepEqual(result.report.collectionTrace, { title: collection.name, link: origin + '/collections/11', status: 'partial',
    pages: 2, members: 3, shown: 2, more: true, posts: 1, versions: 1, filtered: 1, unavailable: 1, unavailableVersions: 0 });
  assert.ok(result.report.connections.some(row => row.kind === 'recorded' && row.items[1].link.endsWith('modelVersionId=41')));
  assert.ok(result.report.connections.some(row => row.kind === 'post-media'));
  assert.ok(!result.report.connections.some(row => row.kind === 'post-model'));
  const markdown = reportMarkdown(result.report);
  assert.match(markdown, /Collection trail[\s\S]*Checked 3 media items across 2 pages/u);
  assert.doesNotMatch(markdown + JSON.stringify(reportResearchPlans(result.report)), /\/images\/(?:23|24|99)\b|modelVersionId=42/u);
});

test('a signed-out viewer gets the native collection and no extra read or paid trail', async () => {
  const result = await discoverReport({ origin, hosted: true, signedIn: false, browsingLevel: 1 }, filters, {
    async fetcher(url) {
      assert.equal(url.pathname, '/api/v1/collections/11');
      return Response.json(collection);
    },
  });
  assert.equal(result.report.collectionTrace.status, 'access-needed');
  assert.ok(result.report.rails.some(rail => rail.nativeLink === origin + '/collections/11'));
  assert.deepEqual(reportResearchPlans(result.report), []);
});

test('a grant for private collections does not let a private or unlisted response enter the public report', async () => {
  let requests = 0;
  const result = await discoverReport(user, filters, {
    async fetcher(url) {
      requests++;
      if (url.pathname === '/api/v1/collections/11') return Response.json(collection);
      if (url.pathname === '/api/v1/blocks/collections/11') return Response.json({
        collection: { ...collection, isPublic: false, name: 'private-collection-canary' }, items: [member(99)],
      });
      assert.fail('An unverified collection must not cause more reads.');
    },
  });
  assert.equal(requests, 2);
  assert.equal(result.report.collectionTrace.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result.report), /private-collection-canary|\/images\/99/u);
  assert.deepEqual(reportResearchPlans(result.report), []);
});
