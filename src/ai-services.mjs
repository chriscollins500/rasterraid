import { SITE_ORIGINS, text } from './catalog.mjs';
import { foldSearchText, searchWords } from './query-language.mjs';

export const orchestrationOrigin = 'https://orchestration.civitai.com';
const servicePath = '/v2/services';
const serviceIdPattern = /^(?:[a-z\d][a-z\d._:@-]{0,95}\/){1,7}[a-z\d][a-z\d._:@-]{0,95}$/iu;
const valuePattern = /^[a-z\d][a-z\d_-]{0,39}$/iu;
const recipePattern = /^[a-z][a-z\d]{0,63}$/iu;
const windows = new Set(['1h', '24h', '7d']);
const catalogPageSize = 200;
const catalogPageLimit = 8;
const resultPageSize = 18;
const maxResponseBytes = 1_000_000;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const displayNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const value = item => typeof item === 'string' && valuePattern.test(item) ? item : '';
const number = item => Number.isFinite(item) && item >= 0 ? item : null;
const fieldWords = field => searchWords(field.replace(/([a-z\d])([A-Z])/gu, '$1 $2'));
const stop = new Set('a an the any are at can could do does for from give get how i in into is it looking make me my of on or our should some tell that this to turn use what where which will with would you'.split(' '));
const stem = word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word;
const wordSet = field => new Set(fieldWords(field).map(stem));
const stepMatches = [
  ['transcription', /\b(?:transcrib\w*|transcri(?:p\w*)?|subtitles?|speech.to.text|spoken words|what\b.{0,32}\b(?:says?|said))\b/u, 'Speech to text'],
  ['videoFrameExtraction', /\b(?:keyframes?|frame extraction|extract\b.{0,25}\bframes?|(?:still (?:images?|pictures?)|stills|thumbnails?)\b.{0,35}\b(?:video|clip|footage))\b/u, 'Stills from video'],
  ['mediaCaptioning', /\b(?:media caption\w*|image caption\w*|(?:describ\w*|description|caption)\b.{0,42}\b(?:what is visible|what it shows|picture|image|photo|footage))\b/u, 'Describe visible content'],
  ['audioCaptioning', /\b(?:audio caption\w*|(?:instruments?|tempo|instrumentation)\b.{0,40}\b(?:music|audio|song|soundtrack)|(?:describe|analyze)\b.{0,35}\b(?:music|soundtrack|audio))\b/u, 'Describe music or sound'],
  ['multimodalEmbedding', /\b(?:multimodal embeddings?|visual embeddings?|image embeddings?|(?:vectors?|similarity)\b.{0,30}\b(?:images?|pictures?|photos?))\b/u, 'Compare representations'],
  ['transcode', /\b(?:transcod\w*|re.encod\w*|(?:convert|standardiz\w*|downscal\w*)\b.{0,30}\b(?:mp4|webm|footage|video))\b/u, 'Convert video format'],
  ['polyGen', /\b(?:3d\b.{0,40}\bfrom (?:one |a |an |a single )?(?:picture|photo|image)|(?:one|single) (?:picture|photo|image)\b.{0,40}\b3d)\b/u,
    'Image to 3D', item => item.input.includes('image') && item.output.includes('3d') && /\/imageTo3D$/iu.test(item.id)],
];

export function aiServiceLink(id) {
  if (typeof id !== 'string' || id.length > 200 || !serviceIdPattern.test(id)) return null;
  return orchestrationOrigin + servicePath + '/' + id;
}

export function aiServiceReference(input, { allowId = false } = {}) {
  if (allowId && aiServiceLink(input)) return input;
  try {
    const url = new URL(input);
    if (url.origin !== orchestrationOrigin || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith(servicePath + '/')) return null;
    const id = decodeURIComponent(url.pathname.slice(servicePath.length + 1));
    return aiServiceLink(id) ? id : null;
  } catch { return null; }
}

export const aiServiceLabel = word => word === '3d' ? '3D' : word.slice(0, 1).toUpperCase() + word.slice(1);
const serviceValues = values => [...new Set(Array.isArray(values) ? values.slice(0, 40).map(value).filter(Boolean) : [])];

