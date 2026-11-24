import { CATALOG, CatalogError, catalogRead, listItems, mediaUrl, numericId, previewUrl, SITE_ORIGINS, siteSearch, siteTagFacets, text, visibleRating } from './catalog.mjs';
import { describeMediaQuery, descriptiveMediaRoutes, filterMediaExclusions, rankMediaMatches } from './gallery-relevance.mjs';
import { foldSearchText, translateCatalogTerms } from './query-language.mjs';
import { NATIVE_MODELS_INDEX } from './runtime-config.mjs';
import { editDistance, protectedReference } from './text-assist.mjs';
import { readPublishedSetup } from './gallery-setup.mjs';

export const isGalleryScope = scope => ['gallery', 'videos', 'audio', 'posts'].includes(scope);
export const isVisualGalleryScope = scope => scope === 'gallery' || scope === 'videos';
export const galleryCreator = value => text(value, 81).replace(/^@/u, '').trim();
export const galleryCreatorPattern = /^[\p{L}\p{N}_-]{1,80}$/u;
export const galleryBaseModels = value => [...new Set((Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
  .map(name => typeof name === 'string' ? name.trim() : '').filter(name => name && text(name, 100) === name))];
const sortOrders = new Set(['Newest', 'Oldest', 'Most Reactions', 'Most Comments', 'Most Collected']);
const galleryPeriodPattern = /^[A-Z][A-Za-z0-9]{0,29}$/u;
export const gallerySourceFilters = Object.freeze({ modelId: 'mediaModelId', modelVersionId: 'mediaModelVersionId', postId: 'mediaPostId' });
const galleryRelationFields = Object.keys(gallerySourceFilters);
const galleryId = value => typeof value === 'string' && /^[1-9]\d{0,14}$/u.test(value);
const filler = new Set(['a', 'an', 'and', 'find', 'for', 'from', 'i', 'images', 'in', 'like', 'looking', 'me', 'of', 'please', 'show', 'some', 'the', 'to', 'videos', 'with']);
const phrase = value => (foldSearchText(text(value, 160)).match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
export const tagRecord = value => numericId(value?.id) && text(value.name, 80) ? { id: value.id, name: text(value.name, 80) } : null;

export function galleryTagIds(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return [];
  const values = value.split(',');
  return values.every(galleryId) ? [...new Set(values.map(Number))] : [];
}

export function gallerySourceIds(filters) {
  return Object.fromEntries(Object.entries(gallerySourceFilters).flatMap(([key, name]) =>
    galleryId(filters[name]) ? [[key, Number(filters[name])]] : []));
}

export function sampleMediaByPost(items, limit) {
  const posts = new Set();
  const first = [];
  const rest = [];
  for (const item of items) {
    const post = item.postId ?? null;
    if (posts.has(post)) rest.push(item);
    else {
      posts.add(post);
      first.push(item);
    }
  }
  return [...first, ...rest].slice(0, limit);
}

export function extractReferenceVersions(image) {
  // Keep the catalog association and the picture's reported resources separate.
  const meta = image?.meta?.meta ?? image?.meta;
  const recorded = ['civitaiResources', 'resources'].flatMap(key => Array.isArray(meta?.[key]) ? meta[key] : []);
  return {
    associated: [...new Set((Array.isArray(image?.modelVersionIds) ? image.modelVersionIds : []).filter(numericId))],
    recorded: [...new Set(recorded.map(item => item?.modelVersionId ?? item?.versionId).filter(numericId))],
  };
}

async function findTags(origin, queries, exactNames, options) {
  const terms = queries.map(q => ({
    indexUid: NATIVE_MODELS_INDEX, q, limit: 8, attributesToRetrieve: ['tags'],
  }));
  const direct = exactNames.map(name => ({
    indexUid: NATIVE_MODELS_INDEX, q: '', limit: 3, attributesToRetrieve: ['tags'],
    filter: ['tags.name = ' + JSON.stringify(name)],
  }));
  let results;
  try {
    results = await siteSearch(origin, [...terms, ...direct], options);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error.status !== 400 || !direct.length || !terms.length) throw error;
    results = await siteSearch(origin, terms, options);
  }
  const tags = new Map();
  for (const [index, result] of results.entries()) {
    const exact = exactNames[index - terms.length];
    for (const hit of result.hits) {
      for (const candidate of Array.isArray(hit?.tags) ? hit.tags : []) {
        const tag = tagRecord(candidate);
        if (tag && (!exact || phrase(tag.name) === exact) && !tags.has(tag.id)) tags.set(tag.id, tag);
      }
    }
  }
  return [...tags.values()];
}

async function recoverMediaTag(origin, word, tags, options) {
  const key = phrase(word);
  const prefix = key.slice(0, Math.max(3, Math.min(5, Math.floor(key.length / 2))));
  let facets;
  try {
    facets = await siteTagFacets(origin, prefix, options);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error.status === 429) throw error;
    const { data } = await catalogRead(origin, CATALOG.tags, { query: prefix, limit: 100 }, options);
    facets = listItems(data).map(row => ({ name: row?.name, count: 0 }));
  }
  const nearby = new Map();
  for (const row of [...tags.map(tag => ({ name: tag.name, count: 0 })), ...facets]) {
    const name = phrase(row.name);
    if (!/^\p{L}{5,35}$/u.test(name) || name[0] !== key[0] || editDistance(key, name) !== 1) continue;
    if (!nearby.has(name) || row.count > nearby.get(name)) nearby.set(name, row.count);
  }
  const ranked = [...nearby].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return {};
  const names = ranked.slice(0, 3).map(([name]) => name);
  const known = tags.filter(tag => names.includes(phrase(tag.name)));
  const missing = names.filter(name => !known.some(tag => phrase(tag.name) === name));
  const verified = missing.length ? [...known, ...await findTags(origin, [], missing, options)] : known;
  const choices = names.flatMap(name => verified.filter(tag => phrase(tag.name) === name));
  const [first, second] = ranked;
  const certain = !second || first[1] >= 8 && first[1] >= 8 * second[1];
  const preferred = choices.filter(tag => phrase(tag.name) === first[0]);
  return certain && preferred.length === 1 ? { correction: preferred[0] } : { suggestions: choices.slice(0, 3) };
}

