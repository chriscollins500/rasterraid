import { capabilitySchema, capabilityVersion } from './catalog-capabilities.mjs';
import { SITE_ORIGINS } from '../src/catalog.mjs';

const states = new Set(['ready', 'denied', 'unavailable', 'rate-limited', 'invalid-response', 'partial', 'stale', 'not-observed', 'not-requested']);
const incompleteStates = new Set(['unavailable', 'rate-limited', 'invalid-response', 'partial', 'stale', 'not-observed']);
const isRecord = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const sorted = items => [...new Set(items)].sort();

function snapshotSources(snapshot) {
  if (snapshot?.schema !== capabilitySchema || snapshot.schemaVersion !== capabilityVersion ||
      typeof snapshot.capturedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
      !Array.isArray(snapshot.sources) || !snapshot.sources.length || snapshot.sources.length > 512) {
    throw new TypeError('Expected a supported RasterRaid capability snapshot.');
  }
  const sources = new Map();
  for (const row of snapshot.sources) {
    if (typeof row?.id !== 'string' || !/^[a-z][a-z\d.-]{0,119}$/u.test(row.id) || sources.has(row.id) ||
        !states.has(row.state) || !['live', 'reference'].includes(row.kind) ||
        typeof row.url !== 'string' || row.url.length > 512 || !row.url.startsWith('https://') ||
        row.origin && !SITE_ORIGINS.includes(row.origin)) {
      throw new TypeError('Invalid capability source in the snapshot.');
    }
    if (row.facts !== undefined && (!isRecord(row.facts) || Object.keys(row.facts).length > 2200 ||
        Object.entries(row.facts).some(([field, values]) => !field.length || field.length > 420 ||
          /[\p{Cc}\p{Cf}]/u.test(field) || !Array.isArray(values) || values.length > 1600 ||
          values.some(value => typeof value !== 'string' || value.length > 300 || /[\p{Cc}\p{Cf}]/u.test(value))))) {
      throw new TypeError('Invalid capability facts in the snapshot.');
    }
    sources.set(row.id, row);
  }
  return sources;
}

function factChanges(previous = {}, current = {}) {
  return sorted([...Object.keys(previous), ...Object.keys(current)]).flatMap(field => {
    const before = new Set(Object.hasOwn(previous, field) ? previous[field] : []);
    const after = new Set(Object.hasOwn(current, field) ? current[field] : []);
    const added = sorted([...after].filter(value => !before.has(value)));
    const removed = sorted([...before].filter(value => !after.has(value)));
    return added.length || removed.length ? [{ field, added, removed }] : [];
  });
}

function usableFacts(row) {
  return row?.state === 'ready' ? row.facts : null;
}

function selectedFacts(facts, names) {
  if (!facts || names.some(([, key]) => !Array.isArray(facts[key]))) return null;
  return Object.fromEntries(names.map(([label, key]) => [label, facts[key]]));
}

function comparePair(id, first, second) {
  if (!first || !second) return { id, state: 'indeterminate' };
  const differences = factChanges(first, second);
  return differences.length ? { id, state: 'different', differences } : { id, state: 'match' };
}

export function capabilityAgreement(snapshot) {
  const sources = snapshotSources(snapshot);
  const paired = ['site-enums', 'app-manifest', 'app-tools'];
  const agreement = paired.map(name => {
    const [com, red] = ['com', 'red'].map(domain => usableFacts(sources.get(domain + '.' + name)));
    const id = 'domains.' + name;
    const authorKey = credentialKey(snapshot, SITE_ORIGINS[0]);
    return name === 'app-tools' && com && red && (!authorKey || authorKey !== credentialKey(snapshot, SITE_ORIGINS[1]))
      ? { id, state: 'indeterminate', reason: 'different author browsing or scope contexts' } : comparePair(id, com, red);
  });
  for (const domain of ['com', 'red']) {
    const source = sources.get(domain + '.site-enums');
    const relay = sources.get(domain + '.filter-feed');
    const tools = sources.get(domain + '.app-tools');
    const enums = usableFacts(source);
    const liveRelay = usableFacts(relay);
    const app = usableFacts(tools);
    const relayId = domain + '.site-to-filter-feed';
    const expected = selectedFacts(enums, [
      ['modelTypes', 'ModelType'], ['activeBaseModels', 'ActiveBaseModel'], ['baseModels', 'effectiveBaseModels'],
    ]);
    agreement.push(liveRelay && relay.cors !== 'permitted'
      ? { id: relayId, state: 'different', reason: 'filter feed lacks an opaque-origin allow header' }
      : comparePair(relayId, expected, liveRelay));
    agreement.push(comparePair(domain + '.site-to-app-model-types', selectedFacts(enums, [['modelTypes', 'ModelType']]),
      selectedFacts(app, [['modelTypes', 'search_models/types/items/enum']])));
  }
  return agreement;
}

function credentialKey(snapshot, origin) {
  const credential = snapshot.appCredentials?.[origin];
  if (!Number.isInteger(credential?.ceiling) || !Number.isInteger(credential.viewerBrowsingLevel) || !Array.isArray(credential.scopes)) return null;
  return JSON.stringify([credential.ceiling, credential.viewerBrowsingLevel, sorted(credential.scopes)]);
}

function transport(row) {
  return { state: row.state, http: row.http ?? null, cors: row.cors ?? null };
}

export function compareCapabilities(baseline, current) {
  const before = snapshotSources(baseline);
  const after = snapshotSources(current);
  const sourcesChanged = [];
  const accessChanged = [];
  const factsChanged = [];
  const unverified = [];
  for (const id of sorted([...before.keys(), ...after.keys()])) {
    const prior = before.get(id);
    const next = after.get(id);
    if (!prior || !next || prior.url !== next.url || prior.kind !== next.kind || prior.credential !== next.credential) {
      sourcesChanged.push({ id, before: prior?.url ?? null, after: next?.url ?? null });
      continue;
    }
    const oldTransport = transport(prior);
    const newTransport = transport(next);
    if (oldTransport.state !== newTransport.state || oldTransport.http !== newTransport.http || oldTransport.cors !== newTransport.cors) {
      accessChanged.push({ id, before: oldTransport, after: newTransport });
    }
    const priorKey = next.credential ? credentialKey(baseline, prior.origin) : null;
    const comparable = !next.credential || prior.state !== 'ready' && next.state !== 'ready' ||
      Boolean(priorKey && priorKey === credentialKey(current, next.origin));
    if (prior.state !== 'ready' || next.state !== 'ready' || !comparable) {
      unverified.push({ id, before: prior.state, after: next.state, ...(!comparable && { reason: 'different author browsing or scope contexts' }) });
      continue;
    }
    const differences = factChanges(prior.facts, next.facts);
    if (differences.length) factsChanged.push({ id, differences });
  }
  const agreement = capabilityAgreement(current);
  const incomplete = [...after.values()].some(row => incompleteStates.has(row.state) || row.kind === 'reference' && row.state !== 'ready');
  const requiresReview = Boolean(sourcesChanged.length || accessChanged.length || factsChanged.length || unverified.some(row => row.reason) ||
    incomplete || agreement.some(row => row.state === 'different'));
  return { schemaVersion: 1, baselineAt: baseline.capturedAt, currentAt: current.capturedAt, requiresReview,
    sourcesChanged, accessChanged, factsChanged, unverified, agreement };
}
