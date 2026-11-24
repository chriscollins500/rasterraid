import { SITE_ORIGINS } from './catalog.mjs';

const reuseMs = 120_000;
const sourceLimit = 32;
const libraryScopes = new Set(['ownedModels', 'vault', 'saved', 'downloads', 'creations', 'notifications', 'messages']);
const unavailableGallery = new Set(['gallery-unavailable', 'tag-unavailable', 'source-unavailable']);

function transient(status) {
  return status == null || status === 408 || status === 429 || status >= 500 && status <= 599;
}

export function reportSourceFailure(result, status) {
  if (!result) return transient(status) ? 'retryable' : 'unavailable';
  if (result.library) return 'unavailable';
  const failures = result.flows?.filter(flow => flow.status !== 200) ?? [];
  if (failures.length) return failures.some(flow => transient(flow.status)) ? 'retryable' : 'unavailable';
  if (result.gallery?.incomplete || result.gallery?.throttled || result.serviceCatalog?.partial ||
      unavailableGallery.has(result.gallery?.status) || ['incomplete', 'unavailable'].includes(result.hashStatus)) return 'retryable';
  return result.gallery?.partial ? 'unavailable' : null;
}

function viewKey(context) {
  if (!context || context.connectionLost || !SITE_ORIGINS.includes(context.origin) ||
      !Number.isInteger(context.browsingLevel)) return null;
  return JSON.stringify([context.origin, Boolean(context.hosted), Boolean(context.token), Boolean(context.signedIn),
    context.viewerUserId, context.browsingLevel, context.storageMode, [...(context.scopes ?? [])].sort()]);
}

const ordered = record => Object.keys(record).sort().map(key => [key, record[key]]);

export function createReportRecovery(context, filters, preferences, { now = () => Date.now() } = {}) {
  const owner = viewKey(context);
  if (!owner || filters.scope !== 'report' || filters.reportType === 'portfolio' || filters.upgradePair ||
      filters.reportSources?.some(scope => libraryScopes.has(scope))) return null;
  const plan = structuredClone(filters);
  const profile = structuredClone(preferences);
  const saved = new Map();
  let generation = 0;
  let discarded = false;
  const matches = viewer => !discarded && viewKey(viewer) === owner;

  return {
    filters: plan,
    preferences: profile,
    matches,
    discard() { discarded = true; saved.clear(); },
    begin({ discoverSource, recordedSource }) {
      const attempt = ++generation;
      const reused = new Set();
      let retryable = false;

      async function read(kind, viewer, args, options, request) {
        const { signal, fetcher, ...settings } = options;
        signal?.throwIfAborted();
        const eligible = matches(viewer) && !args.some(record => libraryScopes.has(record.scope));
        if (!eligible) return request();
        const key = JSON.stringify([kind, ...args.map(ordered), ordered(settings)]);
        const previous = saved.get(key);
        const age = previous && now() - previous.checkedAt;
        if (previous && previous.attempt < attempt && age >= 0 && age < reuseMs) {
          reused.add(key);
          return structuredClone(previous.result);
        }
        let result;
        try {
          result = await request();
        } catch (error) {
          signal?.throwIfAborted();
          if (transient(error?.status)) retryable = true;
          throw error;
        }
        signal?.throwIfAborted();
        const failure = reportSourceFailure(result);
        if (failure === 'retryable') retryable = true;
        if (!failure && !result.ownerStatus && matches(viewer) && generation === attempt) {
          saved.delete(key);
          if (saved.size >= sourceLimit) saved.delete(saved.keys().next().value);
          saved.set(key, { result: structuredClone(result), checkedAt: now(), attempt });
        }
        return result;
      }

      return {
        get reused() { return reused.size; },
        get retryable() { return retryable; },
        discoverSource: (viewer, filters, options) =>
          read('search', viewer, [filters], options, () => discoverSource(viewer, filters, options)),
        recordedSource: (viewer, records, filters, options) =>
          read('versions', viewer, [records, filters], options, () => recordedSource(viewer, records, filters, options)),
      };
    },
  };
}
