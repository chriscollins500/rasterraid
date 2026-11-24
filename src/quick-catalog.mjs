import { readAppStorePage } from './app-store.mjs';
import { quickBountySource } from './bounties.mjs';
import { siteSearch, text } from './catalog.mjs';
import { quickDirectorySources } from './directory.mjs';
import { readGalleryPage, sampleMediaByPost, tagRecord } from './gallery.mjs';
import { searchTerms, searchWords, translateCatalogTerms } from './query-language.mjs';
import { NATIVE_MODELS_INDEX } from './runtime-config.mjs';

const indexLimit = 8;
const cardLimit = 5;
const mediaLimit = 8;
const exactFirst = ['tools', 'comics', 'guides'];
const titleKey = value => searchWords(value).join(' ');

function quickReadOptions(signal, fetcher) {
  const deadline = AbortSignal.timeout(2_400);
  return { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, fetcher };
}

function relatedCards(cards, group, query) {
  const key = titleKey(query);
  const terms = searchTerms(query);
  const matches = cards.filter(card => {
    if (titleKey(card.title) === key) return true;
    if (group === 'creators' || !terms.length) return false;
    const domain = group === 'bounties' || group === 'comics' ? card.title : [card.title, card.summary, card.description].filter(Boolean).join(' ');
    const words = new Set(searchWords(domain));
    return terms.every(term => words.has(term));
  });
  matches.sort((a, b) => Number(titleKey(b.title) === key) - Number(titleKey(a.title) === key));
  return [...new Map(matches.map(card => [card.link, card])).values()].slice(0, cardLimit);
}

function galleryTag(query, rows) {
  const key = titleKey(query);
  const candidates = new Map();
  if (searchWords(query).length > 3) return null;
  for (const row of rows) for (const data of Array.isArray(row?.tags) ? row.tags : []) {
    const tag = tagRecord(data);
    if (tag && titleKey(tag.name) === key) candidates.set(tag.id, tag);
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

export async function readQuickCatalog(context, input, { signal, fetcher } = {}) {
  const literal = text(input, 160);
  const translated = translateCatalogTerms(literal)?.focus;
  const query = translated && titleKey(translated) !== titleKey(literal) ? translated : literal;
  const sources = [...quickDirectorySources(context, query, indexLimit), quickBountySource(context, query, indexLimit)].filter(Boolean);
  const galleryAllowed = !context.hosted || Boolean(context.token);
  const tagRequest = { indexUid: NATIVE_MODELS_INDEX, q: query, limit: indexLimit, attributesToRetrieve: ['tags'] };
  const requests = [...sources.map(source => source.request), ...(galleryAllowed ? [tagRequest] : [])];
  let pages;
  try {
    pages = await siteSearch(context.origin, requests, quickReadOptions(signal, fetcher));
    if (pages.some((page, index) => page.indexUid && page.indexUid !== requests[index].indexUid)) {
      throw new Error('Civitai returned an unexpected search index.');
    }
  } catch {
    signal?.throwIfAborted();
    return { status: 'unavailable', areas: [], exact: null };
  }
  const areas = sources.map(({ group, scope }, i) => {
    const cards = relatedCards(sources[i].cards(pages[i].hits.slice(0, indexLimit)), group, query);
    return { group, scope, query, cards };
  });
  const exact = exactFirst.filter(group => areas.find(area => area.group === group)?.cards.some(card => titleKey(card.title) === titleKey(literal)));
  const tag = galleryAllowed && galleryTag(query, pages.at(-1).hits);
  return { status: 'ready', areas, query, exact: exact.length === 1 ? exact[0] : null, tag };
}

export async function sampleQuickCatalog(context, base, models, { signal, fetcher } = {}) {
  if (!base) return null;
  const { exact, tag, query, status } = base;
  const areas = [...base.areas];
  const options = quickReadOptions(signal, fetcher);
  let incomplete = false;
  if (exact === 'tools') {
    try {
      const page = await readAppStorePage(context, { query }, { ...options, maxPages: 1 });
      areas.push({ group: 'apps', scope: 'apps', query, cards: page.items.slice(0, cardLimit) });
    } catch {
      signal?.throwIfAborted();
      incomplete = true;
    }
  } else if (tag && !exact && !models.some(model => model.nameMatch)) {
    const media = [['gallery', 'image'], ['videos', 'video']];
    const samples = await Promise.allSettled(media.map(([, type]) => readGalleryPage(context,
      { type, tags: [tag.id], sort: 'Most Reactions' }, { ...options, limit: mediaLimit })));
    signal?.throwIfAborted();
    for (const [index, [group]] of media.entries()) {
      const sample = samples[index];
      if (sample.status === 'rejected') {
        incomplete = true;
        continue;
      }
      const cards = sampleMediaByPost(sample.value.items.filter(item => item.preview || item.stream), cardLimit);
      areas.push({ group, scope: group, query: tag.name, tag, cards });
    }
  }
  signal?.throwIfAborted();
  return { status: incomplete ? 'partial' : status, exact,
    groups: Object.fromEntries(areas.map(({ group, cards }) => [group, cards])),
    areas: areas.map(({ cards, ...area }) => ({ ...area, count: cards.length })) };
}

export function mergeQuickCatalog(current, { groups, areas, exact, status }, models, query) {
  const related = { ...current };
  for (const [group, cards] of Object.entries(groups)) {
    related[group] = [...new Map([...(current[group] ?? []), ...cards].map(card => [card.link, card])).values()];
  }
  const lead = exact && !models.some(model => model.nameMatch) ? exact : null;
  if (lead) related[lead].sort((a, b) => Number(titleKey(b.title) === titleKey(query)) - Number(titleKey(a.title) === titleKey(query)));
  return { related, quickCatalog: { status, lead, areas } };
}
