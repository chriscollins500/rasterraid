import { numericId, text } from './catalog.mjs';
import { isModelFile } from './release-compatibility.mjs';

export const exampleVersionLimit = 8;
const resourceLimit = 24;
const resourceTypes = new Map([
  ['checkpoint', 'Checkpoint'], ['model', 'Model'], ['lora', 'LoRA'], ['locon', 'LoCon'], ['lycoris', 'LyCORIS'],
  ['vae', 'VAE'], ['embedding', 'Embedding'], ['textualinversion', 'Embedding'], ['controlnet', 'ControlNet'],
  ['upscaler', 'Upscaler'], ['textencoder', 'Text encoder'], ['clipvision', 'Vision encoder'],
]);

function settingName(value) {
  const label = text(value, 65);
  return /^[\p{L}\p{N}][\p{L}\p{N} .+_()/\-]{0,63}$/u.test(label) ? label : '';
}

function publishedSettings(meta) {
  const seed = (Number.isSafeInteger(meta.seed) && meta.seed >= -1 ||
    typeof meta.seed === 'string' && /^(?:-1|0|[1-9]\d{0,19})$/u.test(meta.seed)) ? String(meta.seed) : '';
  const size = numericId(meta.width) && numericId(meta.height) ? meta.width + ' × ' + meta.height
    : /^([1-9]\d{0,5})\s*[x×]\s*([1-9]\d{0,5})$/iu.exec(text(meta.Size, 30))?.slice(1).join(' × ');
  return [
    ['Size', size], ['Steps', numericId(meta.steps) && String(meta.steps)],
    ['Sampler', settingName(meta.sampler)], ['Scheduler', settingName(meta.scheduler)], ['Seed', seed],
    ['Guidance (CFG)', Number.isFinite(meta.cfgScale) && String(meta.cfgScale)],
    ['CLIP skip', Number.isSafeInteger(meta.clipSkip) && meta.clipSkip >= 0 && String(meta.clipSkip)],
    ['Denoising strength', Number.isFinite(meta.denoise ?? meta['Denoising strength']) && String(meta.denoise ?? meta['Denoising strength'])],
  ].flatMap(([label, value]) => value ? [{ label, value }] : []);
}

function recordedRuntime(meta) {
  let graph = meta.comfy;
  if (typeof graph === 'string') {
    if (graph.length > 250_000) return null;
    try { graph = JSON.parse(graph); } catch { return null; }
  }
  if (!graph || typeof graph !== 'object') return null;
  const nodes = graph.workflow?.nodes ?? graph.nodes;
  return Array.isArray(nodes) && nodes.slice(0, 64).some(node => typeof node?.type === 'string') ? 'ComfyUI' : null;
}

export function readPublishedSetup(raw) {
  const meta = raw?.meta ?? raw ?? {};
  const settings = publishedSettings(meta);
  const versions = new Map();
  const unlinked = [];
  const resources = ['civitaiResources', 'resources'].map(key => Array.isArray(meta[key]) ? meta[key] : []);
  for (const rows of resources) {
    for (const row of rows.slice(0, resourceLimit)) {
      const type = resourceTypes.get(text(row?.type, 35).toLowerCase());
      const weight = Number.isFinite(row?.weight) ? row.weight : null;
      const versionId = numericId(row?.modelVersionId ?? row?.versionId);
      const conflicting = row?.modelVersionId != null && row?.versionId != null && row.modelVersionId !== row.versionId;
      if (!versionId || conflicting) {
        if (weight !== null) {
          const name = typeof row.name === 'string' ? text(row.name.split(/[\\/]/u).at(-1), 100) : '';
          unlinked.push({ type, name, weight });
        }
        continue;
      }
      const entry = versions.get(versionId) ?? { versionId, types: new Set(), weights: new Set() };
      if (type) entry.types.add(type);
      if (weight !== null) entry.weights.add(weight);
      versions.set(versionId, entry);
    }
  }
  const recorded = [...versions.values()].slice(0, exampleVersionLimit)
    .map(({ versionId, types, weights }) => ({ versionId, types: [...types], weights: [...weights] }));
  const runtime = recordedRuntime(meta);
  return { settings, recorded, ...(runtime && { runtime }), unlinked: unlinked.slice(0, exampleVersionLimit), limited: versions.size > recorded.length ||
    unlinked.length > exampleVersionLimit || resources.some(rows => rows.length > resourceLimit) };
}

export function verifiedExampleSetup(reference, candidates, origin) {
  if (!reference?.publishedSetup) return null;
  const variants = new Map(candidates.filter(candidate => numericId(candidate.id) && numericId(candidate.modelId) &&
    candidate.link === new URL('/models/' + candidate.modelId + '?modelVersionId=' + candidate.id, origin).href)
    .map(candidate => [candidate.id, candidate]));
  const { settings, recorded, unlinked, limited } = reference.publishedSetup;
  const details = model => model && { title: [model.model, model.version].filter(Boolean).join(' · '), link: model.link,
    family: model.base, type: model.type, modelId: model.modelId,
    files: (model.files ?? []).filter(isModelFile).map(file => file.name).filter(Boolean) };
  const ids = new Set(recorded.map(row => row.versionId));
  return { link: reference.link, preview: reference.preview, video: reference.video, settings, limited, unlinked,
    recorded: recorded.map(row => ({ ...row, model: details(variants.get(row.versionId)) })),
    associated: reference.associated.filter(id => !ids.has(id) && variants.has(id))
      .map(versionId => ({ versionId, model: details(variants.get(versionId)) })),
  };
}

export function exampleModelFacts({ versionId, types = [], weights = [], model }) {
  return ['Version #' + versionId, ...(types.length ? types : [model?.type]), model?.family,
    weights.length === 1 ? 'Recorded strength ' + weights[0] : weights.length > 1 ? 'Different recorded strengths · ' + weights.join(', ') : '',
    !model && 'Exact listing unverified in this search'].filter(Boolean);
}

export function unlinkedUseLabel({ type, name, weight }) {
  return [name || type || 'Resource', 'Recorded strength ' + weight, 'Exact version unconfirmed'].join(' · ');
}
