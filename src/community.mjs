import { articleAnchors, articleCover, plainArticleText, publicArticle } from './article-sources.mjs';
import { CATALOG, SITE_ORIGINS, catalogRead, listItems, numericId, text, visibleRating } from './catalog.mjs';
import { prepareGallery, readGalleryPage } from './gallery.mjs';
import { foldSearchText, translateCatalogTerms } from './query-language.mjs';
import { editDistance } from './text-assist.mjs';

const stopWords = new Set(['a', 'an', 'and', 'by', 'find', 'for', 'i', 'me', 'of', 'on', 'post', 'posts',
  'show', 'storyline', 'storylines', 'the', 'to', 'with']);
const terms = value => (foldSearchText(text(value, 180)).match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !stopWords.has(word));
const browsingLevel = context => context.hosted ? context.browsingLevel ?? 1 : 31;
const referenceRoutes = {
  storylines: /^(\/storylines)\/([1-9]\d{0,9})\/?$/u,
  challenges: /^(\/challenges(?:\/events)?)\/([1-9]\d{0,9})(?:\/([a-z\d][a-z\d-]{0,125}))?\/?$/iu,
  crucibles: /^(\/crucibles)\/([1-9]\d{0,9})(?:\/([a-z\d][a-z\d-]{0,125}))?\/?$/iu,
};
const referenceSeeds = {
  storylines: ['storylines'],
  challenges: ['community challenge', 'challenge'],
  crucibles: ['crucible'],
};
export const crucibleFilters = {
  status: { Active: 'Active', Pending: 'Upcoming', Completed: 'Completed' },
  contentType: { image: 'Image contests', video: 'Video contests' },
};

export function crucibleReference(path) {
  const match = referenceRoutes.crucibles.exec(path);
  if (!match || /^(?:edit|judge)$/iu.test(match[3] ?? '') || Number(match[2]) > 2_147_483_647) return null;
  return { kind: 'crucible', id: Number(match[2]) };
}

async function read(context, path, params, options) {
  try {
    return (await catalogRead(context.origin, path, params, { ...options, token: context.token })).data;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error.status === 404) return null;
    throw error;
  }
}

function postCard(post, id, leads, context) {
  const ceiling = browsingLevel(context);
  if (post?.id !== id || !post.publishedAt || !visibleRating(post.nsfwLevel, ceiling)) return null;
  const visibleIds = new Set((Array.isArray(post.images) ? post.images : [])
    .filter(item => item?.postId === id && numericId(item.id) && visibleRating(item.browsingLevel, ceiling)).map(item => item.id));
  const previews = leads.filter(item => item.postId === id && visibleIds.has(item.id));
  const creator = text(post.user?.username, 80);
  const tags = Array.isArray(post.tags) ? post.tags.filter(tag => numericId(tag?.id) && text(tag.name, 80))
    .slice(0, 5).map(tag => ({ id: tag.id, name: text(tag.name, 80) })) : [];
  const count = visibleIds.size;
  const mediaCount = count ? count + (post.hasMoreImages ? '+' : '') + (count === 1 ? ' media item' : ' media items') : '';
  return {
    id, creator, title: text(post.title, 150) || (creator ? 'Post by ' + creator : 'Civitai post ' + id),
    description: [creator && text(post.title) ? 'by ' + creator : '', mediaCount].filter(Boolean).join(' · '),
    summary: plainArticleText(text(post.detail, 9000)), tags, previews, verifiedMediaIds: [...visibleIds],
    modelVersionId: numericId(post.modelVersionId),
    link: new URL('/posts/' + id, context.origin).href,
  };
}

