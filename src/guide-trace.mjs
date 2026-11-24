import { numericId } from './catalog.mjs';
import { modelChoiceKey, modelCreatorName, modelFilterValues } from './model-access.mjs';

const guideLimit = 2;
const referenceReads = 4;
const labels = {
  articles: 'The guide links to this article', posts: 'The guide links to this post',
  gallery: 'The guide links to this picture', videos: 'The guide links to this clip',
  collections: 'The guide links to this collection', users: 'The guide links to this creator',
  tools: 'The guide links to this tool', apps: 'The guide links to this app',
};

function matchReference(result, reference, origin, modelFilters) {
  if (!result || result.library) return null;
  const { scope } = reference;
  if (scope === 'models') {
    const families = modelFilterValues(modelFilters.baseModel).map(modelChoiceKey);
    const types = modelFilterValues(modelFilters.resourceType).map(modelChoiceKey);
    const author = modelChoiceKey(modelCreatorName(modelFilters.modelAuthor));
    const model = result.candidates?.find(candidate => numericId(candidate.id) && candidate.modelId === reference.id &&
      (!reference.versionId || candidate.id === reference.versionId) &&
      (!families.length || families.includes(modelChoiceKey(candidate.base))) &&
      (!types.length || types.includes(modelChoiceKey(candidate.type))) &&
      (!modelFilters.modelAuthor || author && author === modelChoiceKey(candidate.creator)) &&
      (!modelFilters.fileFormat || candidate.formats?.includes(modelFilters.fileFormat)) &&
      (modelFilters.supportsGeneration !== 'true' || candidate.generationListed === true) &&
      candidate.link === new URL('/models/' + reference.id + '?modelVersionId=' + candidate.id, origin).href);
    return model ? { link: model.link, result: { candidates: [model], related: {} } } : null;
  }
  const card = result.related?.[scope]?.find(item => item.link === reference.link ||
    (scope === 'users' && item.link?.toLowerCase() === reference.link.toLowerCase()));
  if (!card) return null;
  const media = scope === 'posts' ? (result.related.postMedia ?? []).filter(item => item.postId === card.id).slice(0, 3) : [];
  return { link: card.link, result: { candidates: [], related: { [scope]: [card], ...(media.length && { postMedia: media }) } } };
}

function chooseReads(references) {
  // Prefer an exact release over a model page and take a representative
  // result from each available source before checking several of one kind.
  const groups = new Map();
  for (const reference of references) {
    if (!groups.has(reference.scope)) groups.set(reference.scope, []);
    groups.get(reference.scope).push(reference);
  }
  for (const group of groups.values()) group.sort((a, b) => Number(Boolean(b.versionId)) - Number(Boolean(a.versionId)));
  const ordered = [];
  for (let rank = 0; ordered.length < referenceReads && rank < referenceReads; rank++) {
    for (const group of groups.values()) if (group[rank] && ordered.length < referenceReads) ordered.push(group[rank]);
  }
  return ordered;
}

function guideExamples(records, origin) {
  const pictures = new Map();
  const edges = [];
  for (const { result } of records) {
    for (const model of result.candidates) {
      const sample = model.examples?.find(item => numericId(item.id) && item.preview && !item.video && !item.audio &&
        item.link === new URL('/images/' + item.id, origin).href);
      if (!sample) continue;
      if (!pictures.has(sample.id)) pictures.set(sample.id, { ...sample, title: 'Example for ' + model.model, tags: [],
        description: model.version, source: model.link, sourceTitle: model.model });
      const recorded = sample.recorded?.includes(model.id);
      edges.push({ kind: recorded ? 'recorded' : 'guide-model-example',
        label: recorded ? 'This example records the exact model version' : 'Civitai lists this as an example for the model version',
        first: model.link, second: sample.link });
    }
  }
  if (!pictures.size) return null;
  return { record: { scope: 'gallery', result: { candidates: [], related: { gallery: [...pictures.values()] } } }, edges };
}

