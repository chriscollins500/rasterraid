import assert from 'node:assert/strict';
import test from 'node:test';
import { captureCatalogCheckpoint, captureReportCheckpoint, readReportCheckpoint, reportComparisonMarkdown,
  reviewCatalogCheckpoint, reviewReportCheckpoint } from '../src/report-checkpoint.mjs';
import { readWorkspaceBackup, saveWorkspaceEntry, updateSearchCheckpoint, workspaceBackup, workspaceDocument } from '../src/workspace.mjs';

const origin = 'https://civitai.red';
const context = { origin, browsingLevel: 3, viewerUserId: 17, hosted: true, token: 'checkpoint-read-token' };
const then = '2026-11-21T19:00:00.000Z';
const now = '2026-11-23T19:00:00.000Z';
const evidence = (link, title = 'Public evidence') => ({ link: new URL(link, origin).href, title, group: 'articles',
  description: 'description canary', cover: 'https://image.civitai.com/token-canary.jpg', facts: ['prompt canary'] });
const result = items => ({ report: { evidence: items, rails: [{ scope: 'articles', status: 'ready' }] } });
const saved = references => ({ origin, browsingLevel: 3, checkedAt: then, references });

test('a saved report stores canonical public references and preserves the baseline on backup and concurrent updates', () => {
  const id = '81a790af-f768-4f70-a930-1df30f45a6f0';
  const refs = ['/articles/1043', '/models/4?modelVersionId=6', '/images/12', 'https://orchestration.civitai.com/v2/services/audio/transcription'];
  const report = result([
    ...refs.map(link => evidence(link)),
    evidence('/articles/1043', 'Duplicate'),
    evidence('https://civitai.com/articles/1043'), evidence('/user/vault'), evidence('/user/%76ault'),
    evidence('/api/v1/blocks/workflows/12'), evidence('/articles/1043?token=canary'), evidence('https://lookalike.invalid/articles/42'),
  ]);
  const base = captureReportCheckpoint(report, context, then);
  assert.deepEqual(base, saved(refs));
  assert.equal(captureReportCheckpoint({ report: { ...report.report, localTrace: {} } }, context, then), null);
  const filters = { scope: 'report', query: 'linocut', reportType: 'style' };
  const doc = saveWorkspaceEntry(workspaceDocument(null), 'searches', 'Report to compare', filters, id, base);
  const backup = workspaceBackup(doc);
  assert.doesNotMatch(backup, /canary|viewerUserId|checkpoint-read-token|Public evidence/u);
  const restored = readWorkspaceBackup(backup);
  assert.deepEqual(restored.searches[0].checkpoint, base);
  const replacement = { ...base, checkedAt: now, references: ['/articles/1044'] };
  const refreshed = updateSearchCheckpoint(doc, restored.searches[0], replacement);
  assert.deepEqual(refreshed.searches[0].checkpoint, replacement);
  assert.deepEqual(refreshed.searches[0].filters, doc.searches[0].filters);
  assert.throws(() => updateSearchCheckpoint(refreshed, restored.searches[0], replacement), /Reopen/u);
  assert.throws(() => updateSearchCheckpoint(doc, restored.searches[0], { ...replacement, origin: 'https://civitai.com' }), /Reopen/u);
  for (const invalid of [null, '/user/notifications', '/posts/1?another=true', '//outside.invalid/posts/1', '/api/v1/blocks/workflows']) {
    assert.equal(readReportCheckpoint(saved([invalid])), null);
  }
  const tampered = JSON.parse(backup);
  tampered.searches[0].checkpoint.references.push('/user/messages');
  assert.throws(() => readWorkspaceBackup(JSON.stringify(tampered)), /checkpoint/u);
});

