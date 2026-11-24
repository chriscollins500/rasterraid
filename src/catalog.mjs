import { CIVITAI_IMAGE_DELIVERY, NATIVE_MODELS_INDEX } from './runtime-config.mjs';

export const SITE_ORIGINS = Object.freeze(['https://civitai.com', 'https://civitai.red']);

export const CATALOG = Object.freeze({
  models: '/api/v1/models',
  images: '/api/v1/images',
  articles: '/api/v1/articles',
  collections: '/api/v1/collections',
  creators: '/api/v1/creators',
  hashVersionIds: '/api/v1/model-versions/by-hash/ids',
  generationPermissions: '/api/v1/permissions/check',
  users: '/api/v1/users',
  tags: '/api/v1/tags',
  comics: '/api/v1/comics',
  apps: '/api/v1/apps',
  enums: '/api/v1/enums',
  blockModels: '/api/v1/blocks/models',
  blockImages: '/api/v1/blocks/images',
  blockResources: '/api/v1/blocks/generation-resources',
  blockTools: '/api/v1/blocks/tools',
  blockCollections: '/api/v1/blocks/collections',
  blockGatedImages: '/api/v1/blocks/gated-images',
});

const routes = new Set(Object.values(CATALOG));
const listRoutes = new Set([CATALOG.models, CATALOG.images, CATALOG.articles, CATALOG.collections,
  CATALOG.creators, CATALOG.users, CATALOG.tags, CATALOG.comics, CATALOG.apps,
  CATALOG.blockModels, CATALOG.blockImages, CATALOG.blockResources]);
const exactRoute = /^\/api\/v1\/(?:models\/\d+|model-versions\/(?:\d+|by-hash\/[a-fA-F0-9]{64})|(?:blocks\/)?collections\/\d+|articles\/\d+|posts\/\d+|comics\/\d+(?:\/chapters\/\d+)?|apps\/[a-z\d][a-z\d-]{0,63})$/u;

export const text = (value, max = 220) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function visibleRating(value, ceiling) {
  return Number.isInteger(value) && value > 0 && value <= 63 && (value & ceiling) === value;
}

export function mediaUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://image.civitai.com' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function previewUrl(value) {
  const safeUrl = mediaUrl(value);
  if (!safeUrl) return null;
  const url = new URL(safeUrl);
  const parts = url.pathname.split('/');
  if (parts.length === 5 && /^[\da-f-]{36}$/i.test(parts[2]) && parts[3].includes('=')) {
    parts[3] = 'anim=false,width=640,optimized=true';
    url.pathname = parts.join('/');
  }
  return url.href;
}

export function clipAnalysisUrl(value) {
  const safe = mediaUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  const parts = url.pathname.split('/');
  if (parts.length === 5 && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(parts[2]) &&
      parts[3] === 'original=true' && /\.mp4$/iu.test(parts[4]) && !url.search && !url.hash) {
    parts[3] = 'transcode=true,width=320,original=false,optimized=true';
    url.pathname = parts.join('/');
  }
  return url.href;
}

export function catalogImagePreview(image, ceiling) {
  if (image?.needsReview || image?.blockedFor || !visibleRating(image?.browsingLevel ?? image?.nsfwLevel, ceiling)) return null;
  if (image.type === 'video') return previewUrl(image.thumbnail?.url ?? image.thumbnail);
  const direct = previewUrl(image.url);
  if (direct) return direct;
  // Civitai's image client adds .jpeg to older image names stored as the asset UUID.
  const name = image.name === image.url ? image.name + '.jpeg' : image.name;
  if (image.type !== 'image' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(image.url) ||
      !/^[^/\\]+\.(?:avif|gif|jpe?g|png|webp)$/iu.test(name)) return null;
  return new URL(image.url + '/anim=false,width=640,optimized=true/' + encodeURIComponent(name), CIVITAI_IMAGE_DELIVERY).href;
}