function matchTags(needle, tags) {
  const query = ' ' + phrase(needle) + ' ';
  const seen = new Set();
  const candidates = tags.map(tag => ({ ...tag, key: phrase(tag.name) })).filter(tag => tag.key && query.includes(' ' + tag.key + ' '));
  candidates.sort((a, b) => b.key.length - a.key.length);
  const picked = [];
  const used = new Set();
  for (const { id, name, key } of candidates) {
    const parts = key.split(' ');
    if (seen.has(id) || parts.some(word => used.has(word))) continue;
    picked.push({ id, name });
    seen.add(id);
    parts.forEach(word => used.add(word));
    if (picked.length === 3) break;
  }
  return picked;
}

function mediaCard(row, requestedType, origin, ceiling, requiredTags, tags) {
  const level = row?.browsingLevel ?? row?.nsfwLevel;
  const type = row?.type;
  if (!numericId(row?.id) || row.needsReview || row.blockedFor || !['image', 'video', 'audio'].includes(type) ||
      (requestedType && type !== requestedType) || !visibleRating(level, ceiling)) return null;
  if (requiredTags.some(id => !tags.some(tag => tag.id === id))) return null;
  const video = type === 'video';
  const audio = type === 'audio';
  const source = mediaUrl(row.url);
  const path = source ? new URL(source).pathname : '';
  const stream = (video && /\.(?:mp4|webm)$/iu.test(path) ||
    audio && /\.(?:mp3|mp4|m4a|aac|wav|ogg|oga|opus|flac|webm)$/iu.test(path)) ? source : null;
  const creator = text(row.username, 80);
  const kind = video ? 'Video' : audio ? 'Audio' : 'Image';
  const prompt = text(row.meta?.meta?.prompt ?? row.meta?.prompt, 160);
  return {
    id: row.id, postId: numericId(row.postId), video, audio, stream, creator, prompt, url: audio || video ? null : source,
    ...(video && { width: numericId(row.width), height: numericId(row.height) }),
    preview: audio || video ? mediaUrl(row.thumbnail?.url ?? row.thumbnail) : previewUrl(source),
    title: text(row.meta?.title, 96) || (creator ? kind + ' by ' + creator : 'Gallery ' + kind.toLowerCase()),
    description: text(row.baseModel, 80),
    tags: tags.slice(0, 8),
    link: new URL('/images/' + row.id, origin).href,
  };
}

