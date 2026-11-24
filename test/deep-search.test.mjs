import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { createMockBackend } from '../mock/backend.mjs';
import { createMockClient, createWorkflowSimulationClient, MOCK_API, MOCK_PAGE } from '../mock/client.mjs';
import { installMockPanel } from '../mock/panel.mjs';
import { linocutSample } from '../mock/sample.mjs';
import { localWorkflowJournal } from '../src/workflow-journal.mjs';
import { installWorkflowRun } from '../src/workflow-view.js';

const origin = 'https://civitai.com';
const draft = (site = origin) => ({
  origin: site, baseModel: 'SDXL 1.0',
  picks: linocutSample(site).candidates.map(row => ({ id: row.id, modelId: row.modelId, title: row.model, baseModel: row.base })),
});
const jobPath = id => MOCK_API + '/jobs/' + id;

async function preview(t, ...flags) {
  const dir = process.env.RASTERRAID_TEST_DIST === '1' ? ['dist'] : [];
  const child = spawn(process.execPath, ['scripts/serve.mjs', '0', ...dir, ...flags], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    child.kill();
    await exit;
  });
  const [line] = await Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(5_000) }),
    exit.then(() => { throw new Error('Preview exited before announcing its port.'); }),
  ]);
  return JSON.parse(line).origin;
}

test('loopback Deep Search goes from confirmed quote through recovery to exact-version evidence', async t => {
  const local = await preview(t, '--mock-deep-search');
  const client = createMockClient(local);
  assert.equal((await fetch(local + MOCK_PAGE)).status, 200);
  for (const asset of ['panel.mjs', 'client.mjs', 'sample.mjs']) {
    assert.equal((await fetch(local + '/mock/' + asset)).status, 200);
  }

  const exact = draft('https://civitai.red');
  exact.picks.push(exact.picks.shift());
  const quote = await client.estimate(exact);
  assert.deepEqual([quote.total, quote.authorFee, quote.buzzCharged], [6, 1, 0]);
  const operation = randomUUID();
  await assert.rejects(client.read(operation), { status: 404 });

  const interrupted = createMockClient(local, async (url, options) => {
    const response = await fetch(url, options);
    assert.equal(response.status, 201);
    await response.text();
    throw new TypeError('Simulated lost confirmation response.');
  });
  await assert.rejects(interrupted.confirm(operation, quote.id), /lost confirmation/);

  const restored = await client.read(operation);
  assert.equal(restored.id, operation);
  assert.ok(['queued', 'running'].includes(restored.status));
  const replay = await client.confirm(operation, quote.id);
  assert.equal(replay.id, operation);
  await assert.rejects(client.confirm(randomUUID(), quote.id), { status: 409 });

  const timeout = Date.now() + 5_000;
  let report;
  do {
    await pause(200);
    report = await client.read(operation);
  } while (report.status !== 'succeeded' && Date.now() < timeout);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.buzzCharged, 0);
  assert.equal(report.baseModel, 'SDXL 1.0');
  assert.deepEqual(report.results.map(row => [row.id, row.fit]), [
    [3087275, 'compatible'], [3461981, 'other'], [1006035, 'other'],
  ]);
  assert.equal(report.results[0].source, 'https://civitai.red/models/2744788?modelVersionId=3087275');
  assert.equal((await client.cancel(operation)).status, 'succeeded');
});

test('mock backend rejects stale quotes and keeps cancelled runs terminal', () => {
  let time = 1000;
  const backend = createMockBackend({ now: () => time });
  const start = ({ quote, id }) => backend('PUT', jobPath(id), { quoteId: quote.id });
  const next = () => ({ quote: backend('POST', MOCK_API + '/estimate', draft()).body, id: randomUUID() });
  assert.equal(backend('POST', MOCK_API + '/estimate', { ...draft(), origin: 'https://example.test' }).status, 400);
  const expired = next();
  time = expired.quote.expiresAt;
  assert.equal(start(expired).status, 410);

  const active = next();
  assert.equal(start(active).body.status, 'queued');
  time += 651;
  assert.equal(backend('GET', jobPath(active.id)).body.step, 1);
  time += 1000;
  assert.equal(backend('GET', jobPath(active.id)).body.step, 2);
  assert.equal(backend('DELETE', jobPath(active.id)).body.status, 'cancelled');
  time += 10_000;
  assert.equal(start(active).body.status, 'cancelled');
  assert.equal(backend('GET', jobPath(active.id)).body.results, undefined);
  assert.equal(start({ id: active.id, quote: next().quote }).status, 409);
});

