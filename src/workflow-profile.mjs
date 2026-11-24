import { civitaiAir, text } from './catalog.mjs';
import { traceComfyWorkflow } from './comfy-workflow.mjs';

const loaderFields = {
  CheckpointLoaderSimple: [['ckpt_name', 'Checkpoint', 0]],
  CheckpointLoader: [['ckpt_name', 'Checkpoint', 1]],
  UNETLoader: [['unet_name', 'Diffusion model', 0]],
  UnetLoaderGGUF: [['unet_name', 'Diffusion model', 0]],
  UnetLoaderGGUFAdvanced: [['unet_name', 'Diffusion model', 0]],
  VAELoader: [['vae_name', 'VAE', 0]],
  LoraLoader: [['lora_name', 'LoRA', 0]],
  LoraLoaderModelOnly: [['lora_name', 'LoRA', 0]],
  CLIPLoader: [['clip_name', 'Text encoder', 0]],
  CLIPLoaderGGUF: [['clip_name', 'Text encoder', 0]],
  DualCLIPLoader: [['clip_name1', 'Text encoder', 0], ['clip_name2', 'Text encoder', 1]],
  DualCLIPLoaderGGUF: [['clip_name1', 'Text encoder', 0], ['clip_name2', 'Text encoder', 1]],
  TripleCLIPLoader: [['clip_name1', 'Text encoder', 0], ['clip_name2', 'Text encoder', 1], ['clip_name3', 'Text encoder', 2]],
  QuadrupleCLIPLoader: [['clip_name1', 'Text encoder', 0], ['clip_name2', 'Text encoder', 1], ['clip_name3', 'Text encoder', 2], ['clip_name4', 'Text encoder', 3]],
  ControlNetLoader: [['control_net_name', 'ControlNet', 0]],
  UpscaleModelLoader: [['model_name', 'Upscaler', 0]],
  FrameInterpolationModelLoader: [['model_name', 'Frame interpolation model', 0]],
  CLIPVisionLoader: [['clip_name', 'Vision encoder', 0]],
  StyleModelLoader: [['style_model_name', 'Style model', 0]],
};
const models = /\.(?:safetensors|gguf|ckpt|pt|pth|bin|onnx|sft|tflite|pkl|safetensor)$/iu;
export const maximumWorkflowBytes = 10_000_000;
const kinds = new Set(Object.values(loaderFields).flatMap(entries => entries.map(entry => entry[1])));
const airKinds = new Map([['checkpoint', 'Checkpoint'], ['lora', 'LoRA'], ['locon', 'LoRA'], ['vae', 'VAE'],
  ['controlnet', 'ControlNet'], ['upscaler', 'Upscaler'], ['textencoder', 'Text encoder'], ['clipvision', 'Vision encoder']]);