export async function followGuideReferences({ origin, scopeList, modelFilters, rows, anchor, signal, onPhase, verifiedRead }) {
  const articleResults = rows.find(row => row.scope === 'articles')?.result;
  const sources = [...(anchor?.related.articles ?? []), ...(articleResults?.related.articles ?? [])];
  const leads = [];
  for (const source of sources) {
    if (!leads.some(lead => lead.link === source.link)) leads.push(source);
    if (leads.length === guideLimit) break;
  }
  if (!leads.length) return null;
  const needsHydration = leads.some(lead => !Array.isArray(lead.citations));
  if (needsHydration) onPhase('Reading the public guides…');
  const guides = (await Promise.all(leads.map(async lead => {
    if (Array.isArray(lead.citations)) return lead;
    if (articleResults?.flows?.some(flow => flow.status === 429)) return null;
    const exact = await verifiedRead({ scope: 'articles', query: lead.link }, result =>
      result.related.articles?.some(card => card.link === lead.link && Array.isArray(card.citations)));
    return exact?.related.articles.find(card => card.link === lead.link);
  }))).filter(Boolean);
  signal?.throwIfAborted();

  const selected = new Set(scopeList);
  const known = new Map(rows.map(row => [row.scope, row.result]));
  const targets = new Map();
  for (const guide of guides) for (const citation of guide.citations) {
    const scope = citation.scope === 'gallery' && !selected.has('gallery') && selected.has('videos') ? 'videos' : citation.scope;
    if (!selected.has(scope) || citation.link === guide.link) continue;
    if (!targets.has(citation.link)) targets.set(citation.link, { ...citation, scope, sources: [] });
    targets.get(citation.link).sources.push(guide.link);
  }
  const matched = new Map();
  const unresolved = [];
  for (const reference of targets.values()) {
    const present = matchReference(known.get(reference.scope), reference, origin, modelFilters);
    if (present) matched.set(reference.link, present);
    else unresolved.push(reference);
  }

  // The exact version endpoint has no category, release period, training
  // source or checkpoint-subtype query. Keep those strict filters attached
  // to ordinary search results instead of assuming a linked version fits.
  const needsCatalogFilter = Boolean(modelFilters.category || modelFilters.period || modelFilters.fromPlatform === 'true' ||
    modelFilters.checkpointType);
  const canFollow = unresolved.filter(reference => reference.scope !== 'models' || !needsCatalogFilter);
  const requests = chooseReads(canFollow);
  if (requests.length) onPhase('Verifying exact resources linked in the guides…');
  for (let index = 0; index < requests.length; index += 2) {
    await Promise.all(requests.slice(index, index + 2).map(async reference => {
      const filters = reference.scope === 'models' ? modelFilters : {};
      const exact = await verifiedRead({ ...filters, scope: reference.scope, query: reference.link },
        result => Boolean(matchReference(result, reference, origin, modelFilters)));
      const verified = matchReference(exact, reference, origin, modelFilters);
      if (verified) matched.set(reference.link, verified);
    }));
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();

  const records = [];
  const edges = [];
  for (const reference of targets.values()) {
    const verified = matched.get(reference.link);
    if (!verified) continue;
    records.push({ scope: reference.scope, result: verified.result });
    const kind = reference.scope === 'models' ? reference.versionId ? 'guide-version' : 'guide-model' : 'guide-link';
    const label = kind === 'guide-version' ? 'The guide links to this exact model version'
      : kind === 'guide-model' ? 'The guide links to this model’s catalog page' : labels[reference.scope];
    for (const first of reference.sources) edges.push({ kind, label, first, second: verified.link });
  }
  if (selected.has('gallery')) {
    const examples = guideExamples(records, origin);
    if (examples) {
      records.push(examples.record);
      edges.push(...examples.edges);
    }
  }
  return { records, edges, summary: {
    guides: guides.map(({ title, link, updatedAt }) => ({ title, link, updatedAt })),
    checkedAt: new Date().toISOString(), unreadGuides: leads.length - guides.length,
    confirmed: matched.size, unavailable: requests.filter(reference => !matched.has(reference.link)).length,
    needFilterEvidence: unresolved.length - canFollow.length, unchecked: canFollow.length - requests.length,
  } };
}
