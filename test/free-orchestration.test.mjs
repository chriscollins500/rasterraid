import assert from 'node:assert/strict';
import test from 'node:test';
import { isZeroBuzzWorkflow, orchestrationClient } from '../scripts/orchestration.mjs';

const operation = 'rasterraid-free-164a0444-74f7-4ea5-a66b-ab6c852544cc';
const quota = { enabled: true, models: [
  { key: 'qwen3.8-chat', airs: ['civitai/qwen3.8'], remaining: 2 },
  { key: 'transcription', airs: ['fixture-audio'], remaining: 1 },
] };
const chat = { $type: 'chatCompletion', name: 'review', input: {
  model: 'civitai/qwen3.8', messages: [{ role: 'user', content: [{ type: 'text', text: { $ref: 'transcript', path: 'output.text' } }] }],
} };
const transcript = { $type: 'transcription', name: 'transcript', input: {
  mediaUrl: 'https://image.civitai.com/fixture/example.mp4', returnTimeStamps: true,
} };
const zero = { tier: 'free', cost: { total: 0 }, status: 'unassigned', transactions: { list: [] } };

function fixture({ availability = quota, estimate = zero, loseReply = false } = {}) {
  const requests = [];
  const client = orchestrationClient('token-fixture-only', async (url, options) => {
    const post = options.method === 'POST';
    const quote = url.searchParams.get('whatif');
    requests.push({ route: url.pathname, whatif: quote, body: post ? JSON.parse(options.body) : null });
    if (quote === 'false' && loseReply) throw new Error('Response unavailable');
    return Response.json(post ? { ...estimate, ...(quote === 'false' && { id: 'fixture-workflow', status: 'scheduled' }) } : availability);
  });
  return { requests, client };
}

test('a free transcript and review use the confirmed free payload with a live-only recovery ID', async () => {
  const { requests, client } = fixture();
  const mutable = structuredClone(chat);
  const prepared = await client.prepareFree([transcript, mutable], operation);
  mutable.input.model = 'unquoted-model';
  assert.deepEqual(requests.map(row => [row.route, row.whatif]), [
    ['/v2/consumer/free-tier', null], ['/v2/consumer/workflows', 'true'],
  ]);
  assert.deepEqual(prepared.quota.map(row => [row.key, row.requested]), [['transcription', 1], ['qwen3.8-chat', 1]]);
  assert.deepEqual(prepared.quote, { tier: 'free', total: 0, status: 'unassigned' });
  await prepared.submit();
  const { externalId, ...submitted } = requests[2].body;
  assert.equal(externalId, operation);
  assert.equal(requests[1].body.externalId, undefined);
  assert.deepEqual(submitted, requests[1].body);
  assert.equal(submitted.steps[1].input.model, chat.input.model);
  assert.equal(submitted.tier, 'free');
  assert.equal(submitted.upgradeMode, 'manual');
  assert.throws(() => prepared.submit(), /one submission/u);
  assert.equal(requests.length, 3);
});

test('free preparation stops on insufficient quota, a private media URL, or a chat tool', async () => {
  for (const steps of [[chat, chat], [{ ...transcript, input: { mediaUrl: transcript.input.mediaUrl + '?signed=private' } }],
    [{ ...chat, input: { ...chat.input, tools: [{ type: 'web_search' }] } }]]) {
    const availability = { ...quota, models: quota.models.map(model => ({ ...model, remaining: 1 })) };
    const { requests, client } = fixture({ availability });
    await assert.rejects(() => client.prepareFree(steps, operation), /quota|outside/u);
    assert.deepEqual(requests.map(row => row.route), ['/v2/consumer/free-tier']);
  }
});

test('a paid or incomplete estimate cannot open the free submit path', async () => {
  for (const estimate of [{ ...zero, tier: 'paid' }, { ...zero, cost: { total: 1 } }, { ...zero, cost: null },
    { ...zero, transactions: { list: [{}] } }, { ...zero, status: 'failed' }]) {
    const { requests, client } = fixture({ estimate });
    await assert.rejects(() => client.prepareFree([chat], operation), /explicit 0 Buzz/u);
    assert.deepEqual(requests.map(row => row.whatif), [null, 'true']);
  }
  assert.equal(isZeroBuzzWorkflow({ ...zero, transactions: null }), true);
  assert.equal(isZeroBuzzWorkflow({ ...zero, transactions: { list: [], insufficientBuzz: true } }), false);
});

test('a lost free submission reply can be followed by read-only lookup', async () => {
  const { requests, client } = fixture({ loseReply: true });
  const prepared = await client.prepareFree([chat], operation);
  await assert.rejects(() => prepared.submit(), /Response unavailable/u);
  assert.throws(() => prepared.submit(), /one submission/u);
  await client.findFreeWorkflows(operation);
  const [latest] = requests.slice(-1);
  assert.equal(latest.route, '/v2/consumer/workflows');
  assert.equal(latest.body, null);
  assert.equal(requests.filter(row => row.whatif === 'false').length, 1);
});