function serviceCard(row, window, detail) {
  const link = aiServiceLink(row?.id);
  const category = value(row?.category);
  if (!link || category !== row.id.split('/')[0]) return null;
  const title = text(row.name, 150) || row.id;
  const status = value(row.status) || 'unknown';
  const input = serviceValues(row.modalities?.input);
  const output = serviceValues(row.modalities?.output);
  const tags = serviceValues(row.tags);
  const requestCount = number(row.metrics?.requests);
  const successRate = number(row.metrics?.successRate);
  const performance = row.metrics?.window === window && requestCount > 0 ? {
    window, requests: requestCount,
    checkedAt: Number.isFinite(Date.parse(row.metrics.asOf)) ? new Date(row.metrics.asOf).toISOString() : null,
    cost: number(row.metrics.costBuzz?.p50), seconds: number(row.metrics.latencySeconds?.p50),
    successRate: successRate !== null && successRate <= 1 ? successRate : null,
  } : null;
  const step = typeof row.step === 'string' && recipePattern.test(row.step) ? row.step : '';
  const recipe = step && row.estimate === 'POST /v2/consumer/recipes/' + step + '?whatif=true'
    ? orchestrationOrigin + '/v2/consumer/recipes/' + step + '/openapi.yaml' : null;
  const parameters = detail && row.parameters && typeof row.parameters === 'object' && !Array.isArray(row.parameters)
    ? Object.keys(row.parameters).map(value).filter(Boolean).slice(0, 12) : [];
  return {
    id: row.id, link, title, category: aiServiceLabel(category), serviceCategory: category, status, input, output, tags, detail,
    summary: text(row.description, 440), strengths: text(row.strengths, 330), performance, step, recipe, parameters,
    description: input.length && output.length ? input.map(aiServiceLabel).join(' / ') + ' → ' + output.map(aiServiceLabel).join(' / ') : '',
  };
}

export function aiServicePerformance(item) {
  const stats = item.performance;
  if (!stats) return [];
  return [
    stats.cost !== null && displayNumber.format(stats.cost) + ' Buzz median',
    stats.seconds !== null && displayNumber.format(stats.seconds) + ' s median',
    stats.successRate !== null && displayNumber.format(stats.successRate * 100) + '% successful',
    displayNumber.format(stats.requests) + ' requests over ' + stats.window,
  ].filter(Boolean);
}

async function boundedJson(response) {
  if (!response.body || +(response.headers.get('content-length') ?? 0) > maxResponseBytes) throw new Error('Service response too large');
  const input = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let source = '';
  try {
    while (true) {
      const chunk = await input.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxResponseBytes) throw new Error('Service response too large');
      source += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(source + decoder.decode());
  } finally {
    await input.cancel().catch(() => {});
    input.releaseLock();
  }
}

