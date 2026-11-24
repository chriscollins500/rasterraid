import { CATALOG, CatalogError, SITE_ORIGINS, catalogRead, mediaUrl, numericId, previewUrl, text, visibleRating } from './catalog.mjs';

export const libraryScopes = ['vault', 'saved', 'downloads', 'creations', 'notifications', 'messages'];
export const libraryHandoffs = libraryScopes.filter(scope => scope !== 'saved');
export const COLLECTION_SCOPE = 'collections:read:self';
export const PRIVATE_COLLECTION_SCOPE = 'collections:read:private';
export const PICK_LIMIT = 6;

const paths = { vault: '/user/vault', saved: '/collections', downloads: '/user/downloads', creations: '/generate',
  notifications: '/user/notifications', messages: '/' };
const savedLinks = [
  ['Saved models', '/models?favorites=true'], ['Saved articles', '/articles?favorites=true'],
  ['Models from followed creators', '/models?followed=true'], ['Followed hubs', '/hubs'],
];
const labels = { vault: 'Open Vault on Civitai', saved: 'Open Collections on Civitai',
  downloads: 'Open download history on Civitai', creations: 'Open creation history on Civitai',
  notifications: 'Open notifications on Civitai', messages: 'Open Civitai to use Chat' };
const href = (origin, path) => new URL(path, origin).href;

export function libraryReference(url) {
  if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password || url.hash) return null;
  const path = url.pathname + url.search;
  for (const [scope, nativePath] of Object.entries(paths)) {
    if (path === nativePath && scope !== 'messages') return { kind: 'library', scope, path };
  }
  const saved = savedLinks.find(([, nativePath]) => nativePath === path && path !== '/hubs');
  if (saved) return { kind: 'library', scope: 'saved', path, label: saved[0] + ' on Civitai' };
  return null;
}

export function isLibraryNavigation(url, viewerUsername) {
  const following = viewerUsername && '/user/' + encodeURIComponent(viewerUsername) + '/following';
  return Boolean(libraryReference(url) || (url.pathname === '/' || url.pathname === following) && !url.search && !url.hash);
}

export function hasCollectionAccess(context, includePrivate = false) {
  return Boolean(context.hosted && context.signedIn && context.token && context.scopes.includes(COLLECTION_SCOPE) &&
    (!includePrivate || context.scopes.includes(PRIVATE_COLLECTION_SCOPE)));
}

function collectionCard(origin, row, ceiling) {
  if (!numericId(row?.id) || !text(row.name) || typeof row.isPublic !== 'boolean') return null;
  const count = Number.isSafeInteger(row.itemCount) && row.itemCount >= 0 ? row.itemCount : null;
  const path = href(origin, '/collections/' + row.id);
  return {
    id: row.id, title: text(row.name, 160), link: path,
    category: row.isPublic ? (row.followed === true ? 'Followed collection' : 'Public collection') : 'Private or unlisted collection',
    description: count === null ? '' : count.toLocaleString() + (count === 1 ? ' item' : ' items'),
    preview: visibleRating(row.coverNsfwLevel, ceiling) ? previewUrl(row.coverImageUrl) : null,
    previewBadge: 'Collection cover',
    lookup: { label: 'Preview collection media', link: path, scope: 'saved' },
  };
}

function collectionMedia(origin, row, ceiling) {
  if (!numericId(row?.mediaId) || !['image', 'video'].includes(row.type) || !visibleRating(row.nsfwLevel, ceiling)) return null;
  const video = row.type === 'video';
  const url = mediaUrl(row.url);
  const author = text(row.creator?.username, 80);
  return { id: row.mediaId, video, url: video ? null : url, tags: [],
    title: (video ? 'Video' : 'Picture') + (author ? ' by ' + author : ''),
    link: href(origin, '/images/' + row.mediaId),
    stream: video && url && /\.(?:mp4|webm)$/iu.test(new URL(url).pathname) ? url : null,
    preview: previewUrl(video ? row.thumbnailUrl : url), previewBadge: 'Collection item',
    ...(video && { width: numericId(row.width), height: numericId(row.height) }),
  };
}