export function applyNativeGalleryFilters(url, plan, sort, tagIds = []) {
  if (!url) return;
  for (const base of galleryBaseModels(plan.baseModels)) url.searchParams.append('baseModels', base);
  if (plan.period) {
    url.searchParams.set('period', plan.period);
    url.searchParams.set('periodMode', 'published');
  }
  if (sortOrders.has(sort)) url.searchParams.set('sort', sort);
  if (plan.username) url.searchParams.set('username', plan.username);
  for (const key of galleryRelationFields) {
    if (numericId(plan[key])) url.searchParams.set(key, plan[key]);
  }
  for (const id of tagIds) url.searchParams.append('tags', id);
}

export function isNativeGalleryNavigation(url) {
  return ['/images', '/videos'].includes(url.pathname) && !url.hash && url.href.length <= 4096 && validGalleryParameters(url);
}

function validGalleryParameters(url) {
  const validators = {
    query: value => value.length <= 500 && !/\p{Cc}/u.test(value),
    username: value => galleryCreatorPattern.test(value),
    sort: value => sortOrders.has(value),
    period: value => galleryPeriodPattern.test(value),
    periodMode: value => value === 'published' && url.searchParams.has('period'),
    baseModels: value => galleryBaseModels(value)[0] === value && !/[,\p{Cc}]/u.test(value),
    tags: galleryId,
    similarTo: value => url.pathname === '/images' && galleryId(value),
    ...Object.fromEntries(galleryRelationFields.map(key => [key, galleryId])),
  };
  return [...url.searchParams].every(([key, value]) => Object.hasOwn(validators, key) && validators[key](value) &&
    (key === 'baseModels' || key === 'tags' || url.searchParams.getAll(key).length === 1));
}

const tracking = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);
const nativeOnly = new Map([
  ['collectionId', 'a collection feed'], ['collectionTagId', 'a collection feed'], ['hubId', 'a hub feed'],
  ['followed', 'an account filter'], ['hidden', 'an account filter'], ['excludeOwn', 'an account filter'],
  ['requiringMeta', 'a Civitai moderation filter'], ['notPublished', 'a Civitai moderation filter'],
  ['pendingReviewOnly', 'a Civitai moderation filter'], ['jumpTo', 'a fixed month'], ['remixOfId', 'remix ancestry'],
]);

