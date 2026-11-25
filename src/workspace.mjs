import { catalogRead, civitaiAir, numericId, SITE_ORIGINS, text } from './catalog.mjs';
import { galleryBaseModels, galleryCreator, galleryCreatorPattern, gallerySourceFilters, gallerySourceIds, galleryTagIds, isGalleryScope,
  isVisualGalleryScope, tagRecord } from './gallery.mjs';
import { reportSettings, reportSources } from './report.mjs';
import { readCatalogCheckpoint, readReportCheckpoint } from './report-checkpoint.mjs';
import { releaseMediaSources } from './release-trail.mjs';
import { discover, modelUsage, readModelFileHistory, readRecordedVersions, readSavedModelVersions, searchTarget } from './search.mjs';
import { comparePublishedRelease, isModelFile, listedCreatorTerms, publishedName, releaseSetupIssue } from './release-compatibility.mjs';
import { catalogSearchText, modelChoiceFields, modelCreatorName, modelDownloadFilter, modelFilterParam } from './model-access.mjs';
import { environmentProfile } from './workflow-profile.mjs';
import { upgradeForSearch } from './upgrade-evidence.mjs';

const searchScopes = new Set(['all', 'pictures', 'tags', 'creators', 'guides', 'report', ...Object.keys(reportSources)]);
const fields = new Set(['query', 'scope', 'category', 'modelAuthor', 'baseModel', 'resourceType', 'checkpointType', 'fileFormat', 'downloadAccess', 'creatorUsage', 'sort',
  'period', 'exclude', 'supportsGeneration', 'fromPlatform', 'catalogSort', 'mediaSort', 'bountyType', 'bountyBase',
  'bountyStatus', 'bountySort', 'articleAuthor', 'articleTag', 'articleOfficial', 'comicAuthor', 'comicGenre',
  'collectionAuthor', 'collectionType', 'toolType', 'toolCompany', 'appKind', 'appCategory', 'reportType',
  'serviceCategory', 'serviceInput', 'serviceOutput', 'serviceState', 'serviceTag', 'serviceWindow', 'serviceMatch']);
const entryLimit = 20;
const listLimit = 10;
const maximumPins = 24;
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/u;
const workspaceBackupSchema = 'rasterraid.saved-workspace';
const workspaceLists = ['searches', 'shortlists'];
const workspaceWriteLimit = 32;
export const workspaceBackupMaximumBytes = 2 * 1024 * 1024;

