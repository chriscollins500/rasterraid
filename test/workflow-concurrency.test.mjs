import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkflowSimulation, SIMULATION_WORKFLOWS } from '../mock/workflows.mjs';
import { appRunTransport, QUOTE_SCOPE, WORKFLOW_REQUEST_TIMEOUT_MS } from '../src/workflow-client.mjs';
import { appWorkflowJournal } from '../src/workflow-journal.mjs';
import { LIVE_QUOTE_MAX_AGE_MS } from '../src/quotes.mjs';
import { createWorkflowSession } from '../src/workflow-session.mjs';

const activeKey = 'research-run';
const plan = { title: 'Compare the public preview', body: { tier: 'paid', steps: [
  { name: 'preview_notes', $type: 'chatCompletion', input: { messages: [] } },
] } };

function sharedPlatform(origin, { before, after } = {}) {
  let currentTime = 1_000_000;
  const now = () => currentTime;
  const storage = new Map();
  const submissions = [];
  const requests = [];
  const provider = createWorkflowSimulation({ now });
  const source = { title: 'Public preview', link: origin + '/images/310' };

  function tab(name) {
    const binding = { origin, viewerUserId: 35, signedIn: true, hosted: true, browsingLevel: 3, token: 'token-' + name,
      scopes: [QUOTE_SCOPE, 'apps:storage'] };
    let access = { ...binding };
    const getContext = () => access;
    const fetcher = async (url, options) => {
      assert.equal(url.origin, origin);
      assert.equal(options.headers.Authorization, 'Bearer ' + binding.token);
      assert.equal(options.credentials, 'omit');
      options.signal.throwIfAborted();
      const body = options.body && JSON.parse(options.body);
      const key = url.pathname.split('/').at(-1);
      const shorthand = { name, method: options.method, key, body };
      requests.push(shorthand);
      const override = await before?.(shorthand);
      if (override) return override;
      let reply;
      if (url.pathname === '/api/v1/blocks/storage/prefs/' + key) {
        const old = storage.get(key);
        const version = old?.version ?? 0;
        if (options.method === 'GET') reply = old ? Response.json(old) : Response.json({ code: 'not_found' }, { status: 404 });
        else if (options.method === 'PUT') {
          if (body.ifVersion !== version) reply = Response.json({ code: 'version_conflict' }, { status: 409 });
          else {
            const next = { key, data: body.data, version: version + 1 };
            storage.set(key, next);
            reply = Response.json(next);
          }
        }
      } else {
        assert.equal(url.pathname, '/api/v1/blocks/workflows/' + key);
        if (key === 'submit') submissions.push(body.idempotencyKey);
        const result = provider(options.method, SIMULATION_WORKFLOWS + key, body);
        if (key === 'query' && result.status === 200) for (const row of result.body.workflows) {
          row.createdAt = new Date(row.createdAt).toISOString();
        }
        reply = Response.json(result.body, { status: result.status });
      }
      assert.ok(reply);
      await after?.(shorthand, reply);
      return reply;
    };
    const journal = appWorkflowJournal(binding, getContext, { fetcher });
    const client = appRunTransport(binding, getContext, { fetcher });
    let operation = 0;
    const session = createWorkflowSession({ origin, browsingLevel: binding.browsingLevel, journal, client, now,
      operationId: () => name + '-' + ++operation });
    return { session, prepare: () => session.prepare(plan, [source]), access: update => { access = { ...access, ...update }; } };
  }

  return { tab, submissions, requests, receipt: () => storage.get(activeKey)?.data, now, advance: duration => { currentTime += duration; } };
}

for (const origin of ['https://civitai.com', 'https://civitai.red']) {
  test('a contending tab reloads the one submission and cannot archive its pending receipt on ' + origin, async () => {
    const committed = Promise.withResolvers();
    const acknowledge = Promise.withResolvers();
    const platform = sharedPlatform(origin, { async after({ name, method, key, body }, response) {
      if (name === 'left' && method === 'PUT' && key === activeKey && response.ok && body.data.status === 'submitting') {
        committed.resolve();
        await acknowledge.promise;
      }
    } });
    const left = platform.tab('left');
    const right = platform.tab('right');
    await Promise.all([left.session.restore(), right.session.restore()]);
    await Promise.all([left.prepare(), right.prepare()]);
    const first = left.session.confirm();
    const afterConfirmation = first.catch(() => {});
    try {
      await committed.promise;
      await right.session.confirm();
      assert.equal(right.session.state().receiptRefreshed, true);
      assert.equal(right.session.state().run.operationId, 'left-1');
      assert.equal(right.session.state().submissionPending, true);
      assert.equal(right.session.state().retryAvailable, false);
      assert.equal(right.session.state().recoveryAvailable, true);
      await assert.rejects(right.session.archiveUnconfirmed(), /confirmation is still being checked/u);
      await assert.rejects(right.session.prepareRetry(plan), /can no longer be retried safely/u);
      await assert.rejects(right.prepare(), /Resolve the current run/u);
      assert.deepEqual(platform.submissions, []);
      assert.equal(platform.receipt().status, 'submitting');
    } finally {
      acknowledge.resolve();
      await afterConfirmation;
    }
    await first;
    await right.session.checkSavedRun();
    assert.equal(right.session.state().run.workflowId, left.session.state().run.workflowId);
    assert.equal(right.session.state().submissionPending, false);
    platform.advance(2_000);
    await right.session.refresh();
    assert.equal(right.session.state().run.status, 'succeeded');
    assert.match(right.session.state().snapshot.steps[0].lines[0], /analyze/);
    assert.deepEqual(platform.submissions, ['left-1']);
  });
}