export function readNativeGallerySearch(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  url.pathname = url.pathname.replace(/\/$/u, '');
  if (!SITE_ORIGINS.includes(url.origin) || !['/images', '/videos'].includes(url.pathname)) return null;
  const failure = reason => ({ origin: url.origin, reason });
  if (url.username || url.password || url.hash || url.href.length > 4096) return failure('an unsupported address');
  const params = url.searchParams;
  for (const key of tracking) params.delete(key);
  const scope = url.pathname === '/videos' ? 'videos' : 'gallery';
  if (params.has('types')) {
    const types = params.getAll('types');
    if (types.length !== 1 || types[0] !== (scope === 'videos' ? 'video' : 'image')) return failure('a different or mixed media type');
    params.delete('types');
  }
  if (params.has('view')) {
    const views = params.getAll('view');
    if (views.length !== 1 || views[0] !== 'feed') return failure('a different Civitai gallery view');
    params.delete('view');
  }
  for (const key of params.keys()) if (nativeOnly.has(key)) return failure(nativeOnly.get(key));
  const period = params.get('period');
  if (params.get('periodMode') === 'stats' || period && period !== 'AllTime' && params.get('periodMode') !== 'published') {
    return failure('a time window without a posted-date filter');
  }
  if (!validGalleryParameters(url)) return failure('a filter RasterRaid cannot import');
  const words = params.get('query') ?? '';
  const similarTo = params.get('similarTo');
  if (words.length > 160 || words && (words.trim() !== words || protectedReference(words) || /^[@]/u.test(words) || similarTo)) {
    return failure('a search phrase RasterRaid cannot preserve');
  }
  const filters = { scope, query: similarTo ? new URL('/images?similarTo=' + similarTo, url.origin).href : words };
  for (const [field, data] of Object.entries({ mediaSort: params.get('sort'), mediaPeriod: period === 'AllTime' ? '' : period,
    mediaCreator: params.get('username'), mediaBaseModels: galleryBaseModels(params.getAll('baseModels')).join(','),
    mediaTags: galleryTagIds(params.getAll('tags').join(',')).join(','),
    ...Object.fromEntries(Object.entries(gallerySourceFilters).map(([key, field]) => [field, params.get(key)])),
  })) if (data) filters[field] = data;
  return { origin: url.origin, filters };
}

const imageTags = row => (Array.isArray(row?.tags) ? row.tags : []).map(tagRecord).filter(Boolean);
const publishedPrompt = row => row.meta?.meta?.prompt ?? row.meta?.prompt;

async function readGalleryBatch(context, plan, { cursor, signal, fetcher, limit = 24, describe = false }) {
  const { origin, hosted, token } = context;
  const appCatalog = hosted && Boolean(token);
  const ceiling = hosted ? context.browsingLevel ?? 1 : 31;
  const { type, tags, requiredTags = [], hasPublishedPrompt, exampleSource, ...params } = plan;
  const selectedTags = [...new Set([...requiredTags, ...tags])];
  const baseModels = new Set(galleryBaseModels(params.baseModels));
  const creator = params.username?.toLowerCase();
  const { data } = await catalogRead(origin, appCatalog ? CATALOG.blockImages : CATALOG.images, {
    ...params, type, cursor, tags: selectedTags.join(','), limit, withTags: true,
    ...(hasPublishedPrompt && { withMeta: true }),
    ...(appCatalog ? {} : { browsingLevel: ceiling }),
  }, { token, signal, fetcher });
  const next = data.metadata?.nextCursor;
  return {
    items: listItems(data).flatMap(row => {
      const records = imageTags(row);
      const item = mediaCard(row, type, origin, ceiling, selectedTags, records);
      if (!item || creator && item.creator.toLowerCase() !== creator ||
          baseModels.size && !baseModels.has(text(row.baseModel, 100)) ||
          hasPublishedPrompt && !text(publishedPrompt(row), 160)) return [];
      if (requiredTags.length) {
        const required = new Set(requiredTags);
        const ordered = records.filter(tag => required.has(tag.id)).concat(records.filter(tag => !required.has(tag.id)));
        item.tags = ordered.slice(0, Math.max(8, requiredTags.length));
      }
      if (exampleSource || describe || hasPublishedPrompt) Object.assign(item, extractReferenceVersions(row));
      if (exampleSource) item.exampleSource = exampleSource;
      if (describe || hasPublishedPrompt) item.modelReferencesChecked = true;
      const result = type === 'image' || type === 'video' ? { ...item, browsingLevel: row.browsingLevel ?? row.nsfwLevel,
        preferenceTags: [...new Set(records.map(tag => tag.id))].slice(0, 24) } : item;
      if (!describe) return [result];
      return [{ item: result, tags: records, prompt: text(publishedPrompt(row), 2_400), title: text(row.meta?.title, 160) }];
    }),
    nextCursor: typeof next === 'string' && next && next !== cursor ? next : null,
  };
}