test('a two-source refresh keeps exact older records separate from new sample results and checks each live identity', async () => {
  const previous = saved(['/models/4?modelVersionId=62', '/models/4?modelVersionId=63', '/images/127', '/images/128',
    '/articles/18', '/collections/19', '/posts/20', '/articles/21', '/hubs/abc']);
  const refreshed = result([evidence('/articles/18'), evidence('/articles/25', 'New publication')]);
  const paths = [];
  const diff = await reviewReportCheckpoint(previous, refreshed, context, { checkedAt: now, fetcher(url, options) {
    paths.push(url.pathname + url.search);
    assert.equal(url.origin, origin);
    assert.equal(options.method, undefined);
    if (url.pathname.endsWith('/blocks/models')) {
      assert.equal(url.searchParams.get('modelVersionIds'), '62,63');
      assert.equal(options.headers.Authorization, 'Bearer checkpoint-read-token');
      return Response.json({ items: [{ id: 4, name: 'Current model', modelVersions: [{ id: 62, name: 'v6' }] }] });
    }
    if (url.pathname.endsWith('/blocks/images')) {
      assert.equal(url.searchParams.get('ids'), '127,128');
      assert.equal(url.searchParams.has('browsingLevel'), false);
      return Response.json({ items: [
        { id: 127, browsingLevel: 1, type: 'image', url: 'https://image.civitai.com/picture.jpeg' },
        { id: 128, browsingLevel: 8, type: 'image', url: 'https://image.civitai.com/private-canary.jpeg' },
      ] });
    }
    assert.equal(options.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/collections/19') return new Response(null, { status: 404 });
    if (url.pathname === '/api/v1/posts/20') return new Response(null, { status: 503 });
    assert.equal(url.pathname, '/api/v1/articles/21');
    return Response.json({ id: 21, title: 'Still published', status: 'Published', availability: 'Public', nsfwLevel: 1 });
  } });
  assert.equal(paths.length, 5);
  assert.equal(diff.same, 1);
  assert.deepEqual(diff.added.map(row => row.title), ['New publication']);
  assert.deepEqual(diff.older.map(row => row.status), [
    'available', 'unavailable', 'available', 'unavailable', 'unavailable', 'check-failed', 'available', 'unchecked',
  ]);
  assert.deepEqual(diff.older.filter(row => row.link).map(row => row.link), [origin + '/models/4?modelVersionId=62',
    origin + '/images/127', origin + '/articles/21']);
  assert.equal(diff.incomplete, true);
  assert.equal(diff.checkpoint, null);
  const exported = reportComparisonMarkdown(diff);
  assert.match(exported, /\[New publication\]\(<https:\/\/civitai.red\/articles\/25>\)/u);
  assert.match(exported, /Could not check Civitai now/u);
  assert.doesNotMatch(exported, /\/collections\/19|private-canary/u);
});

test('a changed Civitai access context skips exact checks and a complete refresh can advance the checkpoint', async () => {
  const previous = saved(['/articles/18']);
  const current = result([evidence('/articles/18'), evidence('/articles/19')]);
  const fetcher = () => { throw new Error('No extra reads expected'); };
  for (const changed of [{ ...context, browsingLevel: 1 }, { ...context, origin: 'https://civitai.com' }]) {
    const review = await reviewReportCheckpoint(previous, current, changed, { checkedAt: now, fetcher });
    assert.deepEqual(review, { status: 'context-changed', checkedAt: then, origin });
  }
  const diff = await reviewReportCheckpoint(previous, current, context, { checkedAt: now, fetcher });
  assert.equal(diff.same, 1);
  assert.deepEqual(diff.checkpoint.references, ['/articles/18', '/articles/19']);
  current.report.rails[0].status = 'partial';
  assert.equal((await reviewReportCheckpoint(previous, current, context, { checkedAt: now, fetcher })).checkpoint, null);
});

const catalogVersion = (version, publiclyListed = true) => ({
  id: version, modelId: 4, model: 'Linocut', version: 'v' + version, publiclyListed,
  link: origin + '/models/4?modelVersionId=' + version,
  desc: 'model description canary',
});
const catalogSearch = (candidates, related = {}, flows = [{ status: 200 }]) => ({
  scope: 'all', target: { kind: 'text' }, candidates, related, flows,
});

test('a public catalog search stores exact result IDs including an empty completed sample', () => {
  const sample = catalogSearch([catalogVersion(6), catalogVersion(7, false)], {
    articles: [evidence('/articles/1043'), evidence('/articles/1043'), evidence('/user/notifications')],
    gallery: [evidence('/images/73'), evidence('/images/73?token=canary')],
  });
  const baseline = captureCatalogCheckpoint(sample, context, then);
  assert.deepEqual(baseline, saved(['/models/4?modelVersionId=6', '/articles/1043', '/images/73']));
  assert.doesNotMatch(JSON.stringify(baseline), /canary|checkpoint-read-token|Public evidence/u);
  const empty = captureCatalogCheckpoint(catalogSearch([]), context, then);
  assert.deepEqual(empty, saved([]));
  assert.equal(captureCatalogCheckpoint({ ...sample, visualComposition: {} }, context, then), null);
  assert.equal(captureCatalogCheckpoint({ ...sample, library: {} }, context, then), null);
  assert.equal(captureCatalogCheckpoint({ ...sample, target: { kind: 'version' } }, context, then), null);
  assert.equal(captureCatalogCheckpoint({ ...sample, flows: [{ status: 503 }] }, context, then), null);
  assert.equal(captureCatalogCheckpoint(catalogSearch([], {}, []), context, then), null);
  const gallery = { ...catalogSearch([], { gallery: [evidence('/images/73')] }, []), gallery: { status: 'ready' } };
  assert.deepEqual(captureCatalogCheckpoint(gallery, context, then).references, ['/images/73']);
  const directory = { ...catalogSearch([], {}, []), directory: { scope: 'articles', plan: {} } };
  assert.deepEqual(captureCatalogCheckpoint(directory, context, then).references, []);
  const model = { ...catalogVersion(6), examples: [evidence('/images/39')] };
  const pictures = { ...catalogSearch([model]), scope: 'pictures' };
  assert.deepEqual(captureCatalogCheckpoint(pictures, context, then).references, ['/images/39']);
});

test('existing saved searches can start tracking and preserve catalog checkpoints through backup', async () => {
  const id = '81a790af-f768-4f70-a930-1df30f45a6f0';
  const filters = { scope: 'models', query: 'linocut', fileFormat: 'SafeTensor' };
  const existing = saveWorkspaceEntry(workspaceDocument(), 'searches', 'Saved Linocut', filters, id);
  const reloaded = readWorkspaceBackup(workspaceBackup(existing)).searches[0];
  assert.equal(reloaded.catalogCheckpoint, undefined);
  const observed = updateSearchCheckpoint(existing, reloaded, saved([]));
  assert.deepEqual(readWorkspaceBackup(workspaceBackup(observed)).searches[0],
    { ...reloaded, catalogCheckpoint: saved([]) });
  const newer = saved(['/models/4?modelVersionId=63']);
  assert.throws(() => updateSearchCheckpoint(observed, reloaded, newer), /Reopen the latest saved search/u);
  const named = observed.searches[0];
  assert.throws(() => updateSearchCheckpoint(observed, { ...named, filters: { ...filters, query: 'poster' } }, newer), /Reopen/u);
  const diff = await reviewCatalogCheckpoint(named.catalogCheckpoint, catalogSearch([catalogVersion(63)]), context, { checkedAt: now });
  assert.deepEqual(diff.added.map(row => row.ref), [newer.references[0]]);
  const refreshed = updateSearchCheckpoint(observed, named, diff.checkpoint);
  assert.equal(refreshed.searches[0].catalogCheckpoint.checkedAt, now);
  assert.deepEqual(refreshed.searches[0].filters, named.filters);
  const tampered = JSON.parse(workspaceBackup(refreshed));
  tampered.searches[0].catalogCheckpoint.references.push('/user/vault');
  assert.throws(() => readWorkspaceBackup(JSON.stringify(tampered)), /checkpoint/u);
});

test('catalog comparisons keep new versions separate from earlier public, withheld and failed sources', async () => {
  const prior = saved(['/models/4?modelVersionId=62', '/models/4?modelVersionId=63', '/articles/18', '/collections/19']);
  const refreshed = catalogSearch([catalogVersion(64)], { articles: [evidence('/articles/18')] });
  const reads = [];
  const diff = await reviewCatalogCheckpoint(prior, refreshed, context, { checkedAt: now, fetcher(url) {
    reads.push(url.pathname);
    if (url.pathname.endsWith('/models')) {
      assert.equal(url.searchParams.get('modelVersionIds'), '62,63');
      return Response.json({ items: [{ id: 4, name: 'Existing release', availability: 'Public', modelVersions: [
        { id: 62, name: 'v62', status: 'Published' }, { id: 63, name: 'withheld title canary', availability: 'Unlisted' },
      ] }] });
    }
    assert.equal(url.pathname, '/api/v1/collections/19');
    return new Response(null, { status: 503 });
  } });
  assert.equal(diff.kind, 'search');
  assert.equal(diff.same, 1);
  assert.deepEqual(diff.added.map(row => row.link), [origin + '/models/4?modelVersionId=64']);
  assert.deepEqual(diff.older.map(row => row.status), ['available', 'unavailable', 'check-failed']);
  assert.equal(diff.checkpoint, null);
  assert.equal(reads.length, 2);
  const copied = reportComparisonMarkdown(diff);
  assert.match(copied, /Changes since saved search/u);
  assert.match(copied, /Linocut · v64/u);
  assert.doesNotMatch(copied, /withheld title canary|collections\/19/u);
  const unavailable = await reviewCatalogCheckpoint(prior, refreshed, { ...context, browsingLevel: 1 }, {
    checkedAt: now, fetcher() { assert.fail('Changed browsing level should skip saved-reference reads.'); },
  });
  assert.deepEqual(unavailable, { kind: 'search', status: 'context-changed', checkedAt: then, origin });
});

test('a tokenless hosted comparison confirms older versions and media through public Site routes', async () => {
  const previous = saved(['/models/4?modelVersionId=62', '/models/4?modelVersionId=63', '/images/120']);
  const refreshed = catalogSearch([catalogVersion(64, true)]);
  const reads = [];
  const release = { id: 62, modelId: 4, status: 'Published', nsfwLevel: 1, name: 'v62' };
  const current = await reviewCatalogCheckpoint(previous, refreshed, { ...context, token: undefined }, {
    checkedAt: now,
    fetcher(url, options) {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      reads.push(url.pathname);
      if (url.pathname === '/api/v1/model-versions/62') return Response.json(release);
      if (url.pathname === '/api/v1/model-versions/63') return new Response(null, { status: 404 });
      if (url.pathname === '/api/v1/models/4') {
        return Response.json({ id: 4, name: 'Public model', availability: 'Public', nsfwLevel: 1, modelVersions: [release] });
      }
      assert.equal(url.pathname, '/api/v1/images');
      assert.equal(url.searchParams.get('imageId'), '120');
      assert.equal(url.searchParams.get('browsingLevel'), '3');
      return Response.json({ items: [{ id: 120, nsfwLevel: 1 }] });
    },
  });
  assert.deepEqual(reads.toSorted(), ['/api/v1/images', '/api/v1/model-versions/62', '/api/v1/model-versions/63', '/api/v1/models/4']);
  assert.deepEqual(current.older.map(row => row.status), ['available', 'unavailable', 'available']);
  assert.equal(current.incomplete, false);
  assert.deepEqual(current.checkpoint.references, ['/models/4?modelVersionId=64']);
});
