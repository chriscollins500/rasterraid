import assert from 'node:assert/strict';
import test from 'node:test';
import { blockFixtureToken } from '../mock/host-fixture.mjs';
import { watchHost } from '../src/civitai-host.js';
import { isWorkflowModel, workflowFiles, workflowReadResult } from '../src/published-workflow.mjs';
import { inspectWorkflowGraph } from '../src/workflow-profile.mjs';
import { workflowAuditMarkdown } from '../src/workspace-file-view.js';

const expected = { modelId: 1309369, versionId: 2947948, fileId: 2827194 };
const graph = {
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'urn:air:sd1:checkpoint:civitai:4384@128713+93211.safetensors' } },
  2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'workflow-private-prompt-fixture' } },
};
const response = (fileId = expected.fileId) => ({
  file: {
    meta: { modelId: expected.modelId, modelVersionId: expected.versionId, fileId, fileName: 'Workflow.zip', signedUrl: 'discard' },
    entries: [
      { path: 'graph/api.json', format: 'api', graph },
      { path: 'metadata.json', format: 'unknown', graph: {} },
      { path: 'invalid.json', format: 'ui', graph: {} },
    ],
    truncated: true,
  },
});

function frame(origin, viewerId = 21) {
  let receive;
  let context;
  const messages = [];
  const parent = { postMessage(data, targetOrigin) { messages.push({ data, targetOrigin }); } };
  const win = {
    parent, document: { body: { scrollHeight: 600 }, documentElement: { dataset: {} } }, atob,
    addEventListener(type, fn) { assert.equal(type, 'message'); receive = fn; },
    removeEventListener() { receive = null; },
  };
  const dispose = watchHost(win, value => { context = value; });
  const send = (type, payload, { source = parent, from = origin } = {}) => receive({ source, origin: from, data: { type, payload } });
  send('BLOCK_INIT', { blockId: 'rasterraid', blockInstanceId: 'page_fixture', renderMode: 'iframe',
    viewer: viewerId ? { id: viewerId, signedIn: true } : null, context: { slotId: 'app.page' }, token: blockFixtureToken({ viewerId }) });
  return { messages, send, dispose, context: () => context };
}

test('published archives retain exact IDs and supported graphs and export the chosen file provenance', () => {
  assert.ok(isWorkflowModel('Workflows') && isWorkflowModel('ComfyWorkflows') && !isWorkflowModel('Checkpoint'));
  assert.deepEqual(workflowFiles({ files: [{ id: 2, name: 'A.ZIP' }, { id: 3, name: 'C.safetensors' }] }).map(file => file.id), [2]);
  const result = workflowReadResult(response(), expected);
  assert.equal(result.status, 'ready');
  assert.equal(result.file.fileId, expected.fileId);
  assert.equal(result.file.skipped, 2);
  assert.equal(result.file.truncated, true);
  assert.equal(result.file.signedUrl, undefined);
  const inspection = inspectWorkflowGraph(result.file.graphs[0].graph);
  assert.equal(inspection.assets.length, 1);
  const markdown = workflowAuditMarkdown([], { runtime: 'comfyui', assets: inspection.assets }, '2026-11-23', { ...inspection, source: {
    link: 'https://civitai.red/models/1309369?modelVersionId=2947948', modelName: 'Workflow [archive]', versionId: expected.versionId,
    fileName: result.file.fileName, fileId: result.file.fileId, graph: result.file.graphs[0].path, format: 'ComfyUI API graph', truncated: true,
  } });
  assert.match(markdown, /Version #2947948\nFile #2827194 · Workflow\.zip/u);
  assert.match(markdown, /graph\/api\.json/u);
  assert.doesNotMatch(markdown, /workflow-private-prompt-fixture/u);
  assert.deepEqual(workflowReadResult(response(17), expected), { status: 'invalid' });
  assert.deepEqual(workflowReadResult(null, expected), { status: 'invalid' });
  assert.deepEqual(workflowReadResult({ error: 'forbidden' }, expected), { status: 'forbidden' });
  assert.deepEqual(workflowReadResult({ ...response(), error: 'not-found' }, expected), { status: 'invalid' });
});

test('workflow reads are scoped to the active Civitai page, request and file', async t => {
  for (const origin of ['https://civitai.com', 'https://civitai.red']) await t.test(origin, async () => {
    const host = frame(origin);
    try {
      const request = host.context().readWorkflowFile(expected, new AbortController().signal);
      const { data, targetOrigin } = host.messages.at(-1);
      assert.equal(targetOrigin, origin);
      assert.equal(data.type, 'GET_RESOURCE_FILE');
      const { requestId } = data.payload;
      assert.deepEqual(data.payload, { requestId, modelVersionId: expected.versionId, fileId: expected.fileId });
      host.send('RESOURCE_FILE_RESULT', { requestId, error: 'not-found' }, { source: {} });
      host.send('RESOURCE_FILE_RESULT', { requestId, error: 'not-found' },
        { from: origin.endsWith('.red') ? 'https://civitai.com' : 'https://civitai.red' });
      host.send('RESOURCE_FILE_RESULT', { requestId: 'other', error: 'forbidden' });
      assert.deepEqual(await host.context().readWorkflowFile(expected, new AbortController().signal), { status: 'busy' });
      host.send('RESOURCE_FILE_RESULT', { requestId, ...response() });
      assert.equal((await request).file.fileId, expected.fileId);
    } finally { host.dispose(); }
  });
});

test('guest, cancellation and visibility reduction prevent stale workflow data from entering the view', async () => {
  const guest = frame('https://civitai.com', null);
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await guest.context().readWorkflowFile(expected, signal), { status: 'unauthorized' });
    assert.deepEqual(guest.messages.map(message => message.data.type), ['BLOCK_READY']);
  } finally { guest.dispose(); }

  const host = frame('https://civitai.red');
  try {
    const cancelled = new AbortController();
    const current = host.context();
    const request = current.readWorkflowFile(expected, cancelled.signal);
    const { requestId } = host.messages.at(-1).data.payload;
    cancelled.abort();
    assert.deepEqual(await request, { status: 'cancelled' });
    host.send('RESOURCE_FILE_RESULT', { requestId, ...response() });
    const next = current.readWorkflowFile({ modelId: expected.modelId, versionId: expected.versionId }, signal);
    assert.equal(Object.hasOwn(host.messages.at(-1).data.payload, 'fileId'), false);
    host.send('TOKEN_REFRESH', { token: blockFixtureToken({ viewerLevel: 1 }) });
    assert.deepEqual(await next, { status: 'cancelled' });
    assert.deepEqual(await current.readWorkflowFile(expected, signal), { status: 'cancelled' });
  } finally { host.dispose(); }
});