export async function readGalleryPage(context, plan, { cursor, signal, fetcher, limit = 24 } = {}) {
  const { ranking, exclusions, ...params } = plan;
  if (!ranking) {
    if (!exclusions?.length) return readGalleryBatch(context, params, { cursor, signal, fetcher, limit });
    const page = await readGalleryBatch(context, { ...params, withMeta: true }, { cursor, signal, fetcher, limit, describe: true });
    return { ...page, items: filterMediaExclusions(page.items, exclusions) };
  }
  const positions = [...(cursor?.positions ?? ranking.routes.map(() => null))];
  const lanes = ranking.routes.map((tags, index) => ({ tags, index, cursor: positions[index] })).filter(lane => lane.cursor !== false);
  const size = Math.max(1, Math.ceil(limit / Math.max(1, lanes.length)));
  const responses = await Promise.allSettled(lanes.map(lane => readGalleryBatch(context,
    { ...params, withMeta: true, tags: lane.tags }, { cursor: lane.cursor, signal, fetcher, limit: size, describe: true })));
  signal?.throwIfAborted();
  const errors = responses.filter(response => response.status === 'rejected');
  const throttled = errors.find(error => error.reason?.status === 429);
  if (errors.length && errors.length === responses.length) throw (throttled ?? errors[0]).reason;
  const rows = new Map();
  for (const [offset, result] of responses.entries()) {
    const { index } = lanes[offset];
    if (result.status === 'rejected') {
      const status = result.reason?.status;
      if (status >= 400 && status < 500 && ![408, 429].includes(status)) positions[index] = false;
      continue;
    }
    positions[index] = result.value.nextCursor ?? false;
    for (const row of result.value.items) if (!rows.has(row.item.id)) rows.set(row.item.id, row);
  }
  return { items: rankMediaMatches([...rows.values()], ranking),
    nextCursor: positions.some(position => position !== false) ? { positions } : null,
    partial: errors.length > 0, ...(throttled && { throttled: true }) };
}

function exactMediaRows(data, requested, origin, ceiling, { withTags = false, withSetup = false } = {}) {
  return listItems(data).flatMap(row => {
    if (!requested.delete(row?.id)) return [];
    const records = imageTags(row);
    const item = mediaCard(row, null, origin, ceiling, [], records);
    if (!item || withSetup && item.audio) return [];
    const setup = withSetup ? readPublishedSetup(row.meta) : null;
    return [{ ...item, ...extractReferenceVersions(row),
      ...(setup && { prompt: '', publishedSetup: setup, recorded: setup.recorded.map(record => record.versionId) }),
      ...(withTags && { tagCount: records.length, tags: records.slice(0, 48) }) }];
  });
}

export async function readAppMediaByIds(context, ids, { withTags = false, withSetup = false, ...options } = {}) {
  if (!context.hosted || !context.token) throw new CatalogError('Waiting for Civitai to connect gallery access.');
  const requested = new Set(ids.filter(numericId));
  if (!requested.size) return [];
  if (requested.size > 100) throw new RangeError('Check up to 100 media IDs at once.');
  const { data } = await catalogRead(context.origin, CATALOG.blockImages, {
    ids: [...requested].join(','), limit: requested.size, withMeta: true, ...(withTags && { withTags }),
  }, { ...options, privateRead: true, token: context.token });
  return exactMediaRows(data, requested, context.origin, context.browsingLevel ?? 1, { withTags, withSetup });
}

export async function readExampleMedia(context, ids, options = {}) {
  if (context.hosted && context.token) return { items: await readAppMediaByIds(context, ids, { ...options, withSetup: true }), partial: false };
  const ceiling = context.hosted ? context.browsingLevel ?? 1 : 31;
  const responses = await Promise.allSettled(ids.map(async imageId => {
    const { data } = await catalogRead(context.origin, CATALOG.images, { imageId, limit: 1, withMeta: true, browsingLevel: ceiling }, options);
    return exactMediaRows(data, new Set([imageId]), context.origin, ceiling, { withSetup: true });
  }));
  options.signal?.throwIfAborted();
  return { items: responses.flatMap(row => row.status === 'fulfilled' ? row.value : []),
    partial: responses.some(row => row.status === 'rejected') };
}

