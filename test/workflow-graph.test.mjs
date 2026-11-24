import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflowGraph, environmentProfile, workflowInspectionLabel } from '../src/workflow-profile.mjs';
import { checkWorkflowFiles, checkWorkspaceAsset } from '../src/workspace.mjs';
import { workflowAuditMarkdown, workflowFileStatus } from '../src/workspace-file-view.js';

const first = 'urn:air:sdxl:lora:civitai:11@21+31.safetensors';
const second = 'urn:air:sdxl:lora:civitai:11@21+32.safetensors';
const version = 'urn:air:sdxl:lora:civitai:11@21';
const excludedAir = 'urn:air:sdxl:lora:civitai:12@22+33.safetensors';
const api = (class_type, inputs) => ({ class_type, inputs });
const port = (name, type, link) => ({ name, type, link });

test('the saved output traces its bypass connection without loading the bypassed model, muted roots or preview branch', () => {
  const data = { nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['secret\\active.safetensors'] },
    { id: 2, type: 'CheckpointLoaderSimple', widgets_values: ['preview.safetensors'] },
    { id: 3, type: 'LoraLoaderModelOnly', mode: 4, widgets_values: ['bypassed.safetensors'],
      inputs: [port('model', 'MODEL', 10)], outputs: [{ type: 'MODEL' }] },
    { id: 4, type: 'ToImage', inputs: [port('model', 'MODEL', 11)] },
    { id: 5, type: 'ToImage', inputs: [port('model', 'MODEL', 12)] },
    { id: 6, type: 'SaveImage', inputs: [port('images', 'IMAGE', 13)] },
    { id: 7, type: 'PreviewImage', inputs: [port('images', 'IMAGE', 14)] },
    { id: 8, type: 'SaveImage', mode: 2, inputs: [port('images', 'IMAGE', 15)] },
    { id: 9, type: 'CheckpointLoaderSimple', mode: 2, widgets_values: ['muted.safetensors'] },
  ], links: [[10, 1, 0, 3, 0, 'MODEL'], [11, 3, 0, 4, 0, 'MODEL'], [12, 2, 0, 5, 0, 'MODEL'],
    [13, 4, 0, 6, 0, 'IMAGE'], [14, 5, 0, 7, 0, 'IMAGE'], [15, 5, 0, 8, 0, 'IMAGE']] };
  const trace = inspectWorkflowGraph(data);
  assert.deepEqual(trace.assets, [{ kind: 'Checkpoint', file: 'active.safetensors' }]);
  assert.equal(trace.mode, 'saved');
  assert.equal(trace.outputs, 1);
  assert.equal(trace.excluded, 1);
  assert.equal(trace.unresolved, 0);
  assert.doesNotMatch(JSON.stringify(trace), /secret|preview\.safetensors|bypassed/u);
  assert.match(workflowInspectionLabel(trace), /1 save output traced/u);
});

test('the API trace follows a selected output and lazy switch, preserving only used selector slots', () => {
  const prompt = {
    1: api('CivitaiModelSelector', { air: excludedAir, resources_json: JSON.stringify({ bySlot: { 0: first, 1: second } }) }),
    2: api('CivitaiModelSelector', { air: excludedAir }),
    3: api('PrimitiveBoolean', { value: false }),
    4: api('ComfySwitchNode', { switch: ['3', 0], on_true: ['2', 0], on_false: ['1', 1] }),
    5: api('MakeImage', { model: ['4', 0] }),
    6: api('SaveImage', { images: ['5', 0] }),
    7: api('PreviewImage', { images: ['2', 0] }),
  };
  const detection = inspectWorkflowGraph({ prompt, partial_execution_targets: ['6'] });
  assert.equal(detection.mode, 'selected');
  assert.deepEqual(detection.assets, [{ kind: 'LoRA', air: second }]);
  prompt[3] = api('PrivateComputedValue', { searchTerm: 'local graph text' });
  const dynamic = inspectWorkflowGraph({ prompt, partial_execution_targets: ['6'] });
  assert.deepEqual(dynamic.assets, []);
  assert.equal(dynamic.unresolved, 1);
  assert.equal(inspectWorkflowGraph({ prompt, partial_execution_targets: [] }).mode, 'disabled');
});

