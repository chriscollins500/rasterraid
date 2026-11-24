import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appHistoryTransport, QUOTE_SCOPE } from '../src/workflow-client.mjs';
import { appWorkflowJournal } from '../src/workflow-journal.mjs';
import { findOriginalWorkflow, workflowRecoveryStep } from '../src/workflow-recovery.mjs';
import { readWorkflowReportFile, workflowReportFile, workflowReportMaximumBytes } from '../src/workflow-report-file.mjs';
import { createWorkflowSession } from '../src/workflow-session.mjs';
import { workflowReportMarkdown } from '../src/workflow-results-view.js';

const origin = 'https://civitai.red';
const owner = Object.freeze({ origin, viewerUserId: 35, signedIn: true, hosted: true, browsingLevel: 3, token: 'app-history-test-token',
  scopes: [QUOTE_SCOPE, 'apps:storage'] });
const source = { title: 'Trace example', link: origin + '/images/310' };
const run = (id, createdAt, other = {}) => ({
  schema: 1, origin, operationId: 'op-' + id, bodyHash: 'a'.repeat(64), createdAt, status: 'succeeded',
  workflowId: 'wf-' + id, title: 'Research ' + id, quote: { total: 6, authorFee: 1 }, browsingLevel: 3,
  receipt: { total: 5, authorFee: 1, observedAt: createdAt + 100 }, sources: [source],
  steps: [{ name: 'report_brief', $type: 'chatCompletion', sourceLink: source.link }], ...other,
});

function storageFixture(initial, failArchive = () => false) {
  const active = 'research-run';
  const records = new Map([[active, { key: active, data: initial, version: 1 }]]);
  const writes = [];
  function fetcher(url, options) {
    assert.equal(url.origin, origin);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + owner.token);
    const path = '/api/v1/blocks/storage/prefs';
    if (url.pathname === path) {
      assert.equal(options.method, 'GET');
      assert.equal(url.searchParams.get('keyPrefix'), 'research-history-');
      assert.equal(url.searchParams.get('sort'), '-createdAt');
      assert.equal(url.searchParams.get('limit'), '24');
      const items = [...records.values()].filter(entry => entry.key.startsWith(url.searchParams.get('keyPrefix')));
      return Response.json({ items, nextCursor: null });
    }
    assert.ok(url.pathname.startsWith(path + '/'));
    const key = url.pathname.slice(path.length + 1);
    const found = records.get(key);
    if (options.method === 'GET') return found ? Response.json(found) : Response.json({ code: 'not_found' }, { status: 404 });
    assert.equal(options.method, 'PUT');
    const body = JSON.parse(options.body);
    if (body.ifVersion !== (found?.version ?? 0)) return Response.json({ code: 'version_conflict' }, { status: 409 });
    if (key.startsWith('research-history-') && failArchive()) return Response.json({ code: 'unavailable' }, { status: 503 });
    const value = { key, version: body.ifVersion + 1, data: body.data };
    records.set(key, value);
    writes.push(key);
    return Response.json(value);
  }
  return { records, writes, journal: () => appWorkflowJournal(owner, () => owner, { fetcher }) };
}

test('the private workflow journal saves earlier runs and linked research before replacing the current record', async () => {
  const first = run('one', 1000, { userPrompt: 'private-canary' });
  const second = run('two', 2000, { previous: first });
  const { records, writes, journal } = storageFixture(second);
  const a = journal();
  const b = journal();
  assert.equal((await a.read()).workflowId, second.workflowId);
  assert.equal((await b.read()).workflowId, second.workflowId);
  const next = run('three', 3000, { workflowId: null, status: 'submitting', receipt: undefined });
  await a.write(next);
  assert.deepEqual(writes, ['research-history-op-one', 'research-history-op-two', 'research-run']);
  assert.equal(records.get('research-run').data.status, 'submitting');
  assert.doesNotMatch(JSON.stringify([...records.values()]), /private-canary/u);
  await assert.rejects(b.write(run('concurrent', 3100)), error => error.status === 409);
  const fresh = journal();
  const current = await fresh.read();
  assert.equal(current.operationId, next.operationId);
  assert.equal(current.status, 'unknown');
  const history = await fresh.listHistory();
  assert.deepEqual(history.entries.map(entry => [entry.workflowId, entry.quote.total, entry.receipt.total]),
    [[first.workflowId, 6, 5], [second.workflowId, 6, 5]]);
  assert.equal(history.entries[1].previous.workflowId, first.workflowId);
  await assert.rejects(fresh.write(run('four', 4000)), /Resolve the current run/u);
  await assert.rejects(fresh.write({ ...current, bodyHash: 'b'.repeat(64) }), /identity or status/u);
});

