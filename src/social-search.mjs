import { articleAnchors, articleCover, publicArticle } from './article-sources.mjs';
import { CATALOG, SITE_ORIGINS, catalogImagePreview, catalogRead, listItems, numericId, siteSearch, text, visibleRating } from './catalog.mjs';
import { discoverDirectory } from './directory.mjs';
import { prepareGallery, readGalleryPage } from './gallery.mjs';
import { foldSearchText, translateCatalogTerms } from './query-language.mjs';
import { NATIVE_COLLECTIONS_INDEX } from './runtime-config.mjs';
import { collectionResult } from './site-results.mjs';

export const socialScopes = ['hubs', 'topics', 'communities', 'reviews', 'comments'];
const hubGuide = 34441;
const maxId = 2_147_483_647;
function id(value) {
  const number = typeof value === 'string' && /^[1-9]\d{0,9}$/u.test(value) ? Number(value) : value;
  return numericId(number) && number <= maxId ? number : null;
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const key = value => foldSearchText(text(value, 160)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const topicName = value => /^[\p{L}\p{N}][\p{L}\p{N} ._()+'-]{0,79}$/u.test(value);
const ceilingFor = context => context.hosted ? context.browsingLevel ?? 1 : 31;
const reviewFilters = ['images', 'up', 'down'];
const formatCount = new Intl.NumberFormat();

const href = (origin, path) => new URL(path, origin).href;
const byCount = value => value === null || value === undefined ? ''
  : formatCount.format(value) + (value === 1 ? ' comment' : ' comments');

function topicLink(origin, name) {
  return href(origin, '/tag/' + encodeURIComponent(name));
}

function reviewLink(origin, modelId, versionId, filter) {
  const url = new URL('/models/' + modelId + '/reviews', origin);
  if (versionId) url.searchParams.set('modelVersionId', versionId);
  if (filter) url.searchParams.set('filter', filter);
  return url.href;
}

export function socialReference(url) {
  if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password) return null;
  if (url.pathname === '/hubs' && !url.search && !url.hash) return { kind: 'hub', path: '/hubs' };
  const hub = /^\/hubs\/([a-z\d]{8}|[1-9]\d{0,9})(?:\/([a-z\d][a-z\d-]{0,140}))?\/?$/iu.exec(url.pathname);
  if (hub && !url.search && !url.hash) return { kind: 'hub', key: hub[1], slug: hub[2], path: url.pathname.replace(/\/$/u, '') };

  const tag = /^\/tag\/([^/]+)\/?$/u.exec(url.pathname);
  if (tag && !url.search && !url.hash) {
    try {
      const name = decodeURIComponent(tag[1]);
      if (topicName(name)) return { kind: 'topic', value: name };
    } catch { return null; }
  }
  const reviews = /^\/models\/([1-9]\d{0,9})\/reviews\/?$/u.exec(url.pathname);
  if (reviews && id(reviews[1]) && !url.hash && [...url.searchParams].every(([field, value]) =>
    url.searchParams.getAll(field).length === 1 && (field === 'modelVersionId' ? /^[1-9]\d{0,9}$/u.test(value) && id(value)
      : field === 'filter' && reviewFilters.includes(value)))) {
    return { kind: 'modelReviews', modelId: id(reviews[1]), id: id(url.searchParams.get('modelVersionId')),
      reviewFilter: url.searchParams.get('filter') };
  }
  const comment = /^\/comments\/(?:v2\/)?([1-9]\d{0,9})\/?$/u.exec(url.pathname);
  if (id(comment?.[1]) && !url.search && !url.hash) return { kind: 'comment', id: id(comment[1]) };
  const discussion = /^\/articles\/([1-9]\d{0,9})(?:\/[^/]+)?\/?$/u.exec(url.pathname);
  if (id(discussion?.[1]) && !url.search && url.hash === '#comments') return { kind: 'articleComments', id: id(discussion[1]) };
  return null;
}

export function isSocialNavigation(url) {
  const reference = socialReference(url);
  if (reference) return true;
  return url.pathname === '/search/models' && !url.hash && [...url.searchParams].every(([field, value]) =>
    field === 'query' && url.searchParams.getAll(field).length === 1 && value.length <= 160);
}

function resultFor(scope, target, nativeLink = null) {
  return { scope, target, nativeLink, related: {}, reference: null, candidates: [], shortlisted: [], guides: [],
    flows: [], alternateQueries: [], baseline: [], combined: [] };
}

async function read(context, result, options, label, route, params = {}) {
  options.signal?.throwIfAborted();
  try {
    return (await catalogRead(context.origin, route, params, options)).data;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error.status !== 404) result.flows.push({ label, status: error.status ?? null });
    return null;
  }
}

async function articles(context, result, target, options) {
  const matches = await discoverDirectory(context, target, 'articles', {}, options);
  result.flows.push(...matches.flows);
  return matches.related.articles;
}

async function hubResults(context, result, options, query) {
  const { origin } = context;
  const { target } = result;
  result.nativeLink = href(origin, target.kind === 'hub' ? target.path : '/hubs');
  if (target.key) return;

  const intro = !query || /^(?:hubs?|how hubs work|build a feed)$/iu.test(query);
  const [guide, matches] = await Promise.all([
    intro ? articles(context, result, { kind: 'article', id: hubGuide }, options) : [],
    articles(context, result, { kind: 'text', value: intro ? 'hub' : query }, options),
  ]);
  const leads = matches.filter(card => card.id !== hubGuide && /\bhubs?\b/iu.test(card.title)).slice(0, 5);
  const records = await Promise.all(leads.map(card => read(context, result, options, 'Public hub reference', '/api/v1/articles/' + card.id)));
  const shared = new Map();
  for (const [index, row] of records.entries()) {
    if (!publicArticle(row, ceilingFor(context)) || row.id !== leads[index].id) continue;
    for (const anchor of articleAnchors(row.content)) {
      let reference;
      try { reference = socialReference(new URL(anchor.href, origin)); } catch { continue; }
      if (reference?.kind !== 'hub' || !reference.key || shared.has(reference.key)) continue;
      shared.set(reference.key, {
        id: reference.key, title: anchor.label || reference.slug?.replaceAll('-', ' ') || 'Shared hub',
        category: 'Shared hub link', description: 'Open the current image feed on Civitai.',
        link: href(origin, reference.path), source: href(origin, '/articles/' + row.id), sourceTitle: 'Source article',
        preview: articleCover(row, ceilingFor(context)), previewId: row.coverImage?.id, previewBadge: 'Source article cover',
      });
    }
  }
  result.related.hubs = [...shared.values()].slice(0, 8);
  result.related.hubGuides = guide.map(card => ({ ...card, category: 'Official hub guide', summary: '',
    description: 'Build an image feed from creators, models, and tags.' }));
}

async function publicCollections(context, result, query, options) {
  const { origin } = context;
  const ceiling = ceilingFor(context);
  const targetId = result.target.kind === 'collection' ? result.target.id : null;
  if (targetId) {
    const row = await read(context, result, options, 'Public collection', '/api/v1/collections/' + targetId);
    const card = row?.id === targetId ? collectionResult(origin, row, ceiling) : null;
    return card ? [{ ...card, id: row.id, category: 'Public collection' }] : [];
  }
  const [site, indexed] = await Promise.all([
    read(context, result, options, 'Public collections', CATALOG.collections, { query, nsfw: true, limit: 10 }),
    siteSearch(origin, [{ indexUid: NATIVE_COLLECTIONS_INDEX, q: query, limit: 8, attributesToRetrieve: ['id'] }], options)
      .catch(error => {
        options.signal?.throwIfAborted();
        result.flows.push({ label: 'Civitai collection search', status: error.status ?? null });
        return [];
      }),
  ]);
  const rows = listItems(site);
  const found = new Set(rows.map(row => row?.id));
  const extra = (indexed[0]?.hits ?? []).map(row => id(row?.id)).filter(value => value && !found.has(value) && found.add(value)).slice(0, 3);
  rows.push(...(await Promise.all(extra.map(async value => {
    const row = await read(context, result, options, 'Public collection detail', '/api/v1/collections/' + value);
    return row?.id === value ? row : null;
  }))).filter(Boolean));
  const wanted = key(query);
  return rows.flatMap(row => {
    const card = collectionResult(origin, row, ceiling);
    return card ? [{ ...card, id: row.id, category: 'Public collection', previewId: row.coverImage?.id, previewBadge: 'Collection cover' }] : [];
  }).sort((a, b) => Number(key(b.title) === wanted) - Number(key(a.title) === wanted)).slice(0, 8);
}

async function topicsAndCommunities(context, result, options, query) {
  const { origin } = context;
  const { scope, target } = result;
  if (scope === 'communities') {
    const phrase = query || 'community';
    const url = new URL('/articles', origin);
    url.searchParams.set('query', phrase);
    result.nativeLink = target.kind === 'collection' ? href(origin, '/collections/' + target.id) : url.href;
    result.nativeActions = [{ label: 'Civitai Hubs', link: href(origin, '/hubs') }];
    const [collections, matches] = await Promise.all([
      publicCollections(context, result, phrase, options),
      target.kind === 'collection' ? [] : articles(context, result, { kind: 'text', value: phrase }, options),
    ]);
    result.related.collections = collections;
    result.related.communityArticles = matches.slice(0, 8);
    return;
  }

  const phrase = translateCatalogTerms(query)?.focus ?? query;
  if (phrase && phrase !== query) result.alternateQueries.push(phrase);
  const [site, collections, gallery] = await Promise.all([
    read(context, result, options, 'Civitai tags', CATALOG.tags, { query: phrase, limit: 12 }),
    publicCollections(context, result, phrase, options),
    phrase ? prepareGallery(context, { kind: 'tag', value: phrase }, { scope: 'gallery' }, options) : null,
  ]);
  const topics = new Map();
  for (const row of [...(gallery?.tags ?? []), ...listItems(site)]) {
    const name = text(row.name, 80);
    if (topicName(name) && !topics.has(key(name))) topics.set(key(name), name);
  }
  const wanted = key(phrase);
  const lead = topics.get(wanted);
  if (target.kind === 'topic' || lead) result.nativeLink = topicLink(origin, lead ?? target.value);
  result.related.topics = [...topics.values()].sort((a, b) => Number(key(b) === wanted) - Number(key(a) === wanted)).slice(0, 8).map(name => ({
    id: key(name), title: name, category: 'Civitai tag', link: topicLink(origin, name),
    lookup: { label: 'See gallery images', link: name, scope: 'gallery' },
  }));
  result.related.collections = collections;
  if (gallery?.plan.tags.length) {
    try {
      const { items } = await readGalleryPage(context, gallery.plan, { ...options, limit: 3 });
      result.related.topicImages = items.filter(item => item.preview).map(item => ({ ...item, previewBadge: 'Gallery image' }));
    } catch { options.signal?.throwIfAborted(); }
  }
}

function modelVersions(row, ceiling) {
  if (!id(row?.id) || row.availability !== 'Public' || row.mode || !text(row.name) || !Array.isArray(row.modelVersions)) return [];
  return row.modelVersions.filter(version => id(version?.id) && visibleRating(version.nsfwLevel, ceiling) &&
    (!version.status || version.status === 'Published'));
}

function modelPreview(version, ceiling) {
  for (const image of Array.isArray(version.images) ? version.images : []) {
    const preview = catalogImagePreview(image, ceiling);
    if (preview) return { preview, previewId: image.id ?? version.id, previewBadge: 'Model example' };
  }
  return {};
}

async function feedbackModels(context, result, options, query) {
  const { origin } = context;
  const { target, scope } = result;
  const ceiling = ceilingFor(context);
  const review = scope === 'reviews';
  const exact = ['model', 'version', 'modelReviews'].includes(target.kind);
  let modelId = target.kind === 'model' ? target.id : target.modelId;
  const versionId = target.kind === 'model' ? null : target.id;
  if (target.kind === 'version' && !modelId) {
    const version = await read(context, result, options, 'Exact model version', '/api/v1/model-versions/' + versionId);
    if (version?.id === versionId) modelId = id(version.modelId);
  }
  if (exact && !modelId) return [];
  const exactModel = exact ? await read(context, result, options, 'Public model', '/api/v1/models/' + modelId) : null;
  let rows = exact ? [exactModel].filter(row => row?.id === modelId)
    : listItems(await read(context, result, options, 'Public model search', CATALOG.models,
      { query, nsfw: true, limit: 8, sort: query ? undefined : 'Most Downloaded' }));
  rows = rows.map(row => ({ row, versions: modelVersions(row, ceiling).filter(version => !exact || !versionId || version.id === versionId) }))
    .filter(entry => entry.versions.length).sort((a, b) => Number(key(b.row.name) === key(query)) - Number(key(a.row.name) === key(query)));

  return rows.flatMap(({ row, versions }) => versions.slice(0, exact && review ? 8 : 1).map(version => {
    const name = text(row.name, 155);
    const base = text(version.baseModel, 80);
    if (!review) {
      const commentCount = count(row.stats?.commentCount);
      return {
        id: row.id, title: name, category: 'Model discussion', commentCount, description: byCount(commentCount),
        ...modelPreview(version, ceiling), link: href(origin, '/models/' + row.id + '?modelVersionId=' + version.id),
      };
    }
    const up = count(version.stats?.thumbsUpCount);
    const down = count(version.stats?.thumbsDownCount);
    const versionName = text(version.name, 80);
    const filter = target.reviewFilter;
    return {
      id: version.id, title: name + (versionName ? ' · ' + versionName : ''), category: 'Model version',
      description: [base, up === null ? '' : formatCount.format(up) + ' thumbs up',
        down === null ? '' : formatCount.format(down) + ' thumbs down'].filter(Boolean).join(' · '),
      ...modelPreview(version, ceiling), link: reviewLink(origin, row.id, version.id, filter),
      actions: filter === 'images' ? [] : [{ label: 'Reviews with images', link: reviewLink(origin, row.id, version.id, 'images'),
        ariaLabel: 'Reviews with images for ' + name + (versionName ? ' ' + versionName : '') + ' on Civitai' }],
      lookup: !exact && versions.length > 1 ? { label: 'Choose a version', link: href(origin, '/models/' + row.id), scope: 'reviews' } : null,
    };
  })).slice(0, 8);
}

function articleDiscussion(origin, card) {
  return { ...card, category: 'Article discussion', description: byCount(card.commentCount) || card.description,
    summary: '', link: href(origin, '/articles/' + card.id + '#comments') };
}

async function mediaDiscussion(context, result, options) {
  const { origin } = context;
  const { target } = result;
  const ceiling = ceilingFor(context);
  if (target.kind === 'image') {
    const data = await read(context, result, options, 'Public image', CATALOG.images, { imageId: target.id, limit: 1 });
    const row = listItems(data).find(entry => entry.id === target.id && visibleRating(entry.browsingLevel, ceiling));
    if (!row) return [];
    return [{ id: row.id, title: 'Image' + (text(row.username) ? ' by ' + text(row.username, 80) : ''), category: 'Image discussion',
      description: byCount(count(row.stats?.commentCount)), preview: catalogImagePreview(row, ceiling),
      previewBadge: 'Image', link: href(origin, '/images/' + row.id) }];
  }
  const row = await read(context, result, options, 'Public post', '/api/v1/posts/' + target.id);
  if (row?.id !== target.id || !visibleRating(row.nsfwLevel, ceiling)) return [];
  const previews = Array.isArray(row.images) ? row.images : [];
  const preview = previews.map(image => catalogImagePreview({ ...image, nsfwLevel: image.browsingLevel }, ceiling)).find(Boolean);
  return [{ id: row.id, title: text(row.title, 155) || 'Post ' + row.id, category: 'Post discussion', preview,
    previewBadge: 'Post image', link: href(origin, '/posts/' + row.id) }];
}

async function feedback(context, result, options, query) {
  const { scope, target } = result;
  const { origin } = context;
  if (scope === 'reviews') {
    result.related.reviews = await feedbackModels(context, result, options, query);
    if (target.kind === 'modelReviews') result.nativeLink = reviewLink(origin, target.modelId, target.id, target.reviewFilter);
    else if (['model', 'version'].includes(target.kind)) result.nativeLink = result.related.reviews[0]?.link;
    else {
      const search = new URL('/search/models', origin);
      if (query) search.searchParams.set('query', query);
      result.nativeLink = search.href;
    }
    return;
  }
  if (target.kind === 'comment') {
    result.nativeLink = href(origin, '/comments/' + target.id);
    return;
  }
  if (['article', 'articleComments'].includes(target.kind)) {
    result.nativeLink = href(origin, '/articles/' + target.id + '#comments');
    result.related.articleDiscussions = (await articles(context, result, { kind: 'article', id: target.id }, options))
      .map(card => articleDiscussion(origin, card));
    return;
  }
  if (['image', 'post'].includes(target.kind)) {
    result.nativeLink = href(origin, '/' + target.kind + 's/' + target.id);
    result.related.mediaDiscussions = await mediaDiscussion(context, result, options);
    return;
  }
  if (['model', 'version', 'modelReviews'].includes(target.kind)) {
    result.related.modelDiscussions = await feedbackModels(context, result, options, query);
    result.nativeLink = result.related.modelDiscussions[0]?.link;
    return;
  }
  const [models, matches] = await Promise.all([
    feedbackModels(context, result, options, query),
    articles(context, result, { kind: 'text', value: query || 'community' }, options),
  ]);
  result.related.modelDiscussions = models.filter(card => card.commentCount > 0);
  result.related.articleDiscussions = matches.filter(card => card.commentCount > 0).slice(0, 8).map(card => articleDiscussion(origin, card));
}

export async function discoverSocial(context, target, scope, options = {}) {
  const result = resultFor(scope, target);
  const query = text(target.value, 120);
  if (scope === 'hubs') await hubResults(context, result, options, query);
  else if (scope === 'topics' || scope === 'communities') await topicsAndCommunities(context, result, options, query);
  else await feedback(context, result, options, query);
  return result;
}
