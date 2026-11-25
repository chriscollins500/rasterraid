import { CATALOG, catalogRead, mediaUrl, numericId, SITE_ORIGINS, text } from './catalog.mjs';
import { plainArticleText } from './article-sources.mjs';
import { comparePublishedRelease, formatKey, isModelFile, listedCreatorTerms, publishedName } from './release-compatibility.mjs';
import { modelUsage, readRecordedVersions, searchTarget } from './search.mjs';

export const upgradeSources = Object.freeze(['models', 'gallery', 'collections', 'articles', 'tools']);

function exactFile(value) {
  if (!numericId(value?.modelId) || !numericId(value.versionId) || !numericId(value.fileId)) return null;
  return { modelId: value.modelId, versionId: value.versionId, fileId: value.fileId };
}

export function upgradePair(value) {
  const from = exactFile(value?.from);
  const to = exactFile(value?.to);
  return from && to && from.modelId === to.modelId && from.versionId !== to.versionId ? { from, to } : null;
}

export function upgradeVersionLink(origin, version) {
  return new URL('/models/' + version.modelId + '?modelVersionId=' + version.versionId, origin).href;
}

export function upgradeForSearch(filters) {
  const pair = upgradePair(filters?.upgradePair);
  if (!pair || filters.scope !== 'report' || filters.reportType !== 'workflow') return null;
  try {
    const anchor = searchTarget(filters.query);
    if (anchor.kind === 'version' && anchor.modelId === pair.to.modelId && anchor.id === pair.to.versionId &&
        (!anchor.fileId || anchor.fileId === pair.to.fileId)) return pair;
  } catch { /* Search validates its own input before submitting. */ }
  return null;
}

function fileMatches(model, reference, format) {
  const file = model?.selectedFile;
  return model?.modelId === reference.modelId && model.id === reference.versionId && file?.id === reference.fileId &&
    isModelFile(file) && (!format || [file.format, file.name?.split('.').at(-1)].some(value => formatKey(value) === formatKey(format)));
}

function checkedCard(result, record, index, format) {
  const recorded = result.matchCards?.[index];
  if (!fileMatches(recorded, record, format)) return null;
  const shown = result.candidates.find(model => model.id === recorded.id && model.modelId === recorded.modelId);
  return { ...recorded, examples: shown?.examples ?? [] };
}

const boolean = value => typeof value === 'boolean' ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const excerpt = value => plainArticleText(value, 500).split(/\s+/u).slice(0, 23).join(' ');
const fileSize = value => Number.isFinite(value) && value > 0 ? value : null;

const memoryTerm = '(?:vram|(?:gpu|graphics|video)\\s+memory)';
const memoryAmount = '([1-9]\\d{0,3}(?:\\.\\d{1,2})?)\\s*(GB|GiB)\\b';
const amountBeforeMemory = new RegExp('(?<![\\d.,])' + memoryAmount + '\\s+(?:of\\s+)?' + memoryTerm + '\\b', 'giu');
const amountAfterMemory = new RegExp('\\b' + memoryTerm + '(?:\\s+(?:required|recommended|minimum))?\\s*[:=]\\s*' + memoryAmount, 'giu');
const memoryMention = new RegExp('\\b' + memoryTerm + '\\b', 'iu');
const memoryDetail = '(?:\\s+' + memoryTerm + ')?\\s*[:=]?$';
const memoryMinimum = new RegExp('\\b(?:minimum(?:\\s+of)?|at least|requires?|needs?)(?:\\s+(?:is|a))?' + memoryDetail, 'iu');
const memoryRecommendation = new RegExp('\\b(?:recommend(?:s|ed)?|recommendation)(?:\\s+(?:is|of))?' + memoryDetail, 'iu');
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

