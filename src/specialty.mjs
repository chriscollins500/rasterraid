import {
  CATALOG, catalogRead, listItems, numericId, previewUrl, siteSearch, text, visibleRating,
} from './catalog.mjs';
import { hydratePosts } from './community.mjs';
import { filterOptions } from './filter-options.mjs';
import { discoverGallery, prepareGallery, readGalleryPage } from './gallery.mjs';
import { foldSearchText, translateCatalogTerms } from './query-language.mjs';
import { NATIVE_COLLECTIONS_INDEX } from './runtime-config.mjs';
import { collectionResult } from './site-results.mjs';

const audioFamilyPattern = /\b(?:audio|music|sonilo|ace[- ]step|musicgen)\b/iu;
const clipFiller = new Set(['a', 'an', 'and', 'audio', 'find', 'for', 'i', 'in', 'like', 'looking', 'me', 'music',
  'of', 'please', 'show', 'some', 'song', 'sound', 'the', 'to', 'track', 'with']);
const clipTerms = value => (foldSearchText(text(value, 160)).match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !clipFiller.has(word));
const versionsOf = record => Array.isArray(record?.modelVersions) ? record.modelVersions : [];

export function audioFamilies(baseModels = filterOptions.baseModels) {
  return baseModels.filter(base => audioFamilyPattern.test(base));
}

