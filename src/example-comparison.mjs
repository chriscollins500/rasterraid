import { numericId, SITE_ORIGINS } from './catalog.mjs';
import { hydratePosts } from './community.mjs';
import { readExampleMedia } from './gallery.mjs';

export const exampleComparisonSources = ['gallery', 'videos', 'models', 'posts'];
const exampleNames = ['First example', 'Second example'];
const catalogId = value => numericId(value) && value <= 2_147_483_647;

function exampleId(value) {
  if (/^[1-9]\d{0,9}$/u.test(value)) return Number(value);
  try {
    const url = new URL(value);
    if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password || url.search || url.hash) return null;
    return Number(/^\/images\/([1-9]\d{0,9})(?:\/[^/]{1,170})?\/?$/u.exec(url.pathname)?.[1]);
  } catch { return null; }
}

export function examplePairIds(query) {
  const ids = query.trim().split(/\s+/u).map(exampleId);
  if (ids.length !== 2 || !ids.every(catalogId) || ids[0] === ids[1]) {
    throw new Error('Enter two different Civitai picture or clip links or IDs, separated by a space.');
  }
  return ids;
}

export function pastedExamplePair(query) {
  const links = query.trim().split(/\s+/u);
  if (links.length !== 2 || links.some(link => !link.startsWith('https://'))) return null;
  try { return examplePairIds(query); } catch { return null; }
}

export function exampleSide(index) {
  return exampleNames[index];
}

export function exampleVersionUse(record) {
  if (!record) return 'Unreported';
  const strengths = record.weights.length ? 'Strength ' + record.weights.join(' / ') : 'Strength unreported';
  return [record.types.join(' / '), strengths].filter(Boolean).join(' · ');
}

export async function readExampleComparison(context, ids, modelFilters, { signal, fetcher, onPhase, recordedSource }) {
  const options = { signal, fetcher };
  onPhase('Checking both Civitai examples…');
  const media = await readExampleMedia(context, ids, options).catch(error => {
    signal?.throwIfAborted();
    return { items: [], partial: true, status: error.status };
  });
  const byId = new Map(media.items.map(item => [item.id, item]));
  const examples = ids.map(id => byId.get(id) ?? null);
  const items = examples.filter(Boolean);
  if (items.some(item => catalogId(item.postId))) onPhase('Verifying the published posts…');
  const posts = await hydratePosts(context, items.filter(item => catalogId(item.postId)), '', options);
  const recorded = [...new Set(items.flatMap(item => item.recorded).filter(catalogId))];
  const associated = [...new Set(items.flatMap(item => item.associated).filter(catalogId))];
  const linked = [...new Set([...recorded, ...posts.items.map(post => post.modelVersionId).filter(catalogId), ...associated])];
  const verify = linked.slice(0, 18);
  const versionBatches = [verify.slice(0, 8), verify.slice(8, 16), verify.slice(16)].filter(batch => batch.length);
  if (verify.length) onPhase('Checking the exact model versions…');
  const modelReads = await Promise.allSettled(versionBatches.map(batch => recordedSource(context,
    { records: batch.map(versionId => ({ versionId })) }, modelFilters,
    { ...options, evidenceLabel: 'Linked to the compared examples' })));
  signal?.throwIfAborted();
  const models = new Map();
  const modelFlows = [];
  for (const result of modelReads) {
    if (result.status === 'rejected') {
      modelFlows.push({ label: 'Exact model versions', status: result.reason?.status ?? null });
      continue;
    }
    modelFlows.push(...result.value.flows);
    for (const model of result.value.candidates) {
      if (verify.includes(model.id) && catalogId(model.modelId) &&
          model.link === new URL('/models/' + model.modelId + '?modelVersionId=' + model.id, context.origin).href) {
        models.set(model.id, model);
      }
    }
  }
  const settings = [...new Set(items.flatMap(item => item.publishedSetup.settings.map(setting => setting.label)))].map(label =>
    ({ label, values: examples.map(item => item?.publishedSetup.settings.find(setting => setting.label === label)?.value ?? null) }));
  const versions = recorded.map(id => ({ id, model: models.get(id), values: examples.map(item =>
    item?.publishedSetup.recorded.find(entry => entry.versionId === id) ?? null) }));
  const verifiedPosts = new Map(posts.items.flatMap(post => post.previews.map(item => [item.id, post])));
  const summary = {
    examples: examples.map((item, index) => {
      const post = item && verifiedPosts.get(item.id);
      return { id: ids[index], item, post, postModel: post && models.get(post.modelVersionId) };
    }),
    settings, versions, limited: verify.length < linked.length || items.some(item => item.publishedSetup.limited),
  };
  const mediaFlow = media.partial ? [{ label: 'Exact Civitai examples', status: media.status ?? null }] : [];
  return { summary, models: [...models.values()], modelFlows, mediaFlow,
    posts: posts.items, postFlows: posts.partial ? [{ label: 'Published posts', status: null }] : [] };
}
