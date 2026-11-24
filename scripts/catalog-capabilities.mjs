import { CATALOG, SITE_ORIGINS, catalogRead, siteSearch } from '../src/catalog.mjs';
import { HOST_PROBES, runHostProbe } from '../src/probe.mjs';
import { choices, modelEnumChoices } from '../hosting/filter-feed/worker/index.js';
import { NATIVE_MODELS_INDEX, PUBLIC_FILTER_FEED } from '../src/runtime-config.mjs';
import { orchestrationOrigin, readAiServiceRegistry } from '../src/ai-services.mjs';
import { mintProbeToken } from './civitai-probe-token.mjs';

export const capabilitySchema = 'rasterraid.catalog-capabilities';
export const capabilityVersion = 1;
const docs = 'https://raw.githubusercontent.com/civitai/civitai-developer-docs/main/';
const manifestPath = '/schemas/app-block/v1.json';
const nativePath = '/api/search/multi-search';
const sourceSizeLimit = 2 * 1024 * 1024;
const httpMethods = new Set(['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'trace']);
const endpointPath = /^\/[\w./{}*-]{1,240}$/u;
const memberName = /^[a-z_$][\w$-]{0,95}$/iu;
const scopeName = /^[a-z][a-z\d-]{0,39}(?::[a-z][a-z\d-]{0,39}){1,5}$/u;
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const unique = values => [...new Set(values)].sort();

function strings(value, { pattern, limit = 1600 } = {}) {
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' ||
    !item.trim() || item.length > 300 || /[\p{Cc}\p{Cf}]/u.test(item) || (pattern && !pattern.test(item)))) return null;
  return unique(value);
}

function markdownTable(source, header) {
  const lines = source.split(/\r?\n/u).map(line => line.trim());
  const start = lines.findIndex(line => header.test(line));
  if (start < 0 || !/^\|(?:\s*[:-]+\s*\|){2,}$/u.test(lines[start + 1] ?? '')) return [];
  const rows = [];
  for (let i = start + 2; lines[i]?.startsWith('|'); i++) rows.push(lines[i]);
  return rows;
}

export function siteReferenceFacts(source) {
  const rows = markdownTable(source, /^\|\s*Resource\s*\|\s*Endpoints\s*\|$/u);
  if (!rows.length) return null;
  const operations = [];
  for (const row of rows) {
    const list = [...row.matchAll(/`(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/[^`\s]+)`/gu)];
    if (!list.length || list.some(([, , path]) => !endpointPath.test(path))) return null;
    operations.push(...list.map(([, method, path]) => method + ' /api/v1' + path));
  }
  return { operations: unique(operations) };
}

function scopeFacts(source) {
  const rows = markdownTable(source, /^\|\s*Scope\s*\|\s*What it authorizes\s*\|/u);
  if (!rows.length) return null;
  const declarations = [];
  const deprecated = [];
  for (const row of rows) {
    const match = /^\|\s*`([^`]+)`\s*\|/u.exec(row);
    if (!match || !scopeName.test(match[1])) return null;
    declarations.push(match[1]);
    if (/\|\s*Deprecated\b/iu.test(row)) deprecated.push(match[1]);
  }
  return { scopes: unique(declarations), deprecated: unique(deprecated) };
}

function modelFilterFacts(source) {
  const block = /^(?:export )?const getAllModelsSchema = z\.object\(\{\s*\r?\n([\s\S]*?)^\}\);/mu.exec(source)?.[1];
  if (!block) return null;
  const names = [...block.matchAll(/^ {2}([a-z][\w]*)\s*:/gmu)].map(([, name]) => name);
  return names.length ? { declaredTopLevelFilters: unique(names) } : null;
}

export function orchestrationSpecFacts(spec) {
  if (!record(spec?.paths) || !/^3\.\d+\.\d+$/u.test(spec.openapi ?? '')) return null;
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!endpointPath.test(path) || !record(item)) return null;
    for (const [method, operation] of Object.entries(item)) {
      if (!httpMethods.has(method)) continue;
      if (!record(operation)) return null;
      operations.push(method.toUpperCase() + ' ' + path);
    }
  }
  return operations.length ? { openapi: [spec.openapi], operations: unique(operations) } : null;
}