export class CatalogError extends Error {
  constructor(message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'CatalogError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const catalogDeadlines = new WeakMap();
const retryTime = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

function catalogPauseError(remaining) {
  const seconds = Math.ceil(remaining / 1_000);
  const delay = seconds < 60 ? retryTime.format(seconds, 'second')
    : seconds < 3_600 ? retryTime.format(Math.ceil(seconds / 60), 'minute')
      : retryTime.format(Math.ceil(seconds / 3_600), 'hour');
  return new CatalogError(`Civitai paused catalog requests. Try again ${delay}.`, { status: 429, retryAfter: String(seconds) });
}

export function catalogPause(origin, fetcher = fetch) {
  const remaining = (catalogDeadlines.get(fetcher)?.get(origin) ?? 0) - Date.now();
  return remaining > 0 ? catalogPauseError(remaining) : null;
}

function checkCatalogPause(origin, fetcher, signal, source) {
  signal?.throwIfAborted();
  const pause = catalogPause(origin, fetcher);
  if (pause) throw pause;
  const deadlines = catalogDeadlines.get(fetcher);
  const remaining = (deadlines?.get(source) ?? 0) - Date.now();
  if (remaining > 0) {
    throw new CatalogError('Civitai asked us to wait before checking this source again.', {
      status: 503, retryAfter: String(Math.ceil(remaining / 1_000)),
    });
  }
  deadlines?.delete(source);
}

function catalogResponseError(response, origin, fetcher, source, message) {
  const after = response.headers.get('retry-after');
  void response.body?.cancel().catch(() => {});
  const { status } = response;
  const error = new CatalogError(message, { status, retryAfter: after });
  if (status !== 429 && status !== 503) return error;
  const now = Date.now();
  const value = after?.trim() ?? '';
  const deadline = /^\d+$/u.test(value) ? now + Number(value) * 1_000 : /^[a-z]+[ ,]/iu.test(value) ? Date.parse(value) : NaN;
  if (status === 503 && Number.isSafeInteger(deadline) && deadline <= now) return error;
  const retryAt = Number.isSafeInteger(deadline) ? Math.max(now + 1_000, deadline) : now + (status === 429 ? 15_000 : 2_000);
  let deadlines = catalogDeadlines.get(fetcher);
  if (!deadlines) {
    deadlines = new Map();
    catalogDeadlines.set(fetcher, deadlines);
  }
  for (const [key, until] of deadlines) if (until <= now) deadlines.delete(key);
  const key = status === 429 ? origin : source;
  const latest = Math.max(deadlines.get(key) ?? 0, retryAt);
  deadlines.set(key, latest);
  return status === 429 ? catalogPauseError(latest - now) : error;
}

export function catalogUrl(origin, route, query = {}) {
  if (!SITE_ORIGINS.includes(origin) || (!routes.has(route) && !exactRoute.test(route))) {
    throw new TypeError('Unsupported Civitai catalog destination.');
  }
  const url = new URL(route, origin);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const part of value) url.searchParams.append(key, String(part));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function catalogRead(origin, route, query, { token, signal, headerProbe = false, fetcher = fetch, privateRead = false, fileHashes } = {}) {
  const url = catalogUrl(origin, route, query);
  const headers = { Accept: 'application/json' };
  const hashLookup = route === CATALOG.hashVersionIds;
  if (hashLookup) {
    if (!Array.isArray(fileHashes) || !fileHashes.length || fileHashes.length > 8 ||
        !fileHashes.every(value => typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value))) {
      throw new TypeError('A lookup requires one to eight full SHA-256 hashes.');
    }
    headers['Content-Type'] = 'application/json';
  }
  if (token && route.startsWith('/api/v1/blocks/')) headers.Authorization = `Bearer ${token}`;
  if (headerProbe) headers.Origin = 'null';
  const body = hashLookup ? JSON.stringify(fileHashes) : null;
  const selection = new URL(url);
  // Ranked gallery lanes can request a larger next batch after a sibling lane finishes.
  if (Number(selection.searchParams.get('limit')) > 0) selection.searchParams.delete('limit');
  const source = body ? selection.href + '\0' + body : selection.href;
  checkCatalogPause(origin, fetcher, signal, source);
  const timeout = AbortSignal.timeout(14_000);
  const response = await fetcher(url, {
    headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    ...(privateRead || hashLookup ? { cache: 'no-store' } : {}),
    ...(hashLookup ? { method: 'POST', body } : {}),
  });
  const details = {
    status: response.status,
    cors: response.headers.get('access-control-allow-origin'),
    cache: response.headers.get('cache-control'),
  };
  if (!response.ok) throw catalogResponseError(response, origin, fetcher, source, `Civitai returned HTTP ${response.status}.`);
  if (!response.headers.get('content-type')?.includes('application/json')) {
    void response.body?.cancel().catch(() => {});
    throw new CatalogError('Civitai returned a response outside the catalog contract.');
  }
  const data = await response.json();
  if (!data || typeof data !== 'object' || listRoutes.has(route) && !Array.isArray(data) && !Array.isArray(data.items)) {
    throw new CatalogError('Civitai did not return the requested catalog data.');
  }
  return { data, ...details };
}

async function siteSearchRequest(origin, path, body, { signal, fetcher = fetch } = {}) {
  if (!SITE_ORIGINS.includes(origin)) throw new TypeError('Unsupported Civitai search host.');
  const url = new URL(path, origin);
  const payload = JSON.stringify(body);
  const source = url.href + '\0' + payload;
  checkCatalogPause(origin, fetcher, signal, source);
  const timeout = AbortSignal.timeout(7_000);
  const response = await fetcher(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: payload,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw catalogResponseError(response, origin, fetcher, source, 'Civitai site search did not respond.');
  return response.json();
}

export async function siteSearch(origin, queries, options) {
  const data = await siteSearchRequest(origin, '/api/search/multi-search', { queries }, options);
  if (!Array.isArray(data?.results) || data.results.length !== queries.length || data.results.some(result => !Array.isArray(result?.hits))) {
    throw new Error('Civitai did not return the requested search results.');
  }
  return data.results;
}

export async function siteTagFacets(origin, prefix, options) {
  const facetQuery = text(prefix, 12);
  if (!/^\p{L}{3,8}$/u.test(facetQuery)) throw new TypeError('Choose a short tag prefix.');
  const path = '/api/search/indexes/' + NATIVE_MODELS_INDEX + '/facet-search';
  const data = await siteSearchRequest(origin, path, { facetName: 'tags.name', facetQuery }, options);
  if (!Array.isArray(data?.facetHits)) throw new CatalogError('Civitai did not return tag choices.');
  return data.facetHits.slice(0, 1_000).map(row => ({
    name: text(row?.value, 80), count: Number.isSafeInteger(row?.count) && row.count > 0 ? row.count : 0,
  })).filter(row => row.name);
}

export function listItems(data) {
  return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
}

export function numericId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function civitaiAir(value) {
  if (typeof value !== 'string' || value.length > 250) return null;
  const match = /^urn:air:[\w-]{0,64}:[\w-]{0,64}:civitai:([1-9]\d{0,14})(?:@([1-9]\d{0,14}))?(?:\+([1-9]\d{0,14}))?(?:\.([\w-]{1,32}))?$/iu.exec(value);
  if (!match) return null;
  const [, model, version, file, format] = match;
  return version ? { kind: 'version', id: Number(version), modelId: Number(model), air: value, fileId: numericId(Number(file)), format }
    : { kind: 'model', id: Number(model), air: value, fileId: numericId(Number(file)), format };
}

export function listSummary(data) {
  const items = listItems(data);
  const firstItem = items.find(item => item && typeof item === 'object');
  return {
    count: items.length,
    hasCursor: Boolean(data?.metadata?.nextCursor ?? data?.nextCursor ?? data?.metadata?.nextPage),
    firstId: numericId(firstItem?.id) ?? numericId(data?.id),
    keys: Object.keys(firstItem ?? data).slice(0, 24),
  };
}
