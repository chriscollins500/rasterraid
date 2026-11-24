import { articleAnchors, articleCover, plainArticleText, publicArticle } from './article-sources.mjs';
import { CATALOG, SITE_ORIGINS, catalogRead, listItems, numericId, siteSearch, text, visibleRating } from './catalog.mjs';
import { foldSearchText, translateCatalogTerms } from './query-language.mjs';
import { NATIVE_ARTICLES_INDEX } from './runtime-config.mjs';
import { editDistance } from './text-assist.mjs';

const SERVICES_GUIDE = 38740;
const BUZZ_GUIDE = 2579;
const OFFICIAL_ARTICLE_TAG = 831959;
const articleLimit = 5;
const marketplacePath = '/buzz/marketplace';
const stop = new Set(['a', 'an', 'and', 'civitai', 'find', 'for', 'how', 'i', 'me', 'of', 'on', 'please', 'the', 'to', 'want', 'with']);
const serviceWords = new Set(['commission', 'commissions', 'commissioning', 'creator', 'creators', 'hire', 'service', 'services']);
const buzzWords = new Set(['buzz', 'credit', 'credits', 'guide', 'marketplace', 'type', 'types', 'work', 'works']);
const commission = /\b(?:commissions?|commissioning|creator services)\b/iu;
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

function tokens(value) {
  return (foldSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(word => /^train(?:ed|ing|s)?$/u.test(word) ? 'training' : word.replace(/(?<=[a-z]{4})s$/u, ''));
}

export function commerceReference(url) {
  if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password) return null;
  const listing = /^\/services\/([1-9]\d{0,9})(?:\/[^/]+)?\/?$/u.exec(url.pathname);
  if (listing && Number(listing[1]) <= 2_147_483_647) return { kind: 'service', id: Number(listing[1]) };
  const shop = /^\/user\/([^/]+)\/shop\/?$/u.exec(url.pathname);
  if (shop) {
    let username;
    try { username = decodeURIComponent(shop[1]); } catch { return null; }
    if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(username)) return null;
    const service = /^#service-([1-9]\d{0,9})$/u.exec(url.hash);
    const section = service && Number(service[1]) <= 2_147_483_647 ? url.hash
      : url.hash === '#shop-services' ? url.hash : '';
    return { kind: 'serviceShop', username, section };
  }
  if (url.pathname === marketplacePath || url.pathname === marketplacePath + '/') return { kind: 'buzzMarketplace' };
  return null;
}

function commerceLink(origin, target, query = '') {
  if (target.kind === 'service') return new URL('/services/' + target.id, origin).href;
  if (target.kind === 'serviceShop') {
    const url = new URL('/user/' + encodeURIComponent(target.username) + '/shop', origin);
    url.hash = target.section;
    return url.href;
  }
  if (target.kind === 'buzzMarketplace') return new URL(marketplacePath, origin).href;
  const url = new URL('/services', origin);
  if (query) url.searchParams.set('query', query);
  return url.href;
}

export function isCommerceNavigation(url, origin) {
  const reference = commerceReference(url);
  if (reference) return commerceLink(origin, reference) === url.href;
  return url.pathname === '/services' && !url.hash && [...url.searchParams].every(([key, value]) =>
    key === 'query' && url.searchParams.getAll(key).length === 1 && value.length <= 100);
}