test('an archive write failure prevents a confirmation from reaching submit', async () => {
  const original = run('one', 1000);
  const { records, writes, journal } = storageFixture(original, () => true);
  let submissions = 0;
  const session = createWorkflowSession({ origin, browsingLevel: 3, journal: journal(), now: () => 2000,
    client: { estimate: () => ({ status: 'pending', cost: { total: 3, authorFee: 0 } }), submit: () => { submissions++; } } });
  await session.restore();
  await session.prepare({ title: 'Next research', body: { tier: 'paid', steps: [
    { name: 'report_brief', $type: 'chatCompletion', input: { messages: [] } },
  ] } }, [source]);
  await assert.rejects(session.confirm(), error => error.status === 503);
  assert.equal(submissions, 0);
  assert.deepEqual(writes, []);
  assert.equal(records.get('research-run').data.workflowId, original.workflowId);
  assert.equal(session.state().run.workflowId, original.workflowId);
});

test('recovering an archived receipt preserves the current run and stays idempotent across two history sessions', async () => {
  const pending = run('older', 1000, { workflowId: null, status: 'unconfirmed', receipt: undefined,
    recoveryStep: await workflowRecoveryStep('op-older'), retryQuote: { total: 7, authorFee: 1, observedAt: 1100 } });
  const { records, writes, journal } = storageFixture(pending);
  const a = journal();
  const b = journal();
  const current = run('newer', 3000, { status: 'processing' });
  await a.write(current);
  const key = 'research-history-' + pending.operationId;
  assert.equal(records.get(key).data.status, 'unconfirmed');
  const reply = { workflowId: 'wf-older', status: 'processing', cost: { total: 3, authorFee: 1 }, textOutputs: ['private-note'] };
  const [left, right] = await Promise.all([a.saveRecovered(pending, reply), b.saveRecovered(pending, reply)]);
  assert.deepEqual(left, right);
  assert.equal(left.workflowId, reply.workflowId);
  assert.equal(left.status, 'processing');
  assert.equal(left.receipt.total, 3);
  assert.equal(left.receipt.authorFee, 1);
  assert.deepEqual(left.retryQuote, pending.retryQuote);
  assert.deepEqual(left.sources, [source]);
  assert.deepEqual(writes, [key, 'research-run', key]);
  assert.equal(records.get('research-run').data.workflowId, current.workflowId);
  assert.doesNotMatch(JSON.stringify(records.get(key)), /private-note/u);
  assert.deepEqual((await journal().listHistory()).entries, [left]);

  await assert.rejects(b.saveRecovered(pending, { ...reply, workflowId: 'another-run' }), error => error.code === 'receipt-changed');
  await assert.rejects(b.saveRecovered({ ...pending, bodyHash: 'b'.repeat(64) }, reply), error => error.code === 'receipt-changed');
  await assert.rejects(b.saveRecovered(pending, reply, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(writes.length, 3);
});

test('replacing a kept run preserves an archive already recovered by a second session', async () => {
  const kept = run('kept', 1000, { workflowId: null, status: 'unconfirmed', receipt: undefined,
    recoveryStep: await workflowRecoveryStep('op-kept') });
  const { records, writes, journal } = storageFixture(kept);
  const archive = 'research-history-' + kept.operationId;
  records.set(archive, { key: archive, data: kept, version: 1 });
  const restored = await journal().saveRecovered(kept, { workflowId: 'wf-kept', status: 'succeeded', cost: { total: 2, authorFee: 0 } });
  await journal().write(run('next', 2000));
  assert.deepEqual(records.get(archive).data, restored);
  assert.deepEqual(writes, [archive, 'research-run']);
});

test('archived workflow lookup can continue through older pages and the remainder of a busy status batch', async () => {
  const saved = run('buried', 2_000_000, { workflowId: null, status: 'unconfirmed', receipt: undefined,
    recoveryStep: await workflowRecoveryStep('op-buried') });
  const reads = [];
  const queries = [];
  const client = {
    async list({ cursor, limit }) {
      assert.equal(limit, 24);
      queries.push(cursor);
      const page = cursor ? Number(cursor.slice(5)) : 0;
      if (page < 3) return { workflows: [{ workflowId: 'newer-' + page, createdAt: saved.createdAt + 960_000 }], cursor: 'page-' + (page + 1) };
      return { workflows: Array.from({ length: 10 }, (_, index) => ({ workflowId: 'run-' + index, createdAt: saved.createdAt })), cursor: null };
    },
    async inspect(workflowId) {
      reads.push(workflowId);
      if (workflowId === 'run-5') throw Object.assign(new Error('Expired result'), { status: 410 });
      return { workflowId, status: 'succeeded', steps: [
        { name: workflowId === 'run-9' ? saved.recoveryStep : 'unrelated', $type: 'chatCompletion' },
      ] };
    },
  };
  const { signal } = new AbortController();
  const first = await findOriginalWorkflow(client, saved, signal);
  assert.equal(first.snapshot, null);
  assert.ok(first.next);
  assert.deepEqual(reads, []);
  const second = await findOriginalWorkflow(client, saved, signal, first.next);
  assert.equal(second.snapshot, null);
  assert.ok(second.next);
  assert.equal(reads.length, 8);
  const third = await findOriginalWorkflow(client, saved, signal, second.next);
  assert.equal(third.snapshot.workflowId, 'run-9');
  assert.equal(third.next, null);
  assert.deepEqual(queries, [undefined, 'page-1', 'page-2', 'page-3']);
  assert.deepEqual(reads, Array.from({ length: 10 }, (_, index) => 'run-' + index));
});

test('app history strips workflow internals and discards a reply after access changes', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let context = owner;
  const page = { workflows: [{ workflowId: 'wf_one', status: 'succeeded', createdAt: '2026-11-23T00:11:30Z', cost: 9,
    prompts: ['private-prompt'], images: [{ url: 'https://unapproved.example/file' }], transactions: ['private-receipt'] },
    { workflowId: 'whatif', status: 'pending', createdAt: '2026-11-23T00:15:30Z', cost: 2 }], cursor: 'opaque-next' };
  const calls = [];
  const client = appHistoryTransport(owner, () => context, { fetcher: async (url, config) => {
    assert.equal(url.origin, origin);
    assert.equal(config.credentials, 'omit');
    assert.equal(config.method, 'POST');
    calls.push([url.pathname, JSON.parse(config.body)]);
    if (url.pathname.endsWith('/query')) return Response.json(page);
    return promise;
  } });
  assert.deepEqual(Object.keys(client).sort(), ['list', 'poll']);
  const listed = await client.list({ cursor: 'earlier-page', limit: 12 });
  assert.deepEqual(listed, { workflows: [{ workflowId: 'wf_one', status: 'succeeded', createdAt: Date.parse('2026-11-23T00:11:30Z'), cost: 9 }],
    cursor: 'opaque-next' });
  assert.deepEqual(calls[0], ['/api/v1/blocks/workflows/query', { limit: 12, cursor: 'earlier-page' }]);
  const pending = client.poll('wf_one');
  context = { ...owner, scopes: ['apps:storage'] };
  resolve(Response.json({ snapshot: { workflowId: 'wf_one', status: 'succeeded', textOutputs: ['private-output'] } }));
  await assert.rejects(pending, /Civitai access changed/u);
  assert.deepEqual(calls[1], ['/api/v1/blocks/workflows/poll', { workflowId: 'wf_one' }]);
  await assert.rejects(client.list(), /Civitai access changed/u);
  assert.throws(() => client.list({ cursor: 'a'.repeat(257) }), /valid page/u);
});

test('a restricted run can export its exact receipt without its title, notes or source links', () => {
  const record = run('one', 1000, { title: 'Private title' });
  const snapshot = { steps: [], text: ['Private notes'], restricted: true };
  const markdown = workflowReportMarkdown([{ run: record, snapshot }]);
  assert.match(markdown, /Workflow ID · wf-one/u);
  assert.match(markdown, /Operation ID · op-one/u);
  assert.match(markdown, /Quoted total · 6 Buzz/u);
  assert.match(markdown, /Civitai reported total · 5 Buzz/u);
  assert.match(markdown, /Reported author fee · 1 Buzz/u);
  assert.doesNotMatch(markdown, /Private (title|notes)|images\/310/u);
});

const reportBytes = value => new TextEncoder().encode(value).buffer;

test('a portable Deep Search report preserves the exact notes, costs and source links with its capture time', async () => {
  const record = run('caption', 1000, { workflowId: '35-portable-report' });
  const snapshot = { steps: [], text: ['Original caption · gravure café'] };
  const markdown = workflowReportMarkdown([{ run: record, snapshot }]);
  const capturedAt = 1795500000000;
  const saved = await workflowReportFile(owner, record.workflowId, markdown, { capturedAt });
  const contents = JSON.parse(saved);
  assert.match(contents.sha256, /^[a-f\d]{64}$/u);
  assert.doesNotMatch(saved, /app-history-test-token|apps:storage/u);
  const restored = await readWorkflowReportFile(reportBytes(saved), { ...owner, browsingLevel: 7, scopes: [] });
  assert.deepEqual(restored, { format: 'rasterraid.deep-search-report', version: 1, origin, workflowId: record.workflowId,
    browsingLevel: 3, simulated: false, capturedAt, markdown });
  assert.match(restored.markdown, /Original caption · gravure café/u);
  assert.match(restored.markdown, /Quoted total · 6 Buzz/u);
  assert.match(restored.markdown, /Quoted author fee · 1 Buzz/u);
  assert.match(restored.markdown, /Civitai reported total · 5 Buzz/u);
  assert.ok(restored.markdown.includes(source.link));
  await assert.rejects(readWorkflowReportFile(reportBytes(saved.replace('Original caption', 'Updated caption')), owner), /checksum/u);
  await assert.rejects(readWorkflowReportFile(reportBytes(saved.slice(0, -1)), owner), /intact/u);
  await assert.rejects(readWorkflowReportFile(Uint8Array.of(255).buffer, owner), /intact/u);
  await assert.rejects(readWorkflowReportFile(new ArrayBuffer(workflowReportMaximumBytes + 1), owner), /1 MiB/u);
  await assert.rejects(workflowReportFile(owner, record.workflowId, markdown + 'é'.repeat(workflowReportMaximumBytes / 2)), /1 MiB/u);
});

test('portable Deep Search reports reopen only in their original account, host, and browsing access or simulation', async () => {
  const markdown = '# Deep Search\n\nOriginal notes.';
  const saved = reportBytes(await workflowReportFile(owner, '35-report', markdown));
  await assert.rejects(readWorkflowReportFile(saved, { ...owner, origin: 'https://civitai.com' }), /RasterRaid on civitai\.red/u);
  await assert.rejects(readWorkflowReportFile(saved, { ...owner, viewerUserId: 3 }), /original Civitai account/u);
  await assert.rejects(readWorkflowReportFile(saved, { ...owner, signedIn: false }), /original Civitai account/u);
  await assert.rejects(readWorkflowReportFile(saved, { ...owner, browsingLevel: 1 }), /original Civitai browsing access/u);
  await assert.rejects(workflowReportFile(owner, '35-', markdown), /original Civitai account/u);
  const local = { origin, hosted: false };
  const localMarkdown = '# Simulated Deep Search\n\nSample notes.';
  const preview = reportBytes(await workflowReportFile(local, 'mock-example', localMarkdown, { simulated: true }));
  assert.equal((await readWorkflowReportFile(preview, local, true)).markdown, localMarkdown);
  await assert.rejects(readWorkflowReportFile(preview, owner), /RasterRaid simulation/u);
  await assert.rejects(readWorkflowReportFile(saved, local, true), /RasterRaid on Civitai/u);
});