export async function discoverAudio(context, target, filters, options, { rankVersions, queryVariants, catalog }) {
  const { origin, hosted } = context;
  const { signal } = options;
  const ceiling = hosted ? context.browsingLevel ?? 1 : 31;
  const { read, exactVersions, routeForModels, appCatalog, flows, publicAudioLeads } = catalog;
  const families = filters.audioFamilies ?? audioFamilies();
  const exact = target.kind === 'model' || target.kind === 'version';
  const galleryTask = exact ? null : discoverGallery(context, target, filters, options);
  const thematic = target.kind === 'text' || target.kind === 'tag';
  const handle = thematic ? /^@([\p{L}\p{N}_-]{1,80})(?:\s+(.*))?$/u.exec(target.value) : null;
  const query = thematic ? text(handle ? handle[2] : target.value, 120) : '';
  const localized = translateCatalogTerms(query)?.focus;
  const modelParams = { baseModels: families, limit: 12, ...(appCatalog ? {} : { nsfw: true }) };
  const expectedModel = target.modelId ?? (target.kind === 'model' ? target.id : null);

  async function lookup() {
    if (!families.length || (!thematic && !exact)) return [];
    if (exact) {
      const model = target.kind === 'model' ? await read('Exact audio model', '/api/v1/models/' + target.id, {}, true) : null;
      const ids = target.kind === 'version' ? [target.id]
        : versionsOf(model).filter(version => families.includes(version?.baseModel)).map(version => version.id).filter(numericId).slice(0, 6);
      if (!ids.length) return [];
      const found = appCatalog || target.kind === 'version' ? await exactVersions(ids, true) : [model];
      return [{ label: 'Exact audio versions', models: found.filter(item => item && (!expectedModel || item.id === expectedModel))
        .map(item => ({ ...item, modelVersions: versionsOf(item).filter(version => ids.includes(version?.id)) })) }];
    }
    const variants = query
      ? [...new Set([query, localized, ...queryVariants(query)].filter(Boolean))].slice(0, 2)
      : [''];
    return Promise.all(variants.map(async (q, index) => {
      const label = index === 0 ? 'Civitai model search' : 'Query expansion 1';
      // The App list ignores username. Use the Site creator filter for leads
      // and re-read those versions in the hosted catalog before displaying them.
      const route = handle ? CATALOG.models : routeForModels;
      const params = { ...modelParams, query: q, username: handle?.[1], ...(handle ? { nsfw: true } : {}) };
      let found = listItems(await read(label, route, params, true));
      if (handle) found = found.filter(model => foldSearchText(model.creator?.username ?? '') === foldSearchText(handle[1]));
      if (appCatalog && handle && found.length) {
        const authors = new Set(found.map(model => model.id));
        const ids = found.flatMap(versionsOf)
          .filter(version => families.includes(version?.baseModel)).map(version => version.id).filter(numericId).slice(0, 12);
        found = (await exactVersions(ids, true)).filter(model => authors.has(model.id));
      }
      return { label, query: q, recovery: Boolean(index && q === localized), models: found };
    }));
  }

  const rank = lists => rankVersions(lists.map(list => ({ ...list, models: list.models.map(model => ({
    ...model, modelVersions: versionsOf(model).filter(version => families.includes(version?.baseModel)),
  })) })), query, {}, 5);
  const candidates = rank(await lookup());

  async function mediaForRelease(id, required = []) {
    const plan = { modelVersionId: id, sort: filters.mediaSort || 'Most Reactions', tags: [], withMeta: true, username: handle?.[1] };
    const list = async type => {
      try {
        return await readGalleryPage(context, { ...plan, type }, { ...options, limit: required.length ? 5 : 3 });
      } catch (error) {
        signal?.throwIfAborted();
        flows.push({ label: 'Music examples for an exact release', status: error.status ?? null });
        return { items: [], nextCursor: null };
      }
    };
    const matchesBrief = item => item.stream && (!required.length || required.every(word => clipTerms(item.prompt).includes(word)));
    const { items, nextCursor } = await list();
    const playable = items.filter(matchesBrief);
    if (playable.length < 2 && nextCursor && items.some(item => !item.audio && !item.video)) {
      for (const type of ['video', 'audio']) {
        const { items: clips } = await list(type);
        for (const clip of clips) if (matchesBrief(clip) && !playable.some(item => item.id === clip.id)) playable.push(clip);
        if (playable.length >= 2) break;
      }
    }
    return playable.slice(0, 2);
  }

  const exampleCard = (item, source, sourceTitle) => ({
    ...item, title: item.creator ? 'Music example by ' + item.creator : 'Music example',
    category: item.audio ? 'Audio example' : 'Video example', description: item.prompt, tags: [], source, sourceTitle,
  });
  const forModels = (rows, required) => Promise.all(rows.slice(0, 4).map(async ({ id, modelId, model, version }) => {
    const source = new URL('/models/' + modelId + '?modelVersionId=' + id, origin).href;
    return (await mediaForRelease(id, required)).map(item => exampleCard(item, source, [model, version].filter(Boolean).join(' · ')));
  }));
  const examples = await forModels(candidates);
  const supplements = [];
  const required = clipTerms(localized ?? query).slice(0, 6);
  if (!candidates.length && ceiling && publicAudioLeads.size) {
    const leads = [...publicAudioLeads.values()].filter(lead => families.includes(lead.base) &&
      (!expectedModel || lead.modelId === expectedModel) && (target.kind !== 'version' || lead.id === target.id)).slice(0, 2);
    const releases = await Promise.all(leads.map(async lead => ({ id: lead.id, clips: await mediaForRelease(lead.id, required) })));
    const { items: posts, partial } = await hydratePosts(context, releases.flatMap(release => release.clips), query, options);
    if (partial) flows.push({ label: 'Published music posts', status: null });
    for (const release of releases) {
      for (const item of release.clips) {
        const post = posts.find(post => post.id === item.postId && post.modelVersionId === release.id && post.verifiedMediaIds.includes(item.id));
        if (post) supplements.push(exampleCard({ ...item, prompt: '' }, post.link, 'Published Civitai post'));
      }
    }
  }

  // A genre can appear in an example's prompt even when it doesn't appear in the name of its model.
  if (!candidates.length && !supplements.length && required.length && !handle && thematic && flows.length && flows.every(flow => flow.status === 200)) {
    const sample = listItems(await read('Audio catalog sample', routeForModels, modelParams, true));
    supplements.push(...(await forModels(rank([{ label: 'Audio catalog sample', models: sample }]), required)).flat());
  }

  const verifiedGallery = galleryTask ?? (candidates.length ? discoverGallery(context, target, filters, options) : null);
  const result = verifiedGallery ? await verifiedGallery : {
    target, gallery: await prepareGallery(context, target, filters, options), related: { audio: [] }, reference: null,
    candidates: [], shortlisted: [], guides: [], flows: [], alternateQueries: [], baseline: [], combined: [], primaryCount: 0,
  };
  if (expectedModel) {
    result.nativeLink = new URL('/models/' + expectedModel + (target.kind === 'version' ? '?modelVersionId=' + target.id : ''), origin).href;
  }
  const directLookup = ['image', 'post'].includes(target.kind);
  if (directLookup && !result.related.audio.length) {
    try {
      const page = await readGalleryPage(context, { ...result.gallery.plan, type: 'video' }, { ...options, limit: 8 });
      result.related.audio = page.items.filter(item => item.stream && (target.kind === 'image' ? item.id === target.id : item.postId === target.id))
        .map(item => ({ ...item, category: 'Linked video', tags: [] }));
    } catch (error) {
      signal?.throwIfAborted();
      flows.push({ label: 'Linked video examples', status: error.status ?? null });
    }
  }
  const seen = new Set(result.related.audio.map(item => item.id));
  result.related.audioExamples = examples.flat().concat(supplements).filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  result.related.audioTools = candidates.map((item, index) => {
    const cover = item.versionImages.find(image => image?.type === 'image' && !image.needsReview && !image.blockedFor &&
      visibleRating(image.browsingLevel ?? image.nsfwLevel, ceiling));
    return {
      title: item.model, category: item.type.toLowerCase().includes('workflow') ? 'Audio workflow' : 'Audio model',
      description: [item.base, item.creator && 'by ' + item.creator, item.version].filter(Boolean).join(' · '),
      preview: previewUrl(cover?.url) ?? examples[index]?.[0]?.preview,
      link: new URL('/models/' + item.modelId + '?modelVersionId=' + item.id, origin).href,
    };
  });
  result.flows.push(...flows);
  return result;
}