function appendSchemaFacts(facts, prefix, schema) {
  if (!record(schema)) return false;
  const properties = schema.properties ?? {};
  if (!record(properties)) return false;
  const names = strings(Object.keys(properties), { pattern: memberName });
  const required = strings(schema.required ?? [], { pattern: memberName });
  if (!names || !required || required.some(name => !names.includes(name))) return false;
  facts[prefix + '/properties'] = names;
  facts[prefix + '/required'] = required;
  for (const name of names) {
    const property = properties[name];
    if (typeof property === 'boolean') continue;
    if (!record(property)) return false;
    const key = prefix + '/' + name;
    if (property.type !== undefined) {
      const types = strings(Array.isArray(property.type) ? property.type : [property.type], { pattern: memberName });
      if (!types) return false;
      facts[key + '/type'] = types;
    }
    for (const [suffix, values] of [['enum', property.enum], ['items/enum', property.items?.enum]]) {
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.length > 1600 || values.some(value =>
        value !== null && !['string', 'number', 'boolean'].includes(typeof value))) return false;
      const literals = strings(values.map(value => typeof value === 'string' ? value : JSON.stringify(value)));
      if (!literals) return false;
      facts[key + '/' + suffix] = literals;
    }
  }
  return true;
}

function manifestFacts(data) {
  if (!record(data?.properties) || typeof data.$id !== 'string' || !data.$id.endsWith(manifestPath)) return null;
  const facts = {};
  return appendSchemaFacts(facts, 'manifest', data) && facts['manifest/properties'].length ? facts : null;
}

export function appToolFacts(data) {
  if (!Array.isArray(data?.tools) || data.tools.length > 100) return null;
  const names = [];
  const facts = {};
  for (const tool of data.tools) {
    const { name, parameters } = tool?.function ?? {};
    if (typeof name !== 'string' || !memberName.test(name) || names.includes(name) ||
        !appendSchemaFacts(facts, name, parameters ?? {})) return null;
    names.push(name);
  }
  return { tools: unique(names), ...facts };
}

function enumFacts(data) {
  const main = modelEnumChoices(data);
  if (!main) return null;
  const facts = {};
  for (const [key, items] of Object.entries(data)) {
    if (!Array.isArray(items) && !['ModelFileType', 'BaseModelType'].includes(key)) continue;
    const list = memberName.test(key) && strings(items);
    if (!list) return null;
    facts[key] = list;
  }
  facts.effectiveBaseModels = unique(main.baseModels);
  return facts;
}

function filterFeedFacts(data, origin, now) {
  if (data?.source !== origin + CATALOG.enums || typeof data.stale !== 'boolean' ||
      !Number.isSafeInteger(data.checkedAt) || data.checkedAt <= 0 || data.checkedAt > now + 60_000) return null;
  const modelTypes = choices(data.modelTypes);
  const activeBaseModels = choices(data.activeBaseModels);
  const baseModels = choices(data.baseModels);
  if (!modelTypes || !activeBaseModels || !baseModels || !activeBaseModels.every(name => baseModels.includes(name))) return null;
  return { modelTypes: unique(modelTypes), activeBaseModels: unique(activeBaseModels), baseModels: unique(baseModels) };
}

