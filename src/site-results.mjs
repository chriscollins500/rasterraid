import { CATALOG, listItems, numericId, previewUrl, text, visibleRating } from './catalog.mjs';

function card(origin, path, title, description, preview) {
  return { title, description, preview, link: new URL(path, origin).href };
}

export function collectionResult(origin, entry, ceiling) {
  if (entry?.isPublic !== true || !numericId(entry.id) || !text(entry.name) || !visibleRating(entry.nsfwLevel, ceiling)) return null;
  const cover = entry.coverImage;
  const preview = visibleRating(cover?.nsfwLevel, ceiling) ? previewUrl(cover.url ?? entry.coverImageUrl) : null;
  const count = Number.isSafeInteger(entry.itemCount) && entry.itemCount >= 0
    ? entry.itemCount.toLocaleString('en-US') + (entry.itemCount === 1 ? ' item' : ' items') : '';
  const result = card(origin, '/collections/' + entry.id, text(entry.name), count || 'Public collection', preview);
  return { id: entry.id, ...result, creator: text(entry.user?.username, 80), collectionType: text(entry.type, 32), ...(entry.type === 'Image' && {
    lookup: { label: 'Explore collection', link: result.link, scope: 'report', reportType: 'collection' },
  }) };
}

function guideResult(origin, entry, ceiling) {
  if (!numericId(entry?.id) || !text(entry.title) || entry.unlisted || !visibleRating(entry.nsfwLevel, ceiling)) return null;
  const cover = entry.coverImage;
  const preview = visibleRating(cover?.nsfwLevel, ceiling) ? previewUrl(cover.url) : null;
  return card(origin, '/articles/' + entry.id, text(entry.title), 'Article', preview);
}

function creatorResult(origin, entry) {
  const username = text(entry?.username, 80);
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) return null;
  const count = Number.isSafeInteger(entry.modelCount) && entry.modelCount >= 0 ? entry.modelCount : null;
  return card(origin, '/user/' + encodeURIComponent(username), username,
    count === null ? 'Creator' : count + (count === 1 ? ' model' : ' models'), previewUrl(entry.image));
}

function comicResult(origin, entry, ceiling) {
  if (!numericId(entry?.id) || !text(entry.name) || !visibleRating(entry.nsfwLevel, ceiling)) return null;
  const cover = entry.coverImage;
  return card(origin, '/comics/' + entry.id, text(entry.name), text(entry.genre, 50) || 'Comic',
    visibleRating(cover?.nsfwLevel, ceiling) ? previewUrl(cover.url) : null);
}

export async function searchSite(read, origin, input, scope, ceiling, fallback = '', { includeTags = true } = {}) {
  const include = type => scope === 'all' || scope === type;
  const bounded = text(input, 100);
  const requests = [];
  if (include('collections')) requests.push(['collections', 'Public collections', CATALOG.collections,
    { query: bounded, nsfw: true, limit: 8 }, collectionResult]);
  if (include('guides')) requests.push(['guides', 'Articles and guides', CATALOG.articles,
    { query: bounded, nsfw: true, limit: 6 }, guideResult]);
  if (include('creators')) requests.push(['creators', 'Creators', CATALOG.creators,
    { query: bounded, limit: 5 }, creatorResult]);
  if (includeTags && (include('tags') || scope === 'models')) requests.push(['tags', 'Tags', CATALOG.tags,
    { query: bounded, limit: 5 }, (_origin, item) => {
      const name = text(item?.name, 80);
      return name ? { title: name, description: 'Find models with this tag', tag: name } : null;
    }]);

  // These list endpoints have no title query. Match the brief only against the
  // returned batch and identify it as a partial catalog search in the view.
  const parts = [bounded, fallback].join(' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const matches = item => {
    const name = [item.title, item.description].join(' ').toLowerCase();
    return !parts.length || parts.some(part => part.length > 2 && name.includes(part));
  };
  if (scope === 'comics') requests.push(['comics', 'Recent comics', CATALOG.comics,
    { nsfw: true, limit: 30 }, (...args) => {
      const item = comicResult(...args);
      return item && matches(item) ? item : null;
    }]);
  return Object.fromEntries(await Promise.all(requests.map(async ([key, label, route, params, project]) => {
    const data = await read(label, route, params, true);
    const cards = listItems(data).map(entry => project(origin, entry, ceiling)).filter(Boolean);
    if (cards.length || !fallback || !params.query || key === 'creators') return [key, cards];
    const expanded = await read(label + ' (expanded query)', route, { ...params, query: text(fallback, 100) }, true);
    return [key, listItems(expanded).map(entry => project(origin, entry, ceiling)).filter(Boolean)];
  })));
}