export async function discover3D(context, target, options) {
  const { origin, hosted } = context;
  const ceiling = hosted ? context.browsingLevel ?? 1 : 31;
  const nativeLink = new URL('/3d-models' + (target.kind === 'asset3d' ? '/' + target.id : ''), origin).href;
  const flows = [];
  const result = {
    target, scope: 'assets3d', nativeLink, related: { assets3d: [] }, reference: null, candidates: [],
    shortlisted: [], guides: [], flows, alternateQueries: [], baseline: [], combined: [],
  };
  if (target.kind === 'asset3d') return result;

  async function read(label, operation) {
    try {
      const data = await operation();
      flows.push({ label, status: 200 });
      return data;
    } catch (error) {
      options.signal?.throwIfAborted();
      flows.push({ label, status: error.status });
      return null;
    }
  }
  function typedCollection(entry) {
    if (entry?.type !== 'Model3D' || entry.read !== 'Public') return null;
    const card = collectionResult(origin, entry, ceiling);
    return card && { ...card, category: '3D collection' };
  }
  if (target.kind === 'collection') {
    const entry = await read('Exact collection', async () =>
      (await catalogRead(origin, CATALOG.collections + '/' + target.id, {}, options)).data);
    const card = entry?.id === target.id && typedCollection(entry);
    if (card) result.related.assets3d.push(card);
    return result;
  }
  if (target.kind !== 'text' && target.kind !== 'tag') return result;
  const input = text(target.value, 100);
  const broad = !input || /^(?:3[- ]?d(?: (?:assets|models|collections))?)$/iu.test(input);
  const [site, native] = await Promise.all([
    read('Site collections', async () => (await catalogRead(origin, CATALOG.collections, {
      query: broad ? '3D' : input, nsfw: true, limit: 24,
    }, options)).data),
    read('Civitai’s typed collection search', async () => (await siteSearch(origin, [{
      indexUid: NATIVE_COLLECTIONS_INDEX, q: broad ? '' : input, limit: 20, filter: 'type = "Model3D"',
      ...(broad ? { sort: ['id:desc'] } : {}),
      attributesToRetrieve: ['id', 'name', 'type', 'read', 'nsfwLevel', 'metrics', 'image'],
    }], options))[0].hits),
  ]);
  const cards = new Map();
  for (const hit of native ?? []) {
    const levels = Array.isArray(hit?.nsfwLevel) ? hit.nsfwLevel : [hit?.nsfwLevel];
    if (!levels.length || !levels.every(level => visibleRating(level, ceiling))) continue;
    const card = typedCollection({
      ...hit, isPublic: hit.read === 'Public', nsfwLevel: levels.reduce((bits, level) => bits | level, 0),
      itemCount: hit.metrics?.itemCount, coverImage: hit.image,
    });
    if (card) cards.set(hit.id, card);
  }
  for (const entry of listItems(site)) {
    const card = typedCollection(entry);
    if (card) cards.set(entry.id, { ...card, preview: card.preview ?? cards.get(entry.id)?.preview });
  }
  result.related.assets3d = [...cards.values()].slice(0, 16);
  return result;
}
