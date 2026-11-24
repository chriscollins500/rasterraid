import assert from 'node:assert/strict';
import test from 'node:test';
import { captureReportCheckpoint, readReportCheckpoint, reportComparisonMarkdown, reviewReportCheckpoint } from '../src/report-checkpoint.mjs';
import { readWorkspaceBackup, saveWorkspaceEntry, updateReportCheckpoint, workspaceBackup, workspaceDocument } from '../src/workspace.mjs';

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
  const refreshed = updateReportCheckpoint(doc, restored.searches[0], replacement);
  assert.deepEqual(refreshed.searches[0].checkpoint, replacement);
  assert.deepEqual(refreshed.searches[0].filters, doc.searches[0].filters);
  assert.throws(() => updateReportCheckpoint(refreshed, restored.searches[0], replacement), /Reopen/u);
  assert.throws(() => updateReportCheckpoint(doc, restored.searches[0], { ...replacement, origin: 'https://civitai.com' }), /Reopen/u);
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
