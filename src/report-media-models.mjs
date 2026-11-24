import { numericId } from './catalog.mjs';
import { readAppMediaByIds, sampleMediaByPost } from './gallery.mjs';

const previewLimit = 3;
const versionLookupLimit = 4;
const additionalModels = 2;
const linkLimit = 4;
const validVersion = value => numericId(value) && value <= 2_147_483_647;
const knownReferences = ({ item }) => item.modelReferencesChecked || item.recorded?.length;

export async function readReportMediaReferences(context, rows, cardLimit, { signal, fetcher, onRead }) {
  const models = rows.find(row => row.scope === 'models');
  if (!context.hosted || !context.token || !models || models.result?.flows?.some(flow => flow.status === 429)) return null;
  const samples = new Map();
  const throttled = rows.some(row => row.result?.gallery?.throttled);
  for (const row of rows) {
    const { scope, result } = row;
    if (!['gallery', 'videos'].includes(scope)) continue;
    const previews = (result?.related[scope] ?? []).slice(0, cardLimit).filter(item =>
      numericId(item.id) && !item.audio && Boolean(item.video) === (scope === 'videos') &&
      item.link === new URL('/images/' + item.id, context.origin).href && (item.preview || item.stream));
    for (const [rank, item] of sampleMediaByPost(previews, previewLimit).entries()) samples.set(item.id, { item, rank });
  }
  if (!samples.size) return null;
  const ids = [...samples.values()].filter(row => !knownReferences(row)).map(({ item }) => item.id);
  if (!ids.length) return { models, samples: [...samples.values()], partial: false, throttled };
  if (throttled) return { models, samples: [...samples.values()].filter(knownReferences), partial: true, throttled };
  onRead();
  try {
    const found = await readAppMediaByIds(context, ids, { signal, fetcher });
    const verified = new Map(found.map(item => [item.id, item]));
    const checked = [...samples.values()].flatMap(({ item, rank }) => {
      if (knownReferences({ item })) return [{ item, rank }];
      const exact = verified.get(item.id);
      return exact?.link === item.link && !exact.audio && exact.video === Boolean(item.video)
        ? [{ item: { ...exact, exampleSource: item.exampleSource }, rank }] : [];
    });
    return { models, samples: checked, partial: checked.length < samples.size };
  } catch (error) {
    signal?.throwIfAborted();
    return { models, samples: [...samples.values()].filter(knownReferences), partial: true, throttled: error.status === 429 };
  }
}

export async function traceReportMediaModels(context, checked, posts, modelFilters, cardLimit,
  { signal, fetcher, recordedSource, onRead }) {
  const leads = new Map();
  function record(id, link) {
    if (!validVersion(id)) return;
    const matches = leads.get(id) ?? new Map();
    const previous = matches.get(link.first);
    if (!previous || link.score > previous.score) matches.set(link.first, link);
    leads.set(id, matches);
  }
  const byPost = new Map((posts?.result?.related.posts ?? []).slice(0, cardLimit).map(post => [post.id, post]));
  for (const { item, rank } of checked.samples) {
    for (const id of (item.recorded ?? []).slice(0, 12)) record(id, {
      kind: 'recorded', label: 'This example records the exact model version', first: item.link, video: item.video, score: 12 - rank,
    });
    for (const id of (item.associated ?? []).slice(0, 12)) record(id, {
      kind: 'catalog', label: 'Civitai links this example to the model version', first: item.link, video: item.video, score: 6 - rank,
    });
    const release = item.exampleSource;
    if (validVersion(release?.versionId) && numericId(release.modelId) && release.link ===
        new URL('/models/' + release.modelId + '?modelVersionId=' + release.versionId, context.origin).href) {
      record(release.versionId, { kind: 'catalog', label: 'Civitai lists this example for the exact release', first: item.link,
        video: item.video, score: 6 - rank });
    }
    const post = byPost.get(item.postId);
    if (post?.link === new URL('/posts/' + item.postId, context.origin).href &&
        (post.verifiedMediaIds?.includes(item.id) || post.previews?.some(preview => preview.id === item.id && preview.postId === post.id))) {
      record(post.modelVersionId, { kind: 'post-model', label: 'The post lists this exact model version', first: post.link,
        mediaLink: item.link, score: 3 - rank });
    }
  }

  const direct = checked.models.result?.candidates ?? [];
  const inResults = new Set(direct.slice(0, cardLimit).map(item => item.id));
  const known = new Map(direct.map(item => [item.id, item]));
  const ranked = [...leads.entries()].map(([id, matches]) => {
    const edges = [...matches.values()].sort((a, b) => b.score - a.score);
    return { id, edges, recorded: edges.some(edge => edge.kind === 'recorded'), score: edges.reduce((total, edge) => total + edge.score, 0) };
  }).sort((a, b) => Number(b.recorded) - Number(a.recorded) || b.score - a.score);
  const linked = ranked.filter(lead => !inResults.has(lead.id));
  const ids = linked.filter(lead => !known.has(lead.id)).slice(0, versionLookupLimit).map(lead => lead.id);
  let partial = checked.partial;
  if (ids.length && !checked.throttled) {
    onRead();
    try {
      const result = await recordedSource(context, { records: ids.map(versionId => ({ versionId })) }, modelFilters,
        { signal, fetcher, evidenceLabel: 'Linked to previews in this report' });
      signal?.throwIfAborted();
      partial ||= result.flows.some(flow => flow.status !== 200);
      for (const candidate of result.candidates) {
        if (ids.includes(candidate.id) && numericId(candidate.modelId) &&
            candidate.link === new URL('/models/' + candidate.modelId + '?modelVersionId=' + candidate.id, context.origin).href) {
          known.set(candidate.id, candidate);
        }
      }
    } catch {
      signal?.throwIfAborted();
      partial = true;
    }
  }
  const extras = linked.filter(lead => known.has(lead.id)).slice(0, additionalModels);
  const ordered = [...extras, ...ranked.filter(lead => inResults.has(lead.id))];
  const edges = ordered.flatMap(lead => {
    const version = known.get(lead.id);
    const post = lead.edges.find(edge => edge.kind === 'post-model');
    const first = post ? lead.edges.find(edge => edge.first === post.mediaLink) ?? lead.edges.find(edge => edge !== post) : lead.edges[0];
    const second = post ?? lead.edges.find(edge => edge.video !== first.video) ?? lead.edges[1];
    return [first, second].filter(Boolean).map(({ score, mediaLink, video, ...edge }) => ({ ...edge, second: version.link }));
  }).slice(0, linkLimit);
  return { candidates: extras.map(lead => ({ ...known.get(lead.id), linkedFromReportPreview: true })),
    edges, checkedPreviews: checked.samples.length, partial };
}