test('a lost storage acknowledgement exposes the reserved receipt and an expired reservation can retry its own key', async () => {
  let lose = true;
  const platform = sharedPlatform('https://civitai.com', { after({ method, key, body }, response) {
    if (lose && method === 'PUT' && key === activeKey && response.ok && body.data.status === 'submitting') {
      lose = false;
      throw new TypeError('The acknowledgement was interrupted.');
    }
  } });
  const tab = platform.tab('tab');
  await tab.session.restore();
  await tab.prepare();
  await tab.session.confirm();
  const held = tab.session.state();
  assert.equal(held.run.status, 'unknown');
  assert.equal(held.run.submissionUntil, platform.now() + LIVE_QUOTE_MAX_AGE_MS + WORKFLOW_REQUEST_TIMEOUT_MS);
  assert.equal(held.receiptRefreshed, true);
  assert.equal(held.submissionPending, true);
  assert.deepEqual(platform.submissions, []);
  platform.advance(held.run.submissionUntil - platform.now());
  assert.equal(tab.session.state().submissionPending, false);
  await tab.session.prepareRetry(plan);
  await tab.session.confirm();
  assert.deepEqual(platform.submissions, [held.run.operationId]);
  assert.equal(tab.session.state().run.workflowId, platform.receipt().workflowId);
  assert.equal(platform.receipt().submissionUntil, undefined);
});

test('a stalled receipt refresh protects the view until the same account and browsing context can recheck it', async () => {
  let blockReads = false;
  let deferredRead;
  const platform = sharedPlatform('https://civitai.red', {
    before({ name, method, key }) {
      if (blockReads && name === 'stale' && method === 'GET' && key === activeKey) return Response.json({}, { status: 503 });
    },
    async after({ name, method, key }) {
      if (deferredRead && name === 'stale' && method === 'GET' && key === activeKey) {
        deferredRead.started.resolve();
        await deferredRead.released.promise;
      }
    },
  });
  const winning = platform.tab('winning');
  const stale = platform.tab('stale');
  await Promise.all([winning.session.restore(), stale.session.restore()]);
  await Promise.all([winning.prepare(), stale.prepare()]);
  await winning.session.confirm();
  blockReads = true;
  await assert.rejects(stale.session.confirm(), error => error.status === 503);
  assert.equal(stale.session.state().receiptCheckRequired, true);
  assert.equal(stale.session.state().run, null);
  await assert.rejects(stale.prepare(), /Check the saved Deep Search run/u);
  blockReads = false;
  deferredRead = { started: Promise.withResolvers(), released: Promise.withResolvers() };
  const checking = stale.session.checkSavedRun();
  await deferredRead.started.promise;
  stale.access({ browsingLevel: 1 });
  deferredRead.released.resolve();
  await assert.rejects(checking, /browsing access changed/u);
  assert.equal(stale.session.state().run, null);
  assert.equal(stale.session.state().receiptCheckRequired, true);
  deferredRead = undefined;
  stale.access({ browsingLevel: 3 });
  await stale.session.checkSavedRun();
  assert.equal(stale.session.state().run.workflowId, winning.session.state().run.workflowId);
  assert.deepEqual(platform.submissions, ['winning-1']);
});

test('saving an accepted reply after a competing recovery keeps the original operation and newest receipt', async () => {
  const accepted = Promise.withResolvers();
  const response = Promise.withResolvers();
  const platform = sharedPlatform('https://civitai.com', { async after({ name, key }) {
    if (name === 'starting' && key === 'submit') {
      accepted.resolve();
      await response.promise;
    }
  } });
  const starting = platform.tab('starting');
  const watching = platform.tab('watching');
  await starting.session.restore();
  await starting.prepare();
  const submitted = starting.session.confirm();
  const observed = assert.rejects(submitted, error => error.status === 409);
  try {
    await accepted.promise;
    await watching.session.restore();
    assert.equal(watching.session.state().submissionPending, true);
    platform.advance(2_000);
    await watching.session.recoverOriginal();
    assert.equal(watching.session.state().run.status, 'succeeded');
    platform.advance(1);
  } finally { response.resolve(); }
  await observed;
  assert.equal(starting.session.state().run.workflowId, watching.session.state().run.workflowId);
  assert.equal(starting.session.state().receiptPending, true);
  assert.ok(starting.session.state().run.receipt.observedAt > watching.session.state().run.receipt.observedAt);
  await assert.rejects(starting.session.checkSavedRun(), /Save the current receipt/u);
  await starting.session.saveReceiptAgain();
  assert.equal(starting.session.state().receiptPending, false);
  assert.equal(starting.session.state().run.status, 'succeeded');
  assert.deepEqual(starting.session.state().run.receipt, watching.session.state().run.receipt);
  assert.deepEqual(platform.submissions, ['starting-1']);
});
