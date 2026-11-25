import { publicArticle } from './article-sources.mjs';
import { CATALOG, catalogPause, catalogRead, listItems, numericId, SITE_ORIGINS, text, visibleRating } from './catalog.mjs';
import { catalogEvidenceReference, catalogResearchItems } from './catalog-research.mjs';
import { readAppMediaByIds } from './gallery.mjs';
import { catalogSearchFailure } from './report-recovery.mjs';
import { readSavedModelVersions } from './search.mjs';

const referenceLimit = 40;
const siteCheckLimit = 8;
const siteBatchSize = 3;
const retryCheckMs = 4_000;
const exactCatalog = /^\/(models|images|articles|posts|collections|comics)\/([1-9]\d{0,14})$/u;
const retryCheckKinds = new Set(['models', 'articles', 'collections']);
const usableLevel = level => Number.isInteger(level) && level >= 0 && level <= 63;
const sourceName = { models: 'Model version', images: 'Gallery item', articles: 'Article', posts: 'Post',
  collections: 'Collection', comics: 'Comic', apps: 'App listing' };

export const earlierSourceStatus = {
  available: 'Available in Civitai',
  unavailable: 'Unavailable in your current Civitai view',
  'check-failed': 'Could not check Civitai now',
  unchecked: 'Exact availability unconfirmed',
};

function readCheckpoint(value, allowEmpty) {
  if (!value || !SITE_ORIGINS.includes(value.origin) || !usableLevel(value.browsingLevel) ||
      typeof value.checkedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.checkedAt) ||
      !Number.isFinite(Date.parse(value.checkedAt)) || new Date(value.checkedAt).toISOString() !== value.checkedAt ||
      !Array.isArray(value.references) ||
      (!allowEmpty && !value.references.length) || value.references.length > referenceLimit ||
      new Set(value.references).size !== value.references.length ||
      value.references.some(ref => typeof ref !== 'string' || catalogEvidenceReference(ref, value.origin) !== ref)) return null;
  return { origin: value.origin, browsingLevel: value.browsingLevel, checkedAt: value.checkedAt, references: [...value.references],
    ...(!allowEmpty && value.partial === true && { partial: true }) };
}

export const readReportCheckpoint = value => readCheckpoint(value, false);
export const readCatalogCheckpoint = value => readCheckpoint(value, true);

function currentEvidence(items, origin) {
  const refs = new Map();
  for (const item of items ?? []) {
    const ref = catalogEvidenceReference(item?.link, origin);
    const title = text(item?.title, 160);
    if (ref && title && !refs.has(ref)) refs.set(ref, { ref, title, link: new URL(ref, origin).href });
    if (refs.size === referenceLimit) break;
  }
  return refs;
}

function catalogEvidence(result, origin) {
  if (!result || result.report || result.library || result.visualComposition || result.reference ||
      result.scope === 'ownedModels' || !['text', 'tag'].includes(result.target?.kind) || !SITE_ORIGINS.includes(origin)) return null;
  const models = (result.candidates ?? []).filter(row => row.publiclyListed === true);
  const onlyPictures = result.scope === 'pictures';
  const related = onlyPictures ? { pictures: models.flatMap(model => (model.examples ?? []).map(image => ({
    title: model.model, link: image.link,
  }))) } : result.related ?? {};
  const items = catalogResearchItems(result, related, 'all', origin);
  if (!onlyPictures) items.unshift(...models.map(model => ({
    title: [model.model, model.version].filter(Boolean).join(' · '), link: model.link,
  })));
  return currentEvidence(items, origin);
}

export function captureReportCheckpoint(result, context, checkedAt) {
  const report = result?.report;
  if (!report || context?.connectionLost || result.library || report.localTrace || report.referenceUnavailable || report.releaseLookup ||
      (!result.reportPaused && report.rails?.some(rail => rail.status === 'waiting'))) return null;
  const evidence = currentEvidence([...(report.evidence ?? []), ...(result.searchRetry?.sources ?? [])], context?.origin);
  return readReportCheckpoint({ origin: context?.origin, browsingLevel: context?.browsingLevel,
    checkedAt, references: [...evidence.keys()], partial: result.reportPaused || partialReport(report) });
}

export function captureCatalogCheckpoint(result, context, checkedAt) {
  if (context?.connectionLost) return null;
  const evidence = catalogEvidence(result, context?.origin);
  return evidence ? catalogCheckpoint(evidence, result, context, checkedAt) : null;
}

function catalogCheckpoint(evidence, result, context, checkedAt) {
  const searched = evidence.size > 0 || result.directory?.plan || result.gallery?.status === 'ready' ||
    result.flows?.some(flow => flow.status === 200);
  if (!searched || catalogSearchFailure(result)) return null;
  return readCatalogCheckpoint({ origin: context.origin, browsingLevel: context.browsingLevel, checkedAt, references: [...evidence.keys()] });
}