function memoryClaim(note) {
  const amounts = [...note.matchAll(amountBeforeMemory), ...note.matchAll(amountAfterMemory)];
  if (amounts.length !== 1 || /\b(?:no|not|never|without|cannot|failed|out of memory)\b|n['’]t\b/iu.test(note)) return { note };
  const [phrase, amount, unit] = amounts[0];
  const before = note.slice(0, amounts[0].index);
  const after = note.slice(amounts[0].index + phrase.length);
  const subject = (before + phrase.slice(0, phrase.indexOf(amount))).trimEnd();
  const kind = memoryMinimum.test(subject) || /^\s*(?:minimum|required)\b/iu.test(after) ? 'minimum'
    : memoryRecommendation.test(subject) || /^\s*recommended\b/iu.test(after) ? 'recommended'
      : /\b(?:tested|tests)\s+(?:on|with)\b/iu.test(before) ? 'tested' : '';
  return kind ? { note, kind, amount: Number(amount), unit: unit.toLowerCase() === 'gib' ? 'GiB' : 'GB' } : { note };
}

export function creatorMemoryClaims(value) {
  const source = text(value, 80_000);
  const claims = new Map();
  for (const part of source.split(/<\/(?:p|li|h[1-6]|tr)>|<br\b[^>]*>|\r?\n/iu)) {
    const line = plainArticleText(part, 80_000).normalize('NFKC');
    if (!memoryMention.test(line)) continue;
    for (const { segment } of sentences.segment(line)) {
      const note = segment.trim();
      if (!memoryMention.test(note) || note.length > 480 || claims.has(note)) continue;
      claims.set(note, memoryClaim(note));
    }
  }
  return [...claims.values()].sort((first, second) => Number(Boolean(second.kind)) - Number(Boolean(first.kind))).slice(0, 4);
}

const memoryKinds = { minimum: 'Creator’s minimum', recommended: 'Creator’s recommendation', tested: 'Creator’s test figure' };
const memoryLimitNote = 'Creator notes describe particular setups. Run the workflow locally to verify memory use.';

export function upgradeMemoryComparison(comparison, graphicsMemory) {
  const local = Number.isSafeInteger(graphicsMemory) && graphicsMemory > 0 && graphicsMemory <= 2048 ? graphicsMemory : null;
  const sources = (comparison.memorySources ?? []).map(source => ({ ...source, claims: source.claims.map(claim => {
    const label = claim.kind ? memoryKinds[claim.kind] + ' · ' + claim.amount + ' ' + claim.unit : 'Creator’s note';
    if (local === null || claim.unit !== 'GB') return { ...claim, label };
    const amount = Math.round((local - claim.amount) * 100) / 100;
    const difference = amount === 0 ? 'Same stated capacity' : Math.abs(amount) + ' GB ' + (amount > 0 ? 'above' : 'below') + ' this figure';
    return { ...claim, label, difference };
  }) }));
  if (!local && !sources.length) return null;
  return { sources, setup: local ? 'Your setup lists ' + local + ' GB of graphics memory.' : '',
    empty: sources.length ? '' : comparison.memoryChecked ? 'The checked creator notes contained no graphics memory figures.'
      : 'Creator notes were unavailable for the graphics memory check.',
    note: memoryLimitNote };
}

function releaseEvidence(model, publicVersion, permission, origin) {
  const file = model.selectedFile;
  const source = publicVersion?.description || model.releaseNotes || '';
  const hardware = plainArticleText(source, 3000).split(/(?<=[.!?])\s+/u)
    .find(value => /\b(?:VRAM|GPU|graphics memory|graphics cards?)\b/iu.test(value));
  const picture = model.examples?.find(image => !image.video && !image.audio && mediaUrl(image.preview) && numericId(image.id) &&
    image.link === new URL('/images/' + image.id, origin).href);
  return {
    modelId: model.modelId, versionId: model.id, fileId: file.id,
    title: [model.model, model.version].filter(Boolean).join(' · '), link: model.link,
    author: text(model.creator, 80), publishedAt: date(model.publishedAt),
    base: text(model.base, 80), type: text(model.type, 48), role: text(model.checkpointRole, 48),
    file: { name: file.name, sizeKB: fileSize(file.sizeKB), format: text(file.format, 40),
      precision: text(file.precision, 30), variant: text(file.fileVariant, 32) },
    availability: text(model.availability, 40), generationListed: boolean(model.generationListed), publicGeneration: boolean(permission),
    notes: excerpt(source), hardware: excerpt(hardware),
    example: picture ? { link: picture.link, preview: picture.preview, recorded: picture.recorded?.includes(model.id) === true } : null,
  };
}

export async function readUpgradeEvidence(context, pair, filters, {
  signal, fetcher, withExamples, recordedSource = readRecordedVersions,
} = {}) {
  if (!SITE_ORIGINS.includes(context.origin)) throw new TypeError('Use a Civitai host for the upgrade report.');
  const records = [pair.from, pair.to];
  const read = await recordedSource(context, { records: records.map(record => ({ ...record, fields: [] })) }, filters,
    { signal, fetcher, withExamples, includeMatchCards: true });
  signal?.throwIfAborted();
  const models = records.map((record, index) => checkedCard(read, record, index, filters.fileFormat));
  const candidates = models.filter(Boolean);
  const flows = [...(read.flows ?? [])];
  const modelId = pair.from.modelId;
  const ids = candidates.map(model => model.id);
  const checkedAt = new Date().toISOString();
  async function site(label, route, query) {
    try {
      const reply = await catalogRead(context.origin, route, query, { signal, fetcher, privateRead: true });
      flows.push({ label, status: reply.status });
      return reply.data;
    } catch (error) {
      signal?.throwIfAborted();
      flows.push({ label, status: error.status ?? null });
      return null;
    }
  }
  const [listing, gates] = ids.length ? await Promise.all([
    site('Creator’s listing and release notes', '/api/v1/models/' + modelId, {}),
    site('Signed-out generation access', CATALOG.generationPermissions,
      { entityIds: ids.join(','), entityType: 'ModelVersion', permission: 'Generate' }),
  ]) : [];
  signal?.throwIfAborted();
  const publicVersions = listing?.id === modelId && Array.isArray(listing.modelVersions) ? listing.modelVersions : [];
  const versionNotes = models.map(model => model && publicVersions.find(row => row.id === model.id));
  const [previous, next] = models.map((model, index) => model ? releaseEvidence(model, versionNotes[index],
    gates && Object.hasOwn(gates, model.id) ? gates[model.id] : null, context.origin) : null);
  const [fromModel, toModel] = models;
  let fit = 'Both exact files are needed to assess the upgrade.';
  let matches = false;
  if (previous && next) {
    const reason = comparePublishedRelease({ model: fromModel, file: fromModel.selectedFile },
      { ...toModel, files: [toModel.selectedFile] }, '', filters.baseModel).reason;
    const older = Date.parse(previous.publishedAt);
    const newer = Date.parse(next.publishedAt);
    matches = !reason && Number.isFinite(older) && Number.isFinite(newer) && newer > older;
    fit = reason || (matches ? 'Newer release with matching catalog details' : 'The release dates do not establish a newer release.');
  }
  const knownTerms = candidates.map(model => listedCreatorTerms(model.usage)).find(terms => terms.length) ?? [];
  const listed = versionNotes.some(Boolean);
  const listingLink = new URL('/models/' + modelId, context.origin).href;
  const publishedTerms = listed ? listedCreatorTerms(modelUsage(listing)) : [];
  const usage = publishedTerms.length ? publishedTerms : knownTerms;
  const deltaKB = previous?.file.sizeKB && next?.file.sizeKB ? next.file.sizeKB - previous.file.sizeKB : null;
  const notes = [
    ['Current release', previous?.link, versionNotes[0]?.description],
    ['Proposed release', next?.link, versionNotes[1]?.description],
    ['Model listing', listingLink, listed ? listing.description : ''],
  ];
  const memorySources = notes.flatMap(([title, link, description]) => {
    const claims = link ? creatorMemoryClaims(description) : [];
    return claims.length ? [{ title, link, claims }] : [];
  });
  return { candidates, related: {}, flows, upgrade: {
    checkedAt, previous, next, deltaKB, fit, matches, usage,
    termsLink: usage.length ? listingLink : null,
    memoryChecked: notes.some(([, link, description]) => link && plainArticleText(description)), memorySources,
    guides: [], guidesChecked: 0, guidesUnavailable: 0,
  } };
}

export async function upgradeGuides(comparison, articleResult, verifiedRead, origin) {
  const releases = [comparison.previous, comparison.next].filter(Boolean);
  if (!releases.length || articleResult?.flows?.some(flow => flow.status === 429)) return {};
  const seen = new Set();
  const leads = (articleResult?.related.articles ?? []).filter(article => {
    if (!numericId(article.id) || seen.has(article.id) || article.link !== new URL('/articles/' + article.id, origin).href) return false;
    seen.add(article.id);
    return true;
  }).slice(0, 3);
  const inspected = await Promise.all(leads.map(async lead => {
    if (Array.isArray(lead.citations)) return lead;
    const verified = await verifiedRead({ scope: 'articles', query: lead.link }, result =>
      result.related.articles?.some(article => article.link === lead.link && Array.isArray(article.citations)));
    return verified?.related.articles.find(article => article.link === lead.link);
  }));
  const guides = inspected.filter(Boolean).map(article => {
    const references = article.citations.filter(reference => reference.scope === 'models' && reference.id === releases[0].modelId);
    const exact = releases.filter(release => references.some(reference => reference.link === release.link && reference.versionId === release.versionId));
    const mentions = exact.length ? 'exact' : references.length ? 'listing' : 'related';
    const author = text(article.author, 80);
    return { title: article.title, link: article.link, author, mentions,
      creator: Boolean(author && releases.some(release => publishedName(release.author) === publishedName(author))),
      versions: exact.map(release => ({ versionId: release.versionId, link: release.link })), updatedAt: date(article.updatedAt),
    };
  }).sort((first, second) => ({ exact: 0, listing: 1, related: 2 })[first.mentions] - ({ exact: 0, listing: 1, related: 2 })[second.mentions]);
  return { guides, guidesChecked: guides.length, guidesUnavailable: leads.length - guides.length };
}

export function upgradeGuideLabel(guide) {
  const source = guide.creator ? 'Creator article' : 'Community article';
  const reference = guide.mentions === 'exact' ? 'Links to version ' + guide.versions.map(row => '#' + row.versionId).join(' and ')
    : guide.mentions === 'listing' ? 'Links to the model listing' : 'Related result';
  return source + ' · ' + reference;
}

const sizeNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const availability = { Public: 'Public', EarlyAccess: 'Early access', Private: 'Private', Unlisted: 'Unlisted' };
const supported = (value, yes, no) => value === true ? yes : value === false ? no : '';
const diskSize = size => size ? sizeNumber.format(size / 1024) + ' MiB' : '';

export function upgradeFacts(comparison) {
  const facts = [
    ['Model version', row => '#' + row.versionId],
    ['Published file', row => row.file.name + ' · #' + row.fileId],
    ['Release date', row => row.publishedAt?.slice(0, 10)],
    ['Model family', row => row.base],
    ['Resource type', row => row.type],
    ['Checkpoint role', row => row.role],
    ['File format', row => row.file.format],
    ['Precision', row => row.file.precision],
    ['Catalog variant', row => row.file.variant],
    ['Size on disk', row => diskSize(row.file.sizeKB)],
    ['Listing availability', row => Object.hasOwn(availability, row.availability) ? availability[row.availability] : row.availability],
    ['Listed for on-site generation', row => supported(row.generationListed, 'Yes', 'No')],
    ['Generation access when signed out', row => supported(row.publicGeneration, 'Allowed', 'Gated')],
  ];
  return facts.flatMap(([label, value]) => {
    const current = comparison.previous && value(comparison.previous);
    const next = comparison.next && value(comparison.next);
    if (!current && !next && ['Checkpoint role', 'Catalog variant'].includes(label)) return [];
    return [{ label, current: current || 'Unavailable', next: next || 'Unavailable', changed: Boolean(current && next && current !== next) }];
  });
}

export function upgradeStorageChange(comparison) {
  if (comparison.deltaKB === null) return '';
  if (comparison.deltaKB === 0) return 'Both files have the same published size.';
  return 'The proposed file lists ' + diskSize(Math.abs(comparison.deltaKB)) + (comparison.deltaKB > 0 ? ' more' : ' less') + ' on disk.';
}
