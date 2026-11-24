import assert from 'node:assert/strict';
import test from 'node:test';

const root = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { bestMotionMatch, describeMotion, motionPlaneSize, motionSimilarity } = await import(root + 'video-motion.mjs');
const { clipMatchLink, compareClipMotion, discoverVisualNeighbors } = await import(root + 'visual-discovery.mjs');
const { searchTarget } = await import(root + 'search.mjs');
const { gallerySimilarityResearch } = await import(root + 'visual-research.mjs');
const { CATALOG } = await import(root + 'catalog.mjs');

const texture = (seed, dx = 0, dy = 0, exposure = 0) => Uint8Array.from({ length: motionPlaneSize ** 2 }, (_, index) => {
  const x = index % motionPlaneSize - dx;
  const y = (index / motionPlaneSize | 0) - dy;
  const value = Math.imul(x + seed * 3, 0x3ac5e147) ^ Math.imul(y + seed * 9, 0x78450921);
  return 35 + ((Math.imul(value ^ value >>> 16, 0x8c6b4533) >>> 17) % 160) + exposure;
});
const span = .32;
const motion = (seed, dx, dy, exposure = 0) => describeMotion(texture(seed), texture(seed, dx, dy, exposure), span);

test('direction comes from adjacent frames even when texture and exposure differ', () => {
  const reference = motion(2, 4, 0);
  const same = motion(7, 4, 0, 22);
  const reversed = motion(2, -4, 0);
  assert.equal(reference.direction, 'Movement right');
  assert.equal(same.direction, 'Movement right');
  assert.equal(reversed.direction, 'Movement left');
  assert.ok(motionSimilarity(reference, same) > .95);
  assert.ok(motionSimilarity(reference, reversed) < .4);
  assert.ok(motionSimilarity(reference, motion(3, 1, 0)) < motionSimilarity(reference, same));
  assert.equal(bestMotionMatch([{ ...reference, seconds: .7, span }], [{ ...reversed, seconds: 3, span }]), null);
});

test('stills, exposure changes, and hard cuts have no motion signature', () => {
  assert.equal(motion(2, 0, 0), null);
  assert.equal(motion(2, 0, 0, 30), null);
  assert.equal(describeMotion(texture(2), texture(3), span), null);
});

test('outward movement has a different score from inward movement with the same direction histogram', () => {
  const radial = { histogram: Array(8).fill(.125), spread: 1, pace: .12, radial: .76 };
  assert.ok(motionSimilarity(radial, { ...radial, radial: .71 }) > .9);
  assert.ok(motionSimilarity(radial, { ...radial, radial: -.76 }) < .6);
});

const site = 'https://civitai.com';
const clip = (id, postId = id) => ({ id, postId, video: true, stream: 'https://image.civitai.com/motion/' + id + '.mp4' });
const interval = (signature, seconds, stream) => ({ motion: signature, seconds, span, stream });
const still = [interval(null, .8), interval(null, 2.9), interval(null, 4.7)];

test('motion reorders a bounded mixed sample by the matching excerpt and retains catalog-only results', async () => {
  const reference = clip(10);
  const items = [clip(20), clip(21, 20), clip(22), clip(23), clip(24), clip(25), clip(26), clip(27),
    { ...clip(28), stream: 'https://image.invalid/restricted.mp4' }, { ...clip(29), video: false }];
  const ready = [];
  const visited = [];
  const sampledReference = 'https://image.civitai.com/motion/reference-preview.mp4';
  const sampledCandidate = 'https://image.civitai.com/motion/candidate-preview.mp4';
  const ranked = await compareClipMotion(reference, items, { document: {}, onCandidates: result => ready.push(result),
    async sample(_document, url) {
      const id = Number(/\/(\d+)\.mp4$/u.exec(url)[1]);
      visited.push(id);
      if (id === 10) return [interval(motion(2, 4, 0), .8, sampledReference)];
      if (id === 23) return [...still.slice(0, 1), interval(motion(6, 4, 0), 2.9, sampledCandidate), still[2]];
      if (id === 24) throw new Error('Unavailable stream');
      if (id === 20) return [interval(motion(2, -4, 0), .8), ...still.slice(1)];
      return still;
    },
  });
  assert.deepEqual(visited, [10, 20, 22, 23, 24, 25, 26]);
  assert.deepEqual(ready[0].items, items);
  assert.equal(ready[0].motion.status, 'checking');
  assert.deepEqual(ranked.motion, { status: 'complete', eligible: 8, attempted: 6, checked: 5, matched: 1, referenceStream: sampledReference });
  assert.equal(ranked.items[0].id, 23);
  assert.equal(ranked.items[0].motionMatch.seconds, 2.9);
  assert.equal(ranked.items[0].motionMatch.referenceSeconds, .8);
  assert.equal(ranked.items[0].motionMatch.stream, sampledCandidate);
  assert.deepEqual(ranked.items.slice(1), items.filter(item => item.id !== 23));
});