export async function readGalleryVersionParents(context, ids, options = {}) {
  const { origin, hosted, token } = context;
  const parents = new Map();
  if (!ids.length) return parents;
  if (hosted && token) {
    const { data } = await catalogRead(origin, CATALOG.blockModels, { modelVersionIds: ids.join(','), limit: ids.length }, { ...options, token });
    for (const model of listItems(data)) {
      if (!numericId(model?.id) || !Array.isArray(model.modelVersions)) continue;
      for (const version of model.modelVersions) {
        if (ids.includes(version?.id) && !parents.has(version.id)) parents.set(version.id, model.id);
      }
    }
  } else {
    const replies = await Promise.allSettled(ids.map(id => catalogRead(origin, '/api/v1/model-versions/' + id, {}, options)));
    options.signal?.throwIfAborted();
    if (replies.every(row => row.status === 'rejected')) throw replies[0].reason;
    for (const [index, reply] of replies.entries()) {
      if (reply.status !== 'fulfilled') continue;
      const { data } = reply.value;
      if (data?.id !== ids[index] || !numericId(data.modelId)) continue;
      if (hosted && (data.status !== 'Published' || data.availability && data.availability !== 'Public' ||
          !visibleRating(data.browsingLevel ?? data.nsfwLevel, context.browsingLevel ?? 1))) continue;
      parents.set(data.id, data.modelId);
    }
  }
  return parents;
}

async function checkGalleryRelease(context, modelId, versionId, options) {
  const parentId = (await readGalleryVersionParents(context, [versionId], options)).get(versionId);
  return !numericId(parentId) ? 'source-unavailable' : parentId === modelId ? 'ready' : 'source-conflict';
}