export async function readLibraryPage(context, plan, { cursor, signal, fetcher, limit } = {}) {
  if (!hasCollectionAccess(context, plan.includePrivate) || (plan.mode === 'mine' && !plan.includePrivate &&
      context.scopes.includes(PRIVATE_COLLECTION_SCOPE))) throw new Error('Choose which collections to share with RasterRaid.');
  const { origin, token } = context;
  const ceiling = context.browsingLevel ?? 1;
  const detail = plan.collectionId;
  const { data } = await catalogRead(origin, detail ? CATALOG.blockCollections + '/' + detail : CATALOG.blockCollections,
    { mode: detail ? undefined : plan.mode === 'followed' ? 'public' : 'mine', query: detail ? undefined : plan.query,
      cursor, limit: limit ?? (plan.mode === 'followed' && !detail ? 24 : 12) }, { token, signal, fetcher, privateRead: true });
  if (!Array.isArray(data.items)) throw new Error('Civitai did not return collection data.');
  if (detail && (data.collection?.id !== detail || data.collection?.isPublic !== true && !plan.includePrivate)) {
    throw new CatalogError('Civitai did not share this collection.', { status: 404 });
  }
  const items = detail ? data.items.map(row => collectionMedia(origin, row, ceiling)).filter(Boolean)
    : data.items.filter(row => plan.mode === 'followed' ? row?.isPublic === true && row.followed === true
      : row?.isPublic === true || plan.includePrivate).map(row => collectionCard(origin, row, ceiling)).filter(Boolean);
  const next = data.nextCursor;
  const validCursor = detail ? typeof next === 'string' && next.length > 0 && next.length <= 200 : numericId(next);
  return { items, nextCursor: validCursor && next !== cursor ? next : null, title: text(data.collection?.name, 160) };
}

export async function discoverLibrary(context, target, filters, options = {}) {
  const { origin } = context;
  const scope = filters.scope;
  const detail = scope === 'saved' && target.kind === 'collection' ? target.id : null;
  const path = detail ? '/collections/' + detail : target.kind === 'library' ? target.path : paths[scope];
  const nativeLabel = detail ? 'Open full collection on Civitai' : target.label ?? labels[scope];
  const result = {
    scope, target, library: { scope, nativeLabel, status: 'ready' }, nativeLink: href(origin, path),
    related: {}, reference: null, candidates: [], shortlisted: [], guides: [], flows: [], alternateQueries: [], baseline: [], combined: [],
  };
  if (scope !== 'saved') return result;

  result.nativeActions = savedLinks.filter(([, link]) => link !== path).map(([label, link]) => ({ label, link: href(origin, link) }));
  if (context.viewerUsername) result.nativeActions.push({ label: 'Creators you follow',
    link: href(origin, '/user/' + encodeURIComponent(context.viewerUsername) + '/following') });
  const mode = filters.libraryMode;
  const query = text(target.value, 100);
  if (!['mine', 'followed'].includes(mode)) return result;
  if (mode === 'followed' && !detail && !query) {
    result.library.status = 'followed-needs-query';
    return result;
  }
  const includePrivate = mode === 'mine' && filters.libraryPrivate === true;
  if (!hasCollectionAccess(context, includePrivate)) {
    result.library.status = 'access-needed';
    return result;
  }
  const plan = { mode, includePrivate, query, collectionId: detail };
  try {
    const page = await readLibraryPage(context, plan, options);
    const group = detail ? 'libraryMedia' : 'libraryCollections';
    result.related[group] = page.items;
    result.library.pager = { scope: group, plan, nextCursor: page.nextCursor };
    result.library.status = detail ? 'collection' : mode;
    result.library.includesPrivate = includePrivate;
    if (page.title) result.directoryTitle = page.title;
  } catch (error) {
    options.signal?.throwIfAborted();
    result.library.status = [401, 403, 404].includes(error.status) ? 'access-needed' : 'unavailable';
  }
  return result;
}

export function creationPicks(origin, picks, source, ceiling) {
  const seen = new Set();
  return (Array.isArray(picks) ? picks : []).slice(0, PICK_LIMIT).flatMap(pick => {
    if (pick?.source !== source || !['generated', 'posted'].includes(source) || !visibleRating(pick.nsfwLevel, ceiling) ||
        !numericId(pick.width) || !numericId(pick.height)) return [];
    let url;
    try { url = new URL(pick.url); } catch { return []; }
    if (!['https://image.civitai.com', 'https://blobs-b2.civitai.com'].includes(url.origin) || url.username || url.password || seen.has(url.href)) return [];
    const imageId = source === 'posted' ? numericId(pick.imageId) : null;
    if (source === 'posted' && !imageId) return [];
    seen.add(url.href);
    return [{ id: imageId ?? seen.size, title: source === 'posted' ? 'Posted picture' : 'Generated picture',
      category: 'Selected from Civitai', description: pick.width + ' × ' + pick.height,
      preview: url.href, previewBadge: 'Your selection', link: href(origin, imageId ? '/images/' + imageId : paths.creations) }];
  });
}
