import assert from 'node:assert/strict';
import test from 'node:test';
import { readPostPage } from '../src/community.mjs';
import { discover, searchTarget } from '../src/search.mjs';

const context = { origin: 'https://civitai.red', hosted: true, browsingLevel: 3, token: 'read-only-fixture' };
const image = 'https://image.civitai.com/fixture/preview.jpeg';
const cat = { id: 5132, name: 'cat' };
const media = (id, postId, other) => ({ id, postId, type: 'image', browsingLevel: 1, url: image, tags: [cat], ...other });
const post = (id, images, other) => ({
  id, title: 'Cat post ' + id, nsfwLevel: 1, publishedAt: '2026-11-01T00:00:00Z',
  images, tags: [cat], user: { username: 'creator' }, ...other,
});
const reply = value => Response.json(value);

test('post discovery validates public membership, preserves good results on a partial error and deduplicates pages', async () => {
  const readIds = [];
  const options = { async fetcher(url, init) {
    assert.equal(url.origin, context.origin);
    if (url.pathname === '/api/search/multi-search') {
      assert.equal(init.headers.Authorization, undefined);
      return reply({ results: [{ hits: [{ tags: [cat] }] }] });
    }
    if (url.pathname === '/api/v1/blocks/images') {
      assert.equal(init.headers.Authorization, 'Bearer ' + context.token);
      assert.equal(url.searchParams.get('tags'), '5132');
      assert.equal(url.searchParams.get('type'), null);
      if (url.searchParams.get('cursor') === 'feed:next') {
        return reply({ items: [media(2, 42), media(16, 46)] });
      }
      return reply({
        items: [media(1, 42), media(2, 42), media(3, 43), media(4, 44), media(5, 45)],
        metadata: { nextCursor: 'feed:next' },
      });
    }
    const id = Number(url.pathname.split('/').at(-1));
    readIds.push(id);
    assert.equal(init.headers.Authorization, undefined);
    if (id === 43) return reply(post(43, [media(30, 43)]));
    if (id === 44) return reply(post(44, [media(4, 44)], { nsfwLevel: 8 }));
    if (id === 45) return Response.json({}, { status: 503 });
    return reply(id === 42 ? post(42, [media(1, 42), media(2, 42)]) : post(46, [media(16, 46)]));
  } };
  const result = await discover(context, { scope: 'posts', query: 'cat' }, options);
  assert.deepEqual(result.related.posts.map(card => [card.id, card.previews.length]), [[42, 2]]);
  assert.equal(result.gallery.nativeLink, context.origin + '/posts?tags=5132');
  assert.equal(result.gallery.nextCursor, 'feed:next');
  assert.equal(result.flows.length, 1);
  const more = await readPostPage(context, result.gallery, { ...options, cursor: 'feed:next', excluded: new Set([42]) });
  assert.deepEqual(more.items.map(card => card.id), [46]);
  assert.equal(readIds.filter(id => id === 42).length, 1);
});

test('exact post URLs render the matching public post and only App-visible previews', async () => {
  const good = media(31, 23);
  const hidden = media(32, 23, { browsingLevel: 8 });
  const result = await discover(context, { query: 'https://civitai.com/posts/23/sample' }, {
    fetcher(url) {
      if (url.pathname.endsWith('/posts/23')) return reply(post(23, [good, hidden], { detail: '<p>Public detail &amp; attribution</p>' }));
      assert.equal(url.searchParams.get('postId'), '23');
      return reply({ items: [good, hidden] });
    },
  });
  assert.equal(result.exactPost, true);
  assert.equal(result.gallery.nativeLink, context.origin + '/posts/23');
  assert.equal(result.related.posts[0].summary, 'Public detail & attribution');
  assert.deepEqual(result.related.postMedia.map(item => item.id), [31]);
  assert.throws(() => searchTarget('https://civitai.com/posts/2147483648'));
});

test('storyline references keep their article provenance, skip conflicting links and stay on the active host', async () => {
  const cover = '2292a8f1-cfde-4017-a091-556e327237aa';
  const result = await discover(context, { scope: 'storylines', query: 'Forest Tale' }, {
    fetcher(url, init) {
      assert.equal(url.origin, context.origin);
      assert.equal(init.headers.Authorization, undefined);
      if (url.pathname === '/api/v1/articles') return reply({ items: [{ id: 17, nsfwLevel: 1 }, { id: 19, nsfwLevel: 8 }] });
      assert.ok(url.pathname.endsWith('/articles/17'));
      return reply({
        id: 17, nsfwLevel: 1, status: 'Published', availability: 'Public', title: 'Forest Tale recommendations',
        coverImage: { type: 'image', nsfwLevel: 1, url: cover, name: 'cover.jpeg' },
        content: [
          '<a href="https://civitai.com/storylines/20">Forest &amp; Tale</a>',
          '<a href="https://civitai.com/storylines/21">https://civitai.com/storylines/22</a>',
          '<a href="https://not-civitai.invalid/storylines/23">Forest Tale</a>',
        ].join(' '),
      });
    },
  });
  assert.deepEqual(result.related.storylines.map(item => [item.id, item.title, item.link, item.source]), [
    [20, 'Forest & Tale', context.origin + '/storylines/20', context.origin + '/articles/17'],
  ]);
  assert.ok(result.related.storylines[0].preview?.includes(cover));
  const exact = await discover(context, { query: 'https://civitai.com/storylines/20' }, {
    fetcher() { assert.fail('Exact native story links do not call a restricted endpoint'); },
  });
  assert.equal(exact.nativeLink, context.origin + '/storylines/20');
});