function exactReference(ref, origin) {
  const url = new URL(ref, origin);
  if (url.origin !== origin || url.hash) return null;
  const found = exactCatalog.exec(url.pathname);
  if (found) {
    const [, kind, rawId] = found;
    const id = numericId(Number(rawId));
    if (!id || kind !== 'images' && id > 2_147_483_647) return null;
    if (kind === 'models') {
      const versionId = numericId(Number(url.searchParams.get('modelVersionId')));
      return versionId && versionId <= 2_147_483_647 && url.search === '?modelVersionId=' + versionId
        ? { ref, kind, id, modelId: id, versionId, label: 'Model version #' + versionId } : null;
    }
    if (!url.search) return { ref, kind, id, label: sourceName[kind] + ' #' + id };
  }
  const app = /^\/apps\/store-preview\/([a-z\d][a-z\d-]{0,63})$/u.exec(url.pathname);
  return app && !url.search ? { ref, kind: 'apps', id: app[1], label: 'App listing · ' + app[1] } : null;
}

function partialReport(report) {
  return report.rails?.some(rail => ['unavailable', 'partial', 'waiting'].includes(rail.status));
}

function replayEvidence(result, origin) {
  if (!result || result.library || result.visualComposition || result.report?.localTrace || result.scope === 'ownedModels') return null;
  return result.report ? currentEvidence(result.report.evidence, origin) : catalogEvidence(result, origin);
}

export async function recoverEarlierSearchSources(previous, current, context, { signal, fetcher, savedRefs = [], waitMs = retryCheckMs } = {}) {
  signal?.throwIfAborted();
  if (!previous || context.connectionLost ||
      !(current.report ? current.report.rails.some(rail => rail.retryable) : catalogSearchFailure(current) === 'retryable')) return null;
  const earlier = replayEvidence(previous, context.origin);
  const recent = replayEvidence(current, context.origin);
  if (!earlier || !recent) return null;
  const known = new Set([...recent.keys(), ...savedRefs]);
  const references = [...new Set([...earlier.keys(), ...(previous.searchRetry?.references ?? [])])]
    .filter(ref => !known.has(ref) && retryCheckKinds.has(exactReference(ref, context.origin)?.kind)).slice(0, siteCheckLimit);
  if (!references.length) return null;
  if (catalogPause(context.origin, fetcher)) {
    return { references, sources: references.map(ref => ({ title: exactReference(ref, context.origin).label, status: 'unchecked' })) };
  }
  const deadline = AbortSignal.timeout(waitMs);
  const sources = await checkOlderReferences(context, references, { signal, fetcher }, true, deadline);
  signal?.throwIfAborted();
  return { references: references.filter((_, index) => sources[index].status !== 'unavailable'), sources };
}

const appLevel = { g: 1, pg: 1, pg13: 2, r: 4, x: 8, xxx: 16 };
function siteTitle({ kind, id }, row, ceiling) {
  if (kind === 'apps') return row.slug === id && visibleRating(appLevel[row.contentRating], ceiling) ? text(row.name, 160) : '';
  if (row.id !== id) return '';
  if (kind === 'articles') return publicArticle(row, ceiling) ? text(row.title, 160) : '';
  if (!visibleRating(row.nsfwLevel, ceiling)) return '';
  if (kind === 'collections') return row.isPublic === true && row.read === 'Public' ? text(row.name, 160) : '';
  if (kind === 'posts') return row.publishedAt ? text(row.title, 160) || 'Post #' + id : '';
  return text(row.name ?? row.title, 160);
}

