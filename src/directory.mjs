import { articleCitations, articleCover, plainArticleText, publicArticle } from './article-sources.mjs';
import { CATALOG, catalogImagePreview, catalogRead, listItems, numericId, previewUrl, siteSearch, text, visibleRating } from './catalog.mjs';
import { catalogOrder } from './catalog-orders.mjs';
import { foldSearchText, translateCatalogTerms } from './query-language.mjs';
import { NATIVE_ARTICLES_INDEX, NATIVE_COLLECTIONS_INDEX, NATIVE_COMICS_INDEX, NATIVE_TOOLS_INDEX, NATIVE_USERS_INDEX } from './runtime-config.mjs';
import { collectionResult } from './site-results.mjs';
import { readAppStorePage } from './app-store.mjs';
import { readAiServicePage } from './ai-services.mjs';

export const directoryScopes = ['articles', 'users', 'tools', 'comics', 'collections'];
const userTabs = ['models', 'images', 'videos', 'articles', 'posts', '3d-models'];
const pageSize = 12;
const facetFields = { articles: ['tags.name'], comics: ['genre'], tools: ['type', 'company'], collections: ['type'] };
const indexes = { articles: NATIVE_ARTICLES_INDEX, users: NATIVE_USERS_INDEX, tools: NATIVE_TOOLS_INDEX, comics: NATIVE_COMICS_INDEX,
  collections: NATIVE_COLLECTIONS_INDEX };
