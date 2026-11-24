import { numericId, text } from './catalog.mjs';
import { hydratePosts } from './community.mjs';
import { directoryReference } from './directory.mjs';
import { modelCreatorName } from './model-access.mjs';

export const creatorReportSources = ['users', 'models', 'gallery', 'videos', 'articles', 'posts', 'collections', 'comics'];
const roleLabels = {
  models: 'Civitai credits this account with the model', gallery: 'This account uploaded the picture',
  videos: 'This account uploaded the clip', articles: 'Civitai lists this account as the article author',
  posts: 'This account published the post', collections: 'This account curates the collection',
  comics: 'Civitai lists this account as the comic creator',
};
const authorKey = value => modelCreatorName(value).toLowerCase();
const perSource = 5;
const leadLimit = 5;
const postLimit = 4;

export function creatorBrief(value, origin, selected) {
  const brief = text(value, 500);
  const named = /^@([\p{L}\p{N}_-]{1,80})(?:\s+(.+))?$/su.exec(brief);
  const numbered = /^(?:user\s*[#: ]\s*|#)?([1-9]\d{0,9})$/iu.exec(brief);
  let input = named ? { handle: named[1], topic: text(named[2], 160) }
    : numbered && Number(numbered[1]) <= 2_147_483_647 ? { id: Number(numbered[1]), topic: '' } : { topic: text(brief, 160) };
  if (/^https?:\/\//iu.test(brief)) {
    const url = new URL(brief);
    const profile = directoryReference(url);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || profile?.kind !== 'user') {
      throw new Error('Paste a public creator profile on this Civitai domain.');
    }
    input = { handle: profile.handle, topic: '' };
  }
  if (brief.startsWith('@') && !named) throw new Error('Type a Civitai username after @, then an optional topic.');
  if (!selected) return input;
  if (input.handle && authorKey(input.handle) !== authorKey(selected)) throw new Error('The search and Creator filter name different accounts.');
  return input.id || input.handle ? input : { ...input, handle: selected };
}

const itemsFor = (scope, result) => scope === 'models' ? result?.candidates ?? [] : result?.related?.[scope] ?? [];
function scopedResult(scope, result, items) {
  return { ...result, scope, candidates: scope === 'models' ? items : [], related: scope === 'models' ? {} : { [scope]: items },
    flows: result?.flows ?? [{ label: 'Civitai ' + scope, status: null }] };
}

function profileFor(context, result, identity) {
  const profiles = itemsFor('users', result).filter(card => numericId(card.id) && authorKey(card.title) &&
    card.link === new URL('/user/' + encodeURIComponent(card.title), context.origin).href &&
    (!identity.id || card.id === identity.id) && (!identity.handle || authorKey(card.title) === authorKey(identity.handle)));
  return profiles.length === 1 ? profiles[0] : null;
}

function filterFor(scope, topic, creator, modelFilters) {
  if (scope === 'models') return { ...modelFilters, ...(creator && { modelAuthor: creator }), query: topic,
    ...(!topic && !modelFilters.sort && !modelFilters.period && { sort: 'Newest' }) };
  if (scope === 'gallery' || scope === 'videos') return { query: topic, ...(creator && { mediaCreator: creator }),
    ...(!topic && { mediaSort: 'Newest' }) };
  const authorField = { articles: 'articleAuthor', collections: 'collectionAuthor', comics: 'comicAuthor' }[scope];
  return { query: topic, ...(creator && authorField && { [authorField]: creator }) };
}

export async function readCreatorTrail(context, scopes, input, modelFilters, { discoverSource, signal, fetcher, onPhase }) {
  const options = { signal, fetcher };
  async function search(scope, choices) {
    try {
      const result = await discoverSource(context, { scope, ...choices }, options);
      signal?.throwIfAborted();
      return result;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }
  async function profile(identity) {
    const query = identity.id ? 'User #' + identity.id : '@' + identity.handle;
    const result = await search('users', { query });
    return { result, card: profileFor(context, result, identity) };
  }
  const { topic } = input;
  const sources = scopes.filter(scope => scope !== 'users');
  const rows = new Map();
  if (input.handle || input.id) {
    onPhase('Checking the exact creator profile…');
    const { result, card } = await profile(input);
    rows.set('users', scopedResult('users', result, card ? [{ ...card, lookup: null }] : []));
    if (!card) return { rows, summary: { topic, unavailable: true } };

    onPhase('Finding public work credited to @' + card.title + '…');
    const creator = authorKey(card.title);
    if (modelFilters.modelAuthor && authorKey(modelFilters.modelAuthor) !== creator) {
      throw new Error('The profile and Creator filter name different accounts.');
    }
    const work = sources.filter(scope => scope !== 'posts');
    if (scopes.includes('posts') && !work.includes('gallery') && !work.includes('videos')) work.push('gallery', 'videos');
    const checked = await Promise.all(work.map(async scope => {
      const result = await search(scope, filterFor(scope, topic, card.title, modelFilters));
      const items = itemsFor(scope, result).filter(item => authorKey(item.creator) === creator);
      return { scope, result, items };
    }));
    for (const { scope, result, items } of checked) if (scopes.includes(scope)) rows.set(scope, scopedResult(scope, result, items));
    if (scopes.includes('posts')) {
      const samples = new Map();
      const media = checked.filter(({ scope }) => ['gallery', 'videos'].includes(scope));
      for (let index = 0; index < perSource; index++) {
        for (const { items } of media) {
          const item = items[index];
          if (!numericId(item?.postId) || item.postId > 2_147_483_647) continue;
          if (samples.size < postLimit && !samples.has(item.postId)) samples.set(item.postId, []);
          samples.get(item.postId)?.push(item);
        }
      }
      if (samples.size) onPhase('Verifying public posts from the selected pictures and clips…');
      const posts = await hydratePosts(context, [...samples.values()].flat(), topic, options);
      rows.set('posts', scopedResult('posts', { nativeLink: card.link + '/posts', flows: posts.partial ? [{ status: null }] : [] },
        posts.items.filter(item => authorKey(item.creator) === creator)));
    }
    return { rows, summary: { profile: card, topic } };
  }

  onPhase('Finding public work and the accounts credited with it…');
  const matches = await Promise.all(sources.map(async scope => ({ scope, result: await search(scope, filterFor(scope, topic, '', modelFilters)) })));
  const authors = new Map();
  for (const { scope, result } of matches) {
    for (const [position, item] of itemsFor(scope, result).slice(0, perSource).entries()) {
      const key = authorKey(item.creator);
      if (!key) continue;
      if (!authors.has(key)) authors.set(key, { handle: item.creator, sources: new Map() });
      const source = authors.get(key).sources;
      if (!source.has(scope)) source.set(scope, { item, position });
    }
  }
  const ranked = [...authors.values()].sort((a, b) => b.sources.size - a.sources.size ||
    [...a.sources.values()].reduce((sum, row) => sum + row.position, 0) - [...b.sources.values()].reduce((sum, row) => sum + row.position, 0))
    .slice(0, leadLimit);
  if (ranked.length) onPhase('Checking the creator profiles behind the strongest matches…');
  const resolved = await Promise.all(ranked.map(async lead => ({ ...lead, ...await profile(lead) })));
  const leads = resolved.filter(lead => lead.card).map(({ card, sources }) => ({ profile: card, examples: [...sources.entries()].map(([scope, { item }]) =>
    ({ scope, title: item.title ?? [item.model, item.version].filter(Boolean).join(' · '), link: item.link })) }));
  rows.set('users', scopedResult('users', { nativeLink: new URL('/search/users?query=' + encodeURIComponent(topic), context.origin).href,
    flows: resolved.some(lead => !lead.card && (!lead.result || lead.result.flows?.length)) ? [{ status: null }] : [] }, leads.map(lead => lead.profile)));
  const verified = new Set(leads.map(lead => authorKey(lead.profile.title)));
  for (const { scope, result } of matches) rows.set(scope, scopedResult(scope, result,
    itemsFor(scope, result).filter(item => verified.has(authorKey(item.creator)))));
  return { rows, summary: { topic, leads } };
}

export function creatorEdges(scope, result, profiles) {
  if (!roleLabels[scope]) return [];
  const links = new Map(profiles.map(profile => [authorKey(profile.title), profile.link]));
  return itemsFor(scope, result).slice(0, perSource).flatMap(item => links.has(authorKey(item.creator)) ? [{
    kind: 'creator-credit', label: roleLabels[scope], first: item.link, second: links.get(authorKey(item.creator)),
  }] : []);
}