function linkedServices(article, origin) {
  const links = [];
  for (const { href, label } of articleAnchors(article.content)) {
    let parsed;
    try { parsed = new URL(href, origin); } catch { continue; }
    if (parsed.origin !== origin) continue;
    const reference = commerceReference(parsed);
    if (!reference || reference.kind === 'buzzMarketplace') continue;
    const link = commerceLink(origin, reference);
    if (/^https?:\/\//iu.test(label)) {
      try {
        const labelled = commerceReference(new URL(label));
        if (!labelled || commerceLink(origin, labelled) !== link || new URL(label).origin !== origin) continue;
      } catch { continue; }
    }
    const title = reference.kind === 'serviceShop' ? reference.username + ' Creator Shop'
      : (!label || /^(?:here|click here|open|view|service)$/iu.test(label) || /^https?:\/\//iu.test(label))
        ? 'Creator service ' + reference.id : label;
    links.push({ reference, link, title });
  }
  return links;
}

const withinIndexRating = (hit, ceiling) => (Array.isArray(hit?.nsfwLevel) ? hit.nsfwLevel : [hit?.nsfwLevel])
  .some(level => visibleRating(level, ceiling));

async function readArticle(context, id, options) {
  try {
    const { data } = await catalogRead(context.origin, '/api/v1/articles/' + id, {}, options);
    return data.id === id ? data : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function articleCandidates(context, query, words, services, ceiling, options) {
  const { origin } = context;
  const guide = services ? SERVICES_GUIDE : BUZZ_GUIDE;
  const seed = readArticle(context, guide, options);
  if (!services && !words.length) {
    const [answer] = await Promise.allSettled([seed]);
    options.signal?.throwIfAborted();
    return { articles: answer.value ? [answer.value] : [], partial: answer.status === 'rejected' };
  }

  const discoverQuery = services ? ('commission ' + words.join(' ')).trim() : 'buzz ' + words.join(' ');
  const native = siteSearch(origin, [{
    indexUid: NATIVE_ARTICLES_INDEX, q: discoverQuery, limit: 6, attributesToRetrieve: ['id', 'nsfwLevel'],
    ...(services ? {} : { filter: ['tags.name = "civitai official"'] }),
  }], options);
  const browseQueries = [...new Set([query, services ? 'commission' : discoverQuery].filter(Boolean))];
  const site = browseQueries.map(q => catalogRead(origin, CATALOG.articles, {
    query: q, limit: 6, nsfw: true, ...(services ? {} : { tags: OFFICIAL_ARTICLE_TAG }),
  }, options));
  const [guideResponse, nativeResponse, ...siteResponses] = await Promise.allSettled([seed, native, ...site]);
  options.signal?.throwIfAborted();
  const siteIds = response => listItems(response?.value?.data)
    .filter(item => numericId(item?.id) && !item.unlisted && visibleRating(item.nsfwLevel, ceiling)).map(item => item.id);
  const nativeIds = (nativeResponse.value?.[0]?.hits ?? []).filter(hit => numericId(hit?.id) && withinIndexRating(hit, ceiling)).map(hit => hit.id);
  const siteQueues = siteResponses.map(siteIds);
  const queues = [...siteQueues, nativeIds];
  const ids = new Set();
  for (let offset = 0; offset < 6 && ids.size < articleLimit; offset++) {
    for (const queue of queues) {
      const id = queue[offset];
      if (id && id !== guide && ids.size < articleLimit) ids.add(id);
    }
  }
  const details = await Promise.allSettled([...ids].map(id => readArticle(context, id, options)));
  options.signal?.throwIfAborted();
  return {
    articles: [guideResponse, ...details].flatMap(result => result.value ? [result.value] : []),
    partial: [guideResponse, nativeResponse, ...siteResponses, ...details].some(result => result.status === 'rejected'),
  };
}

function articleResult(article, origin, ceiling, category) {
  const username = text(article.user?.username, 80);
  const publishedAt = Date.parse(article.publishedAt);
  return {
    id: article.id, title: text(article.title, 150), category,
    description: [username ? 'by ' + username : '', Number.isFinite(publishedAt) ? day.format(publishedAt) : ''].filter(Boolean).join(' · '),
    preview: articleCover(article, ceiling), previewId: numericId(article.coverImage?.id), previewBadge: 'Article cover',
    link: new URL('/articles/' + article.id, origin).href,
  };
}

export async function discoverMarketplace(context, target, scope, options = {}) {
  const { origin } = context;
  const services = scope === 'services';
  const query = text(target.value, 100);
  const exactService = ['service', 'serviceShop'].includes(target.kind);
  const nativeLink = commerceLink(origin, services ? target : { kind: 'buzzMarketplace' }, query);
  const related = services ? { services: [], serviceArticles: [] } : { marketplace: [] };
  const result = { scope, target, related, nativeLink, reference: null, candidates: [], shortlisted: [], guides: [],
    flows: [], alternateQueries: [], baseline: [], combined: [] };
  if (exactService) return result;

  const ceiling = context.hosted ? context.browsingLevel ?? 1 : 31;
  const ignored = new Set([...stop, ...(services ? serviceWords : buzzWords)].flatMap(tokens));
  const localized = translateCatalogTerms(query)?.brief ?? query;
  const wanted = [...new Set(tokens(localized).filter(word => !ignored.has(word)))].slice(0, 8);
  const { articles, partial } = await articleCandidates(context, query, wanted, services, ceiling, options);
  if (partial) result.flows.push({ label: 'Civitai articles', status: null });
  const matches = [];
  for (const article of articles) {
    if (!publicArticle(article, ceiling) || !text(article.title)) continue;
    const body = plainArticleText(article.content, 15_000);
    const tags = Array.isArray(article.tags) ? article.tags.map(tag => text(tag?.name, 80)).join(' ') : '';
    const links = services ? linkedServices(article, origin) : [];
    const evidence = article.title + ' ' + tags;
    if (services) {
      if (!commission.test(evidence) && !links.some(item => item.reference.kind === 'service') &&
          !(links.length && commission.test(body))) continue;
    } else if (article.isOfficial !== true || !/\bbuzz\b/iu.test(evidence + ' ' + body)) continue;
    const titleTerms = tokens(evidence);
    const detailTerms = new Set(tokens(body + ' ' + links.map(link => link.title).join(' ')));
    if (!wanted.every(word => titleTerms.includes(word) || detailTerms.has(word) || (word.length >= 5 &&
      titleTerms.some(candidate => candidate[0] === word[0] && Math.abs(candidate.length - word.length) <= 1 &&
        editDistance(word, candidate) === 1)))) continue;
    const category = !services || article.isOfficial === true ? 'Official Civitai article' : 'Commission article';
    const card = articleResult(article, origin, ceiling, category);
    let score = wanted.filter(word => titleTerms.includes(word)).length * 3 +
      wanted.filter(word => detailTerms.has(word)).length + Number(article.id === SERVICES_GUIDE || article.id === BUZZ_GUIDE);
    if (!services && wanted.includes(titleTerms[0])) score += 2;
    matches.push({ card, links, score });
  }
  matches.sort((a, b) => b.score - a.score);
  if (!services) {
    related.marketplace = matches.map(item => item.card).slice(0, 6);
    return result;
  }
  related.serviceArticles = matches.map(item => item.card).slice(0, 6);
  const references = new Map();
  for (const { card, links } of matches) {
    for (const { reference, link, title } of links) {
      if (!references.has(link)) references.set(link, {
        id: reference.id ?? reference.username, link, title, category: 'Linked from article',
        source: card.link, sourceTitle: card.title, preview: card.preview, previewId: card.previewId,
      });
    }
  }
  related.services = [...references.values()].slice(0, 8);
  return result;
}