function safeAsset(asset) {
  if (!asset) return null;
  const exact = civitaiAir(asset.air);
  const air = exact?.kind === 'version' ? exact.air : null;
  const file = typeof asset.file === 'string' ? text(asset.file.split(/[\\/]/u).at(-1), 260) : '';
  const hasFile = file && models.test(file) && !/[\u0000-\u001f\u007f<>:"|?*]/u.test(file);
  const kind = kinds.has(asset.kind) ? asset.kind : air ? airKinds.get(air.split(':')[3].toLowerCase()) ?? 'Civitai resource' : null;
  return kind && (hasFile || air) ? { kind, ...(hasFile && { file }), ...(air && { air }) } : null;
}

function assetKey(asset) {
  const address = civitaiAir(asset.air);
  return address ? ['air', address.modelId, address.id, address.fileId, address.format?.toLowerCase().replace(/safetensors?$/u, 'safetensor')].join('/')
    : asset.kind + '|' + asset.file;
}

function uniqueAssets(assets) {
  const unique = new Map();
  for (const asset of assets.filter(Boolean)) {
    const key = assetKey(asset);
    if (!unique.has(key) || asset.file && !unique.get(key).file) unique.set(key, asset);
  }
  return [...unique.values()].slice(0, 100);
}

function directValue(node, canvas, name, index) {
  const values = canvas ? node.raw.widgets_values : node.raw.inputs;
  if (canvas && Array.isArray(values)) return values[index];
  return values?.[name];
}

function loRAStack(node, canvas) {
  const inputs = node.raw.inputs;
  if (node.type === 'Power Lora Loader (rgthree)') {
    const rows = canvas ? node.raw.widgets_values : Object.entries(inputs ?? {}).filter(([key]) => /^lora_\d+$/u.test(key))
      .map(([, value]) => value);
    return Array.isArray(rows) ? rows.slice(0, 100).filter(row => row?.on === true &&
      (row.strength !== 0 || typeof row.strengthTwo === 'number' && row.strengthTwo !== 0)) : [];
  }
  if (node.type === 'NdSuperLoraLoader') {
    const value = directValue(node, canvas, 'lora_bundle', 0);
    if (typeof value !== 'string' || value.length > 100_000) return [];
    try {
      const rows = JSON.parse(value);
      return Array.isArray(rows) ? rows.slice(0, 100).filter(row => row?.enabled === true && (row.strength !== 0 || row.strengthClip !== 0)) : [];
    } catch { return []; }
  }
  return [];
}

function modelAssets(node, canvas, read) {
  const assets = [];
  let uncertain = 0;
  if (node.type === 'LoraLoader' || node.type === 'LoraLoaderModelOnly') {
    const strength = read('strength_model', 1).value;
    if (strength === 0 && (node.type === 'LoraLoaderModelOnly' || read('strength_clip', 2).value === 0)) return { assets, uncertain };
  }
  if (Object.hasOwn(loaderFields, node.type)) for (const [field, kind, position] of loaderFields[node.type]) {
    const found = read(field, position);
    if (found.valueUnknown) uncertain++;
    assets.push(safeAsset({ kind, file: found.value, air: found.value }));
  }
  for (const row of loRAStack(node, canvas)) assets.push(safeAsset({ kind: 'LoRA', file: row.lora, air: row.lora }));
  return { assets, uncertain };
}

export function inspectWorkflowGraph(data) {
  const trace = traceComfyWorkflow(data);
  const inventory = uniqueAssets(trace.inventory.filter(({ node }) => node.mode !== 2 && node.mode !== 4)
    .flatMap(({ node, template }) => modelAssets(node, template.canvas, (name, index) => ({ value: directValue(node, template.canvas, name, index) })).assets));
  const rows = [];
  let unresolved = trace.uncertain;
  for (const entry of trace.active) {
    const { node, slots, canvas, read, air } = entry;
    const files = modelAssets(node, canvas, read);
    rows.push(...files.assets);
    unresolved += files.uncertain;
    if (node.type === 'CivitaiModelSelector') for (const slot of slots) {
      const asset = safeAsset({ air: air(slot) });
      if (asset) rows.push(asset);
      else unresolved++;
    }
  }
  const assets = trace.mode === 'inventory' ? inventory : uniqueAssets(rows);
  const used = new Set(assets.map(assetKey));
  const excluded = inventory.filter(asset => !used.has(assetKey(asset))).length;
  return { nodeCount: trace.nodeCount, assets, mode: trace.mode, outputs: trace.outputs, excluded, unresolved };
}

export function workflowAssetLabel(asset) {
  if (asset.file) return asset.file;
  const reference = civitaiAir(asset.air);
  return (reference?.id ? 'Version #' + reference.id : 'Civitai model') + (reference?.fileId ? ' · File #' + reference.fileId : '');
}

export function workflowInspectionLabel({ mode, outputs, excluded, unresolved }) {
  if (mode === 'inventory') return 'Model inventory · No recognized output to trace';
  if (mode === 'disabled') return 'No enabled recognized output to trace';
  return [outputs + ' ' + (mode === 'saved' ? 'save' : mode === 'preview' ? 'preview' : 'selected') + (outputs === 1 ? ' output traced' : ' outputs traced'),
    excluded && excluded + ' ' + (excluded === 1 ? 'file skipped' : 'files skipped'),
    unresolved && unresolved + ' unresolved ' + (unresolved === 1 ? 'link or input' : 'links or inputs')].filter(Boolean).join(' · ');
}

export function environmentProfile(value) {
  const runtime = ['comfyui', 'civitai'].includes(value?.runtime) ? value.runtime : 'comfyui';
  const baseModel = text(value?.baseModel, 100);
  const vram = typeof value?.vram === 'string' && /^\d{1,4}$/u.test(value.vram) ? Number(value.vram) : value?.vram;
  const assets = uniqueAssets((Array.isArray(value?.assets) ? value.assets : []).slice(0, 100).map(safeAsset));
  return { runtime, baseModel, vram: Number.isSafeInteger(vram) && vram > 0 && vram <= 2048 ? vram : null, assets };
}
