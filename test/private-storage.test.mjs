import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockFixtureToken } from '../mock/host-fixture.mjs';
import { SITE_ORIGINS } from '../src/catalog.mjs';
import { watchHost } from '../src/civitai-host.js';
import * as privateStorage from '../src/workflow-journal.mjs';
import { createWorkflowSession } from '../src/workflow-session.mjs';
import { saveWorkspaceEntry, writeWorkspaceChange } from '../src/workspace.mjs';

const owner = origin => ({
  origin, viewerUserId: 31, signedIn: true, hosted: true, browsingLevel: 3, token: 'viewer-test-token', scopes: ['apps:storage'],
});
const storeInfo = {
  collections: { prefs: { visibility: 'private' } },
  limits: { docBytes: 65_536, viewerBytes: 2_097_152, viewerDocs: 1000 },
  usage: { app: { bytes: 900_001, docs: 8000 }, viewer: { bytes: 23_456, docs: 9 } },
};

test('private usage reads only the signed-in viewer’s live stored limits on each host', async () => {
  for (const origin of SITE_ORIGINS) {
    const context = owner(origin);
    let requests = 0;
    const fetcher = async (url, request) => {
      requests++;
      assert.equal(url.href, origin + '/api/v1/blocks/storage');
      assert.equal(request.headers.Authorization, 'Bearer ' + context.token);
      assert.equal(request.method, 'GET');
      assert.equal(request.body, undefined);
      assert.equal(request.credentials, 'omit');
      assert.equal(request.redirect, 'error');
      return Response.json(storeInfo);
    };
    assert.deepEqual(await privateStorage.readPrivateStorageUsage(context, () => context, { fetcher }), {
      bytes: 23_456, docs: 9, maxBytes: 2_097_152, maxDocs: 1000, maxDocBytes: 65_536,
    });
    assert.equal(requests, 1);
  }
});

test('usage rejects malformed or unavailable storage and discards replies after access changes', async () => {
  const binding = owner(SITE_ORIGINS[0]);
  const read = privateStorage.readPrivateStorageUsage;
  await assert.rejects(read(binding, () => binding, { fetcher: () =>
    Response.json({ code: 'not_eligible', details: { reason: 'app_not_approved' } }, { status: 403 }) }),
  error => error.status === 403 && /Civitai approves RasterRaid/u.test(error.message));
  for (const invalid of [null, { bytes: '123', docs: 0 }, { bytes: -1, docs: 0 }]) {
    await assert.rejects(read(binding, () => binding, { fetcher: () =>
      Response.json({ ...storeInfo, usage: { viewer: invalid } }) }), /could not read private storage usage/u);
  }
  for (const change of [{ viewerUserId: 49 }, { scopes: [] }, { origin: SITE_ORIGINS[1] }, { storageMode: 'local-preview' }]) {
    const rejected = { ...binding, ...change };
    await assert.rejects(read(binding, () => rejected, {
      fetcher: () => assert.fail('A different context must not call storage'),
    }), /original Civitai account/u);
    const pending = Promise.withResolvers();
    let current = binding;
    const reading = read(binding, () => current, { fetcher: () => pending.promise });
    current = rejected;
    pending.resolve(Response.json(storeInfo));
    await assert.rejects(reading, /original Civitai account/u);
  }
});

test('the host opens the exact same-site storage settings path while the viewer holds the grant', () => {
  const [origin, otherOrigin] = SITE_ORIGINS;
  const instance = 'page_storage_settings';
  const parent = { postMessage: data => messages.push(data) };
  const messages = [];
  let receive;
  let current;
  const stop = watchHost({ parent, atob, document: { body: { scrollHeight: 600 }, documentElement: { dataset: {} } },
    addEventListener(_type, handler) { receive = handler; }, removeEventListener() {} }, context => { current = context; });
  const send = (type, payload) => receive({ origin, source: parent, data: { type, payload } });
  try {
    send('BLOCK_INIT', { blockId: 'rasterraid', blockInstanceId: instance, context: { slotId: 'app.page' },
      viewer: { id: 31, signedIn: true }, token: blockFixtureToken({ viewerId: 31, instance, scopes: ['apps:storage'] }),
      renderMode: 'iframe' });
    const path = '/user/account/security';
    current.open(origin + path);
    current.open(otherOrigin + path);
    current.open(origin + path + '/apps');
    current.open(origin + path + '?mode=app');
    current.open(origin + path + '#storage');
    send('TOKEN_REFRESH', { token: null });
    current.open(origin + path);
    assert.deepEqual(messages.filter(row => row.type === 'NAVIGATE').map(row => row.payload),
      [{ path, scope: 'site', target: 'new_tab' }]);
  } finally { stop(); }
});