export function workspaceFilters(filters) {
  if (!searchScopes.has(filters?.scope) || filters.workspaceShortlist) return null;
  if (filters.scope === 'report' && filters.reportType === 'publicWork') return null;
  const selected = {};
  for (const field of fields) {
    const value = Object.hasOwn(filters, field) ? filters[field] : undefined;
    if (modelChoiceFields.includes(field) && Array.isArray(value)) {
      const choices = modelFilterParam(value);
      if (choices) selected[field] = choices;
      continue;
    }
    if (typeof value !== 'string') continue;
    if (field === 'query') {
      try { selected.query = catalogSearchText(value); } catch { return null; }
      continue;
    }
    if (field === 'downloadAccess' && !modelDownloadFilter(value)) continue;
    if (field === 'modelAuthor') {
      const name = modelCreatorName(value);
      if (name) selected[field] = name;
      continue;
    }
    selected[field] = text(value, field === 'exclude' ? 200 : 100);
  }
  try {
    const assets3d = selected.scope === 'assets3d' || selected.scope === 'report' && /^https:\/\/civitai\.(?:com|red)\/3d-models\//iu.test(selected.query ?? '');
    if (selected.query && searchTarget(selected.query, { gallery: ['gallery', 'videos', 'posts', 'audio'].includes(selected.scope),
      assets3d }).kind === 'library') return null;
    if (selected.scope === 'report') {
      selected.reportSources = reportSettings(selected.reportType, filters.reportSources).sources;
      const comparison = upgradeForSearch({ ...selected, upgradePair: filters.upgradePair });
      if (comparison) selected.upgradePair = comparison;
    }
    const tag = isGalleryScope(selected.scope) ? tagRecord(filters.selectedMediaTag) : null;
    if (tag && tag.name === selected.query) selected.selectedMediaTag = tag;
    const releaseGallery = selected.scope === 'report' && selected.reportType === 'release' &&
      selected.reportSources.some(source => releaseMediaSources.has(source));
    if (isVisualGalleryScope(selected.scope) || releaseGallery) {
      const bases = galleryBaseModels(filters.mediaBaseModels);
      const creator = galleryCreator(filters.mediaCreator);
      if (bases.length) selected.mediaBaseModels = bases.join(',');
      if (galleryCreatorPattern.test(creator)) selected.mediaCreator = creator;
      if (/^[A-Z][A-Za-z0-9]{0,29}$/u.test(filters.mediaPeriod ?? '')) selected.mediaPeriod = filters.mediaPeriod;
      if (filters.mediaPublishedPrompt === 'true') selected.mediaPublishedPrompt = 'true';
    }
    if (isVisualGalleryScope(selected.scope)) {
      const tags = galleryTagIds(filters.mediaTags);
      if (filters.mediaTags && !tags.length) return null;
      if (tags.length) selected.mediaTags = tags.join(',');
      const sources = gallerySourceIds(filters);
      for (const [key, field] of Object.entries(gallerySourceFilters)) {
        if (filters[field] && !sources[key]) return null;
        if (sources[key]) selected[field] = String(sources[key]);
      }
    }
  } catch { return null; }
  return selected;
}

export function recentWorkspaceSearches(entries) {
  const searches = new Map();
  for (const entry of Array.isArray(entries) ? entries.slice(0, entryLimit + 1) : []) {
    const filters = workspaceFilters(entry);
    if (!filters) continue;
    const key = JSON.stringify(Object.entries(filters).sort(([first], [second]) => first.localeCompare(second)));
    if (!searches.has(key)) searches.set(key, filters);
    if (searches.size >= entryLimit) break;
  }
  return [...searches.values()];
}

export function recentSearchLabel(filters) {
  if (filters.upgradePair) return 'Review a workflow upgrade';
  if (filters.scope === 'report') return reportSettings(filters.reportType, filters.reportSources).title;
  return reportSources[filters.scope] ?? ({ pictures: 'Model pictures', tags: 'Tags', creators: 'Creators', guides: 'Guides' }[filters.scope] ?? 'Everything');
}

function filePins(rows) {
  if (!Array.isArray(rows) || rows.length > maximumPins) return null;
  const pins = new Map();
  for (const row of rows) {
    const fileId = numericId(row?.fileId);
    const hash = row?.sha256;
    if (!fileId || hash != null && (typeof hash !== 'string' || !/^[a-f\d]{64}$/iu.test(hash))) return null;
    const sha256 = hash?.toLowerCase();
    const prior = pins.get(fileId);
    if (prior?.sha256 && sha256 && prior.sha256 !== sha256) return null;
    if (!prior?.sha256) pins.set(fileId, { fileId, ...(sha256 && { sha256 }) });
  }
  return [...pins.values()];
}

export function versionReferences(candidates) {
  const exact = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const modelId = numericId(candidate?.modelId);
    const versionId = numericId(candidate?.versionId ?? candidate?.id);
    if (!modelId || !versionId || modelId > 2_147_483_647 || versionId > 2_147_483_647) continue;
    const prior = exact.get(versionId);
    if (prior && prior.modelId !== modelId || !prior && exact.size >= listLimit) continue;
    const files = Array.isArray(candidate.savedFiles) ? candidate.savedFiles : candidate.selectedFile ? [candidate.selectedFile] : [];
    const requested = Object.hasOwn(candidate, 'filePins') ? candidate.filePins : files.map(file => ({ fileId: file?.id, sha256: file?.sha256 }));
    const pins = filePins(requested);
    if (!pins) continue;
    const merged = filePins([...(prior?.filePins ?? []), ...pins]);
    if (!merged) continue;
    exact.set(versionId, { modelId, versionId, ...(merged.length && { filePins: merged }) });
  }
  return [...exact.values()];
}

