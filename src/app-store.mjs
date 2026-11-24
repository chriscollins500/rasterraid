import { plainArticleText } from './article-sources.mjs';
import { CATALOG, catalogRead, listItems, previewUrl, text, visibleRating } from './catalog.mjs';
import { catalogOrder } from './catalog-orders.mjs';
import { foldSearchText, translateCatalogTerms } from './query-language.mjs';

const slugPattern = /^[a-z\d][a-z\d-]{0,63}$/u;
const categoryPattern = /^[a-z][a-z\d-]{0,63}$/u;
const listingPath = /^\/apps\/(?:store-preview|run)\/([a-z\d][a-z\d-]{0,63})\/?$/u;
const kinds = { onsite: 'Runs on Civitai', offsite: 'External app' };
const ratings = { g: 1, pg: 1, pg13: 2, r: 4, x: 8, xxx: 16 };
const pageSize = 50;
const queryPages = 3;
const commonWords = new Set(['a', 'an', 'and', 'app', 'apps', 'find', 'for', 'in', 'me', 'of', 'on', 'show', 'the', 'to', 'with']);

const normalize = value => foldSearchText(text(value, 360)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const storeCursor = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/u.test(value) ? value : null;
const ceilingFor = context => context.hosted ? context.browsingLevel ?? 1 : 31;
export const appCategoryLabel = value => value.replace(/(^|-)([a-z])/gu, (_, prefix, char) => (prefix ? ' ' : '') + char.toUpperCase());

export function appReference(url) {
  const match = listingPath.exec(url.pathname);
  if (match && !url.search && !url.hash) return { kind: 'app', slug: match[1] };
  return null;
}

export function isAppStoreNavigation(url) {
  if (appReference(url)) return true;
  if (url.hash || url.pathname !== '/apps/store') return false;
  const params = {
    query: value => value.length <= 160,
    kind: value => Object.hasOwn(kinds, value),
    category: value => categoryPattern.test(value),
    sort: value => Boolean(catalogOrder('apps', value)),
  };
  return [...url.searchParams].every(([key, value]) =>
    Object.hasOwn(params, key) && url.searchParams.getAll(key).length === 1 && params[key](value));
}

function detailLink(origin, slug) {
  return new URL('/apps/store-preview/' + slug, origin).href;
}

function storeLink(origin, plan) {
  const url = new URL('/apps/store', origin);
  for (const key of ['query', 'kind', 'category', 'sort']) {
    if (plan[key]) url.searchParams.set(key, plan[key]);
  }
  return url.href;
}

function appCard(row, context, exact = false) {
  if (!slugPattern.test(row?.slug ?? '') || !Object.hasOwn(kinds, row.kind) ||
      !Object.hasOwn(ratings, row.contentRating) || !visibleRating(ratings[row.contentRating], ceilingFor(context))) return null;
  const title = text(row.name, 160);
  if (!title) return null;
  const category = categoryPattern.test(row.category ?? '') ? row.category : '';
  const byline = text(row.creator?.username, 80);
  const link = detailLink(context.origin, row.slug);
  const reviewCount = Number.isSafeInteger(row.reviewCount) && row.reviewCount > 0 ? row.reviewCount : null;
  return {
    id: row.slug, title, appCategory: category,
    category: [kinds[row.kind], category && appCategoryLabel(category)].filter(Boolean).join(' · '),
    description: text(row.tagline, 180),
    summary: (exact && plainArticleText(row.description, 520)) ||
      [byline && 'by ' + byline, reviewCount && reviewCount + (reviewCount === 1 ? ' review' : ' reviews')].filter(Boolean).join(' · '),
    preview: previewUrl(row.coverUrl) ?? previewUrl(row.iconUrl), previewBadge: 'App artwork', link,
    ...(exact ? { actions: [{ label: 'Browse the App Store', link: storeLink(context.origin, {}) }] }
      : { lookup: { label: 'Preview listing', scope: 'apps', link } }),
  };
}

function titleRank(item, query) {
  const title = normalize(item.title);
  const slug = normalize(item.id);
  if (title === query || slug === query) return 100;
  if (title.startsWith(query)) return 35;
  if (title.includes(query) || slug.includes(query)) return 25;
  const terms = query.split(' ').filter(word => !commonWords.has(word));
  if (!terms.length) return 0;
  const titleWords = (title + ' ' + slug).split(' ');
  const allWords = (title + ' ' + slug + ' ' + normalize(item.description + ' ' + item.summary)).split(' ');
  if (!terms.every(term => allWords.some(word => word === term || (term.length >= 4 && word.startsWith(term))))) return 0;
  return 1 + terms.filter(term => titleWords.includes(term)).length;
}

async function appListings(context, plan, cursor, options) {
  const { data } = await catalogRead(context.origin, CATALOG.apps, {
    kind: plan.kind, category: plan.category, sort: plan.sort ?? 'popular', cursor, limit: pageSize,
  }, options);
  return data;
}

export async function readAppStorePage(context, plan, options = {}) {
  const { cursor, excluded, facets, signal, maxPages = queryPages } = options;
  if (cursor && !storeCursor(cursor)) throw new TypeError('Invalid App Store continuation.');
  const found = new Map();
  const categories = new Set();
  const originals = [normalize(plan.query), normalize(plan.translated)].filter(Boolean);
  const filtered = plan.kind || plan.category;
  const otherCategories = facets && filtered
    ? appListings(context, {}, null, options).then(data => ({ data }), () => ({}))
    : null;
  let nextCursor = cursor ?? null;
  let partial = false;
  const cursors = new Set([nextCursor]);
  const limit = originals.length ? Math.min(queryPages, maxPages) : 1;
  for (let page = 0; page < limit; page++) {
    let data;
    try {
      data = await appListings(context, plan, nextCursor, options);
    } catch (error) {
      signal?.throwIfAborted();
      const unfiltered = (await otherCategories)?.data;
      if (!page && (!unfiltered || error.status !== 400 || !plan.category)) throw error;
      partial = true;
      break;
    }
    for (const row of listItems(data)) {
      const card = appCard(row, context);
      if (!card) continue;
      if (card.appCategory && !filtered) categories.add(card.appCategory);
      if ((plan.kind && row.kind !== plan.kind) || (plan.category && row.category !== plan.category) ||
          excluded?.has(card.id) || found.has(card.id)) continue;
      const rank = originals.length ? Math.max(...originals.map((query, index) => titleRank(card, query) * (index ? 1 : 2))) : 1;
      if (rank) found.set(card.id, { card, rank });
    }
    nextCursor = storeCursor(data.metadata?.nextCursor);
    if (cursors.has(nextCursor)) nextCursor = null;
    if (!nextCursor) break;
    cursors.add(nextCursor);
  }
  const unfiltered = (await otherCategories)?.data;
  for (const row of listItems(unfiltered)) {
    const card = appCard(row, context);
    if (card?.appCategory) categories.add(card.appCategory);
  }
  signal?.throwIfAborted();
  const choices = [...categories].sort((a, b) => a.localeCompare(b));
  const choicesPartial = filtered ? Boolean(storeCursor(unfiltered?.metadata?.nextCursor)) : Boolean(nextCursor || partial);
  return {
    items: (plan.sort ? [...found.values()] : [...found.values()].sort((a, b) => b.rank - a.rank)).map(({ card }) => card),
    nextCursor, partial, facets: !filtered || unfiltered ? { appCategory: choices } : undefined, facetsPartial: choicesPartial,
  };
}

export async function discoverAppStore(context, target, filters, options) {
  const query = text(target.value, 160);
  const translated = translateCatalogTerms(query)?.focus;
  const kind = Object.hasOwn(kinds, filters.appKind) ? filters.appKind : undefined;
  const category = categoryPattern.test(filters.appCategory ?? '') ? filters.appCategory : undefined;
  const sort = catalogOrder('apps', filters.catalogSort)?.site;
  const plan = { query, translated, kind, category, sort };
  const result = { scope: 'apps', target, related: { apps: [] }, reference: null, candidates: [], shortlisted: [],
    flows: [], alternateQueries: translated && translated !== query ? [translated] : [], baseline: [], combined: [],
    nativeLink: storeLink(context.origin, plan) };
  try {
    if (target.kind === 'app') {
      result.nativeLink = detailLink(context.origin, target.slug);
      const { data } = await catalogRead(context.origin, CATALOG.apps + '/' + target.slug, {}, options);
      const card = data.slug === target.slug ? appCard(data, context, true) : null;
      if (card) {
        result.related.apps = [card];
        result.directoryTitle = card.title;
      }
      return result;
    }
    const page = await readAppStorePage(context, plan, { ...options, facets: true });
    result.related.apps = page.items;
    result.directory = { scope: 'apps', plan, nextCursor: page.nextCursor };
    result.directoryFacets = page.facets;
    result.directoryFacetsPartial = page.facetsPartial;
    if (page.partial) result.flows.push({ label: 'Civitai App Store', status: null });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error.status !== 404) result.flows.push({ label: 'Civitai App Store', status: error.status ?? null });
  }
  return result;
}