test('a refused workspace save keeps its original snapshot and can be followed by a smaller save', async () => {
  const context = owner(SITE_ORIGINS[1]);
  const original = { version: 1, data: { searches: [], shortlists: [] }, createdAt: '2026-11-25T23:00:00Z' };
  let saved = original;
  let refusal = 'too_large';
  let writes = 0;
  const record = privateStorage.appPrivateRecord(context, () => context, 'search-workspace', { fetcher: (url, request) => {
    assert.equal(url.href, context.origin + '/api/v1/blocks/storage/prefs/search-workspace');
    assert.equal(request.method, 'PUT');
    const { data, ifVersion } = JSON.parse(request.body);
    assert.equal(ifVersion, saved.version);
    writes++;
    if (refusal) return Response.json({ code: refusal }, { status: 413 });
    saved = { ...saved, version: ifVersion + 1, data };
    return Response.json(saved);
  } });
  const change = { id: '9edc1a2f-bbd5-458e-8234-4b79b0870452', apply: value => saveWorkspaceEntry(value, 'searches',
    'Linocut', { query: 'linocut', scope: 'models' }, '9edc1a2f-bbd5-458e-8234-4b79b0870453') };
  for (const [code, message] of [['too_large', /per-item size limit/u], ['quota_exceeded', /total storage limit/u]]) {
    refusal = code;
    await assert.rejects(writeWorkspaceChange(record, original, change), error =>
      error.status === 413 && error.code === code && message.test(error.message));
    assert.equal(saved, original);
    assert.equal(change.uncertain, undefined);
  }
  refusal = undefined;
  const next = await writeWorkspaceChange(record, original, change);
  assert.equal(next.outcome, 'saved');
  assert.equal(next.snapshot.version, 2);
  assert.equal(next.snapshot.data.searches[0].filters.query, 'linocut');
  assert.equal(writes, 3);
});

test('a Deep Search confirmation refused by private storage leaves the original receipt and uses 0 Buzz', async () => {
  const context = owner(SITE_ORIGINS[0]);
  const prior = { schema: 1, origin: context.origin, operationId: 'prior', bodyHash: 'a'.repeat(64), createdAt: 1000,
    workflowId: '31-prior', status: 'succeeded', title: 'Earlier comparison', browsingLevel: 3, quote: { total: 4, authorFee: 1 } };
  let storageWrites = 0;
  const journal = privateStorage.appWorkflowJournal(context, () => context, { fetcher: (url, request) => {
    if (request.method === 'GET') return url.pathname.endsWith('/research-run')
      ? Response.json({ data: prior, version: 3 }) : Response.json({ code: 'not_found' }, { status: 404 });
    assert.equal(url.pathname, '/api/v1/blocks/storage/prefs/research-history-prior');
    assert.equal(request.method, 'PUT');
    assert.equal(JSON.parse(request.body).ifVersion, 0);
    storageWrites++;
    return Response.json({ code: 'quota_exceeded' }, { status: 413 });
  } });
  const client = {
    estimate: () => ({ status: 'pending', cost: { total: 6, authorFee: 1 } }),
    submit: () => assert.fail('A refused journal reservation must not submit a job'),
  };
  const session = createWorkflowSession({ client, journal, origin: context.origin, browsingLevel: 3, now: () => 2000 });
  await session.restore();
  await session.prepare({ title: 'Linocut comparison', body: { tier: 'paid', steps: [
    { name: 'report_brief', $type: 'chatCompletion', input: { messages: [] } },
  ] } }, []);
  await assert.rejects(session.confirm(), error => error.code === 'quota_exceeded' && /This confirmation used 0 Buzz/u.test(error.message));
  assert.equal(session.state().run.workflowId, prior.workflowId);
  assert.equal(storageWrites, 1);
});