function normalizeEntries(rows, accept) {
  return (Array.isArray(rows) ? rows : []).slice(0, entryLimit).flatMap(row => {
    const name = text(row?.name, 100);
    if (typeof row?.id !== 'string' || !uuid.test(row.id) || !name) return [];
    const value = accept(row);
    return value ? [{ id: row.id, name, ...value }] : [];
  });
}

export function workspaceDocument(value) {
  return {
    profile: environmentProfile(value?.profile),
    searches: normalizeEntries(value?.searches, row => {
      const filters = workspaceFilters(row.filters);
      if (!filters) return null;
      if (filters.scope === 'report') {
        const checkpoint = readReportCheckpoint(row.checkpoint);
        return checkpoint ? { filters, checkpoint } : { filters };
      }
      const catalogCheckpoint = readCatalogCheckpoint(row.catalogCheckpoint);
      return catalogCheckpoint ? { filters, catalogCheckpoint } : { filters };
    }),
    shortlists: normalizeEntries(value?.shortlists, row => {
      const versions = versionReferences(row.versions);
      return versions.length ? { versions } : null;
    }),
  };
}

function workspaceWriteIds(snapshot) {
  const record = snapshot.data?.workspaceWrites;
  if (record?.version !== snapshot.version || !Array.isArray(record.ids) ||
      record.ids.length > Math.min(workspaceWriteLimit, snapshot.version) ||
      new Set(record.ids).size !== record.ids.length ||
      !record.ids.every(id => typeof id === 'string' && uuid.test(id))) return [];
  return record.ids;
}

function workspaceReplaced(before, after) {
  return after.version < before.version || Boolean(before.createdAt && before.createdAt !== after.createdAt);
}

