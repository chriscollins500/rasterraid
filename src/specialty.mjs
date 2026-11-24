import {
  CATALOG, catalogRead, listItems, numericId, previewUrl, siteSearch, text, visibleRating,
} from './catalog.mjs';
import { filterOptions } from './filter-options.mjs';
import { discoverGallery, readGalleryPage } from './gallery.mjs';
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

export async function discoverAudio(context, target, filters, options, { rankVersions, queryVariants }) {
  const { origin, hosted, token } = context;
  const { signal } = options;
  const ceiling = hosted ? context.browsingLevel ?? 1 : 31;
  const families = filters.audioFamilies ?? audioFamilies();
  const galleryTask = discoverGallery(context, target, filters, options);
  const flows = [];
  const appModels = hosted ? CATALOG.blockModels : CATALOG.models;
  const exact = target.kind === 'model' || target.kind === 'version';
  const thematic = target.kind === 'text' || target.kind === 'tag';
  const handle = thematic ? /^@([\p{L}\p{N}_-]{1,80})(?:\s+(.*))?$/u.exec(target.value) : null;
  const query = thematic ? text(handle ? handle[2] : target.value, 120) : '';
  const localized = translateCatalogTerms(query)?.focus;
  const modelParams = { baseModels: families, limit: 12, ...(hosted ? {} : { nsfw: true }) };

  async function models(label, route, params) {
    try {
      const { data, status } = await catalogRead(origin, route, params, { ...options, token });
      flows.push({ label, status });
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      flows.push({ label, status: error.status });
      return null;
    }
  }

  async function lookup() {
    if (!families.length || (hosted && !token) || (!thematic && !exact)) return [];
    if (exact) {
      const model = target.kind === 'model' ? await models('Exact model', '/api/v1/models/' + target.id) : null;
      const ids = target.kind === 'version' ? [target.id]
        : versionsOf(model).filter(version => families.includes(version?.baseModel)).map(version => version.id).filter(numericId).slice(0, 6);
      if (!ids.length) return [];
      const found = hosted
        ? listItems(await models('Exact audio versions', appModels, { modelVersionIds: ids.join(','), limit: ids.length }))
        : target.kind === 'model' ? [model] : await Promise.all(ids.map(async id => {
          const version = await models('Exact audio version', '/api/v1/model-versions/' + id);
          return version && { id: version.modelId, name: version.model?.name, type: version.model?.type, modelVersions: [version] };
        }));
      const expectedModel = target.modelId ?? (target.kind === 'model' ? target.id : null);
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
      const route = handle ? CATALOG.models : appModels;
      const params = { ...modelParams, query: q, username: handle?.[1], ...(handle ? { nsfw: true } : {}) };
      let found = listItems(await models(label, route, params));
      if (handle) found = found.filter(model => foldSearchText(model.creator?.username ?? '') === foldSearchText(handle[1]));
      if (hosted && handle && found.length) {
        const authors = new Set(found.map(model => model.id));
        const ids = found.flatMap(versionsOf)
          .filter(version => families.includes(version?.baseModel)).map(version => version.id).filter(numericId).slice(0, 12);
        found = ids.length ? listItems(await models('Check creator’s audio versions', appModels, { modelVersionIds: ids.join(','), limit: ids.length }))
          .filter(model => authors.has(model.id)).map(model => ({
            ...model, modelVersions: versionsOf(model).filter(version => ids.includes(version?.id)),
          })) : [];
      }
      return { label, query: q, recovery: Boolean(index && q === localized), models: found };
    }));
  }

  const rank = lists => rankVersions(lists.map(list => ({ ...list, models: list.models.map(model => ({
    ...model, modelVersions: versionsOf(model).filter(version => families.includes(version?.baseModel)),
  })) })), query, {}, 5);
  let candidates = rank(await lookup());
  // A genre can appear in an example's prompt without appearing in the name
  // of its model. Sample a bounded number of audio versions when names miss.
  const required = clipTerms(localized ?? query).slice(0, 6);
  const matchPrompt = Boolean(!candidates.length && required.length && !handle && thematic && flows.length &&
    flows.every(flow => flow.status === 200));
  if (matchPrompt) {
    candidates = rank([{ label: 'Audio catalog sample', models: listItems(await models('Audio catalog sample', appModels, modelParams)) }]);
  }

  const examples = await Promise.all(candidates.slice(0, 4).map(async candidate => {
    const { id, modelId, model, version } = candidate;
    const source = new URL('/models/' + modelId + '?modelVersionId=' + id, origin).href;
    try {
      const page = await readGalleryPage(context, {
        type: 'video', modelVersionId: id, sort: filters.mediaSort || 'Most Reactions', tags: [], withMeta: true,
        username: handle?.[1],
      }, { ...options, limit: matchPrompt ? 5 : 3 });
      return page.items.filter(item => item.stream &&
        (!handle || foldSearchText(item.creator) === foldSearchText(handle[1])) &&
        (!matchPrompt || required.every(word => clipTerms(item.prompt).includes(word))))
        .slice(0, 2).map(item => ({
          ...item, title: item.creator ? 'Music example by ' + item.creator : 'Music example',
          category: 'Video example', description: item.prompt, tags: [], source, sourceTitle: [model, version].filter(Boolean).join(' · '),
        }));
    } catch (error) {
      signal?.throwIfAborted();
      flows.push({ label: 'Music examples for version ' + id, status: error.status ?? null });
      return [];
    }
  }));

  const result = await galleryTask;
  const directLookup = ['image', 'post'].includes(target.kind);
  if (directLookup && !result.related.audio.length) {
    try {
      const page = await readGalleryPage(context, { ...result.gallery.plan, type: 'video' }, { ...options, limit: 8 });
      result.related.audio = page.items.filter(item => item.stream).map(item => ({ ...item, category: 'Linked video', tags: [] }));
    } catch (error) {
      signal?.throwIfAborted();
      flows.push({ label: 'Linked video examples', status: error.status ?? null });
    }
  }
  const seen = new Set(result.related.audio.map(item => item.id));
  result.related.audioExamples = examples.flat().filter(item => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
  result.related.audioTools = matchPrompt ? [] : candidates.map((item, index) => {
    const cover = item.versionImages.find(image => image?.type === 'image' && visibleRating(image.browsingLevel ?? image.nsfwLevel, ceiling));
    return {
      title: item.model, category: item.type.toLowerCase().includes('workflow') ? 'Audio workflow' : 'Audio model',
      description: [item.base, item.creator && 'by ' + item.creator, item.version].filter(Boolean).join(' · '),
      preview: previewUrl(cover?.url) ?? examples[index]?.[0]?.preview,
      link: new URL('/models/' + item.modelId + '?modelVersionId=' + item.id, origin).href,
    };
  });
  result.flows = flows;
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