export async function hydratePosts(context, leads, query, { authorId, ...options }, excluded = new Set()) {
  const byPost = new Map();
  for (const item of leads) {
    if (!item.postId || excluded.has(item.postId)) continue;
    if (!byPost.has(item.postId)) byPost.set(item.postId, []);
    byPost.get(item.postId).push(item);
  }
  const groups = [...byPost];
  const cards = [];
  let partial = false;
  for (let index = 0; index < groups.length; index += 4) {
    const rows = await Promise.allSettled(groups.slice(index, index + 4).map(async ([id, media]) => {
      const record = await read(context, '/api/v1/posts/' + id, {}, options);
      if (authorId !== undefined && record?.user?.id !== authorId) return null;
      const card = postCard(record, id, media, context);
      return card?.previews.length ? card : null;
    }));
    options.signal?.throwIfAborted();
    cards.push(...rows.flatMap(row => row.status === 'fulfilled' && row.value ? [row.value] : []));
    partial ||= rows.some(row => row.status === 'rejected');
    if (rows.some(row => row.status === 'rejected' && row.reason?.status === 429)) break;
  }
  const wanted = terms(query);
  const weight = card => {
    const title = terms(card.title);
    const tags = card.tags.flatMap(tag => terms(tag.name));
    return wanted.reduce((score, word) => score + (title.includes(word) ? 2 : 0) + (tags.includes(word) ? 1 : 0), 0);
  };
  return { items: wanted.length ? cards.sort((a, b) => weight(b) - weight(a)) : cards, partial };
}

export async function readPostPage(context, gallery, { cursor, excluded, ...options } = {}) {
  const page = await readGalleryPage(context, gallery.plan, { ...options, cursor, limit: 10 });
  return {
    ...await hydratePosts(context, page.items, gallery.query, options, excluded),
    nextCursor: page.nextCursor,
  };
}

async function modelPosts(context, query, sort, methods, options) {
  const { rankVersions, queryVariants } = methods;
  const route = context.hosted ? CATALOG.blockModels : CATALOG.models;
  for (const variant of queryVariants(query).slice(0, 2)) {
    const data = await read(context, route, { query: variant, limit: 8, ...(context.hosted ? {} : { nsfw: true }) }, options);
    const ranked = rankVersions([{ label: 'Civitai model search', models: listItems(data) }], query, {}, 2);
    if (!ranked.length) continue;
    const pages = await Promise.all(ranked.map(version => readGalleryPage(context, {
      modelVersionId: version.id, tags: [], sort,
    }, { ...options, limit: 4 })));
    const posts = await hydratePosts(context, pages.flatMap(page => page.items), query, options);
    if (posts.items.length || posts.partial) return posts;
  }
  return { items: [], partial: false };
}

function discovery(target, scope, related) {
  return { target, scope, related, reference: null, candidates: [], shortlisted: [], guides: [], flows: [],
    alternateQueries: [], baseline: [], combined: [] };
}

export async function discoverPosts(context, target, filters, options, methods) {
  const gallery = await prepareGallery(context, target, { ...filters, scope: 'posts' }, options);
  const result = { ...discovery(target, 'posts', { posts: [], postMedia: [] }), gallery };
  try {
    let postId = target.kind === 'post' ? target.id : null;
    if (target.kind === 'image') {
      const { items } = await readGalleryPage(context, gallery.plan, { ...options, limit: 1 });
      postId = items.find(item => item.id === target.id)?.postId;
      if (!postId) return result;
      gallery.nativeLink = new URL('/posts/' + postId, context.origin).href;
    }
    if (postId) {
      const [record, page] = await Promise.allSettled([
        read(context, '/api/v1/posts/' + postId, {}, options),
        readGalleryPage(context, { postId, sort: gallery.plan.sort, tags: [] }, { ...options, limit: 12 }),
      ]);
      options.signal?.throwIfAborted();
      if (record.status === 'rejected') throw record.reason;
      if (page.status === 'rejected') result.flows.push({ label: 'Post media', status: page.reason?.status ?? null });
      const card = postCard(record.value, postId, page.value?.items ?? [], context);
      if (card) {
        result.related.posts = [card];
        result.related.postMedia = card.previews;
        result.exactPost = true;
      }
      return result;
    }

    if (gallery.status === 'ready') {
      const page = await readPostPage(context, gallery, options);
      result.related.posts = page.items;
      gallery.nextCursor = page.nextCursor;
      if (page.partial) result.flows.push({ label: 'Public post details', status: null });
    }
    if (!result.related.posts.length && !result.flows.length && gallery.query &&
        !gallery.plan.username && (!context.hosted || context.token)) {
      const query = translateCatalogTerms(gallery.query)?.focus ?? gallery.query;
      const posts = await modelPosts(context, query, gallery.plan.sort, methods, options);
      result.related.posts = posts.items;
      if (posts.partial) result.flows.push({ label: 'Model-linked post details', status: null });
      gallery.modelMatches = Boolean(result.related.posts.length);
    }
  } catch {
    options.signal?.throwIfAborted();
    gallery.status = 'gallery-unavailable';
  }
  return result;
}