export async function prepareGallery(context, target, filters, options = {}) {
  const { origin } = context;
  const scope = filters.scope;
  const galleryUrl = scope === 'audio' ? null : new URL('/' + ({ posts: 'posts', videos: 'videos' }[scope] ?? 'images'), origin);
  const mediaType = { audio: 'audio', videos: 'video', gallery: 'image' }[scope];
  const plan = { type: mediaType, tags: [], sort: sortOrders.has(filters.mediaSort) ? filters.mediaSort : 'Most Reactions' };
  if (mediaType === 'audio') plan.withMeta = true;
  const rateable = isVisualGalleryScope(scope);
  const gallery = { scope, status: 'ready', tags: [], plan, rateable, nextCursor: null, partial: false, nativeLink: galleryUrl?.href };
  const requiredTags = rateable ? galleryTagIds(filters.mediaTags) : [];
  const sources = rateable ? gallerySourceIds(filters) : {};
  const hasLinkedFilters = requiredTags.length > 0 || Object.keys(sources).length > 0;
  if (rateable) {
    const bases = galleryBaseModels(filters.mediaBaseModels);
    if (bases.length) plan.baseModels = bases.join(',');
    if (galleryPeriodPattern.test(filters.mediaPeriod ?? '')) plan.period = filters.mediaPeriod;
    if (filters.mediaPublishedPrompt === 'true') plan.hasPublishedPrompt = true;
    const creator = galleryCreator(filters.mediaCreator);
    if (galleryCreatorPattern.test(creator)) plan.username = creator;
    if (requiredTags.length) plan.requiredTags = requiredTags;
    Object.assign(plan, sources);
  }
  if (plan.username) galleryUrl?.searchParams.set('username', plan.username);

  const referenceFilter = { image: 'imageId', model: 'modelId', version: 'modelVersionId', post: 'postId' }[target.kind];
  if (referenceFilter) {
    if (plan[referenceFilter] && plan[referenceFilter] !== target.id) gallery.status = 'source-conflict';
    else plan[referenceFilter] = target.id;
  }
  // The images API gives the version selector precedence over the model selector.
  if (gallery.status === 'ready' && plan.modelId && plan.modelVersionId) {
    try {
      gallery.status = await checkGalleryRelease(context, plan.modelId, plan.modelVersionId, options);
      if (gallery.status === 'source-unavailable') gallery.failureStatus = 'unverified';
    } catch (error) {
      options.signal?.throwIfAborted();
      gallery.status = 'source-unavailable';
      gallery.failureStatus = error.status ?? null;
      if (error.status === 429) gallery.throttled = true;
    }
  }
  if (!referenceFilter && !['text', 'tag'].includes(target.kind)) gallery.status = 'unsupported';
  if (!referenceFilter && gallery.status === 'ready') {
    let query = target.value ?? '';
    const handle = /^@([\p{L}\p{N}_-]{1,80})(?:\s+(.*))?$/u.exec(query);
    if (handle) {
      query = handle[2] ?? '';
      if (plan.username && plan.username.toLowerCase() !== handle[1].toLowerCase()) {
        gallery.status = 'creator-conflict';
        return gallery;
      }
      plan.username ??= handle[1];
    }
    if (query && scope !== 'posts') galleryUrl?.searchParams.set('query', query);
    if (plan.username) galleryUrl?.searchParams.set('username', plan.username);
    gallery.query = query;
    const selected = tagRecord(filters.selectedMediaTag);
    if (selected && phrase(selected.name) === phrase(query)) {
      gallery.tags = [selected];
    } else if (query) {
      const intent = rateable && target.kind === 'text' ? describeMediaQuery(query) : null;
      const descriptive = options.rankMedia !== false && !filters.mediaSort ? intent : null;
      const positive = intent?.excluded.length ? intent.positive : query;
      const localized = translateCatalogTerms(positive)?.focus;
      const words = phrase(localized ?? positive).split(' ').filter(word => word && !filler.has(word));
      const queries = descriptive?.variants ?? [...new Set([positive, localized, ...words].filter(Boolean))].slice(0, 7);
      const literal = phrase(localized ?? positive);
      const exactNames = rateable && options.recoverTags !== false ? [...new Set([
        ...(literal.length <= 80 && literal.split(' ').length <= 3 ? [literal] : []),
        ...(descriptive?.priority ?? words),
      ].filter(name => name.length > 0 && name.length <= 80))].slice(0, 3) : [];
      try {
        const tags = await findTags(origin, queries, exactNames, options);
        const typed = rateable && target.kind === 'tag'
          ? tags.filter(tag => phrase(tag.name) === phrase(positive)).slice(0, 1)
          : matchTags(descriptive?.positive ?? positive, tags);
        gallery.tags = typed.length ? typed : matchTags(localized, tags);
        if (rateable && options.recoverTags !== false && target.kind === 'text' && !gallery.tags.length && /^\p{L}{5,35}$/u.test(positive)) {
          const recovery = await recoverMediaTag(origin, positive, tags, options);
          if (recovery.correction) {
            gallery.tags = [recovery.correction];
            gallery.correctedTag = recovery.correction.name;
          }
          if (recovery.suggestions?.length) gallery.suggestions = recovery.suggestions;
        }
        if (descriptive) {
          const ranking = descriptiveMediaRoutes(descriptive, tags, gallery.tags);
          if (ranking.routes.length) plan.ranking = { ...ranking, terms: descriptive.terms, excluded: descriptive.excluded };
        }
        if (!plan.ranking && intent?.excluded.length) plan.exclusions = intent.excluded;
        const matched = new Set(gallery.tags.flatMap(tag => phrase(tag.name).split(' ')));
        gallery.partial = !gallery.correctedTag && words.some(word => !matched.has(word));
        if (!gallery.tags.length && !plan.ranking && !hasLinkedFilters) gallery.status = 'no-tag';
      } catch (error) {
        options.signal?.throwIfAborted();
        if (hasLinkedFilters) gallery.incomplete = gallery.partial = true;
        else {
          gallery.status = 'tag-unavailable';
          gallery.failureStatus = error.status ?? null;
        }
      }
    }
    plan.tags = gallery.tags.map(tag => tag.id);
    gallery.preferenceEligible = rateable && target.kind === 'text' && !selected && !hasLinkedFilters && !filters.mediaSort &&
      Boolean(plan.ranking || plan.tags.length);
  }
  if (scope === 'posts') {
    if (plan.postId) galleryUrl.pathname += '/' + plan.postId;
    for (const key of ['modelId', 'modelVersionId']) {
      if (plan[key]) galleryUrl.searchParams.set(key, plan[key]);
    }
    for (const id of plan.tags) galleryUrl.searchParams.append('tags', id);
  } else if (rateable) {
    const explicitTag = target.kind === 'tag' || tagRecord(filters.selectedMediaTag)?.name === gallery.query;
    const tagIds = explicitTag ? [...new Set([...requiredTags, ...plan.tags])] : requiredTags;
    applyNativeGalleryFilters(galleryUrl, plan, filters.mediaSort, tagIds);
  }
  gallery.nativeLink = galleryUrl?.href;
  return gallery;
}

