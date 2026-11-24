import { text } from './catalog.mjs';

// These Civitai profiles use the same WeMM embedding space and differ in
// how their media are prepared. Revision, precision and dimensions still agree.
const wemmProfiles = new Set([
  'wemm-2b-bf16-image262144-v1',
  'wemm-2b-bf16-video-fps2-frames16-pixels4194304-v1',
]);

export function researchMatches(snapshots, spec, previous) {
  const embeddings = new Map(previous?.embeddings);
  const names = [spec.anchor, ...spec.targets.map(item => item.step)];
  for (const step of snapshots) {
    const payload = step?.output;
    if (step?.$type !== 'multimodalEmbedding' || step.status !== 'succeeded' || !names.includes(step.name) ||
        payload?.model !== spec.model || payload.dimensions !== spec.dimensions ||
        !['float32', 'float16'].includes(payload.precision)) continue;
    const { embedding, modelRevision, profile, precision } = payload;
    if (!Array.isArray(embedding) || embedding.length !== spec.dimensions || !embedding.every(Number.isFinite) ||
        !text(modelRevision, 120) || modelRevision.length > 120 || !text(profile, 120) || profile.length > 120) continue;
    const norm = Math.hypot(...embedding);
    if (Number.isFinite(norm) && norm > 0) embeddings.set(step.name, { modelRevision, profile, precision,
      values: embedding.map(value => value / norm) });
  }
  const anchor = embeddings.get(spec.anchor);
  const ranked = anchor ? spec.targets.flatMap(target => {
    const match = embeddings.get(target.step);
    if (!match || match.modelRevision !== anchor.modelRevision || match.precision !== anchor.precision) return [];
    if (match.profile !== anchor.profile && !(spec.model === 'wemm-2b' &&
        wemmProfiles.has(anchor.profile) && wemmProfiles.has(match.profile))) return [];
    const score = anchor.values.reduce((sum, value, index) => sum + value * match.values[index], 0);
    return [{ ...target, score: Math.max(-1, Math.min(1, score)) }];
  }).sort((first, next) => next.score - first.score) : [];
  return { model: spec.model, modelRevision: text(anchor?.modelRevision, 120), targetCount: spec.targets.length, embeddings, ranked,
    ...(spec.previewBasis === 'posters' && { previewBasis: 'posters' }) };
}