function referenceTarget(link, origin, scope) {
  try {
    const url = new URL(link, origin);
    if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password) return null;
    if (scope === 'crucibles' && (url.origin !== origin || !crucibleReference(url.pathname))) return null;
    const matches = referenceRoutes[scope].exec(url.pathname);
    if (!matches || Number(matches[2]) > 2_147_483_647) return null;
    return { id: Number(matches[2]), path: matches[1].toLowerCase() + '/' + matches[2],
      slug: (matches[3] ?? '').replace(/-/gu, ' ') };
  } catch { return null; }
}

function articleReferences(article, context, scope) {
  const { origin } = context;
  const sourceTitle = text(article.title, 140);
  const source = new URL('/articles/' + article.id, origin).href;
  const preview = articleCover(article, browsingLevel(context));
  const references = [];
  for (const { href, label: name } of articleAnchors(article.content)) {
    const target = referenceTarget(href, origin, scope);
    if (!target) continue;
    const labelIsUrl = /^https?:\/\//iu.test(name);
    if (labelIsUrl && referenceTarget(name, origin, scope)?.path !== target.path) continue;
    const category = scope === 'storylines' ? 'Storyline reference' : scope === 'crucibles' ? 'Crucible reference'
      : target.path.startsWith('/challenges/events/') ? 'Challenge event reference' : 'Challenge reference';
    const generic = /^(?:this|community|my very first)?\s*(?:challenge|crucible)$|^(?:here|click here)$/iu.test(name);
    const slugTitle = target.slug ? target.slug[0].toUpperCase() + target.slug.slice(1) : '';
    const title = name && !labelIsUrl && !generic ? name : slugTitle || category.replace(' reference', '') + ' ' + target.id;
    references.push({ id: target.id, title, category, description: '', preview, previewId: numericId(article.coverImage?.id), source, sourceTitle,
      link: new URL(target.path, origin).href });
  }
  return references;
}