test('Impact Pack API pipes follow each consumed component through successive edits', () => {
  const prompt = {
    1: api('CheckpointLoaderSimple', { ckpt_name: 'superseded.safetensors' }),
    2: api('CheckpointLoaderSimple', { ckpt_name: 'replacement.safetensors' }),
    3: api('VAELoader', { vae_name: 'shared_vae.safetensors' }),
    4: api('CLIPLoader', { clip_name: 'encoder.safetensors' }),
    5: api('CLIPTextEncode', { clip: ['4', 0], text: 'positive' }),
    6: api('CLIPTextEncode', { clip: ['4', 0], text: 'negative' }),
    7: api('ToBasicPipe', { model: ['1', 0], clip: ['4', 0], vae: ['3', 0], positive: ['5', 0], negative: ['6', 0] }),
    8: api('EditBasicPipe', { basic_pipe: ['7', 0], model: ['2', 0] }),
    9: api('EditBasicPipe', { basic_pipe: ['8', 0], model: null }),
    10: api('FromBasicPipe_v2', { basic_pipe: ['9', 0] }),
    11: api('FromBasicPipe', { basic_pipe: ['10', 0] }),
    12: api('MakeImage', { model: ['11', 0], vae: ['11', 2] }),
    13: api('CCollins_CiviScribe_SaveImage', { images: ['12', 0] }),
  };
  const assets = ['replacement.safetensors', 'shared_vae.safetensors'];
  const projected = inspectWorkflowGraph({ prompt });
  assert.deepEqual(projected.assets.map(row => row.file), assets);
  assert.deepEqual([projected.excluded, projected.unresolved], [2, 0]);

  prompt[12] = api('ImpactKSamplerBasicPipe', { basic_pipe: ['10', 0] });
  const whole = inspectWorkflowGraph({ prompt });
  assert.deepEqual(whole.assets.map(row => row.file), [...assets, 'encoder.safetensors']);
  assert.deepEqual([whole.excluded, whole.unresolved], [1, 0]);

  prompt[8].inputs.model = ['14', 0];
  prompt[14] = api('ComfySwitchNode', { switch: ['15', 0], on_true: ['2', 0], on_false: ['1', 0] });
  prompt[15] = api('RuntimeValue', {});
  const unknown = inspectWorkflowGraph({ prompt });
  assert.deepEqual(unknown.assets.map(row => row.file), ['shared_vae.safetensors', 'encoder.safetensors']);
  assert.equal(unknown.unresolved, 1);
});

test('Impact Pack canvas pipes use input names and the v2 output slots', () => {
  const workflow = { nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['original.safetensors'] },
    { id: 2, type: 'CheckpointLoaderSimple', widgets_values: ['edition.safetensors'] },
    { id: 3, type: 'VAELoader', widgets_values: ['vae.safetensors'] },
    { id: 4, type: 'ToBasicPipe', inputs: [port('vae', 'VAE', 1), port('model', 'MODEL', 2)] },
    { id: 5, type: 'EditBasicPipe', inputs: [port('model', 'MODEL', 3), port('basic_pipe', 'BASIC_PIPE', 4)] },
    { id: 6, type: 'FromBasicPipe_v2', inputs: [port('basic_pipe', 'BASIC_PIPE', 5)] },
    { id: 7, type: 'MakeImage', inputs: [port('model', 'MODEL', 6), port('vae', 'VAE', 7)] },
    { id: 8, type: 'SaveImage', inputs: [port('images', 'IMAGE', 8)] },
  ], links: [[1, 3, 0, 4, 0, 'VAE'], [2, 1, 0, 4, 1, 'MODEL'], [3, 2, 0, 5, 0, 'MODEL'], [4, 4, 0, 5, 1, 'BASIC_PIPE'],
    [5, 5, 0, 6, 0, 'BASIC_PIPE'], [6, 6, 1, 7, 0, 'MODEL'], [7, 6, 3, 7, 1, 'VAE'], [8, 7, 0, 8, 0, 'IMAGE']] };
  const trace = inspectWorkflowGraph(workflow);
  assert.deepEqual(trace.assets.map(row => row.file), ['edition.safetensors', 'vae.safetensors']);
  assert.deepEqual([trace.excluded, trace.unresolved], [1, 0]);
});