test('a still clip and an unreadable reference have distinct fallback states', async () => {
  for (const [windows, status] of [[still, 'unsteady-reference'], [[], 'unavailable']]) {
    const items = [clip(11)];
    const result = await compareClipMotion(clip(10), items, { document: {}, async sample(_doc, stream) {
      assert.equal(stream, clip(10).stream);
      return windows;
    } });
    assert.equal(result.motion.status, status);
    assert.equal(result.motion.attempted, 0);
    assert.deepEqual(result.items, items);
  }
});

test('canceling motion comparison stops sampling without publishing a final ranking', async () => {
  const controller = new AbortController();
  const visited = [];
  const run = compareClipMotion(clip(10), [clip(11), clip(12), clip(13), clip(14)], { document: {}, signal: controller.signal,
    async sample(_doc, stream) {
      visited.push(stream);
      if (visited.length === 1) return [interval(motion(2, 4, 0), 1)];
      controller.abort();
      return still;
    },
  });
  await assert.rejects(run, { name: 'AbortError' });
  assert.ok(!visited.includes(clip(14).stream));
});

test('clip modes keep a canonical video scope and preserve ordinary image links', () => {
  for (const origin of [site, 'https://civitai.red']) {
    assert.deepEqual(searchTarget(clipMatchLink(origin, 20, true)), { kind: 'similarMedia', id: 20, scope: 'videos', motion: true });
    assert.deepEqual(searchTarget(clipMatchLink(origin, 20)), { kind: 'similarMedia', id: 20, scope: 'videos' });
    assert.deepEqual(searchTarget(origin + '/images?similarTo=20'), { kind: 'similarMedia', id: 20 });
    assert.equal(searchTarget(origin + '/images/20?query=x#match-motion').kind, 'image');
  }
  assert.throws(() => searchTarget('https://civitai.invalid/images/20#match-motion'), /Use a Civitai/u);
  assert.throws(() => searchTarget('https://hidden@civitai.com/images/20#match-motion'), /Use a Civitai/u);
  assert.equal(gallerySimilarityResearch({ gallery: { scope: 'videos' }, target: searchTarget(clipMatchLink(site, 20, true)),
    reference: { id: 20 }, visualSearch: { order: [21] } }, site), null);
});

test('motion discovery requires an authorized playable clip before gathering neighbors', async () => {
  const context = { origin: site, hosted: true, token: 'fixture', browsingLevel: 1 };
  const target = searchTarget(clipMatchLink(site, 20, true));
  for (const [row, status] of [[{ type: 'image', browsingLevel: 1 }, 'motion-reference-required'],
    [{ type: 'video', browsingLevel: 8 }, 'visual-reference-unavailable']]) {
    const result = await discoverVisualNeighbors(context, target, { scope: 'all' }, {
      async fetcher(url) {
        assert.equal(url.pathname, CATALOG.blockImages);
        assert.equal(url.searchParams.get('ids'), '20');
        return Response.json({ items: [{ id: 20, url: clip(20).stream, ...row }] });
      },
      compareMotion() { assert.fail('A rejected reference must not start motion comparisons'); },
    });
    assert.equal(result.gallery.scope, 'videos');
    assert.equal(result.gallery.status, status);
    assert.deepEqual(result.related.videos, []);
  }
});
