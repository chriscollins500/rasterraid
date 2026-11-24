import { CATALOG, catalogRead, listItems, listSummary, numericId } from './catalog.mjs';

const sampleVersionId = 3087275;
const sampleModelId = 2744788;
const sampleImageId = 135405057;
const modelQuery = { query: 'linocut', types: 'LORA', baseModels: 'SDXL 1.0', limit: 1 };
const imageQuery = { modelVersionId: sampleVersionId, limit: 1, withMeta: true };

export const HOST_PROBES = Object.freeze([
  { name: 'App models', route: CATALOG.blockModels, query: modelQuery, kind: 'app' },
  { name: 'App images by version', route: CATALOG.blockImages, query: imageQuery, kind: 'app' },
  { name: 'App resource versions', route: CATALOG.blockResources, query: { ids: sampleVersionId }, kind: 'app' },
  { name: 'App tool declarations', route: CATALOG.blockTools, query: {}, kind: 'app' },
  { name: 'App public collections', route: CATALOG.blockCollections, query: { mode: 'public', limit: 1 }, kind: 'app' },
  { name: 'App gated image lookup', route: CATALOG.blockGatedImages, query: { ids: sampleImageId }, kind: 'app' },
  { name: 'Site model search', route: CATALOG.models, query: { ...modelQuery, nsfw: true }, kind: 'site' },
  { name: 'Site exact model', route: '/api/v1/models/' + sampleModelId, query: {}, kind: 'site' },
  { name: 'Site exact version', route: '/api/v1/model-versions/' + sampleVersionId, query: {}, kind: 'site' },
  { name: 'Site images by version', route: CATALOG.images, query: { ...imageQuery, browsingLevel: 31 }, kind: 'site' },
  { name: 'Site article titles', route: CATALOG.articles, query: { query: 'comfyui', limit: 1 }, kind: 'site' },
  { name: 'Site collection names', route: CATALOG.collections, query: { query: 'linocut', limit: 1 }, kind: 'site' },
  { name: 'Site creator names', route: CATALOG.creators, query: { query: 'civitai', limit: 1 }, kind: 'site' },
  { name: 'Site tags', route: CATALOG.tags, query: { query: 'style', limit: 1 }, kind: 'site' },
  { name: 'Site comics', route: CATALOG.comics, query: { nsfw: true, limit: 1 }, kind: 'site' },
  { name: 'Site App Store', route: CATALOG.apps, query: { limit: 1 }, kind: 'site' },
  { name: 'Site enums', route: CATALOG.enums, query: {}, kind: 'site' },
]);

function summarizeProbe(data) {
  const summary = listSummary(data);
  const firstItem = listItems(data)[0] ?? (Array.isArray(data.images) ? data.images[0] : null);
  const versions = Array.isArray(firstItem?.modelVersions) ? firstItem.modelVersions : [];
  const tools = Array.isArray(data.tools)
    ? data.tools.flatMap(tool => {
      const name = tool?.name ?? tool?.function?.name;
      return /^[a-z_]+$/.test(name ?? '') ? [name] : [];
    }).slice(0, 12)
    : [];
  return {
    ...summary,
    count: Array.isArray(data.images) ? data.images.length : Array.isArray(data.tools) ? data.tools.length : summary.count,
    firstId: summary.firstId ?? numericId(firstItem?.id ?? firstItem?.versionId),
    versionIds: versions.flatMap(version => numericId(version?.id) ?? []).slice(0, 5),
    tools,
    browsingLevel: Number.isInteger(data.maturity?.browsingLevel) ? data.maturity.browsingLevel : null,
    metadataPresent: typeof firstItem?.meta === 'object' && firstItem?.meta !== null,
  };
}

export async function runHostProbe(origin, { token, signal, headerProbe = false, onResult = () => {} } = {}) {
  const results = [];
  const limited = new Set();
  for (const probe of HOST_PROBES) {
    signal?.throwIfAborted();
    let result;
    if (probe.kind === 'app' && !token) {
      result = { status: null, outcome: 'App credential unavailable' };
    } else if (limited.has(probe.kind)) {
      result = { status: null, outcome: 'Stopped after rate limit' };
    } else {
      try {
        const response = await catalogRead(origin, probe.route, probe.query, { token, signal, headerProbe });
        result = {
          status: response.status,
          cors: response.cors,
          outcome: 'Response received',
          ...summarizeProbe(response.data),
        };
      } catch (error) {
        signal?.throwIfAborted();
        const status = error.status ?? null;
        if (status === 429) limited.add(probe.kind);
        result = {
          status,
          outcome: status ? 'HTTP refusal' : 'Browser or network unavailable',
          retryAfter: error.retryAfter ?? null,
        };
      }
    }
    const entry = { name: probe.name, route: probe.route, kind: probe.kind, ...result };
    results.push(entry);
    onResult(entry);
  }
  return results;
}