const indexFields = {
  articles: ['id', 'title', 'nsfwLevel', 'coverImage', 'coverImageWithheld', 'status', 'availability', 'unlisted',
    'user.username', 'createdAt', 'publishedAt', 'isOfficial', 'tags', 'stats.commentCount'],
  users: ['id', 'username', 'profilePicture', 'metrics', 'deletedAt'],
  tools: ['id', 'name', 'type', 'company', 'description', 'bannerUrl', 'icon'],
  comics: ['id', 'name', 'description', 'genre', 'stats.chapterCount', 'nsfwLevel', 'coverImageUrl', 'coverImageNsfwLevel', 'user.username'],
  collections: ['id', 'name', 'read', 'type', 'nsfwLevel', 'image', 'images', 'user.username', 'metrics.itemCount'],
};
const maxId = 2_147_483_647;
const validId = value => numericId(value) && value <= maxId;
const username = value => /^[\p{L}\p{N}_-]{1,80}$/u.test(value ?? '');
const avatar = (value, rating, ceiling) => catalogImagePreview({ type: 'image', name: value, url: value, nsfwLevel: rating }, ceiling);
const ceilingFor = context => context.hosted ? context.browsingLevel ?? 1 : 31;
const normalized = value => foldSearchText(text(value, 180)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const nativeComic = /^\/comics\/([1-9]\d{0,9})(?:\/([a-z\d][a-z\d-]{0,149})(?:\/([1-9]\d{0,8})(?:\/[a-z\d][a-z\d-]{0,149})?)?)?\/?$/u;
const nativeTool = /^\/tools\/([a-z\d][a-z\d-]{0,149})\/?$/u;
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

export function directoryReference(url) {
  const article = /^\/articles\/([1-9]\d{0,9})(?:\/[^/]+)?\/?$/u.exec(url.pathname);
  if (article && validId(Number(article[1]))) return { kind: 'article', id: Number(article[1]) };
  const comic = nativeComic.exec(url.pathname);
  if (comic && validId(Number(comic[1]))) return { kind: comic[3] ? 'comicChapter' : 'comic', id: Number(comic[1]),
    chapter: comic[3] ? Number(comic[3]) : null, path: url.pathname.replace(/\/$/u, '') };
  const tool = nativeTool.exec(url.pathname);
  if (tool) return { kind: 'tool', slug: tool[1] };
  const profile = /^\/user\/([^/]+)(?:\/([a-z\d-]+))?\/?$/u.exec(url.pathname);
  if (profile && (!profile[2] || userTabs.includes(profile[2]))) {
    try {
      const handle = decodeURIComponent(profile[1]);
      if (username(handle)) return { kind: 'user', handle, tab: profile[2] };
    } catch { return null; }
  }
  return null;
}

export function isDirectoryNavigation(url) {
  if (url.hash) return false;
  const reference = directoryReference(url);
  if (!url.search && reference && (reference.kind !== 'article' || url.pathname === '/articles/' + reference.id)) return true;
  const parameters = {
    '/articles': ['query', 'username', 'tags'], '/comics': [],
    '/search/comics': ['query', 'genre'], '/search/users': ['query'], '/search/tools': ['query', 'type', 'company'],
    '/search/collections': ['query', 'type'],
  }[url.pathname];
  return Boolean(parameters && [...url.searchParams].every(([key, value]) => parameters.includes(key) &&
    url.searchParams.getAll(key).length === 1 && value.length <= 160));
}

function directoryLink(origin, scope, plan) {
  const path = { articles: '/articles', users: '/search/users', tools: '/search/tools', collections: '/search/collections',
    comics: plan.query || plan.genre || plan.author ? '/search/comics' : '/comics' }[scope];
  const url = new URL(path, origin);
  const query = scope === 'articles' ? [plan.query, plan.tag].filter(Boolean).join(' ').slice(0, 160)
    : ['comics', 'collections'].includes(scope) && !plan.query ? plan.author : plan.query;
  if (query) url.searchParams.set('query', query);
  if (scope === 'articles') {
    if (plan.author) url.searchParams.set('username', plan.author);
    if (plan.official || plan.siteTagId) url.searchParams.set('tags', String(plan.siteTagId ?? 831959));
  }
  if (plan.genre) url.searchParams.set('genre', plan.genre);
  if (plan.type) url.searchParams.set('type', plan.type);
  if (plan.company) url.searchParams.set('company', plan.company);
  return url.href;
}

function level(value) {
  if (!Array.isArray(value)) return value;
  return value.every(item => visibleRating(item, 63)) ? value.reduce((mask, item) => mask | item, 0) : 0;
}

function nextIndex(result, offset) {
  const next = offset + result.hits.length;
  return result.hits.length === pageSize && next < 1000 ? next : null;
}

function nextSite(data, cursor) {
  const next = data?.metadata?.nextCursor;
  return (numericId(next) || typeof next === 'string' && next && next.length <= 300) && next !== cursor ? next : null;
}

const facetQuery = scope => ({ indexUid: indexes[scope], q: '', limit: 0, facets: facetFields[scope] });

function readFacets(scope, choices) {
  if (!choices?.facetDistribution) return undefined;
  return Object.fromEntries(facetFields[scope].map(field => [
    scope === 'collections' ? 'collectionType' : field,
    Object.entries(choices.facetDistribution[field] ?? {}).filter(([label, count]) => label && label === text(label, 100) && count > 0)
      .map(([label]) => label).sort((a, b) => a.localeCompare(b)),
  ]));
}

async function directoryFacets(context, scope, options) {
  const [choices] = await siteSearch(context.origin, [facetQuery(scope)], options);
  return readFacets(scope, choices);
}

function indexRequest(scope, plan, offset = 0, limit = pageSize) {
  const indexUid = indexes[scope];
  const filter = [];
  for (const [field, value] of Object.entries({
    'user.username': plan.author, username: plan.handle, 'tags.name': plan.tag, genre: plan.genre, type: plan.type, company: plan.company,
  })) {
    if (value) filter.push(field + ' = ' + JSON.stringify(value));
  }
  if (plan.official && plan.tag !== 'civitai official') filter.push('tags.name = "civitai official"');
  if (plan.id) filter.push('id = ' + plan.id);
  return { indexUid, q: plan.indexQuery ?? plan.query, offset, limit, filter,
    sort: catalogOrder(scope, plan.order)?.index, attributesToRetrieve: indexFields[scope],
    ...(scope === 'articles' && { attributesToCrop: ['content:36'], cropMarker: '…' }) };
}

async function indexPage(context, scope, plan, offset, options) {
  const requests = [indexRequest(scope, plan, offset)];
  if (options.facets && facetFields[scope]) requests.push(facetQuery(scope));
  const [result, choices] = await siteSearch(context.origin, requests, options);
  return { rows: result.hits, next: nextIndex(result, offset), facets: readFacets(scope, choices) };
}

function articleCard(article, origin, ceiling, { exact = false, creationDate = false } = {}) {
  const row = { ...article, nsfwLevel: level(article.nsfwLevel) };
  const title = text(row.title, 160);
  if (!publicArticle(row, ceiling) || !title) return null;
  const author = text(row.user?.username, 80);
  const date = Date.parse(creationDate ? row.createdAt : row.publishedAt);
  const link = new URL('/articles/' + row.id, origin).href;
  return {
    id: row.id, title, category: row.isOfficial === true ? 'Official Civitai' : 'Article',
    creator: author,
    description: [author && 'by ' + author, Number.isFinite(date) ? (creationDate ? 'Created ' : '') + day.format(date) : ''].filter(Boolean).join(' · '),
    commentCount: row.stats?.commentCountAllTime ?? row.stats?.commentCount,
    summary: plainArticleText(row._formatted?.content ?? row.content, exact ? 520 : 180),
    ...(creationDate && { createdAt: date }),
    ...(exact && { author, citations: articleCitations(row.content, origin),
      updatedAt: Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toISOString() : null }),
    preview: articleCover(row, ceiling), previewId: numericId(row.coverImage?.id), previewBadge: 'Article cover',
    link, lookup: { label: 'Follow guide links', scope: 'report', reportType: 'guide', link },
  };
}

function articleMatches(row, plan) {
  return (!plan.official || row.isOfficial === true) &&
    (!plan.author || foldSearchText(text(row.user?.username, 80)) === foldSearchText(plan.author)) &&
    (!plan.tag || (Array.isArray(row.tags) && row.tags.some(tag => normalized(tag.name) === normalized(plan.tag))));
}

async function articleTagId(context, tagName, options) {
  const [result] = await siteSearch(context.origin, [{ indexUid: NATIVE_ARTICLES_INDEX, q: '', limit: 5,
    filter: ['tags.name = ' + JSON.stringify(tagName)], attributesToRetrieve: ['tags'] }], options);
  return result.hits.flatMap(row => row.tags ?? [])
    .find(tag => normalized(tag.name) === normalized(tagName) && validId(tag.id))?.id;
}

async function articlePage(context, plan, position, options) {
  const { origin } = context;
  const ceiling = ceilingFor(context);
  const order = catalogOrder('articles', plan.order);
  const creationDate = ['newest', 'oldest'].includes(plan.order);
  const cursor = position ?? { index: order?.site ? null : 0, site: order?.index ? null : '' };
  const [indexed, site, choices] = await Promise.allSettled([
    cursor.index !== null ? indexPage(context, 'articles', plan, cursor.index, options) : null,
    cursor.site !== null ? catalogRead(origin, CATALOG.articles, {
      query: plan.query, username: plan.author, tags: plan.siteTagId ?? (plan.official ? 831959 : undefined),
      nsfw: true, cursor: cursor.site, limit: pageSize, sort: order?.site,
    }, options) : null,
    order?.site && options.facets ? directoryFacets(context, 'articles', options) : null,
  ]);
  options.signal?.throwIfAborted();
  if (!indexed.value && !site.value) throw indexed.reason ?? site.reason ?? new Error('No article source is available.');
  const items = new Map();
  for (const row of [...(indexed.value?.rows ?? []), ...listItems(site.value?.data)]) {
    if (!validId(row?.id)) continue;
    const card = articleMatches(row, plan) ? articleCard(row, origin, ceiling, { creationDate }) : null;
    if (card) items.set(card.id, card);
    else items.delete(row.id);
  }
  const query = normalized(plan.query);
  const rank = card => Number(normalized(card.title) === query) * 2 + Number(Boolean(query) && normalized(card.title).includes(query));
  const ranked = [...items.values()];
  if (!order) ranked.sort((a, b) => rank(b) - rank(a));
  if (creationDate) {
    const direction = plan.order === 'oldest' ? 1 : -1;
    ranked.sort((a, b) => direction * (a.createdAt - b.createdAt || a.id - b.id));
  }
  const next = { index: indexed.value?.next ?? null, site: nextSite(site.value?.data, cursor.site) };
  return {
    items: ranked,
    nextCursor: next.index === null && next.site === null ? null : next,
    facets: indexed.value?.facets ?? choices.value, partial: indexed.status === 'rejected' || site.status === 'rejected',
  };
}

const count = (value, label) => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() + ' ' + label + (value === 1 ? '' : 's') : '';

function userCard(row, origin, ceiling, tab) {
  const handle = text(row.username, 80);
  if (!validId(row.id) || !username(handle) || row.deletedAt) return null;
  const path = '/user/' + encodeURIComponent(handle);
  return {
    id: row.id, title: handle, category: 'User ' + row.id,
    description: [count(row.metrics?.followerCount, 'follower'), count(row.metrics?.uploadCount, 'upload')].filter(Boolean).join(' · '),
    preview: catalogImagePreview(row.profilePicture, ceiling) ?? avatar(row.avatarUrl, row.avatarNsfw, ceiling),
    previewId: numericId(row.profilePicture?.id), link: new URL(tab ? path + '/' + tab : path, origin).href,
    actions: [['Models', 'models'], ['Pictures', 'images'], ['Articles', 'articles']].map(([label, route]) => ({
      label, link: new URL(path + '/' + route, origin).href,
    })),
    lookup: { label: 'Explore this creator', link: new URL(path, origin).href, scope: 'report', reportType: 'creator' },
  };
}

async function userPage(context, plan, offset, options) {
  const { origin } = context;
  const [index, site] = await Promise.allSettled([
    indexPage(context, 'users', plan, offset, options),
    offset === 0 && (plan.id || plan.handle || plan.query && !catalogOrder('users', plan.order)) ? catalogRead(origin, CATALOG.users, plan.id
      ? { ids: plan.id } : { query: plan.handle ?? plan.query }, options) : null,
  ]);
  options.signal?.throwIfAborted();
  if (!index.value && !site.value) throw index.reason ?? site.reason ?? new Error('User search is unavailable.');
  const merged = new Map();
  for (const row of [...listItems(site.value?.data), ...(index.value?.rows ?? [])]) {
    if (!validId(row?.id) || (plan.id && row.id !== plan.id) ||
        (plan.handle && foldSearchText(text(row.username, 80)) !== foldSearchText(plan.handle))) continue;
    merged.set(row.id, { ...merged.get(row.id), ...row });
  }
  const query = foldSearchText(plan.query);
  const rows = [...merged.values()];
  const rank = card => (query && foldSearchText(card.title) === query ? 2 : 0) +
    Number(Boolean(query) && foldSearchText(card.title).startsWith(query));
  const items = rows.map(row => userCard(row, origin, ceilingFor(context), plan.tab)).filter(Boolean);
  if (!catalogOrder('users', plan.order)) items.sort((a, b) => rank(b) - rank(a));
  return {
    items,
    nextCursor: plan.id || plan.handle ? null : index.value?.next ?? null,
    partial: index.status === 'rejected' || site.status === 'rejected',
  };
}

const simpleToolSlug = name => /^[a-z\d]+(?:[ -]+[a-z\d]+)*$/iu.test(name)
  ? name.toLowerCase().replace(/[ -]+/gu, '-') : '';

function toolCard(row, origin, ceiling) {
  const title = text(row.name, 130);
  if (!validId(row.id) || !title) return null;
  const slug = simpleToolSlug(title);
  return {
    id: row.id, title, category: text(row.type, 45).replace(/([a-z])([A-Z])/gu, '$1 $2'),
    description: text(row.company, 90), summary: plainArticleText(row.description, 180),
    preview: avatar(row.bannerUrl, 1, ceiling) ?? avatar(row.icon, 1, ceiling), previewBadge: 'Tool artwork',
    link: slug ? new URL('/tools/' + slug, origin).href : directoryLink(origin, 'tools', { query: title }),
  };
}

function comicPath(url, id, chapter, fallback) {
  try {
    const candidate = new URL(url);
    const parsed = directoryReference(candidate);
    if (['https://civitai.com', 'https://civitai.red'].includes(candidate.origin) && !candidate.username && !candidate.password &&
        parsed?.id === id && parsed.chapter === chapter && parsed.path) return parsed.path;
  } catch {
    // A series has a stable numeric overview even if a response has no canonical URL.
  }
  return fallback;
}

function comicCard(row, origin, ceiling, exact = false) {
  const title = text(row.name, 150);
  if (!validId(row.id) || !title || !visibleRating(level(row.nsfwLevel), ceiling)) return null;
  const author = text(row.user?.username, 80);
  const link = new URL(comicPath(row.url, row.id, null, '/comics/' + row.id), origin).href;
  return {
    id: row.id, title, category: text(row.genre, 45) || 'Comic',
    creator: author,
    description: [author && 'by ' + author, count(row.chapterCount ?? row.stats?.chapterCount ?? row.chapters?.length, 'chapter')]
      .filter(Boolean).join(' · '),
    summary: plainArticleText(row.description, 180),
    preview: articleCover(row, ceiling) ?? avatar(row.coverImageUrl, row.coverImageNsfwLevel, ceiling), previewBadge: 'Comic cover',
    link, lookup: exact ? null : { label: 'View chapters', link, scope: 'comics' },
  };
}

export function quickDirectorySources(context, query, limit) {
  const { origin } = context;
  const ceiling = ceilingFor(context);
  const sources = [
    ['articles', 'guides', articleCard], ['tools', 'tools', toolCard],
    ['comics', 'comics', comicCard], ['users', 'creators', userCard],
  ];
  return sources.map(([scope, group, project]) => ({
    scope, group, request: indexRequest(scope, { query }, 0, limit),
    cards: rows => rows.flatMap(row => {
      const card = row && project(row, origin, ceiling);
      return card ? [card] : [];
    }),
  }));
}

async function comicPage(context, plan, cursor, options) {
  const { origin } = context;
  const ceiling = ceilingFor(context);
  const searching = Boolean(plan.query);
  const order = catalogOrder('comics', plan.order);
  const position = cursor ?? { index: searching || order ? 0 : null, site: order ? null : '' };
  const [indexed, site, choices] = await Promise.allSettled([
    position.index !== null ? indexPage(context, 'comics', plan, position.index, options) : null,
    position.site !== null ? catalogRead(origin, CATALOG.comics, {
      genre: plan.genre, username: plan.author, nsfw: true, limit: searching ? 24 : pageSize, cursor: position.site,
    }, options) : null,
    position.index === null && options.facets ? directoryFacets(context, 'comics', options) : null,
  ]);
  options.signal?.throwIfAborted();
  if (!indexed.value && !site.value) throw indexed.reason ?? site.reason ?? new Error('Comic search is unavailable.');
  const cards = new Map();
  const terms = [plan.query, plan.indexQuery].filter(Boolean).map(query => normalized(query).split(' ').filter(Boolean));
  for (const { row, fromIndex } of [
    ...(indexed.value?.rows ?? []).map(row => ({ row, fromIndex: true })),
    ...listItems(site.value?.data).map(row => ({ row, fromIndex: false })),
  ]) {
    if (!validId(row?.id)) continue;
    const creator = text(row.user?.username, 80);
    if (plan.author && creator && creator.toLowerCase() !== plan.author.toLowerCase()) continue;
    const combined = normalized([row.name, row.description, row.user?.username].filter(Boolean).join(' '));
    const matched = fromIndex || cards.has(row.id) || !terms.length || terms.some(words => words.every(word => combined.includes(word)));
    const card = matched ? comicCard(row, origin, ceiling) : null;
    if (card) cards.set(card.id, card);
    else cards.delete(row.id);
  }
  const title = normalized(plan.query);
  const next = { index: indexed.value?.next ?? null, site: nextSite(site.value?.data, position.site) };
  const facets = indexed.value?.facets ?? choices.value;
  const items = [...cards.values()];
  if (!order) items.sort((a, b) => Number(normalized(b.title) === title) - Number(normalized(a.title) === title));
  return {
    items,
    nextCursor: next.index === null && next.site === null ? null : next, facets,
    partial: indexed.status === 'rejected' || site.status === 'rejected',
  };
}

async function collectionPage(context, plan, options) {
  const { origin } = context;
  const ceiling = ceilingFor(context);
  if (catalogOrder('collections', plan.order) || plan.type || plan.author) {
    const indexed = await indexPage(context, 'collections', plan, options.cursor ?? 0, options);
    const items = indexed.rows.flatMap(row => {
      const title = text(row.name, 160);
      if (row.read !== 'Public' || !validId(row.id) || !title || !visibleRating(level(row.nsfwLevel), ceiling)) return [];
      const creator = text(row.user?.username, 80);
      if (plan.author && creator && creator.toLowerCase() !== plan.author.toLowerCase()) return [];
      const cover = catalogImagePreview(row.image, ceiling) ?? (Array.isArray(row.images) ? row.images : [])
        .map(image => catalogImagePreview(image, ceiling)).find(Boolean);
      return [{ id: row.id, title, preview: cover, category: collectionTypeLabel(row.type), creator,
        description: [count(row.metrics?.itemCount, 'item'), creator && 'by ' + creator].filter(Boolean).join(' · '),
        link: new URL('/collections/' + row.id, origin).href }];
    });
    return { items, nextCursor: indexed.next, facets: indexed.facets };
  }
  const [site, choices] = await Promise.allSettled([
    catalogRead(origin, CATALOG.collections, { query: plan.query, nsfw: true, limit: pageSize, cursor: options.cursor }, options),
    options.facets ? directoryFacets(context, 'collections', options) : null,
  ]);
  options.signal?.throwIfAborted();
  if (site.status === 'rejected') throw site.reason;
  const { data } = site.value;
  return { items: listItems(data).map(row => collectionResult(origin, row, ceiling)).filter(Boolean),
    nextCursor: nextSite(data, options.cursor), facets: choices.value };
}

export function collectionTypeLabel(type) {
  const labels = { Article: 'Articles', Image: 'Pictures and clips', Model: 'Models', Model3D: '3D assets', Post: 'Posts' };
  return Object.hasOwn(labels, type) ? labels[type] : text(type, 90).replace(/([a-z])([A-Z])/gu, '$1 $2');
}

export async function readDirectoryPage(context, scope, plan, options = {}) {
  if (scope === 'apps') return readAppStorePage(context, plan, options);
  if (scope === 'aiServices') return readAiServicePage(plan, options);
  if (scope === 'articles') return articlePage(context, plan, options.cursor, options);
  if (scope === 'users') return userPage(context, plan, options.cursor ?? 0, options);
  if (scope === 'comics') return comicPage(context, plan, options.cursor, options);
  if (scope === 'collections') return collectionPage(context, plan, options);
  const indexed = await indexPage(context, 'tools', plan, options.cursor ?? 0, options);
  const entries = plan.slug ? indexed.rows.filter(row => simpleToolSlug(row.name ?? '') === plan.slug) : indexed.rows;
  const title = normalized(plan.query);
  const items = entries.map(row => toolCard(row, context.origin, ceilingFor(context))).filter(Boolean);
  if (!catalogOrder('tools', plan.order)) items.sort((a, b) => Number(normalized(b.title) === title) - Number(normalized(a.title) === title));
  return { items,
    nextCursor: plan.slug ? null : indexed.next, facets: indexed.facets };
}

async function exactComic(context, target, result, options) {
  const { origin } = context;
  const ceiling = ceilingFor(context);
  const route = '/comics/' + target.id;
  result.nativeLink = new URL(target.path ?? route, origin).href;
  const { data } = await catalogRead(origin, '/api/v1' + route + (target.chapter ? '/chapters/' + target.chapter : ''), { nsfw: true }, options);
  if (target.chapter) {
    if (data.comicId !== target.id || data.number !== target.chapter || !visibleRating(data.nsfwLevel, ceiling)) return;
    const path = comicPath(data.url, target.id, target.chapter, target.path ?? route);
    result.nativeLink = new URL(path, origin).href;
    result.directoryTitle = [text(data.series, 100), text(data.name, 80) || 'Chapter ' + target.chapter].filter(Boolean).join(' · ');
    result.related.comicPages = (Array.isArray(data.pages) ? data.pages : []).filter(page => validId(page.number) &&
      visibleRating(page.nsfwLevel, ceiling) && previewUrl(page.url)).slice(0, 3)
      .map(page => ({ id: page.number, title: 'Page ' + page.number, preview: previewUrl(page.url), previewBadge: 'Chapter preview', link: result.nativeLink }));
    return;
  }
  if (data.id !== target.id) return;
  const card = comicCard(data, origin, ceiling, true);
  if (!card) return;
  result.related.comics = [card];
  result.directoryTitle = card.title;
  result.nativeLink = card.link;
  const chapters = Array.isArray(data.chapters) ? data.chapters : [];
  result.related.comicChapters = chapters.filter(chapter => validId(chapter.number) && visibleRating(chapter.nsfwLevel, ceiling))
    .map(chapter => {
      const path = comicPath(chapter.url, target.id, chapter.number, '');
      if (!path) return null;
      const link = new URL(path, origin).href;
      const early = Date.parse(chapter.earlyAccessEndsAt) > Date.now();
      return { id: chapter.number, title: text(chapter.name, 100) || 'Chapter ' + chapter.number,
        category: 'Chapter ' + chapter.number, description: early ? 'Early access' : count(chapter.pageCount, 'page'), link,
        lookup: early ? null : { label: 'Preview chapter', link, scope: 'comics' } };
    }).filter(Boolean);
}

export async function discoverDirectory(context, target, scope, filters, options = {}) {
  const { origin } = context;
  const entered = text(target.value, 160);
  const byAuthor = ['articles', 'comics', 'collections'].includes(scope) ? /^@([\p{L}\p{N}_-]{1,80})(?:\s+(.*))?$/u.exec(entered) : null;
  const atHandle = scope === 'users' && entered.startsWith('@') && username(entered.slice(1)) ? entered.slice(1) : '';
  const enteredId = /^#?[1-9]\d{0,9}$/u.test(entered) ? Number(entered.replace('#', '')) : null;
  const userId = scope === 'users' && validId(enteredId) ? enteredId : null;
  const query = byAuthor ? (byAuthor[2] ?? '') : atHandle || userId || (scope === 'articles' && target.kind === 'tag') ? '' : entered;
  const translated = ['articles', 'comics'].includes(scope) ? translateCatalogTerms(query)?.focus : '';
  const order = catalogOrder(scope, filters.catalogSort);
  const plan = { query, indexQuery: translated || undefined, order: order ? filters.catalogSort : undefined };
  const enteredAuthor = text({ articles: filters.articleAuthor, comics: filters.comicAuthor, collections: filters.collectionAuthor }[scope], 81)
    .replace(/^@/u, '');
  if (byAuthor || username(enteredAuthor)) plan.author = byAuthor?.[1] ?? enteredAuthor;
  if (scope === 'articles') {
    plan.tag = text(target.kind === 'tag' ? target.value : filters.articleTag, 100);
    plan.official = filters.articleOfficial === 'true';
  } else if (scope === 'users') {
    plan.handle = target.handle || atHandle || undefined;
    plan.id = validId(target.id ?? userId) ? target.id ?? userId : undefined;
    plan.tab = target.tab;
  } else if (scope === 'tools') {
    plan.slug = target.slug;
    if (plan.slug) plan.query = plan.slug.replace(/-/gu, ' ');
    plan.type = text(filters.toolType, 100);
    plan.company = text(filters.toolCompany, 100);
  } else if (scope === 'comics') {
    plan.genre = text(filters.comicGenre, 100);
  } else if (scope === 'collections') {
    plan.type = text(filters.collectionType, 100);
  }
  const result = { scope, target, related: { [scope]: [] }, reference: null, candidates: [], shortlisted: [], guides: [],
    flows: [], alternateQueries: translated ? [translated] : [], baseline: [], combined: [],
    nativeLink: directoryLink(origin, scope, plan) };
  try {
    if (target.kind === 'article') {
      result.nativeLink = new URL('/articles/' + target.id, origin).href;
      const { data } = await catalogRead(origin, '/api/v1/articles/' + target.id, {}, options);
      const card = data.id === target.id ? articleCard(data, origin, ceilingFor(context), { exact: true }) : null;
      if (card) result.related.articles = [card];
      return result;
    }
    if (scope === 'articles' && order?.site && plan.tag) {
      plan.siteTagId = normalized(plan.tag) === 'civitai official' ? 831959 : await articleTagId(context, plan.tag, options);
      if (!plan.siteTagId) return result;
      result.nativeLink = directoryLink(origin, scope, plan);
    }
    if (['comic', 'comicChapter'].includes(target.kind)) {
      await exactComic(context, target, result, options);
      return result;
    }
    if (plan.slug) result.nativeLink = new URL('/tools/' + plan.slug, origin).href;
    if (plan.handle) result.nativeLink = new URL('/user/' + encodeURIComponent(plan.handle) + (plan.tab ? '/' + plan.tab : ''), origin).href;
    const page = await readDirectoryPage(context, scope, plan, { ...options, facets: true });
    result.related[scope] = page.items;
    result.directory = { scope, plan, nextCursor: page.nextCursor };
    result.directoryFacets = page.facets;
    if (scope === 'users' && plan.id && page.items[0]) result.nativeLink = page.items[0].link;
    if (page.partial) result.flows.push({ label: 'Civitai ' + scope, status: null });
  } catch (error) {
    options.signal?.throwIfAborted();
    const missing = error.status === 404 && ['article', 'comic', 'comicChapter'].includes(target.kind);
    if (!missing) result.flows.push({ label: 'Civitai ' + scope, status: error.status ?? null });
  }
  return result;
}