// Keep a stable action until the private document confirms its outcome.
export async function writeWorkspaceChange(store, snapshot, change, { signal, onCheck } = {}) {
  if (typeof change.id !== 'string' || !uuid.test(change.id)) throw new TypeError('A workspace change needs a valid ID.');
  const result = outcome => ({ outcome, snapshot });
  async function check() {
    onCheck?.();
    const before = snapshot;
    try {
      snapshot = await store.readSnapshot({ signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (change.uncertain) return result('check');
      throw error;
    }
    signal?.throwIfAborted();
    const ids = workspaceWriteIds(snapshot);
    if (workspaceReplaced(before, snapshot)) return result('review');
    if (ids.includes(change.id)) return result('saved');
    const previous = change.uncertain;
    if (!previous) return undefined;
    const stillSameDocument = previous.version === 0 ? snapshot.version === 0 :
      Boolean(previous.createdAt && previous.createdAt === snapshot.createdAt);
    if (!stillSameDocument || snapshot.version < previous.version) return result('review');
    if (snapshot.version > previous.version) {
      // Every revision since the original attempt must have a receipt before rebasing.
      if (ids.length < snapshot.version - previous.version) return result('review');
      change.uncertain = undefined;
    }
  }

  if (change.uncertain) {
    const recovered = await check();
    if (recovered) return recovered;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const expected = snapshot.version + 1;
    if (!Number.isSafeInteger(expected)) return result('review');
    if (workspaceWriteIds(snapshot).includes(change.id)) return result('saved');
    const data = workspaceDocument(change.apply(workspaceDocument(snapshot.data)));
    data.workspaceWrites = { version: expected, ids: [change.id, ...workspaceWriteIds(snapshot)].slice(0, workspaceWriteLimit) };
    try {
      const saved = await store.writeSnapshot(data, { ifVersion: snapshot.version, signal });
      signal?.throwIfAborted();
      if (saved.version === expected && workspaceWriteIds(saved)[0] === change.id) {
        const replaced = workspaceReplaced(snapshot, saved);
        snapshot = saved;
        return result(replaced ? 'review' : 'saved');
      }
      change.uncertain ??= { version: snapshot.version, createdAt: snapshot.createdAt };
    } catch (error) {
      signal?.throwIfAborted();
      const status = error?.status;
      if (status !== 409) {
        const refused = status >= 400 && status < 500 && status !== 408;
        if (refused && !change.uncertain) throw error;
        if (!refused) change.uncertain ??= { version: snapshot.version, createdAt: snapshot.createdAt };
      }
    }
    const recovered = await check();
    if (recovered) return recovered;
  }
  return result(change.uncertain ? 'check' : 'review');
}

export function workspaceBackup(value) {
  const { searches, shortlists } = workspaceDocument(value);
  return JSON.stringify({ schema: workspaceBackupSchema, version: 1, searches, shortlists }, null, 2);
}

export function readWorkspaceBackup(input) {
  if (typeof input !== 'string' || input.length > workspaceBackupMaximumBytes ||
      new TextEncoder().encode(input).byteLength > workspaceBackupMaximumBytes) {
    throw new Error('Choose a RasterRaid backup up to 2 MiB.');
  }
  let value;
  try { value = JSON.parse(input.replace(/^\uFEFF/u, '')); }
  catch { throw new Error('The backup could not be read as JSON.'); }
  if (value?.schema !== workspaceBackupSchema || value.version !== 1 ||
      !workspaceLists.every(type => Array.isArray(value[type]) && value[type].length <= entryLimit)) {
    throw new Error('Choose a RasterRaid saved workspace backup.');
  }
  const saved = workspaceDocument(value);
  for (const type of workspaceLists) {
    if (saved[type].length !== value[type].length || new Set(saved[type].map(entry => entry.id)).size !== saved[type].length) {
      throw new Error('The backup contains an invalid or repeated saved item.');
    }
  }
  for (const [index, row] of value.shortlists.entries()) {
    const versions = saved.shortlists[index].versions;
    if (versions.length !== row.versions?.length || row.versions.some((version, i) =>
      Object.hasOwn(version, 'filePins') && (!Array.isArray(version.filePins) || version.filePins.length !== (versions[i].filePins?.length ?? 0)))) {
      throw new Error('A shortlist contains incomplete version or file references.');
    }
  }
  if (value.searches.some((row, i) => ['checkpoint', 'catalogCheckpoint'].some(key =>
    Object.hasOwn(row, key) && !saved.searches[i][key]))) {
    throw new Error('A saved comparison checkpoint contains invalid source references.');
  }
  return { searches: saved.searches, shortlists: saved.shortlists };
}

export function workspaceBackupPlan(current, backup) {
  const additions = {};
  const duplicates = {};
  const key = ({ id, ...entry }) => JSON.stringify(entry);
  for (const type of workspaceLists) {
    const seen = new Set(current[type].map(key));
    additions[type] = [];
    duplicates[type] = 0;
    for (const row of backup[type]) {
      const reference = key(row);
      if (seen.has(reference)) { duplicates[type]++; continue; }
      additions[type].push(row);
      seen.add(reference);
    }
  }
  return { additions, duplicates };
}

export function mergeWorkspaceBackup(current, backup, makeId = () => crypto.randomUUID()) {
  const { additions } = workspaceBackupPlan(current, backup);
  const next = { ...current };
  for (const type of workspaceLists) {
    if (current[type].length + additions[type].length > entryLimit) {
      throw new Error('Choose fewer items or make room in your saved ' + (type === 'searches' ? 'searches.' : 'shortlists.'));
    }
    const ids = new Set(current[type].map(row => row.id));
    const added = additions[type].map(row => {
      const id = ids.has(row.id) ? makeId() : row.id;
      if (!uuid.test(id) || ids.has(id)) throw new Error('RasterRaid could not assign a saved item ID.');
      ids.add(id);
      return { ...row, id };
    });
    next[type] = [...added, ...current[type]];
  }
  return next;
}

export function saveWorkspaceEntry(workspace, type, name, value, id = crypto.randomUUID(), checkpoint) {
  if (!['searches', 'shortlists'].includes(type) || !text(name, 100) || !uuid.test(id)) throw new TypeError('Enter a name to save this item.');
  const entry = type === 'searches' ? { id, name, filters: value, [value?.scope === 'report' ? 'checkpoint' : 'catalogCheckpoint']: checkpoint }
    : { id, name, versions: value };
  const validated = workspaceDocument({ [type]: [entry] })[type][0];
  if (!validated) throw new Error('Choose an eligible public search or exact model versions to save.');
  const others = workspace[type].filter(item => item.id !== id);
  if (others.length >= entryLimit) throw new Error('Remove a saved item before adding more to this list.');
  return { ...workspace, [type]: [validated, ...others] };
}

export function updateSearchCheckpoint(workspace, expected, next) {
  const entry = workspace.searches.find(row => row.id === expected.id);
  const report = entry?.filters.scope === 'report';
  const key = report ? 'checkpoint' : 'catalogCheckpoint';
  const prior = entry?.[key];
  const checkpoint = report ? readReportCheckpoint(next) : readCatalogCheckpoint(next);
  if (!entry || (report && !prior) || JSON.stringify(prior) !== JSON.stringify(expected[key]) || !checkpoint ||
      JSON.stringify(entry.filters) !== JSON.stringify(expected.filters) ||
      (prior && (prior.origin !== checkpoint.origin || prior.browsingLevel !== checkpoint.browsingLevel || checkpoint.checkedAt <= prior.checkedAt))) {
    throw new Error('Reopen the latest saved ' + (report ? 'report' : 'search') + ' to update its checkpoint.');
  }
  return { ...workspace, searches: workspace.searches.map(row => row === entry ? { ...row, [key]: checkpoint } : row) };
}

export async function reopenShortlist(context, versions, options = {}) {
  if (!SITE_ORIGINS.includes(context.origin)) throw new TypeError('Open a Civitai workspace.');
  return readSavedModelVersions(context, versionReferences(versions), options);
}

const versionAvailability = { Public: 'Public', EarlyAccess: 'Early access', Private: 'Private', Unlisted: 'Unlisted' };

function setupEvidence(model, profile) {
  const equalFamily = profile.baseModel && model.base && profile.baseModel.toLowerCase() === model.base.toLowerCase();
  const family = !model.base ? 'The catalog did not return a family.' : !profile.baseModel ? model.base
    : equalFamily ? model.base + ' matches your declared family.' : model.base + ' differs from your declared ' + profile.baseModel + ' family.';
  const files = (model.savedFiles ?? model.files ?? []).filter(file => !file.fileType || file.fileType === 'Model').slice(0, 4);
  return {
    id: model.id, modelId: model.modelId, title: [model.model, model.version].filter(Boolean).join(' · '), link: model.link,
    family, familyKind: !model.base ? 'Unknown' : profile.baseModel ? 'Catalog and your setup' : 'Catalog fact', files,
    availability: Object.hasOwn(versionAvailability, model.availability) ? versionAvailability[model.availability] : text(model.availability, 40),
    generationListed: model.generationListed,
    usage: listedCreatorTerms(model.usage),
  };
}

export async function checkWorkspaceSetup(context, versions, settings, options = {}) {
  const profile = environmentProfile(settings);
  const { candidates, unavailable, unavailableFiles } = await reopenShortlist(context, versionReferences(versions).slice(0, 3),
    { ...options, withExamples: false });
  const cards = await Promise.all(candidates.map(async model => {
    if (Object.values(model.usage ?? {}).some(value => value !== null)) return setupEvidence(model, profile);
    try {
      const { data } = await catalogRead(context.origin, '/api/v1/models/' + model.modelId, {}, options);
      if (data?.id === model.modelId && data.modelVersions?.some(row => row.id === model.id)) {
        return setupEvidence({ ...model, usage: modelUsage(data) }, profile);
      }
    } catch {
      options.signal?.throwIfAborted();
    }
    return setupEvidence(model, profile);
  }));
  return { cards, unavailable, unavailableFiles, checkedAt: new Date().toISOString(),
    runtime: profile.runtime, baseModel: profile.baseModel, vram: profile.vram };
}

const throttleOf = flows => (flows ?? []).find(entry => entry?.status === 429);

function filenameQueries(file) {
  const stem = file.slice(0, file.lastIndexOf('.')).replace(/[-_.]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const suffixes = new Set(['v', 'version', 'fp16', 'fp32', 'fp8', 'bf16', 'ema', 'emaonly', 'pruned', 'full', 'sdxl', 'sd15',
    'safetensors', 'quantized', 'baked', 'vae', 'diffusers', 'inpainting']);
  const words = stem.split(' ');
  while (words.length > 1 && (suffixes.has(words.at(-1).toLowerCase()) || /^(?:v\s*)?\d+$/iu.test(words.at(-1)))) words.pop();
  const focus = words.join(' ').replace(/([a-z]{2,})\d+$/u, '$1');
  return [...new Set([focus, stem, focus.replace(/([a-z\d])([A-Z])/gu, '$1 $2')].map(value => text(value, 140)).filter(Boolean))];
}

function checkIdentity(candidates, file, target) {
  const results = new Map();
  for (const model of candidates) {
    const pins = [model.selectedFile, ...(model.matchingFiles ?? [])].filter(Boolean);
    const files = target?.fileId || target?.format || target?.kind === 'hash' ? pins : model.files ?? [];
    for (const entry of files) {
      if (!isModelFile(entry) || !numericId(entry.id)) continue;
      const matches = !target ? publishedName(entry.name) === publishedName(file) : target.kind === 'hash'
        ? publishedName(entry.sha256) === publishedName(target.value)
        : (!target.modelId || model.modelId === target.modelId) && model.id === target.id &&
          (target.fileId ? entry.id === target.fileId : Boolean(file && publishedName(entry.name) === publishedName(file)));
      if (matches) results.set([model.modelId, model.id, entry.id].join('/'), { model, file: entry });
    }
  }
  return [...results.values()];
}

function fileUpdates(current, releases, asset, profile) {
  const swaps = [];
  const differences = [];
  const { model } = current;
  const when = Date.parse(model.publishedAt);
  const fit = releaseSetupIssue(model, asset.kind, profile.baseModel);
  if (!Number.isFinite(when)) return { fit, swaps, differences };
  const newer = releases.filter(version => version.id !== model.id && version.modelId === model.modelId && Date.parse(version.publishedAt) > when)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.id - a.id);
  for (const version of newer) {
    const { reason, file: selected } = comparePublishedRelease(current, version, asset.kind, profile.baseModel);
    if (reason) differences.push({ model: version, reason });
    else swaps.push({ model: version, file: selected });
  }
  return { fit, swaps, differences };
}

function exactLookupRecord(target) {
  return target.kind === 'hash' ? { sha256: target.value.toLowerCase(), fields: [] }
    : { modelId: target.modelId, versionId: target.id, fileId: target.fileId, format: target.format, fields: [] };
}

export async function checkWorkspaceAsset(context, asset, baseModel, {
  signal, fetcher, reference, exactResult, discoverSource = discover, readHistory = readModelFileHistory,
  readExact = readRecordedVersions,
} = {}) {
  if (!SITE_ORIGINS.includes(context.origin)) throw new TypeError('Open a Civitai workspace.');
  const normalized = environmentProfile({ baseModel, assets: [asset] });
  const imported = normalized.assets[0];
  if (!imported) throw new Error('Choose a recognized workflow model file or reference.');
  const file = imported.file ?? '';
  const supplied = catalogSearchText(reference);
  const entered = supplied || imported.air || '';
  const target = entered ? searchTarget(entered) : null;
  if (target && target.kind !== 'hash' && !(target.kind === 'version' &&
      (target.air && (target.fileId || !supplied) || target.download && target.fileId))) {
    throw new Error('Enter a SHA-256, an AIR with a file ID, or a pinned Civitai download link.');
  }
  const queries = filenameQueries(file);
  const query = entered || queries[0];
  if (!query) throw new Error('The filename needs a model name to search.');
  const options = { signal, fetcher, catalogOnly: true };
  const discovered = new Map();
  const histories = new Map();
  const flows = [];
  let partial = false;
  let historyBudget = 3;
  let sharedHash = false;

  async function discoverCandidates(value, family) {
    const result = await discoverSource(context, { scope: 'models', query: value, baseModel: family }, options);
    flows.push(...result.flows ?? []);
    for (const model of result.candidates.filter(model => numericId(model.id) && numericId(model.modelId))) {
      if (!discovered.has(model.id)) discovered.set(model.id, model);
    }
  }

  async function checkHistory(model) {
    if (histories.has(model.modelId) || !historyBudget || throttleOf(flows)) return;
    historyBudget--;
    try {
      const record = await readHistory(context, model.modelId, { ...options, file, versionId: target ? model.id : undefined });
      histories.set(model.modelId, record);
      flows.push(...record.flows ?? []);
      if (record.partial) partial = true;
    } catch {
      signal?.throwIfAborted();
      partial = true;
    }
  }

  async function matchVisibleFiles(reserve = 0) {
    const candidates = [...discovered.values()];
    const found = checkIdentity(candidates, file, target);
    if (found.length === 1) await checkHistory(found[0].model);
    if (!target && !found.length) {
      const models = [...new Map(candidates.map(model => [model.modelId, model])).values()]
        .filter(model => !histories.has(model.modelId)).slice(0, Math.max(0, historyBudget - reserve));
      for (const model of models) await checkHistory(model);
    }
    return target ? found : checkIdentity([...candidates, ...[...histories.values()].flatMap(record => record.candidates)], file, null);
  }

  if (target?.download) {
    const resolved = await discoverSource(context, { scope: 'models', query: target.download.link }, options);
    flows.push(...resolved.flows);
    const match = resolved.candidates.find(model => model.id === target.id && model.selectedFile?.id === target.fileId);
    if (match) discovered.set(match.id, match);
  } else if (target) {
    const resolved = exactResult?.air === entered ? exactResult :
      await readExact(context, { records: [exactLookupRecord(target)] }, {}, { ...options, includeMatchCards: true });
    flows.push(...resolved.flows ?? []);
    sharedHash = target.kind === 'hash' && resolved.ambiguous > 0;
    const match = resolved.matchCards[0];
    if (match) discovered.set(match.id, match);
  } else {
    await discoverCandidates(query, normalized.baseModel);
  }
  let matching = await matchVisibleFiles(normalized.baseModel ? 1 : 0);
  if (!target && !matching.length && !throttleOf(flows) && (!discovered.size || normalized.baseModel)) {
    const alternate = normalized.baseModel ? query : queries[1];
    if (alternate) {
      await discoverCandidates(alternate, '');
      matching = await matchVisibleFiles();
    }
  }
  const verifiedReleases = [...histories.values()].flatMap(record => record.candidates);
  const current = matching.length === 1 ? matching[0] : null;
  if (current && target) {
    const fresh = verifiedReleases.find(model => model.id === current.model.id && model.modelId === current.model.modelId);
    if (fresh) current.model = fresh;
  }
  const sameHistory = current ? histories.get(current.model.modelId) : null;
  const assessment = current ? fileUpdates(current, sameHistory?.candidates ?? [], imported, normalized) : null;
  const proposed = assessment?.swaps[0];
  const throttled = throttleOf(flows);
  return { file, query: target ? '' : query, matching, alternatives: [...discovered.values()].slice(0, 3),
    identity: target?.kind === 'hash' ? 'hash' : target?.download ? 'download' : target?.fileId ? 'air' : target ? 'version' : 'filename', sharedHash,
    exactVersion: target?.kind === 'version' ? discovered.get(target.id) ?? null : null,
    newer: proposed?.model ?? null, newerFile: proposed?.file ?? null, fitIssue: assessment?.fit ?? '',
    current: current ? setupEvidence(current.model, normalized) : null,
    update: proposed ? setupEvidence(proposed.model, normalized) : null,
    otherReleases: assessment?.differences.slice(0, 4) ?? [],
    releasesChecked: Boolean(sameHistory?.candidates.some(model => model.id === current.model.id) && !sameHistory.partial),
    verifiedReleases: sameHistory?.verified ?? 0, listedReleases: sameHistory?.listed ?? 0,
    partial: partial || flows.some(flow => flow.status !== 200), throttled: Boolean(throttled), retryAfter: throttled?.retryAfter ?? null,
  };
}

export async function checkWorkflowFiles(context, settings, { offset = 0, signal, onFile, ...options } = {}) {
  const profile = environmentProfile(settings);
  const start = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, profile.assets.length) : 0;
  const rows = [];
  const selected = profile.assets.slice(start, start + 8);
  const exactSources = new Map();
  const addresses = [...new Set(selected.map(asset => asset.air).filter(Boolean))];
  if (addresses.length && !options.reference) {
    const readExact = options.readExact ?? readRecordedVersions;
    const found = await readExact(context, { records: addresses.map(air => exactLookupRecord(civitaiAir(air))) }, {},
      { signal, fetcher: options.fetcher, includeMatchCards: true });
    for (const [index, air] of addresses.entries()) {
      exactSources.set(air, { air, flows: found.flows, matchCards: [found.matchCards[index]] });
    }
  }
  const readHistory = options.readHistory ?? readModelFileHistory;
  const releases = new Map();
  async function sharedHistory(viewer, modelId, lookup) {
    const pending = releases.get(modelId);
    if (pending) {
      const result = await pending;
      if (!result.partial) return result;
    }
    const request = readHistory(viewer, modelId, lookup);
    releases.set(modelId, request);
    try { return await request; }
    catch (error) {
      if (releases.get(modelId) === request) releases.delete(modelId);
      throw error;
    }
  }
  let retryAfter = null;
  let throttled = false;
  for (let index = 0; index < selected.length && !throttled; index += 2) {
    signal?.throwIfAborted();
    const page = selected.slice(index, index + 2);
    const results = await Promise.allSettled(page.map(asset => checkWorkspaceAsset(context, asset, profile.baseModel,
      { ...options, signal, exactResult: exactSources.get(asset.air), readHistory: sharedHistory })));
    signal?.throwIfAborted();
    for (const [position, result] of results.entries()) {
      const asset = page[position];
      const check = result.status === 'fulfilled' ? result.value : null;
      const row = { asset, check };
      if (check?.throttled) {
        throttled = true;
        retryAfter ??= check.retryAfter;
        break;
      }
      rows.push(row);
      onFile?.(row);
    }
  }
  const next = start + rows.length;
  return { rows, next: next < profile.assets.length ? next : null, checkedAt: new Date().toISOString(), throttled, retryAfter };
}