export async function discoverGallery(context, target, filters, options = {}) {
  const gallery = await prepareGallery(context, target, filters, options);
  const { scope, plan } = gallery;
  let items = [];
  if (gallery.status === 'ready') {
    try {
      const result = await readGalleryPage(context, plan, options);
      items = result.items;
      gallery.nextCursor = result.nextCursor;
      if (result.partial) gallery.incomplete = true;
      if (result.throttled) gallery.throttled = true;
    } catch (error) {
      options.signal?.throwIfAborted();
      gallery.status = 'gallery-unavailable';
      gallery.failureStatus = error.status ?? null;
      if (error.status === 429) gallery.throttled = true;
    }
  }
  const modelQuery = gallery.query?.split(/\s+without\s+/iu, 1)[0].trim();
  const established = Boolean(plan.ranking || gallery.tags.length) && !gallery.partial;
  if (options.resolveModel && isVisualGalleryScope(scope) && target.kind === 'text' && modelQuery && modelQuery.length <= 160 &&
      (gallery.status === 'no-tag' || gallery.status === 'ready' && (!items.length || !established && items.length < 3)) &&
      !filters.selectedMediaTag && !plan.requiredTags?.length && !galleryRelationFields.some(field => plan[field]) &&
      !gallery.correctedTag && !gallery.suggestions?.length && !gallery.incomplete) {
    options.onPhase?.('Checking for a matching model release…');
    try {
      const { releases, choices, unavailable } = await options.resolveModel(modelQuery);
      options.signal?.throwIfAborted();
      if (unavailable) gallery.incomplete = true;
      if (choices?.length) gallery.modelChoices = choices;
      if (releases?.length) {
        const { ranking, ...constraints } = plan;
        let first;
        for (const release of releases) {
          const modelPlan = { ...constraints, tags: [], modelVersionId: release.versionId, exampleSource: release,
            exclusions: ranking?.excluded ?? constraints.exclusions };
          const page = await readGalleryPage(context, modelPlan, options);
          first ??= { modelPlan, page };
          if (page.items.length || page.nextCursor) { first = { modelPlan, page }; break; }
        }
        const { modelPlan, page } = first;
        const nativeGallery = new URL(scope === 'videos' ? '/videos' : '/images', context.origin);
        applyNativeGalleryFilters(nativeGallery, modelPlan, filters.mediaSort);
        Object.assign(gallery, { status: page.items.length || page.nextCursor ? 'ready' : 'model-gallery-empty', tags: [], plan: modelPlan,
          modelSource: modelPlan.exampleSource, nativeLink: nativeGallery.href, preferenceEligible: false, nextCursor: page.nextCursor, partial: false });
        items = page.items;
      }
    } catch {
      options.signal?.throwIfAborted();
      gallery.incomplete = true;
    }
  }
  return {
    target, gallery, related: { [scope]: items }, reference: null, candidates: [], shortlisted: [],
    guides: [], flows: [], alternateQueries: [], baseline: [], combined: [], primaryCount: items.length,
  };
}