test('nested canvas subgraphs trace consumed outputs and use the connected external widget value', () => {
  const input = { id: -10 };
  const output = { id: -20 };
  const field = { name: 'unet_name' };
  const edge = (id, origin_id, origin_slot, target_id, target_slot, type) => ({ id, origin_id, origin_slot, target_id, target_slot, type });
  const inner = { id: 'inner', inputNode: input, outputNode: output, inputs: [field], nodes: [
    { id: 1, type: 'UNETLoader', inputs: [port('unet_name', 'COMBO', 1)], widgets_values: ['old.safetensors'] },
    { id: 2, type: 'VAELoader', widgets_values: ['other.safetensors'] },
  ], links: [edge(1, -10, 0, 1, 0, 'COMBO'), edge(2, 1, 0, -20, 0, 'MODEL'), edge(3, 2, 0, -20, 1, 'VAE')] };
  const outer = { id: 'outer', inputNode: input, outputNode: output, inputs: [field], nodes: [
    { id: 1, type: 'inner', inputs: [port('unet_name', 'COMBO', 4)] },
  ], links: [edge(4, -10, 0, 1, 0, 'COMBO'), edge(5, 1, 0, -20, 0, 'MODEL'), edge(6, 1, 1, -20, 1, 'VAE')],
  definitions: { subgraphs: [inner] } };
  const canvas = { definitions: { subgraphs: [outer] }, nodes: [
    { id: 1, type: 'PrimitiveNode', widgets_values: ['active.gguf'] },
    { id: 2, type: 'outer', inputs: [port('unet_name', 'COMBO', 7)] },
    { id: 3, type: 'MakeImage', inputs: [port('model', 'MODEL', 8)] },
    { id: 4, type: 'SaveImage', inputs: [port('images', 'IMAGE', 9)] },
  ], links: [[7, 1, 0, 2, 0, 'COMBO'], [8, 2, 0, 3, 0, 'MODEL'], [9, 3, 0, 4, 0, 'IMAGE']] };
  const traced = inspectWorkflowGraph(canvas);
  assert.equal(traced.outputs, 1);
  assert.equal(traced.unresolved, 0);
  assert.equal(traced.excluded, 2);
  assert.deepEqual(traced.assets, [{ kind: 'Diffusion model', file: 'active.gguf' }]);
  inner.links.push(edge(10, 2, 0, -20, 0, 'MODEL'));
  const ambiguous = inspectWorkflowGraph(canvas);
  assert.deepEqual(ambiguous.assets, []);
  assert.equal(ambiguous.unresolved, 1);
});

test('recorded graph references resolve in one read and keep distinct file pins within a version', async () => {
  const origin = 'https://civitai.com';
  const context = { origin, hosted: true, token: 'read-only', browsingLevel: 3 };
  const input = { assets: [{ air: first }, { air: second }, { air: version }, { air: excludedAir }] };
  const calls = [];
  const settings = environmentProfile(input);
  const check = await checkWorkflowFiles(context, settings, {
    fetcher(url, config) {
      calls.push(url);
      assert.equal(config.headers.Authorization, 'Bearer read-only');
      assert.equal(url.searchParams.get('modelVersionIds'), '21,22');
      assert.equal(config.body, undefined);
      return Response.json({ items: [{ id: 11, name: 'Print', type: 'LORA', modelVersions: [{ id: 21, name: '1', baseModel: 'SDXL 1.0', files: [
        { id: 31, name: 'print1.safetensors', metadata: { format: 'SafeTensor' } },
        { id: 32, name: 'print2.safetensors', metadata: { format: 'SafeTensor' } },
      ] }] }] });
    },
    async readHistory() { return { candidates: [], flows: [] }; },
  });
  assert.equal(calls.length, 1);
  const [one, two, release, unavailable] = check.rows.map(row => row.check);
  assert.deepEqual([one.matching[0].file.id, two.matching[0].file.id], [31, 32]);
  assert.equal(release.exactVersion.id, 21);
  assert.equal(release.current, null);
  assert.match(workflowFileStatus(release), /Version confirmed · File unresolved/u);
  assert.equal(unavailable.exactVersion, null);
  const report = workflowAuditMarkdown(check.rows, settings, '2026-11-22', { mode: 'saved', outputs: 1 });
  assert.match(report, /Version #21 · File #32/u);
  assert.match(report, /Recorded version.*modelVersionId=21/u);
  assert.doesNotMatch(report, /civitai:12@22/u);
});

test('a workspace SHA-256 with several published versions blocks an invented upgrade', async () => {
  const sha256 = '9'.repeat(64);
  const check = await checkWorkspaceAsset({ origin: 'https://civitai.red', hosted: true, token: 'read-only' },
    { kind: 'LoRA', file: 'private\\print.safetensors' }, '', {
      reference: sha256,
      fetcher(url, config) {
        assert.equal(url.pathname, '/api/v1/model-versions/by-hash/ids');
        assert.equal(config.headers.Authorization, undefined);
        assert.deepEqual(JSON.parse(config.body), [sha256]);
        return Response.json([{ modelId: 11, modelVersionId: 21, hash: sha256 }, { modelId: 12, modelVersionId: 22, hash: sha256 }]);
      },
    });
  assert.equal(check.sharedHash, true);
  assert.equal(check.newer, null);
  assert.equal(check.alternatives.length, 0);
  assert.match(workflowFileStatus(check), /SHA-256 matches several versions/u);
});