async function checkOlderReferences(context, references, options, publicOnly, deadline) {
  const rows = references.map(ref => ({ ref, exact: exactReference(ref, context.origin), status: 'unchecked' }));
  const { signal } = options;
  const request = deadline ? { ...options, signal: signal ? AbortSignal.any([signal, deadline]) : deadline } : options;
  const useApp = context.hosted && Boolean(context.token);
  const models = rows.filter(row => row.exact?.kind === 'models').slice(0, useApp ? referenceLimit : siteCheckLimit);
  const media = rows.filter(row => row.exact?.kind === 'images');
  const site = rows.filter(row => row.exact && !['models', 'images'].includes(row.exact.kind)).slice(0, siteCheckLimit);
  const fail = (row, error) => { row.status = [401, 403, 404].includes(error?.status) ? 'unavailable' : 'check-failed'; };
  const mark = (row, title) => { row.status = title ? 'available' : 'unavailable'; if (title) row.title = title; };
  const reads = [];
  if (models.length) reads.push((async () => {
    const checked = await readSavedModelVersions(context, models.map(row => row.exact), { ...request, withExamples: false });
    const visible = new Map(checked.candidates.filter(card => !publicOnly || card.publiclyListed)
      .map(card => [catalogEvidenceReference(card.link, context.origin), [card.model, card.version].filter(Boolean).join(' · ')]));
    const exactReads = checked.flows.filter(flow => flow.label === 'Exact version lookup');
    const complete = (useApp ? checked.flows.length === 1 : exactReads.length === new Set(models.map(row => row.exact.versionId)).size) &&
      checked.flows.every(flow => flow.status === 200 || flow.missing);
    for (const row of models) {
      const title = visible.get(row.ref);
      if (title || complete) mark(row, title);
      else row.status = 'check-failed';
    }
  })().catch(error => { for (const row of models) fail(row, error); }));
  if (media.length && useApp) reads.push((async () => {
    const visible = new Map((await readAppMediaByIds(context, media.map(row => row.exact.id), request)).map(row => [row.id, row.title]));
    for (const row of media) mark(row, visible.get(row.exact.id));
  })().catch(error => { for (const row of media) fail(row, error); }));
  if (!useApp) site.unshift(...media.slice(0, siteCheckLimit - site.length));
  await Promise.all(reads);
  signal?.throwIfAborted();
  for (let first = 0; first < site.length && !deadline?.aborted; first += siteBatchSize) {
    await Promise.all(site.slice(first, first + siteBatchSize).map(async row => {
      try {
        const { kind, id } = row.exact;
        if (kind === 'images') {
          const { data } = await catalogRead(context.origin, CATALOG.images, { imageId: id, limit: 1, browsingLevel: context.browsingLevel }, request);
          const match = listItems(data).find(item => item.id === id && !item.needsReview && !item.blockedFor &&
            visibleRating(item.browsingLevel ?? item.nsfwLevel, context.browsingLevel));
          mark(row, match ? row.exact.label : '');
        } else {
          const { data } = await catalogRead(context.origin, '/api/v1/' + kind + '/' + id,
            kind === 'articles' || kind === 'collections' ? { nsfw: (context.browsingLevel & ~1) !== 0 } : {}, { ...request, privateRead: true });
          mark(row, siteTitle(row.exact, data, context.browsingLevel));
        }
      } catch (error) { fail(row, error); }
    }));
    signal?.throwIfAborted();
  }
  return rows.map(row => ({
    status: row.status, title: row.title ?? row.exact?.label ?? new URL(row.ref, context.origin).pathname,
    ...(row.status === 'available' && { link: new URL(row.ref, context.origin).href }),
  }));
}

export async function reviewReportCheckpoint(previous, result, context, { checkedAt, ...options }) {
  const baseline = readReportCheckpoint(previous);
  if (!baseline || !result?.report || result.report.localTrace || result.library) return null;
  const incomplete = Boolean(result.report.referenceUnavailable || result.report.releaseLookup || partialReport(result.report));
  return compareCheckpoints(baseline, currentEvidence(result.report.evidence, context.origin), context,
    captureReportCheckpoint(result, context, checkedAt), incomplete, { ...options, checkedAt });
}

export async function reviewCatalogCheckpoint(previous, result, context, { checkedAt, ...options }) {
  const baseline = readCatalogCheckpoint(previous);
  const evidence = catalogEvidence(result, context.origin);
  if (!baseline || !evidence || context.connectionLost) return null;
  const next = catalogCheckpoint(evidence, result, context, checkedAt);
  return compareCheckpoints(baseline, evidence, context, next, !next, { ...options, checkedAt }, true);
}

async function compareCheckpoints(baseline, evidence, context, next, partial, { checkedAt, ...options }, catalog = false) {
  const kind = catalog ? { kind: 'search' } : {};
  if (baseline.origin !== context.origin || baseline.browsingLevel !== context.browsingLevel) {
    return { ...kind, status: 'context-changed', checkedAt: baseline.checkedAt, origin: baseline.origin };
  }
  const seen = new Set(baseline.references);
  const older = await checkOlderReferences(context, baseline.references.filter(ref => !evidence.has(ref)), options, catalog);
  const incomplete = partial || older.some(row => row.status === 'check-failed');
  return { ...kind, status: 'ready', savedAt: baseline.checkedAt, checkedAt, incomplete, ...(baseline.partial && { savedPartial: true }),
    same: baseline.references.length - older.length,
    added: [...evidence.values()].filter(row => !seen.has(row.ref)), older, checkpoint: incomplete ? null : next };
}

export function reportComparisonMarkdown(comparison) {
  const { savedAt, checkedAt, added, older, same } = comparison;
  const safe = value => value.replace(/\r?\n|\r/gu, ' ').replace(/[\\\[\]`*<>]/gu, '\\$&');
  const source = row => row.link ? '[' + safe(row.title) + '](<' + row.link + '>)' : safe(row.title);
  const search = comparison.kind === 'search';
  const current = search ? 'sample' : 'report';
  const lines = ['# Changes since saved ' + (search ? 'search' : 'report'), '', 'Saved ' + savedAt, 'Checked ' + checkedAt, '',
    added.length + ' new in this sample · ' + same + ' still in the ' + current + ' · ' + older.length + ' earlier sources outside this sample'];
  if (comparison.savedPartial) lines.push('', 'The saved report had incomplete source coverage.');
  if (comparison.incomplete) lines.push('', 'Some sources could not be checked.');
  if (added.length) lines.push('', '## New in this sample', ...added.map(row => '- ' + source(row)));
  if (older.length) lines.push('', '## Earlier sources', ...older.map(row => '- ' + source(row) + ' · ' + earlierSourceStatus[row.status]));
  return lines.join('\n');
}