async function readRegistry(url, { signal, fetcher = fetch } = {}) {
  const timeout = AbortSignal.timeout(8000);
  try {
    const response = await fetcher(url, {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return { status: response.status };
    if (!response.headers.get('content-type')?.includes('json')) return { status: 'format' };
    return { status: 200, data: await boundedJson(response) };
  } catch {
    signal?.throwIfAborted();
    return { status: timeout.aborted ? 'timeout' : 'unavailable' };
  }
}

async function readPage(window, offset, options) {
  const url = new URL(servicePath, orchestrationOrigin);
  url.search = new URLSearchParams({ limit: catalogPageSize, window, offset });
  const { status, data } = await readRegistry(url, options);
  if (status !== 200) return { status, items: [], total: null };
  if (!Array.isArray(data?.items) || data.items.length > catalogPageSize || data.offset !== offset ||
      !Number.isSafeInteger(data.totalCount) || data.totalCount < 0) {
    return { status: 'format', items: [], total: null };
  }
  return { status, total: data.totalCount, items: data.items.map(row => serviceCard(row, window, false)).filter(Boolean) };
}

export async function readAiServiceRegistry({ signal, fetcher, window: requested } = {}) {
  const window = windows.has(requested) ? requested : '24h';
  const options = { signal, fetcher };
  const first = await readPage(window, 0, options);
  const total = first.total;
  const pages = [first];
  const stopAt = Math.min(total ?? 0, catalogPageLimit * catalogPageSize);
  for (let offset = catalogPageSize; offset < stopAt; offset += catalogPageSize * 3) {
    signal?.throwIfAborted();
    const offsets = [offset, offset + catalogPageSize, offset + 2 * catalogPageSize].filter(next => next < stopAt);
    const batch = await Promise.all(offsets.map(next => readPage(window, next, options)));
    pages.push(...batch);
    if (batch.some(page => page.status === 429)) break;
  }
  signal?.throwIfAborted();
  const items = [...new Map(pages.flatMap(page => page.items).map(item => [item.id, item])).values()];
  const partial = total !== items.length || pages.some(page => page.status !== 200 || page.total !== total);
  const flows = pages.map(({ status }) => ({ label: 'Civitai AI service registry', status }));
  if (partial && flows.every(flow => flow.status === 200)) flows.push({ label: 'Service registry coverage', status: 'partial' });
  return { items, total, window, partial, flows, checkedAt: new Date().toISOString() };
}

export function aiServiceFacets(items) {
  const collect = values => [...new Set(values.filter(Boolean))].sort(collator.compare);
  return {
    serviceCategory: collect(items.map(item => item.serviceCategory)),
    serviceInput: collect(items.flatMap(item => item.input)), serviceOutput: collect(items.flatMap(item => item.output)),
    serviceState: collect(items.map(item => item.status)), serviceTag: collect(items.flatMap(item => item.tags)),
  };
}

export function rankAiServices(items, filters = {}) {
  const query = foldSearchText(text(filters.query, 500)).trim();
  const terms = [...new Set(fieldWords(query).filter(term => !stop.has(term)).map(stem))].slice(0, 20);
  const tasks = filters.serviceMatch === 'keywords' ? [] : stepMatches.filter(([, pattern]) => pattern.test(query));
  const taskFor = item => tasks.find(([step, , , accepts]) => step === item.step && (!accepts || accepts(item)));
  const focus = tasks.length > 0 && items.some(taskFor);
  const candidates = items.filter(item =>
    (!filters.serviceCategory || item.serviceCategory === filters.serviceCategory) &&
    (!filters.serviceState || item.status === filters.serviceState) &&
    (!filters.serviceInput || item.input.includes(filters.serviceInput)) &&
    (!filters.serviceOutput || item.output.includes(filters.serviceOutput)) &&
    (!filters.serviceTag || item.tags.includes(filters.serviceTag)));
  const indexed = candidates.map(item => {
    // Weight names, declared capabilities and I/O ahead of descriptive prose.
    const fields = [[item.title + ' ' + item.id + ' ' + item.step, 4],
      [[item.category, ...item.input, ...item.output, ...item.tags].join(' '), 2], [item.summary + ' ' + item.strengths, 1]];
    return { item, fields: fields.map(([field, weight]) => [wordSet(field), weight]) };
  });
  const frequencies = new Map(terms.map(term => [term, indexed.filter(row => row.fields.some(([field]) => field.has(term))).length]));
  const matches = indexed.map(({ item, fields }) => {
    const exact = query && [item.id, item.title, item.step].some(name => query === foldSearchText(name));
    const task = taskFor(item);
    const score = terms.reduce((sum, term) => {
      const match = fields.reduce((weight, [field, next]) => field.has(term) ? weight + next : weight, 0);
      return sum + match * Math.log(1 + indexed.length / (1 + frequencies.get(term)));
    }, 0);
    const reason = exact ? 'Exact service name' : task?.[2];
    return { item: { ...item, reason }, exact, task: Boolean(task), score };
  }).filter(row => !query || row.exact || row.task || !focus && row.score > 0);
  const metric = { cost: 'cost', speed: 'seconds' }[filters.catalogSort];
  matches.sort((a, b) => {
    const exact = Number(Boolean(b.exact)) - Number(Boolean(a.exact));
    if (exact) return exact;
    const name = collator.compare(a.item.title, b.item.title);
    if (filters.catalogSort === 'name') return name;
    if (metric) {
      const first = a.item.performance?.[metric] ?? Infinity;
      const next = b.item.performance?.[metric] ?? Infinity;
      if (first !== next) return first - next;
    }
    return Number(b.task) - Number(a.task) || b.score - a.score ||
      Number(b.item.status === 'available') - Number(a.item.status === 'available') || name;
  });
  return matches.map(row => row.item);
}

export function readAiServicePage(plan, { cursor = 0 } = {}) {
  const items = plan.matches.slice(cursor, cursor + resultPageSize);
  const next = cursor + items.length;
  return { items, nextCursor: next < plan.matches.length ? next : null, partial: plan.partial };
}

export async function discoverAiServices(context, target, filters, options = {}) {
  if (!SITE_ORIGINS.includes(context.origin)) throw new TypeError('Use a Civitai host for AI service discovery.');
  const base = { scope: 'aiServices', target, candidates: [], shortlisted: [] };
  const window = windows.has(filters.serviceWindow) ? filters.serviceWindow : '24h';
  options.onPhase?.(target.kind === 'aiService' ? 'Checking the exact Civitai AI service…' : 'Reading Civitai’s live AI service registry…');
  if (target.kind === 'aiService') {
    const url = new URL(aiServiceLink(target.id));
    url.searchParams.set('window', window);
    const { status, data } = await readRegistry(url, options);
    const result = data?.id === target.id ? serviceCard(data, window, true) : null;
    return { ...base, directoryTitle: result?.title ?? 'AI service', related: { aiServices: result ? [result] : [] },
      flows: [{ label: 'Exact Civitai AI service', status: status === 200 && !result ? 'format' : status }],
      serviceCatalog: { exact: true, missing: status === 404, partial: !result && status !== 404, window } };
  }
  const { items, total, partial, flows, checkedAt } = await readAiServiceRegistry({ ...options, window });
  const matches = rankAiServices(items, { ...filters, query: target.value });
  const plan = { matches, partial };
  const page = readAiServicePage(plan);
  return { ...base, related: { aiServices: page.items }, flows,
    directory: { scope: 'aiServices', plan, nextCursor: page.nextCursor },
    serviceCatalog: { checkedAt, window, count: items.length, total, partial, matches: matches.length, facets: aiServiceFacets(items) } };
}
