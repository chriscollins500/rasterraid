import { catalogImagePreview, numericId, siteSearch, text, visibleRating } from './catalog.mjs';
import { translateCatalogTerms } from './query-language.mjs';
import { NATIVE_BOUNTIES_INDEX } from './runtime-config.mjs';

const pageSize = 12;
const bountiesSort = new Map([
  ['newest', 'createdAt:desc'], ['buzz', 'stats.unitAmountCountAllTime:desc'],
  ['entries', 'stats.entryCountAllTime:desc'], ['favorites', 'stats.favoriteCountAllTime:desc'],
]);
const typeLabels = Object.freeze({
  ImageCreation: 'Image creation', VideoCreation: 'Video creation', LoraCreation: 'LoRA creation',
  ModelCreation: 'Model creation', EmbedCreation: 'Embedding creation',
  DataSetCreation: 'Dataset creation', DataSetCaption: 'Dataset captioning',
});
const queryFields = ['id', 'name', 'nsfwLevel', 'type', 'details', 'complete', 'startsAt', 'expiresAt', 'stats', 'images', 'user.username'];

export function bountyTypeLabel(value) {
  return Object.hasOwn(typeLabels, value) ? typeLabels[value] : value.replace(/([a-z])([A-Z])/gu, '$1 $2');
}

function bountyStatus(hit, now) {
  if (hit.complete === true) return 'Completed';
  const end = Date.parse(hit.expiresAt);
  if (Number.isFinite(end) && end <= now) return 'Closed';
  const start = Date.parse(hit.startsAt);
  if (Number.isFinite(start) && start > now) return 'Upcoming';
  if (hit.complete === false && Number.isFinite(start) && Number.isFinite(end)) return 'Open';
  return '';
}

function bountyResult(origin, hit, ceiling, now) {
  const name = text(hit?.name, 160);
  const levels = Array.isArray(hit?.nsfwLevel) ? hit.nsfwLevel : [hit?.nsfwLevel];
  // Civitai's bounty rating combines its examples. Its feed admits a bounty
  // with an eligible example and applies the ceiling to each image separately.
  if (!numericId(hit?.id) || !name || !levels.some(level => visibleRating(level, ceiling))) return null;
  const type = text(hit.type, 50);
  const reward = hit.stats?.unitAmountCountAllTime;
  const entries = hit.stats?.entryCountAllTime;
  const creator = text(hit.user?.username, 80);
  const base = text(hit.details?.baseModel, 80);
  const description = [creator && 'by ' + creator, base,
    Number.isSafeInteger(entries) && entries >= 0 ? entries.toLocaleString('en-US') + (entries === 1 ? ' entry' : ' entries') : '']
    .filter(Boolean).join(' · ');
  const previews = (Array.isArray(hit.images) ? hit.images : []).map(image => ({
    id: numericId(image?.id), preview: catalogImagePreview(image, ceiling),
  })).filter(image => image.id && image.preview).slice(0, 4);
  const link = new URL('/bounties/' + hit.id, origin).href;
  return {
    id: hit.id, title: name, description, category: type ? bountyTypeLabel(type) : 'Bounty',
    status: bountyStatus(hit, now), startsAt: text(hit.startsAt, 40), closesAt: text(hit.expiresAt, 40),
    reward: Number.isSafeInteger(reward) && reward >= 0 ? reward : null,
    previews: previews.map(image => ({ ...image, link, badge: 'Bounty example' })), link,
  };
}

function facetValues(data, name) {
  return Object.entries(data?.facetDistribution?.[name] ?? {}).filter(([label, count]) => text(label, 100) === label && label && count > 0)
    .map(([label]) => label).sort((a, b) => a.localeCompare(b));
}