test('mock execution is absent in ordinary previews and blocked for hosted or cross-site requests', async t => {
  const normal = await preview(t);
  assert.equal((await fetch(normal + '/')).status, 200);
  assert.equal((await fetch(normal + MOCK_PAGE)).status, 404);
  await assert.rejects(createMockClient(normal).estimate(draft()), { status: 404 });

  const enabled = await preview(t, '--mock-deep-search');
  const status = await new Promise((resolve, reject) => {
    get(enabled + MOCK_PAGE, { headers: { Host: 'dev-0123456789abcdef.civit.ai' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 404);
  const response = await fetch(enabled + MOCK_API + '/estimate', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(draft()),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.throws(() => createMockClient(origin), /loopback/);
});

class TestElement extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.textContent = '';
    this.value = '';
    this.dataset = {};
  }

  append(...nodes) {
    for (const item of nodes) {
      const node = typeof item === 'string' ? Object.assign(new TestElement('#text'), { textContent: item }) : item;
      this.insertBefore(node, null);
    }
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
    if (this.tag === 'select') this.value = nodes[0]?.value ?? '';
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  insertBefore(node, before) {
    if (node === before) return;
    node.remove();
    const index = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(index, 0, node);
    node.parent = this;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  set onclick(listener) {
    if (this.clickListener) this.removeEventListener('click', this.clickListener);
    this.clickListener = listener;
    this.addEventListener('click', listener);
  }
  setAttribute() {}
  focus() {}
  scrollIntoView() {}
}

function findElement(node, text) {
  if (node.textContent === text && !node.hidden) return node;
  for (const child of node.children) {
    const match = findElement(child, text);
    if (match) return match;
  }
  return null;
}

async function waitForText(node, text) {
  const end = Date.now() + 5_000;
  let result;
  while (!(result = findElement(node, text)) && Date.now() < end) await pause(25);
  assert.ok(result, 'Expected mock panel text: ' + text);
  return result;
}

test('mock panel controls confirm a comparison and restore its report from the same tab session', async t => {
  const local = await preview(t, '--mock-deep-search');
  const storage = new Map();
  const globals = {
    document: { createElement: tag => new TestElement(tag) },
    location: { origin: local },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }

  const mount = () => {
    const panel = new TestElement('aside');
    installMockPanel(panel)(linocutSample(origin).candidates, { baseModel: 'SDXL 1.0' }, origin);
    return panel;
  };
  const view = mount();
  const estimate = await waitForText(view, 'Get mock quote');
  assert.equal(estimate.disabled, false);
  estimate.dispatchEvent(new Event('click'));
  await waitForText(view, '6 mock credits');
  await waitForText(view, 'Includes 1 mock author credit. 0 Buzz charged.');
  assert.equal(storage.size, 0);

  (await waitForText(view, 'Confirm mock run')).dispatchEvent(new Event('click'));
  await waitForText(view, 'Mock run queued.');
  await waitForText(view, 'Comparison ready. 0 Buzz charged.');
  await waitForText(view, '1 of 3 match SDXL 1.0');
  assert.equal(storage.size, 1);

  const rebuilt = mount();
  await waitForText(rebuilt, '1 of 3 match SDXL 1.0');
  const source = await waitForText(rebuilt, linocutSample(origin).candidates[0].model);
  assert.equal(source.href, 'https://civitai.com/models/2744788?modelVersionId=3087275');
});

test('the report simulation confirms a multi-step workflow and restores its results over loopback', async t => {
  const local = await preview(t, '--mock-deep-search');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new TestElement(tag) } });
  t.after(() => oldDocument ? Object.defineProperty(globalThis, 'document', oldDocument) : delete globalThis.document);
  const storage = new Map();
  const journal = localWorkflowJournal({ sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } }, origin);
  const client = createWorkflowSimulationClient(local);
  const step = ($type, name) => ({ $type, name, input: { model: 'fixture' } });
  const plan = { title: 'Mixed analysis', body: { tier: 'paid', steps: [
    step('chatCompletion', 'report_source_check'), step('chatCompletion', 'report_fit'),
    step('transcription', 'report_transcript'), step('audioCaptioning', 'report_music'),
  ] } };
  const mount = () => {
    const view = new TestElement('section');
    const ui = installWorkflowRun(view, { client, journal, context: { origin }, simulated: true });
    t.after(() => ui.dispose());
    return { view, ui };
  };
  const first = mount();
  await pause(25);
  first.ui.offer(plan, [{ title: 'Source article', link: origin + '/articles/18' }]);
  const confirm = await waitForText(first.view, 'Confirm simulation');
  assert.equal(storage.size, 0);
  confirm.dispatchEvent(new Event('click'));
  await waitForText(first.view, 'Simulated music description for the selected clip.');
  first.ui.dispose();
  const restored = mount();
  const source = await waitForText(restored.view, 'Source article');
  assert.equal(source.href, origin + '/articles/18');
  assert.ok(findElement(restored.view, '0:00 · Simulated words from the selected clip.'));

  const original = await journal.read();
  (await waitForText(restored.view, 'Quote a final synthesis')).dispatchEvent(new Event('click'));
  const confirmSynthesis = await waitForText(restored.view, 'Confirm simulation');
  assert.deepEqual(await journal.read(), original);
  confirmSynthesis.dispatchEvent(new Event('click'));
  await waitForText(restored.view, 'A real run would use the completed research and its sources to explain the strongest option and what to check next.');
  const completed = await journal.read();
  assert.notEqual(completed.workflowId, original.workflowId);
  assert.equal(completed.previous.workflowId, original.workflowId);
  assert.equal(completed.previous.body, undefined);
  assert.ok(findElement(restored.view, '0:00 · Simulated words from the selected clip.'));
  restored.ui.dispose();

  const synthesis = mount();
  (await waitForText(synthesis.view, 'Load previous research')).dispatchEvent(new Event('click'));
  await waitForText(synthesis.view, '0:00 · Simulated words from the selected clip.');
  assert.ok(findElement(synthesis.view, 'Decision and next steps'));
  assert.ok(!findElement(synthesis.view, 'Quote a final synthesis'));
});
