export const FILTER_REFRESH_MS = 120_000;
export const FILTER_PATH = '/filter-options.json';
const ENUM_PATH = '/api/v1/enums';
const origins = new Map([['com', 'https://civitai.com'], ['red', 'https://civitai.red']]);

export function choices(value) {
  if (!Array.isArray(value) || !value.length || value.length > 1500 ||
      value.some(item => typeof item !== 'string' || !item.trim() || item.length > 100)) return null;
  return [...new Set(value)];
}

export function modelEnumChoices(data) {
  const modelTypes = choices(data?.ModelType);
  const activeBaseModels = choices(data?.ActiveBaseModel);
  const historical = choices(data?.BaseModel);
  if (!modelTypes || !activeBaseModels || !historical) return null;
  return { modelTypes, activeBaseModels, baseModels: [...new Set([...activeBaseModels, ...historical])] };
}

async function readEnums(origin, path, _query, { signal }) {
  const response = await fetch(new URL(path, origin), {
    headers: { Accept: 'application/json' }, redirect: 'manual', signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Civitai enum feed unavailable (HTTP ' + response.status + ').');
  }
  return { data: await response.json() };
}

export function createFilterFeed({ read = readEnums, now = Date.now } = {}) {
  const cache = new Map();
  return async function filterFeed(domain) {
    const origin = origins.get(domain);
    if (!origin) return { status: 400, data: { error: 'Select a Civitai domain.' } };
    const current = cache.get(domain);
    if (current?.pending) return current.pending;
    if (current && now() - current.checkedAt < FILTER_REFRESH_MS) return current.result;

    const pending = (async () => {
      let result;
      try {
        const { data } = await read(origin, ENUM_PATH, {}, { signal: AbortSignal.timeout(7_000) });
        const metadata = modelEnumChoices(data);
        if (!metadata) throw new Error('Unexpected Civitai enum response.');
        result = { status: 200, data: { ...metadata, source: origin + ENUM_PATH, checkedAt: now(), stale: false } };
      } catch (error) {
        if (read === readEnums) console.warn('Civitai enum request failed for', domain, error?.message ?? 'Unknown error');
        result = current?.result.status === 200
          ? { status: 200, data: { ...current.result.data, stale: true } }
          : { status: 503, data: { error: 'Civitai filters are temporarily unreachable.' } };
      }
      cache.set(domain, { checkedAt: now(), result });
      return result;
    })();
    cache.set(domain, { pending });
    return pending;
  };
}

export function createFilterHandler(filterFeed = createFilterFeed()) {
  return async function fetchFilters(request) {
    const url = new URL(request.url);
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    };
    if (url.pathname !== FILTER_PATH) return Response.json({ error: 'Not found.' }, { status: 404, headers });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json({ error: 'This feed is read-only.' }, { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
    }
    const params = [...url.searchParams];
    if (params.length !== 1 || params[0][0] !== 'domain' || !origins.has(params[0][1])) {
      return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: 'Use domain=com or domain=red.' }), { status: 400, headers });
    }
    const { status, data } = await filterFeed(params[0][1]);
    if (status === 200 && !data.stale) headers['Cache-Control'] = 'public, max-age=0, s-maxage=30';
    if (status === 503) headers['Retry-After'] = '120';
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(data), { status, headers });
  };
}

export default { fetch: createFilterHandler() };