async function responseText(response) {
  if (!response.body || Number(response.headers.get('content-length')) > sourceSizeLimit) throw new RangeError('Response size');
  const stream = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let text = '';
  try {
    for (let chunk = await stream.read(); !chunk.done; chunk = await stream.read()) {
      length += chunk.value.byteLength;
      if (length > sourceSizeLimit) throw new RangeError('Response size');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await stream.cancel().catch(() => {});
    stream.releaseLock();
  }
}

const corsEvidence = value => value === '*' || value === 'null' ? 'permitted' : value ? 'other' : 'absent';
const accessState = status => status === 401 || status === 403 ? 'denied' : status === 429 ? 'rate-limited' : 'unavailable';
const statusCode = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const observation = (source, state, http = null, cors = null) => ({ ...source, state, http, cors });

async function publicDocument(source, project, { fetcher, signal, json, filterFeed }) {
  let response;
  try {
    response = await fetcher(new URL(source.url), {
      method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { Accept: json ? 'application/json' : 'text/plain, text/markdown', ...(filterFeed && { Origin: 'null' }) },
    });
  } catch { return observation(source, 'unavailable'); }
  const cors = filterFeed ? corsEvidence(response.headers.get('access-control-allow-origin')) : null;
  if (!response.ok) return observation(source, accessState(response.status), response.status, cors);
  try {
    const contentType = response.headers.get('content-type') ?? '';
    if (!(json ? contentType.includes('json') : /^text\/(?:plain|markdown)\b/iu.test(contentType))) {
      return observation(source, 'invalid-response', response.status, cors);
    }
    const body = await responseText(response);
    const data = json ? JSON.parse(body) : body;
    const facts = project(data);
    if (!facts) return observation(source, 'invalid-response', response.status, cors);
    return { ...observation(source, filterFeed && data.stale ? 'stale' : 'ready', response.status, cors), facts,
      ...(filterFeed && { upstreamCheckedAt: new Date(data.checkedAt).toISOString() }) };
  } catch (error) {
    return observation(source, error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError
      ? 'invalid-response' : 'unavailable', response.status, cors);
  }
}

async function catalogObservation(source, origin, route, project, { token, fetcher, signal }) {
  try {
    const { data, status, cors } = await catalogRead(origin, route, {}, { token, fetcher, signal, headerProbe: true });
    const facts = project(data);
    return facts ? { ...observation(source, 'ready', status, corsEvidence(cors)), facts }
      : observation(source, 'invalid-response', status, corsEvidence(cors));
  } catch (error) {
    const http = statusCode(error.status);
    return observation(source, http === 200 ? 'invalid-response' : accessState(http), http);
  }
}

async function nativeObservation(source, origin, { fetcher, signal }) {
  let cors = null;
  try {
    await siteSearch(origin, [{ indexUid: NATIVE_MODELS_INDEX, q: 'linocut', limit: 1, attributesToRetrieve: ['id'] }], {
      signal,
      async fetcher(url, options) {
        const response = await fetcher(url, { ...options, headers: { ...options.headers, Origin: 'null' } });
        cors = corsEvidence(response.headers.get('access-control-allow-origin'));
        return response;
      },
    });
    return { ...observation(source, 'ready', 200, cors), facts: { configuredIndex: [NATIVE_MODELS_INDEX] } };
  } catch (error) {
    const http = statusCode(error.status);
    return observation(source, accessState(http), http, cors);
  }
}

async function serviceObservation(options) {
  const source = { id: 'orchestration.services', kind: 'live', url: orchestrationOrigin + '/v2/services' };
  try {
    const result = await readAiServiceRegistry(options);
    const http = statusCode(result.flows[0]?.status);
    if (result.partial) return { ...observation(source, http === 200 ? 'partial' : accessState(http), http),
      received: result.items.length, total: result.total };
    const facts = { services: unique(result.items.map(item => item.id)) };
    for (const item of result.items) {
      facts['service/' + item.id] = unique([
        ...item.input.map(value => 'input/' + value), ...item.output.map(value => 'output/' + value),
        ...(item.step ? ['step/' + item.step] : []), ...(item.recipe ? ['publishedRecipe'] : []),
      ]);
    }
    return { ...observation(source, 'ready', http), facts };
  } catch { return observation(source, 'unavailable'); }
}

async function probeObservations(origin, domain, { token, requested, signal, probe }) {
  const results = new Map();
  try {
    await probe(origin, { token, signal, headerProbe: true, onResult: result => results.set(result.name, result) });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  return HOST_PROBES.map(probe => {
    const source = { id: domain + '.probe.' + probe.name.toLowerCase().replace(/[^a-z\d]+/gu, '-'), kind: 'live',
      url: origin + probe.route, origin, ...(probe.kind === 'app' && { credential: 'app' }) };
    if (probe.kind === 'app' && !token) return observation(source, requested ? 'unavailable' : 'not-requested');
    const result = results.get(probe.name);
    if (!result || result.outcome === 'Stopped after rate limit') return observation(source, 'not-observed');
    const http = statusCode(result.status);
    return http === 200
      ? { ...observation(source, 'ready', http, corsEvidence(result.cors)), sample: { count: result.count, hasMetadata: result.metadataPresent } }
      : observation(source, accessState(http), http);
  });
}

async function hostObservations(origin, { cli, mint, probe, fetcher, signal }) {
  const domain = new URL(origin).hostname.split('.').at(-1);
  const source = (name, url, credential) => ({ id: domain + '.' + name, kind: 'live', url, origin, ...(credential && { credential }) });
  const feedUrl = new URL(PUBLIC_FILTER_FEED);
  feedUrl.searchParams.set('domain', domain);
  const tools = source('app-tools', origin + CATALOG.blockTools, 'app');
  const author = cli ? await mint(cli, origin) : {};
  const options = { fetcher, signal };
  const [enums, relay, manifest, declarations, native, probes] = await Promise.all([
    catalogObservation(source('site-enums', origin + CATALOG.enums), origin, CATALOG.enums, enumFacts, options),
    publicDocument(source('filter-feed', feedUrl.href), data => filterFeedFacts(data, origin, Date.now()), { ...options, json: true, filterFeed: true }),
    publicDocument(source('app-manifest', origin + manifestPath), manifestFacts, { ...options, json: true }),
    author.token ? catalogObservation(tools, origin, CATALOG.blockTools, appToolFacts, { ...options, token: author.token })
      : observation(tools, cli ? 'unavailable' : 'not-requested', author.mintFailure?.http ?? null),
    nativeObservation(source('native-model-search', origin + nativePath), origin, options),
    probeObservations(origin, domain, { token: author.token, requested: Boolean(cli), signal, probe }),
  ]);
  return { origin, credential: author.credential ?? null, sources: [enums, relay, manifest, declarations, native, ...probes] };
}

export async function captureCapabilities({ cli, fetcher = fetch, mint = mintProbeToken, probe = runHostProbe,
  signal = AbortSignal.timeout(55_000) } = {}) {
  const declarations = [
    ['site.reference', docs + 'site/reference/index.md', siteReferenceFacts],
    ['site.model-filter-source', 'https://raw.githubusercontent.com/civitai/civitai/main/src/server/schema/model.schema.ts', modelFilterFacts],
    ['app.scope-reference', docs + 'apps/reference/scopes.md', scopeFacts],
    ['orchestration.reference', 'https://developer.civitai.com/openapi/v2-consumers.json', orchestrationSpecFacts, true],
  ];
  const [references, services, hosts] = await Promise.all([
    Promise.all(declarations.map(([id, url, project, json]) => publicDocument({ id, url, kind: 'reference' }, project, { fetcher, signal, json }))),
    serviceObservation({ fetcher, signal }),
    Promise.all(SITE_ORIGINS.map(origin => hostObservations(origin, { cli, mint, probe, fetcher, signal }))),
  ]);
  const sources = [...references, services, ...hosts.flatMap(host => host.sources)];
  return { schema: capabilitySchema, schemaVersion: capabilityVersion, capturedAt: new Date().toISOString(),
    appCredentials: Object.fromEntries(hosts.map(host => [host.origin, host.credential])),
    sources: sources.sort((first, second) => first.id.localeCompare(second.id, 'en')), buzzSpent: 0 };
}