function bountySearch(context, plan, cursor = 0, limit = pageSize) {
  const ceiling = context.hosted ? context.browsingLevel ?? 1 : 31;
  const levels = [1, 2, 4, 8, 16, 32].filter(level => visibleRating(level, ceiling));
  if (!levels.length) return null;
  const levelFilter = 'nsfwLevel IN [' + levels.join(', ') + ']';
  const filter = [levelFilter];
  if (plan.id) filter.push('id = ' + plan.id);
  if (plan.type) filter.push('type = ' + JSON.stringify(plan.type));
  if (plan.base) filter.push('details.baseModel = ' + JSON.stringify(plan.base));
  if (plan.creator) filter.push('user.username = ' + JSON.stringify(plan.creator));
  if (plan.tag) filter.push('tags.name = ' + JSON.stringify(plan.tag));
  if (plan.open) filter.push('complete = false');
  const sort = plan.id ? null : bountiesSort.get(plan.sort) ?? (plan.query ? null : 'createdAt:desc');
  const request = {
    indexUid: NATIVE_BOUNTIES_INDEX, q: plan.query, offset: cursor, limit: plan.id ? 1 : limit,
    filter, attributesToRetrieve: queryFields, ...(sort ? { sort: [sort, 'id:desc'] } : {}),
  };
  const choices = { indexUid: NATIVE_BOUNTIES_INDEX, q: '', limit: 0, filter: [levelFilter], facets: ['type', 'details.baseModel'] };
  const now = Date.now();
  return { request, choices, cards: hits => hits.map(hit => bountyResult(context.origin, hit, ceiling, now))
    .filter(item => item && (!plan.id || item.id === plan.id) && (!plan.open || item.status === 'Open')) };
}

export function quickBountySource(context, query, limit) {
  const source = bountySearch(context, { query }, 0, limit);
  return source && { scope: 'bounties', group: 'bounties', request: source.request, cards: source.cards };
}

export async function readBountyPage(context, plan, { cursor = 0, facets = false, signal, fetcher } = {}) {
  const source = bountySearch(context, plan, cursor);
  if (!source) return { items: [], nextCursor: null };
  const { request, choices, cards } = source;
  const [results, options] = await siteSearch(context.origin, facets ? [request, choices] : [request], { signal, fetcher });
  const items = cards(results.hits);
  const next = cursor + results.hits.length;
  return {
    items,
    nextCursor: !plan.id && results.hits.length === pageSize && next < 1000 ? next : null,
    facets: options?.facetDistribution ? { types: facetValues(options, 'type'), bases: facetValues(options, 'details.baseModel') } : null,
  };
}

export async function discoverBounties(context, target, filters, options) {
  const exact = target.kind === 'bounty';
  const query = target.kind === 'text' ? text(target.value, 140) : '';
  const handle = /^@([\p{L}\p{N}_-]{1,80})(?:\s+(.*))?$/u.exec(query);
  const plan = exact ? { id: target.id, query: '' } : {
    query: handle ? handle[2] ?? '' : query,
    creator: handle?.[1],
    tag: target.kind === 'tag' ? target.value : '',
    type: text(filters.bountyType, 60), base: text(filters.bountyBase, 100),
    sort: filters.bountySort, open: filters.bountyStatus === 'open',
  };
  const native = new URL(exact ? '/bounties/' + target.id : '/bounties', context.origin);
  if (plan.query || plan.creator || plan.tag || plan.type || plan.base) {
    native.pathname = '/search/bounties';
    for (const [name, value] of Object.entries({ query: plan.query, users: plan.creator, tags: plan.tag, type: plan.type, baseModel: plan.base })) {
      if (value) native.searchParams.set(name, value);
    }
  }
  const gallery = { scope: 'bounties', plan, nextCursor: null, status: 'ready', tags: [], nativeLink: native.href };
  const result = {
    target, scope: 'bounties', gallery, related: { bounties: [] }, reference: null, candidates: [], shortlisted: [],
    guides: [], flows: [], alternateQueries: [], baseline: [], combined: [],
  };
  if (!exact && !['text', 'tag'].includes(target.kind)) {
    gallery.status = 'unsupported';
    return result;
  }
  try {
    let page = await readBountyPage(context, plan, { ...options, facets: !exact });
    const translated = translateCatalogTerms(plan.query)?.focus;
    if (!page.items.length && !page.nextCursor && translated && translated !== plan.query) {
      const initialFacets = page.facets;
      const expanded = { ...plan, query: translated };
      page = await readBountyPage(context, expanded, options);
      page.facets = initialFacets;
      gallery.plan = expanded;
      if (page.items.length) result.alternateQueries = [translated];
    }
    result.related.bounties = page.items;
    result.bountyFacets = page.facets;
    gallery.nextCursor = page.nextCursor;
  } catch {
    options.signal?.throwIfAborted();
    gallery.status = 'gallery-unavailable';
    result.flows.push({ label: 'Civitai bounty search', status: null });
  }
  return result;
}