async function discoverReferences(context, target, options, scope) {
  const { origin } = context;
  const challenges = scope === 'challenges';
  const crucibles = scope === 'crucibles';
  const exact = target.kind === scope.slice(0, -1) || (challenges && target.kind === 'challengeEvent');
  const nativePath = '/' + scope + (target.kind === 'challengeEvent' ? '/events' : '') + (exact ? '/' + target.id : '');
  const native = new URL(nativePath, origin);
  const query = text(target.value, 100);
  if (crucibles && !exact && query) native.searchParams.set('query', query);
  const result = { ...discovery(target, scope, { [scope]: [] }), nativeLink: native.href };
  if (challenges && !exact) {
    result.nativeActions = [
      ['Active', '/challenges?status=active'], ['Upcoming', '/challenges?status=upcoming'],
      ['Completed', '/challenges?status=completed'], ['Winners', '/challenges/winners'],
    ].map(([label, path]) => ({ label, link: new URL(path, origin).href }));
  }
  if (crucibles && !exact) {
    result.nativeActions = Object.entries(crucibleFilters).flatMap(([key, values]) =>
      Object.entries(values).map(([value, label]) => {
        const url = new URL(native);
        url.searchParams.set(key, value);
        return { label, link: url.href };
      }));
  }
  if (exact || (target.kind !== 'text' && target.kind !== 'tag')) return result;

  const focus = translateCatalogTerms(query)?.focus ?? query;
  const wanted = terms(focus).filter(word => ![scope, scope.slice(0, -1)].includes(word));
  const seeds = referenceSeeds[scope];
  const termsToRead = wanted.length ? [query, ...(crucibles && focus !== query ? [focus] : [])] : [];
  const queries = [...new Set([seeds[0], ...termsToRead, ...seeds.slice(1)])];
  const sources = await Promise.allSettled(queries.map(q => read(context, CATALOG.articles, { query: q, limit: 5, nsfw: true }, options)));
  options.signal?.throwIfAborted();
  const candidates = new Set(sources.flatMap(source => source.status === 'fulfilled' ? listItems(source.value)
    .filter(item => numericId(item?.id) && !item.unlisted && visibleRating(item.nsfwLevel, browsingLevel(context))).map(item => item.id) : []));
  const articles = [...candidates].slice(0, 8);
  // Civitai's introduction is a stable starting point while discovery uses the live article feed.
  if (crucibles && !wanted.length && !articles.includes(36010)) articles.push(36010);
  const exactArticles = await Promise.allSettled(articles
    .map(id => read(context, '/api/v1/articles/' + id, {}, options)));
  options.signal?.throwIfAborted();
  const matches = new Map();
  const guides = [];
  for (const response of exactArticles) {
    if (response.status !== 'fulfilled' || !publicArticle(response.value, browsingLevel(context))) continue;
    const article = response.value;
    const references = articleReferences(article, context, scope);
    const sourceTitle = text(article.title, 140);
    if ((challenges || crucibles) && !references.length && terms(sourceTitle).some(word => [scope, scope.slice(0, -1)].includes(word)) &&
        wanted.every(word => terms(sourceTitle).includes(word)) &&
        Array.isArray(article.tags) && article.tags.some(tag => tag?.name === 'announcement')) {
      guides.push({ title: sourceTitle, category: crucibles ? 'Crucible guide' : 'Challenge guide', preview: articleCover(article, browsingLevel(context)),
        link: new URL('/articles/' + article.id, origin).href });
    }
    for (const card of references) {
      const titleWords = terms(card.title + ' ' + card.description);
      const articleWords = terms(card.sourceTitle);
      const inSource = [...titleWords, ...articleWords];
      if (!wanted.every(word => inSource.includes(word) || (crucibles && word.length >= 5 &&
        inSource.some(candidate => word[0] === candidate[0] && Math.abs(candidate.length - word.length) <= 1 &&
          editDistance(candidate, word) === 1)))) continue;
      let score = wanted.filter(word => titleWords.includes(word)).length;
      if (crucibles) {
        score += wanted.filter(word => inSource.includes(word)).length;
        if (wanted.length && titleWords.join(' ') === wanted.join(' ')) score += 2;
      }
      const current = matches.get(card.link);
      if (!current || score > current.score) matches.set(card.link, { card, score });
    }
  }
  result.related[scope] = [...matches.values()].sort((a, b) => b.score - a.score).map(item => item.card).slice(0, 12);
  if (guides.length) result.related.guides = guides.slice(0, 2);
  if ([...sources, ...exactArticles].some(source => source.status === 'rejected')) {
    result.flows.push({ label: 'Civitai article references', status: null });
  }
  return result;
}

export const discoverStorylines = (context, target, options) => discoverReferences(context, target, options, 'storylines');
export const discoverChallenges = (context, target, options) => discoverReferences(context, target, options, 'challenges');
export const discoverCrucibles = (context, target, options) => discoverReferences(context, target, options, 'crucibles');
