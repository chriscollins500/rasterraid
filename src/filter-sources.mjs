import { CATALOG, SITE_ORIGINS, catalogRead } from './catalog.mjs';
import { FILTER_PATH, choices, modelEnumChoices } from '../hosting/filter-feed/worker/index.js';
import { PUBLIC_FILTER_FEED } from './runtime-config.mjs';
export { FILTER_REFRESH_MS, modelEnumChoices } from '../hosting/filter-feed/worker/index.js';

export function toolFilterChoices(data) {
  const tool = Array.isArray(data?.tools) ? data.tools.find(item => item?.function?.name === 'search_models') : null;
  const fields = tool?.function?.parameters?.properties;
  return {
    modelTypes: choices(fields?.types?.items?.enum),
    sorts: choices(fields?.sort?.enum),
    periods: choices(fields?.period?.enum),
  };
}

export function applyFilterChoices(previous, { types, bases, activeBases, sorts, periods } = {}) {
  return {
    modelTypes: choices(types) ?? previous.modelTypes,
    baseModels: choices(bases) ?? previous.baseModels,
    ...(activeBases || previous.activeBaseModels ? { activeBaseModels: choices(activeBases) ?? previous.activeBaseModels } : {}),
    sorts: choices(sorts) ?? previous.sorts,
    periods: choices(periods) ?? previous.periods,
  };
}

export async function fetchFilterMetadata(origin, { localFeed, signal, fetcher = fetch } = {}) {
  if (!SITE_ORIGINS.includes(origin)) throw new TypeError('Expected a Civitai origin.');
  for (const endpoint of [PUBLIC_FILTER_FEED, localFeed].filter(Boolean)) {
    const url = new URL(endpoint);
    if (url.pathname !== FILTER_PATH || url.username || url.password || url.hash) continue;
    url.searchParams.set('domain', origin === SITE_ORIGINS[1] ? 'red' : 'com');
    try {
      const response = await fetcher(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) continue;
      const data = await response.json();
      const modelTypes = choices(data?.modelTypes);
      const activeBaseModels = choices(data?.activeBaseModels);
      const baseModels = choices(data?.baseModels);
      if (data?.source !== origin + CATALOG.enums || typeof data.stale !== 'boolean' ||
          !Number.isSafeInteger(data.checkedAt) || data.checkedAt <= 0 || data.checkedAt > Date.now() + 60_000 ||
          !modelTypes || !baseModels || !activeBaseModels || !activeBaseModels.every(name => baseModels.includes(name))) continue;
      return { modelTypes, activeBaseModels, baseModels, stale: data.stale, checkedAt: data.checkedAt };
    } catch {
      signal?.throwIfAborted();
    }
  }
  const { data } = await catalogRead(origin, CATALOG.enums, {}, { signal, fetcher });
  const metadata = modelEnumChoices(data);
  return metadata && { ...metadata, stale: false, checkedAt: Date.now() };
}
