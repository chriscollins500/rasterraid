import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverReport, reportMarkdown } from '../src/report.mjs';
import { workspaceFilters } from '../src/workspace.mjs';

const origin = 'https://civitai.red';
const viewer = { origin, hosted: true, signedIn: true, token: 'read-only-fixture', browsingLevel: 3,
  viewerUserId: 21, viewerUsername: 'OldHandle' };
const preset = { scope: 'report', reportType: 'publicWork' };
const author = { id: 21, username: 'CurrentHandle' };
const media = (id, postId, type, other = {}) => ({
  id, postId, type, username: author.username, browsingLevel: 1, tags: [],
  url: 'https://image.civitai.com/fixture/preview.' + { image: 'jpeg', video: 'mp4', audio: 'mp3' }[type],
  meta: { prompt: 'A watercolor landscape' }, ...other,
});
const post = (id, member, other = {}) => ({
  id, user: author, title: 'Published work', nsfwLevel: 1, publishedAt: '2026-01-01T00:00:00Z',
  images: [{ id: member, postId: id, browsingLevel: 1 }], ...other,
});

test('my public work filters by the current signed-in ID and verifies authorship and preview membership', async () => {
  const reads = [];
  const result = await discoverReport(viewer, { ...preset, query: 'acuarela', mediaCreator: 'Other', userId: 900 }, {
    async fetcher(url, request) {
      assert.equal(url.origin, origin);
      assert.equal(request.credentials, 'omit');
      reads.push(url.pathname);
      if (url.pathname === '/api/v1/users') {
        assert.equal(url.searchParams.get('ids'), '21');
        assert.equal(request.headers.Authorization, undefined);
        return Response.json({ items: [author, { id: 900, username: 'Other' }] });
      }
      if (url.pathname === '/api/v1/blocks/images') {
        assert.equal(url.searchParams.get('userId'), '21');
        assert.equal(url.searchParams.get('username'), author.username);
        assert.equal(url.searchParams.get('sort'), 'Newest');
        assert.equal(url.searchParams.get('limit'), '24');
        assert.equal(request.headers.Authorization, 'Bearer ' + viewer.token);
        assert.equal(request.cache, 'no-store');
        const type = url.searchParams.get('type');
        const items = {
          image: [
            media(1, 101, 'image'),
            media(2, 102, 'image', { username: 'Other' }),
            media(3, 103, 'image', { userId: 900 }),
            media(4, 104, 'image', { browsingLevel: 8 }),
            media(5, 105, 'image', { meta: null }),
            media(6, 106, 'image'),
            media(7, 107, 'image'),
            media(8, 108, 'image'),
          ],
          video: [media(9, 101, 'video')],
          audio: [media(10, null, 'audio')],
        }[type];
        return Response.json({ items, metadata: type === 'image' ? { nextCursor: 'older' } : {} });
      }
      assert.equal(request.headers.Authorization, undefined);
      const record = {
        '/api/v1/posts/101': post(101, 1),
        '/api/v1/posts/105': post(105, 5, { title: 'Watercolor experiments' }),
        '/api/v1/posts/106': post(106, 6, { user: { ...author, id: 900 } }),
        '/api/v1/posts/107': post(107, 7, { publishedAt: null }),
        '/api/v1/posts/108': post(108, 1),
      }[url.pathname];
      assert.ok(record, 'Unexpected read ' + url.pathname);
      return Response.json(record);
    },
  });
  assert.equal(result.report.publicWork.profile.id, author.id);
  assert.equal(result.report.publicWork.profile.title, author.username);
  assert.equal(result.report.publicWork.earlierUploads, true);
  assert.deepEqual(result.related.gallery.map(item => item.id), [1, 6, 7, 8]);
  assert.deepEqual(result.related.gallery.map(item => item.postId), [101, null, null, null]);
  assert.deepEqual(result.related.videos.map(item => item.id), [9]);
  assert.deepEqual(result.related.audio.map(item => item.id), [10]);
  assert.deepEqual(result.related.posts.map(item => [item.id, item.previews.map(preview => preview.id)]), [[105, [5]], [101, [1]]]);
  assert.equal(reads.filter(path => path === '/api/v1/posts/101').length, 1);
  assert.ok(result.report.connections.some(connection => connection.kind === 'post-media' &&
    connection.items.some(item => item.link === origin + '/posts/101')));
  assert.match(reportMarkdown(result.report), /5 pictures · 1 clip · 1 audio upload · 2 verified posts/u);
  assert.equal(workspaceFilters({ ...preset, query: 'acuarela' }), null);
});

test('my public work stops before catalog reads without an active viewer or an exact profile', async () => {
  const fetcher = () => assert.fail('An unverified account reached the media catalog');
  await assert.rejects(discoverReport({ ...viewer, token: null }, preset, { fetcher }), /Sign in on Civitai/u);
  await assert.rejects(discoverReport({ ...viewer, connectionLost: true }, preset, { fetcher }), /Sign in on Civitai/u);

  const result = await discoverReport(viewer, preset, {
    async fetcher(url) {
      assert.equal(url.pathname, '/api/v1/users');
      assert.equal(url.searchParams.get('ids'), '21');
      return Response.json({ items: [{ ...author, id: 22 }] });
    },
  });
  assert.equal(result.report.publicWork.profile, null);
  assert.deepEqual(result.report.rails.map(row => row.scope), ['users']);
  assert.deepEqual(result.report.evidence, []);
});
