import {
  CATALOG, SITE_ORIGINS, catalogRead, civitaiAir, listItems, mediaUrl, numericId, previewUrl, text, visibleRating,
} from './catalog.mjs';
import { collectionResult, searchSite } from './site-results.mjs';
import { plainArticleText } from './article-sources.mjs';
import { discoverGallery, extractReferenceVersions, galleryBaseModels, isGalleryScope } from './gallery.mjs';
import { clipMatchTarget, discoverVisualComposition, discoverVisualNeighbors } from './visual-discovery.mjs';
import { crucibleReference, discoverChallenges, discoverCrucibles, discoverPosts, discoverStorylines } from './community.mjs';
import { discoverBounties } from './bounties.mjs';
import { discoverLeaderboards, leaderboardReference } from './leaderboards.mjs';
import { commerceReference, discoverMarketplace } from './marketplace.mjs';
import { directoryReference, directoryScopes, discoverDirectory } from './directory.mjs';
import { appReference, discoverAppStore } from './app-store.mjs';
import { aiServiceReference, discoverAiServices } from './ai-services.mjs';
import { discoverOpportunities, opportunityReference } from './opportunities.mjs';
import { discover3D, discoverAudio } from './specialty.mjs';
import { discoverSocial, socialReference } from './social-search.mjs';
import { discoverLibrary, libraryReference, libraryScopes } from './library.mjs';
import { catalogWords, foldSearchText, searchTerms as terms, searchWords as words, translateCatalogTerms, translateOnDevice } from './query-language.mjs';
import { correctSpelling, editDistance, protectedReference, searchStarts } from './text-assist.mjs';
import { personalModelOrder } from './preferences.mjs';
import { orderModelRelevance } from './model-reranker.mjs';
import { matchesModelDownload, modelChoiceKey, modelCreatorName, modelDownloadFilter, modelFilterParam, modelFilterValues,
  modelVersionDownload } from './model-access.mjs';
import { nativeModelSearchLink } from './native-model-search.mjs';
import { mergeQuickCatalog, readQuickCatalog, sampleQuickCatalog } from './quick-catalog.mjs';
import { exampleVersionLimit, readPublishedSetup } from './gallery-setup.mjs';

export { mediaUrl } from './catalog.mjs';

const aliases = [
  [/\blinocut\b/i, 'relief print'],
  [/\bchiaroscuro\b/i, 'dramatic lighting'],
  [/\bcel shading\b/i, 'toon shading'],
  [/\bcyanotype\b/i, 'blueprint print'],
  [/\bhalftone\b/i, 'screen print'],
  [/\brisograph\b/i, 'riso print'],
];

const spellingVocabulary = [...new Set([...searchStarts, ...catalogWords].flatMap(words))]
  .filter(word => word.length >= 6);
const literalLabel = 'Civitai model search';
const spellingLabel = 'Spelling recovery';
const saleListing = Symbol('Civitai sale listing');
const genericModelTerms = new Set(['lora', 'sdxl', 'flux', 'pony', 'checkpoint', 'model', 'models', 'style', 'look', 'workflow']);
const releaseSuffix = /(?:\s*[-–—|:]\s*|\s+)\(?(?:v(?:ersion)?\.?|ver\.?)\s*\d+(?:\.\d+)*(?:\s+(?:b(?:eta)?|rc|alpha|build|preview)\s*\d+)?\)?$/iu;
const releaseName = title => text(title, 600).normalize('NFKC').replace(releaseSuffix, '');
const nameKey = title => words(title).join(' ');

function nameMatch(title, inputKey) {
  if (!inputKey) return 0;
  if (nameKey(title) === inputKey) return 2;
  return nameKey(releaseName(title)) === inputKey ? 1 : 0;
}

function spellingPrefix(input) {
  if (protectedReference(input)) return '';
  const tokens = words(input);
  if (tokens.length > 3 || !tokens.every(token => /^[a-z]{2,32}$/u.test(token))) return '';
  const longest = tokens.toSorted((a, b) => b.length - a.length)[0];
  if (!longest || longest.length < 6) return '';
  // Meilisearch treats a final token as a prefix. Require the returned
  // title to pass a separate edit-distance check before showing it.
  return [...tokens.filter(word => word !== longest), longest.slice(0, longest.length >= 9 ? 5 : 4)].join(' ');
}

export function searchTarget(value, { gallery = false, assets3d = false, aiServices = false } = {}) {
  const input = text(value, 500);
  if (!input) throw new Error('Enter a search brief or an exact Civitai reference.');
  const aiService = aiServiceReference(input, { allowId: aiServices });
  if (aiService) return { kind: 'aiService', id: aiService };
  if (/^urn:air:/iu.test(input)) {
    const air = civitaiAir(input);
    if (!air) throw new Error('Use a canonical Civitai AIR address.');
    return air;
  }
  if (/^[a-f0-9]{64}$/i.test(input)) return { kind: 'hash', value: input };
  const version = input.match(/^version\s*[#: ]\s*([1-9]\d{0,14})$/i);
  if (version) return { kind: 'version', id: Number(version[1]) };
  const crucible = input.match(/^crucible\s*[#: ]\s*([1-9]\d{0,9})$/iu);
  if (crucible && Number(crucible[1]) <= 2_147_483_647) return { kind: 'crucible', id: Number(crucible[1]) };
  const publicId = input.match(/^(article|comic|user|comment)\s*[#: ]\s*([1-9]\d{0,9})$/iu);
  if (publicId && Number(publicId[2]) <= 2_147_483_647) return { kind: publicId[1].toLowerCase(), id: Number(publicId[2]) };
  const tag = input.match(/^tag:\s*(.{1,80})$/iu);
  if (tag) return { kind: 'tag', value: tag[1].trim() };
  if (!/^https?:\/\//i.test(input)) return { kind: 'text', value: aiServices ? input : input.slice(0, 160) };

  const url = new URL(input);
  if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password) throw new Error('Use a Civitai.com or Civitai.red link.');
  const clipMatch = clipMatchTarget(url);
  if (clipMatch) return clipMatch;
  if (/^\/images\/?$/u.test(url.pathname) && url.searchParams.has('similarTo')) {
    const refs = url.searchParams.getAll('similarTo');
    if (refs.length !== 1 || !/^[1-9]\d{0,14}$/u.test(refs[0])) throw new Error('Use a Civitai link with one valid reference picture.');
    return { kind: 'similarMedia', id: Number(refs[0]) };
  }
  const competition = crucibleReference(url.pathname) ?? leaderboardReference(url);
  if (competition) return competition;
  const commerce = commerceReference(url);
  if (commerce) return commerce;
  const catalog = libraryReference(url) ?? socialReference(url) ?? directoryReference(url) ?? appReference(url) ?? opportunityReference(url);
  if (catalog) return catalog;
  if (assets3d) {
    const asset = url.pathname.match(/^\/3d-models\/([1-9]\d{0,14})(?:\/[^/]+)?\/?$/u);
    if (asset) return { kind: 'asset3d', id: Number(asset[1]) };
    if (!/^\/collections\/[1-9]\d{0,14}(?:\/[^/]+)?\/?$/u.test(url.pathname)) {
      throw new Error('Paste a link to a Civitai 3D asset or 3D collection.');
    }
  }
  const route = url.pathname.match(/^\/(models|images|collections|posts|storylines|bounties|challenges|challenges\/events)\/([1-9]\d{0,14})(?:\/[^/]+)?\/?$/);
  if (!route) throw new Error(gallery
    ? 'Paste a link to a Civitai image, video, post, or model.'
    : 'Paste a link to a Civitai result page.');
  if (!['models', 'images', 'collections'].includes(route[1]) && Number(route[2]) > 2_147_483_647) {
    throw new Error('Use the Civitai link with a valid ID.');
  }
  if (route[1] === 'models' && url.searchParams.has('modelVersionId')) {
    const ids = url.searchParams.getAll('modelVersionId');
    if (ids.length !== 1 || !/^[1-9]\d{0,14}$/.test(ids[0])) throw new Error('The model version ID is invalid.');
    const files = url.searchParams.getAll('modelFileId');
    if (files.length && (files.length !== 1 || !/^[1-9]\d{0,14}$/.test(files[0]))) throw new Error('The model file ID is invalid.');
    return { kind: 'version', id: Number(ids[0]), modelId: Number(route[2]), ...(files.length && { fileId: Number(files[0]) }) };
  }
  const kind = { bounties: 'bounty', 'challenges/events': 'challengeEvent' }[route[1]] ?? route[1].slice(0, -1);
  return { kind, id: Number(route[2]) };
}

export function queryVariants(input) {
  const tokens = terms(input).slice(0, 8);
  const cleaned = tokens.join(' ');
  const alternate = aliases.find(([pattern]) => pattern.test(cleaned));
  const focus = alternate ? cleaned.match(alternate[0])[0] : tokens.slice(-3).join(' ');
  return [...new Set([input, focus, alternate?.[1] ?? cleaned]
    .map(query => query.trim()).filter(Boolean))].slice(0, 3);
}

function modelQueryVariants(input) {
  const baseline = queryVariants(input);
  const tokens = terms(input);
  if (tokens.length < 6 || baseline.length !== 3 || !/(?:[,;]|\b(?:for|with|using|in|like|find|show)\b)/iu.test(input) ||
      aliases.some(([pattern]) => pattern.test(tokens.join(' ')))) return baseline;
  const tail = tokens.slice(-4).filter(word => !genericModelTerms.has(word)).slice(-2);
  const focus = tail.join(' ');
  return tail.length === 2 && !baseline.slice(0, 2).includes(focus) ? [baseline[0], baseline[1], focus] : baseline;
}

async function recoveryQueries(input, signal) {
  if (!input || protectedReference(input)) return [];
  const corrected = correctSpelling(input, spellingVocabulary);
  const localized = translateCatalogTerms(corrected ?? input);
  if (localized) {
    return [...new Set([localized.focus, localized.brief])]
      .map(query => ({ query, label: 'Language expansion', recovery: true }));
  }
  const translated = await translateOnDevice(corrected ?? input, signal);
  if (translated) return [{ query: translated, label: 'Language expansion', recovery: true }];
  return corrected && terms(corrected).length
    ? [{ query: corrected, label: spellingLabel, recovery: true }]
    : [];
}

function publicFile(entry) {
  const name = typeof entry?.name === 'string' ? text(entry.name.split(/[\\/]/u).at(-1), 260) : '';
  if (!numericId(entry?.id) || !name) return null;
  const hash = entry.hashes?.SHA256;
  return { id: entry.id, name, format: text(entry.metadata?.format, 40),
    sha256: typeof hash === 'string' && /^[a-f\d]{64}$/iu.test(hash) ? hash : null,
    ...(Number.isFinite(entry.sizeKB) && entry.sizeKB > 0 && { sizeKB: entry.sizeKB }),
    ...(text(entry.metadata?.fp, 24) && { precision: text(entry.metadata.fp, 24) }),
    ...(text(entry.metadata?.size, 32) && { fileVariant: text(entry.metadata.size, 32) }),
    ...(text(entry.type, 40) && { fileType: text(entry.type, 40) }) };
}

export function modelUsage(model) {
  const commercial = Array.isArray(model.allowCommercialUse) ? model.allowCommercialUse :
    typeof model.allowCommercialUse === 'string' ? model.allowCommercialUse.trim().replace(/^\{|\}$/gu, '').split(',') : null;
  return {
    creditOptional: typeof model.allowNoCredit === 'boolean' ? model.allowNoCredit : null,
    derivatives: typeof model.allowDerivatives === 'boolean' ? model.allowDerivatives : null,
    differentLicense: typeof model.allowDifferentLicense === 'boolean' ? model.allowDifferentLicense : null,
    commercial: commercial ? [...new Set(commercial.slice(0, 12).map(code => text(code, 40)).filter(Boolean))] : null,
  };
}

function modelVersions(model) {
  if (!numericId(model?.id) || !Array.isArray(model.modelVersions)) return [];
  return model.modelVersions.flatMap(version => {
    if (!numericId(version?.id)) return [];
    return [{
      id: version.id,
      modelId: model.id,
      model: text(model.name),
      version: text(version.name),
      type: text(model.type, 40),
      base: text(version.baseModel, 80),
      checkpointRole: text(version.baseModelType, 48),
      creator: text(model.creator?.username, 80),
      formats: version.selectedFile ? [version.selectedFile.format].filter(Boolean)
        : version.matchingFiles ? version.matchingFiles.map(file => file.format).filter(Boolean)
        : Array.isArray(version.files) ? version.files.map(file => text(file?.metadata?.format, 40)).filter(Boolean) : [],
      files: Array.isArray(version.files) ? version.files.map(publicFile).filter(Boolean).slice(0, 24) : [],
      publishedAt: typeof version.publishedAt === 'string' && Number.isFinite(Date.parse(version.publishedAt)) ? version.publishedAt : null,
      availability: text(version.availability, 40),
      generationListed: typeof version.supportsGeneration === 'boolean' ? version.supportsGeneration : null,
      ...modelVersionDownload(version),
      ...(model[saleListing] && { listingOnSale: true }),
      usage: modelUsage(model),
      desc: text(model.description, 500).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      tags: Array.isArray(model.tags) ? model.tags.map(tag => text(tag, 50)).filter(Boolean).slice(0, 15) : [],
      versionImages: Array.isArray(version.images) ? version.images.slice(0, 6) : [],
      trainedWords: Array.isArray(version.trainedWords) ? version.trainedWords : null,
      ...(version.selectedFile && { selectedFile: version.selectedFile }),
      ...(version.matchingFiles && { matchingFiles: version.matchingFiles }),
    }];
  });
}

const fileIdentity = value => text(value, 260).normalize('NFKC').toLowerCase();

export async function readModelFileHistory(context, modelId, { file, versionId, signal, fetcher } = {}) {
  if (!numericId(modelId)) throw new TypeError('Choose a Civitai model first.');
  const reads = modelCatalogReads(context, {}, { signal, fetcher });
  const site = await reads.read('Model release history', '/api/v1/models/' + modelId, {}, true);
  const list = site?.id === modelId && Array.isArray(site.modelVersions) ? site.modelVersions.filter(row => numericId(row?.id)) : [];
  const byId = new Map(list.map(version => [version.id, version]));
  const filename = fileIdentity(file);
  const direct = list.filter(row => row.id === versionId ||
    filename && Array.isArray(row.files) && row.files.some(entry => fileIdentity(entry?.name) === filename));
  const newest = list.toSorted((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  const ids = [...new Set([...direct, ...newest].map(row => row.id))].slice(0, 48);
  const verified = [];
  if (context.hosted) {
    for (let offset = 0; offset < ids.length && !reads.rateLimits.has('app'); offset += 12) {
      const batch = await reads.exactVersions(ids.slice(offset, offset + 12));
      verified.push(...batch.filter(model => model.id === modelId));
    }
  } else if (ids.length) {
    verified.push({ ...site, modelVersions: ids.map(id => byId.get(id)) });
  }
  signal?.throwIfAborted();
  const appVersions = new Map(verified.flatMap(model => model.modelVersions.map(version => [version.id, version])));
  const ranked = rankVersions([{ label: 'Model release history', models: verified }], '', {}, ids.length, true);
  const candidates = ranked.map(model => {
    const publicVersion = byId.get(model.id);
    const usage = Object.values(model.usage).some(value => value !== null) ? model.usage : modelUsage(site);
    return { ...modelCards([model], context.origin, modelCatalogCeiling(context))[0], usage,
      releaseNotes: plainArticleText(appVersions.get(model.id)?.description || publicVersion?.description, 520) };
  });
  const partial = !site || site.id !== modelId || !list.length || ids.length < byId.size ||
    context.hosted && !context.token || reads.flows.some(flow => flow.status !== 200);
  return { candidates, partial, listed: byId.size, verified: candidates.length, flows: reads.flows };
}

export function rankVersions(lists, input, { baseModel, resourceType, fileFormat = '', exclude = '', downloadAccess = '',
  supportsGeneration, modelAuthor } = {}, limit = 6, keepVersions = false) {
  const candidates = new Map();
  const query = terms(input);
  const inputKey = nameKey(input);
  const exclusions = text(exclude, 200).split(',').map(value => terms(value).join(' ')).filter(Boolean);
  const families = new Set(modelFilterValues(baseModel).map(modelChoiceKey));
  const types = new Set(modelFilterValues(resourceType).map(modelChoiceKey));
  const author = modelChoiceKey(modelCreatorName(modelAuthor));
  for (const { label, models, recovery, query: variant } of lists) {
    const wordsToMatch = recovery && query.length ? terms(variant) : query;
    for (const [position, record] of models.entries()) {
      for (const candidate of modelVersions(record)) {
        if (families.size && !families.has(modelChoiceKey(candidate.base))) continue;
        if (types.size && !types.has(modelChoiceKey(candidate.type))) continue;
        if (modelAuthor && (!author || modelChoiceKey(candidate.creator) !== author)) continue;
        if (supportsGeneration === 'true' && candidate.generationListed !== true) continue;
        if (fileFormat && !candidate.formats.includes(fileFormat)) continue;
        if (!matchesModelDownload(candidate, downloadAccess)) continue;
        const title = words(candidate.model);
        const metadata = [candidate.model, candidate.desc, ...candidate.tags].flatMap(words).join(' ');
        if (exclusions.some(exclusion => (' ' + metadata + ' ').includes(' ' + exclusion + ' '))) continue;
        const match = wordsToMatch.filter(word => title.includes(word)).length;
        const phrase = wordsToMatch.length > 0 && (' ' + title.join(' ') + ' ').includes(' ' + wordsToMatch.join(' ') + ' ');
        const existing = candidates.get(candidate.id);
        if (existing?.retrieval.includes(label)) continue;
        const weight = recovery ? .8 : label.startsWith('Query expansion') ? .65 : label === 'Catalog tag matches' ? .55 : 1;
        const fit = weight / (20 + position);
        candidates.set(candidate.id, {
          ...candidate,
          nameMatch: nameMatch(candidate.model, inputKey),
          literalPosition: label === literalLabel ? position : existing?.literalPosition ?? Number.MAX_SAFE_INTEGER,
          match: Math.max(existing?.match ?? 0, wordsToMatch.length ? match / wordsToMatch.length : 0),
          phrase: Boolean(existing?.phrase || phrase),
          rank: (existing?.rank ?? 0) + fit,
          retrieval: [...(existing?.retrieval ?? []), label],
        });
      }
    }
  }
  const score = candidate => candidate.rank + .02 * candidate.match + (candidate.phrase ? .012 : 0);
  // Exact or release-suffixed titles have priority over the fusion score.
  // The literal catalog order breaks ties between otherwise exact names.
  const sorted = [...candidates.values()].sort((a, b) =>
    b.nameMatch - a.nameMatch || (a.nameMatch ? a.literalPosition - b.literalPosition : 0) ||
    score(b) - score(a) || b.id - a.id);
  const seen = new Set();
  return sorted.filter(candidate => {
    if (!keepVersions && seen.has(candidate.modelId)) return false;
    seen.add(candidate.modelId);
    return true;
  }).slice(0, limit);
}

function extractImage(image, origin) {
  if (!numericId(image?.id)) return null;
  const video = image.type === 'video';
  const audio = image.type === 'audio';
  const url = video || audio ? null : mediaUrl(image.url);
  return {
    id: image.id, postId: numericId(image.postId),
    url,
    preview: previewUrl(video || audio ? image.thumbnail?.url ?? image.thumbnail : url),
    creator: text(image.username, 80),
    video, audio,
    link: new URL('/images/' + image.id, origin).href,
    ...extractReferenceVersions(image),
  };
}

function normalizeVersion(version) {
  const modelId = numericId(version?.modelId ?? version?.model?.id);
  if (!numericId(version?.id) || !modelId) return null;
  return {
    id: modelId,
    name: version.model?.name,
    type: version.model?.type,
    creator: version.model?.creator,
    modelVersions: [version],
  };
}

function airFiles(models, target) {
  if (!target.fileId && !target.format) return models;
  const formatKey = value => text(value, 40).toLowerCase().replace(/safetensors?$/u, 'safetensor');
  return models.flatMap(model => {
    const versions = model.modelVersions.flatMap(version => {
      const files = Array.isArray(version.files) ? version.files : [];
      const matches = files.filter(entry => numericId(entry?.id) && (!target.fileId || entry.id === target.fileId) &&
        (!target.format || [entry.metadata?.format, text(entry.name, 220).split('.').at(-1)].some(value => formatKey(value) === formatKey(target.format))))
        .map(publicFile).filter(Boolean);
      if (matches.length === 1) return [{ ...version, selectedFile: matches[0] }];
      return matches.length ? [{ ...version, matchingFiles: matches }] : [];
    });
    return versions.length ? [{ ...model, modelVersions: versions }] : [];
  });
}

function matchVersionDigest(version, digest) {
  const { selectedFile, matchingFiles, ...details } = version;
  const files = selectedFile ? [selectedFile] : matchingFiles ?? (Array.isArray(version.files) ? version.files.map(publicFile).filter(Boolean) : []);
  const matching = files.filter(file => file.sha256?.toLowerCase() === digest.toLowerCase());
  if (matching.length === 1) return [{ ...details, selectedFile: matching[0] }];
  return matching.length ? [{ ...details, matchingFiles: matching }] : [];
}

function recordedModelMatches(models, claim) {
  const compatible = models.filter(model => !claim.modelId || model.id === claim.modelId);
  const pinned = airFiles(compatible, claim);
  if (!claim.sha256) return pinned;
  return pinned.flatMap(model => {
    const versions = model.modelVersions.flatMap(version => matchVersionDigest(version, claim.sha256));
    return versions.length ? [{ ...model, modelVersions: versions }] : [];
  });
}

const modelPageSize = 6;
const modelPageScopes = new Set(['all', 'models', 'pictures']);
const modelPages = new WeakMap();
const modelCatalogCeiling = context => context.hosted ? context.browsingLevel ?? 1 : 31;
const modelCatalogAccess = context => [context.origin, Boolean(context.hosted), context.viewerUserId, modelCatalogCeiling(context)].join('#');
const modelCursor = value => numericId(value) || (typeof value === 'string' && value.length <= 512 &&
  value === value.trim() && /^[^\u0000-\u001f\u007f]+$/u.test(value) ? value : null);

async function readDigestCandidates(read, hashes) {
  const digests = new Map(hashes.map(hash => [hash.toLowerCase(), new Map()]));
  if (!digests.size) return { digests, complete: true };
  const data = await read('Published file digest candidates', CATALOG.hashVersionIds, {}, true, [...digests.keys()]);
  const complete = Array.isArray(data) && data.length <= 512;
  if (complete) for (const row of data) {
    const key = typeof row?.hash === 'string' && row.hash.length === 64 && row.hash.toLowerCase();
    const version = numericId(row?.modelVersionId);
    if (digests.has(key) && version) digests.get(key).set(version, numericId(row.modelId));
  }
  return { digests, complete };
}

async function exactDigestLookup(reads, lookupVersions, hash) {
  const key = hash.toLowerCase();
  const { digests, complete } = await readDigestCandidates(reads.read, [key]);
  const ids = digests.get(key);
  if (!complete) {
    const version = await reads.read('Published file digest lookup', '/api/v1/model-versions/by-hash/' + key, {}, true);
    const id = numericId(version?.id);
    if (id) ids.set(id, numericId(version.modelId ?? version.model?.id));
  }
  const versions = await lookupVersions([...ids.keys()].slice(0, 12));
  return digestMatches(versions, ids, key, complete);
}

function digestMatches(models, ids, key, complete) {
  const matches = models.flatMap(model => {
    const modelVersions = model.modelVersions.flatMap(version => {
      const assigned = ids.get(version.id);
      return ids.has(version.id) && (!assigned || assigned === model.id) ? matchVersionDigest(version, key) : [];
    });
    return modelVersions.length ? [{ ...model, modelVersions }] : [];
  });
  const files = matches.flatMap(model => model.modelVersions)
    .flatMap(version => [version.selectedFile, ...(version.matchingFiles ?? [])].filter(Boolean));
  const status = ids.size > 1 || files.length > 1 ? 'shared' : !complete || ids.size && !files.length ? 'incomplete' : files.length ? 'unique' : 'missing';
  return { matches, status };
}

export async function readPublishedFiles(context, hashes, { signal, fetcher } = {}) {
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 8 ||
      !hashes.every(hash => typeof hash === 'string' && /^[a-f\d]{64}$/iu.test(hash))) {
    throw new TypeError('Provide one to eight full SHA-256 checksums.');
  }
  const checksums = [...new Set(hashes.map(hash => hash.toLowerCase()))];
  const reads = modelCatalogReads(context, {}, { signal, fetcher });
  const { digests, complete } = await readDigestCandidates(reads.read, checksums);
  const listings = [...digests.values()].map(ids => [...ids.keys()]);
  const ids = new Set();
  // Give each file a chance to show a match before reading additional listings.
  for (let position = 0; position < 12 && ids.size < 12; position++) {
    for (const versions of listings) {
      if (versions[position]) ids.add(versions[position]);
      if (ids.size === 12) break;
    }
  }
  const ceiling = modelCatalogCeiling(context);
  const verified = (await reads.exactVersions([...ids], true)).flatMap(model => {
    const level = model.browsingLevel ?? model.nsfwLevel;
    if (level != null && !visibleRating(level, ceiling)) return [];
    const modelVersions = model.modelVersions.filter(version => {
      const rating = version.browsingLevel ?? version.nsfwLevel;
      return rating == null || visibleRating(rating, ceiling);
    });
    return modelVersions.length ? [{ ...model, modelVersions }] : [];
  });
  signal?.throwIfAborted();
  const files = new Map();
  for (const [digest, candidates] of digests) {
    const { matches, status } = digestMatches(verified, candidates, digest, complete);
    const ranked = rankVersions([{ label: 'Exact file checksum', models: matches }], '', {}, 12, true);
    files.set(digest, { status, candidates: modelCards(ranked, context.origin, ceiling) });
  }
  return { files, flows: reads.flows };
}

export function hashLookupNote(status) {
  return {
    shared: 'Civitai lists this SHA-256 against more than one file or version. Use a version link or an AIR address with a file ID to identify the listing you want.',
    incomplete: 'Civitai could not verify the full set of listings for this SHA-256. A version link or an AIR address with a file ID can identify the listing.',
    missing: 'Civitai returned no verified file for this SHA-256.',
  }[status];
}

function modelCatalogReads(context, filters, { signal, fetcher }) {
  const { origin, token, hosted } = context;
  const ceiling = modelCatalogCeiling(context);
  const flows = [];
  const rateLimits = new Set();
  const checkedVersions = new Map();
  const routeForModels = hosted ? CATALOG.blockModels : CATALOG.models;
  const routeForImages = hosted ? CATALOG.blockImages : CATALOG.images;
  const ordered = Boolean(filters.sort || filters.period);

  async function read(label, route, query, optional = false, fileHashes) {
    signal?.throwIfAborted();
    const rail = route.startsWith('/api/v1/blocks/') ? 'app' : 'site';
    if (rateLimits.has(rail) || (rail === 'app' && !token)) return null;
    try {
      const { data } = await catalogRead(origin, route, query, { token, signal, fetcher, fileHashes,
        privateRead: rail === 'app' && query.owner === 'mine' });
      if (route === CATALOG.blockModels) {
        for (const model of listItems(data)) {
          for (const version of Array.isArray(model?.modelVersions) ? model.modelVersions : []) {
            if (numericId(model.id) && numericId(version?.id)) checkedVersions.set(version.id, { model, version });
          }
        }
      }
      flows.push({ label, status: 200, count: listItems(data).length });
      return data;
    } catch (error) {
      signal?.throwIfAborted();
      const status = error.status ?? null;
      if (status === 429) rateLimits.add(rail);
      flows.push({ label, status, count: 0, retryAfter: error.retryAfter ?? null });
      if (optional || status === 403 || status === 404 || status === 429) return null;
      throw error;
    }
  }

  async function exactVersions(ids, optional = false) {
    if (!ids.length) return [];
    if (hosted) {
      const data = await read('App exact version lookup', routeForModels, { modelVersionIds: ids.join(','), limit: ids.length }, true);
      return listItems(data).filter(model => Array.isArray(model?.modelVersions)).map(model => ({
        ...model,
        modelVersions: model.modelVersions.filter(version => ids.includes(version?.id)),
      }));
    }
    if (!optional) return siteVersionCreators(await Promise.all(ids.map(id => read('Exact version lookup', '/api/v1/model-versions/' + id, {}))));
    const data = [];
    for (let index = 0; index < ids.length && !rateLimits.has('site'); index += 2) {
      const batch = await Promise.all(ids.slice(index, index + 2)
        .map(id => read('Exact version lookup', '/api/v1/model-versions/' + id, {}, true)));
      data.push(...batch);
    }
    return siteVersionCreators(data);
  }

  async function siteVersionCreators(data) {
    const models = data.map(normalizeVersion).filter(Boolean);
    if (!filters.modelAuthor) return models;
    const missing = [...new Set(models.filter(model => !modelCreatorName(model.creator?.username)).map(model => model.id))];
    const verified = new Map();
    for (let index = 0; index < missing.length && !rateLimits.has('site'); index += 2) {
      await Promise.all(missing.slice(index, index + 2).map(async id => {
        const model = await read('Exact model creator', '/api/v1/models/' + id, {}, true);
        if (model?.id === id && modelCreatorName(model.creator?.username)) verified.set(id, model.creator);
      }));
    }
    return models.map(model => verified.has(model.id) ? { ...model, creator: verified.get(model.id) } : model);
  }

  async function saleListings(models) {
    const ids = [...new Set(models.map(model => model?.id).filter(appVersionId))].slice(0, 24);
    if (!ids.length) return new Set();
    const data = await read('Civitai current model sales', CATALOG.models, { ids: ids.join(','), onSale: true, nsfw: true, limit: ids.length }, true);
    return data && Array.isArray(data.items) ? new Set(data.items.map(model => model?.id).filter(id => ids.includes(id))) : null;
  }

  async function confirmedLists(sources, query, limit = 12) {
    if (!hosted || !sources.length) return sources;
    const candidates = rankVersions(sources, ordered ? '' : query, filters, limit);
    const ids = candidates.filter(row => checkedVersions.get(row.id)?.model.id !== row.modelId).map(row => row.id);
    for (let index = 0; index < ids.length && !rateLimits.has('app'); index += 12) {
      await exactVersions(ids.slice(index, index + 12));
    }
    const byModel = new Map();
    for (const row of candidates) {
      const checked = checkedVersions.get(row.id);
      if (checked?.model.id === row.modelId) {
        byModel.set(row.modelId, { ...checked.model, modelVersions: [checked.version], [saleListing]: row.listingOnSale === true });
      }
    }
    return sources.map(source => ({
      ...source, models: source.models.map(model => byModel.get(model?.id)).filter(Boolean),
    }));
  }

  async function finishCards(ranked, candidates, { versionAssociation = false } = {}) {
    const detailIds = hosted ? ranked.filter(row => row.trainedWords === null).map(row => row.id) : [];
    const details = detailIds.length ? read('Generation resource details', CATALOG.blockResources, {
      ids: detailIds.join(','),
    }, true) : null;
    const enrich = async candidate => {
      const data = await read('Examples for version ' + candidate.id, routeForImages, {
        modelVersionId: candidate.id, limit: 2, withMeta: true, ...(hosted ? {} : { browsingLevel: ceiling }),
      }, true);
      return listItems(data)
        .filter(image => hosted || visibleRating(image?.browsingLevel, ceiling))
        .map(image => extractImage(image, origin)).filter(Boolean)
        .map(image => versionAssociation && !image.associated.includes(candidate.id)
          ? { ...image, associated: [...image.associated, candidate.id] } : image);
    };
    const [pictures, resourcesReply] = await Promise.all([Promise.all(candidates.map(enrich)), details]);
    const resources = listItems(resourcesReply);
    return candidates.map((candidate, index) => {
      const resource = resources.find(item => item?.versionId === candidate.id && item.modelId === candidate.modelId);
      return {
        ...candidate,
        examples: pictures[index].length ? pictures[index] : candidate.examples,
        triggers: resource ? triggerWords(resource.trainedWords) : candidate.triggers,
      };
    });
  }

  return { flows, rateLimits, read, exactVersions, saleListings, confirmedLists, finishCards, routeForModels, routeForImages };
}

const triggerWords = value => Array.isArray(value) ? value.map(word => text(word, 100)).filter(Boolean).slice(0, 6) : [];

function modelCards(ranked, origin, ceiling) {
  return ranked.map(({ versionImages, trainedWords, ...candidate }) => ({
    ...candidate,
    link: new URL('/models/' + candidate.modelId + '?modelVersionId=' + candidate.id, origin).href,
    triggers: triggerWords(trainedWords),
    examples: versionImages.filter(image => visibleRating(image?.browsingLevel ?? image?.nsfwLevel, ceiling))
      .map(image => extractImage(image, origin)).filter(image => image?.preview).slice(0, 2),
  }));
}

export async function readSavedModelVersions(context, versions, { fetcher, signal, withExamples = true } = {}) {
  const reads = modelCatalogReads(context, {}, { fetcher, signal });
  const models = await reads.exactVersions(versions.map(entry => entry.versionId), true);
  const byId = new Map(models.map(model => [model.id, model]));
  const ranked = [];
  const unavailable = [];
  const unavailableFiles = [];
  for (const entry of versions) {
    const model = byId.get(entry.modelId);
    const version = model?.modelVersions.find(row => row.id === entry.versionId);
    const pins = entry.filePins ?? [];
    const files = Array.isArray(version?.files) ? version.files : [];
    const savedFiles = pins.flatMap(pin => {
      const exact = files.filter(file => file?.id === pin.fileId);
      const file = exact.length === 1 ? publicFile(exact[0]) : null;
      if (file && (!pin.sha256 || file.sha256?.toLowerCase() === pin.sha256)) return [file];
      unavailableFiles.push({ modelId: entry.modelId, versionId: entry.versionId, fileId: pin.fileId });
      return [];
    });
    if (!version || pins.length && !savedFiles.length) {
      unavailable.push(entry);
      continue;
    }
    const [row] = modelVersions({ ...model, modelVersions: [version] });
    if (savedFiles.length) {
      row.savedFiles = savedFiles;
      row.formats = savedFiles.map(file => file.format).filter(Boolean);
      if (savedFiles.length === 1) row.selectedFile = savedFiles[0];
    }
    ranked.push(row);
  }
  const cards = modelCards(ranked, context.origin, modelCatalogCeiling(context));
  const candidates = withExamples && cards.length ? await reads.finishCards(ranked, cards) : cards;
  signal?.throwIfAborted();
  return { candidates, unavailable, unavailableFiles, flows: reads.flows };
}

function modelContinuation(state) {
  if (!state.pending.length && !state.rails.length) return null;
  const handle = Object.freeze({});
  modelPages.set(handle, state);
  return handle;
}

function matchingModelRows(data, plan, excluded, onSale) {
  const models = listItems(data).filter(model => !excluded?.has(model?.id) &&
    (!plan.nearName || editDistance(plan.nearName, nameKey(releaseName(model?.name))) <= 1));
  return onSale ? models.map(model => ({ ...model, [saleListing]: true })) : models;
}

export async function readModelPage(context, cursor, options = {}) {
  const state = modelPages.get(cursor);
  if (!state || state.access !== modelCatalogAccess(context) || (context.hosted && !context.token)) {
    throw new Error('Civitai access changed. Search again to load more models.');
  }
  if (state.owned) {
    const reads = modelCatalogReads(context, state.filters, options);
    const page = await ownedModelPage(context, reads, state);
    const items = await reads.finishCards(page.ranked, modelCards(page.ranked, context.origin, modelCatalogCeiling(context)), { versionAssociation: true });
    options.signal?.throwIfAborted();
    return { items, nextCursor: page.nextCursor, partial: page.status !== 'ready' || reads.flows.some(flow => flow.status !== 200) };
  }
  const reads = modelCatalogReads(context, state.filters, options);
  const pending = state.pending.filter(row => matchesModelDownload(row, state.filters.downloadAccess));
  const rails = [...state.rails];
  if (pending.length < modelPageSize && rails.length) {
    const excluded = new Set([...state.seen, ...pending.map(item => item.modelId)]);
    const results = await Promise.all(rails.map(async rail => {
      const data = await reads.read(rail.label, rail.route, { ...rail.params, cursor: rail.cursor }, true);
      const next = modelCursor(data?.metadata?.nextCursor);
      return { ...rail, models: matchingModelRows(data, rail, excluded, rail.params.onSale), resolved: Boolean(data),
        next: data ? next !== rail.cursor ? next : null : rail.cursor };
    }));
    const publicResults = results.filter(rail => rail.route === CATALOG.models);
    const confirmed = await reads.confirmedLists(publicResults, state.query, Number.POSITIVE_INFINITY);
    const verificationFailed = reads.flows.some(flow => flow.label === 'App exact version lookup' && flow.status !== 200);
    const verified = new Map(confirmed.map(rail => [rail.label, rail]));
    const sources = results.map(rail => verified.get(rail.label) ?? rail);
    pending.push(...rankVersions(sources, state.query, state.filters, Number.POSITIVE_INFINITY));
    rails.splice(0, rails.length, ...results.flatMap(({ models, next, resolved, ...rail }) => {
      const nextCursor = resolved && verificationFailed && rail.route === CATALOG.models ? rail.cursor : next;
      return nextCursor ? [{ ...rail, cursor: nextCursor }] : [];
    }));
  }
  const ranked = pending.splice(0, modelPageSize);
  const cards = modelCards(ranked, context.origin, modelCatalogCeiling(context));
  const items = await reads.finishCards(ranked, cards);
  options.signal?.throwIfAborted();
  const nextCursor = modelContinuation({ ...state, pending, rails, seen: [...state.seen, ...items.map(item => item.modelId)] });
  return { items, nextCursor, partial: reads.flows.some(flow => flow.status !== 200) };
}

const ownerLabel = 'My published models';
const isPublished = value => (!value?.availability || value.availability === 'Public') &&
  (!value?.status || value.status === 'Published');
const appVersionId = value => numericId(value) && value <= 2_147_483_647;

export async function galleryModelSources(context, query, filters, options) {
  const key = nameKey(query);
  if (!key) return {};
  const { downloadAccess } = filters;
  const access = modelDownloadFilter(downloadAccess);
  const families = new Set(galleryBaseModels(filters.mediaBaseModels));
  const { read, routeForModels, confirmedLists } = modelCatalogReads(context, { downloadAccess, baseModel: [...families] }, options);
  const params = { query, limit: 12, ...(access && { [access.parameter]: true, nsfw: true }) };
  const data = await read('Find the model named in the gallery search', access ? CATALOG.models : routeForModels, params, true);
  if (!data) return { unavailable: true };
  let models = matchingModelRows(data, {}, undefined, params.onSale);
  if (access) {
    const [verified] = await confirmedLists([{ label: literalLabel, models }], query);
    models = verified.models;
  }
  const matches = new Map();
  for (const model of models) {
    if (!appVersionId(model?.id) || !isPublished(model) || model.mode === 'TakenDown') continue;
    const name = text(model.name);
    const exact = nameKey(name) === key;
    const shortTitle = name.split(/\s+(?:[-–—|:]\s+|\()/u, 1)[0];
    if (!exact && nameKey(shortTitle) !== key) continue;
    const releases = (Array.isArray(model.modelVersions) ? model.modelVersions : [])
      .filter(row => appVersionId(row?.id) && isPublished(row) && (!families.size || families.has(row.baseModel)) &&
        (!access || matchesModelDownload({ ...modelVersionDownload(row), listingOnSale: model[saleListing] }, downloadAccess)))
      .slice(0, 2).map(row => ({ title: name, version: text(row.name, 100), modelId: model.id, versionId: row.id,
        link: new URL('/models/' + model.id + '?modelVersionId=' + row.id, context.origin).href }));
    matches.set(model.id, { exact, releases });
  }
  const named = [...matches.values()];
  const exact = named.filter(row => row.exact);
  if (exact.length === 1) return { releases: exact[0].releases };
  return { choices: (exact.length ? exact : named).flatMap(row => row.releases.slice(0, 1)).slice(0, 5) };
}

async function readOwnedModels(context, reads, params) {
  const data = await reads.read(ownerLabel, CATALOG.blockModels, { ...params, owner: 'mine' }, true);
  if (!data) {
    const status = reads.flows.at(-1)?.status;
    return { status: status === 401 ? 'sign-in' : status === 403 ? 'denied' : 'unavailable', models: [] };
  }
  if (data.metadata?.owner !== 'mine' || !Array.isArray(data.items)) {
    return { status: 'unverified', models: [] };
  }
  const models = data.items.flatMap(model => {
    if (!numericId(model?.id) || !isPublished(model) ||
        numericId(model.userId) && Number(context.viewerUserId) !== model.userId ||
        !Array.isArray(model.modelVersions)) return [];
    const versions = model.modelVersions.filter(version => appVersionId(version?.id) && isPublished(version));
    return versions.length ? [{ ...model, modelVersions: versions }] : [];
  });
  return { status: 'ready', models, next: modelCursor(data.metadata.nextCursor) };
}

function rankOwnedModels(models, query, filters, tags, keepVersions = false) {
  const matching = models.filter(model => !tags.length ||
    Array.isArray(model.tags) && tags.every(tag => model.tags.some(name => nameKey(name) === tag)));
  return rankVersions([{ label: ownerLabel, models: matching }], filters.sort ? '' : query, filters,
    Number.POSITIVE_INFINITY, keepVersions);
}

async function ownedModelPage(context, reads, state) {
  const { params, query, filters, tags } = state;
  const pending = [...state.pending];
  let rails = state.rails;
  let fields = {};
  let status = 'ready';
  if (pending.length < modelPageSize && rails.length) {
    const [{ cursor, previous }] = rails;
    const page = await readOwnedModels(context, reads, { ...params, cursor });
    status = page.status;
    if (status === 'ready') {
      const seen = new Set([...state.seen, ...pending.map(item => item.modelId)]);
      pending.push(...rankOwnedModels(page.models.filter(row => !seen.has(row.id)), query, filters, tags));
      const next = page.next;
      rails = next && next !== cursor && !previous.includes(next) ? [{ cursor: next, previous: [...previous, cursor] }] : [];
    } else if (status !== 'unavailable') {
      rails = [];
    }
    if (cursor === undefined) fields = { firstPageRead: status === 'ready', cursorAvailable: rails.length > 0 };
  }
  const ranked = pending.splice(0, modelPageSize);
  const nextCursor = modelContinuation({ ...state, rails, pending, seen: [...state.seen, ...ranked.map(row => row.modelId)] });
  return { ranked, nextCursor, status, ...fields };
}

async function discoverOwnedModels(context, target, filters, { signal, fetcher, onPhase, onRanked, catalogOnly }) {
  const reads = modelCatalogReads(context, filters, { signal, fetcher });
  const origin = context.origin;
  const username = context.viewerUsername;
  const profile = context.viewerUserId && typeof username === 'string' && /^[\p{L}\p{N}_-]{2,80}$/u.test(username);
  const nativeLink = profile ? new URL('/user/' + encodeURIComponent(username) + '/models', origin).href
    : context.viewerUserId ? undefined : new URL('/', origin).href;
  const alternateQueries = [];
  let hashStatus;
  const result = (rows, status, nextCursor) => ({
    scope: 'ownedModels', target, directoryTitle: ownerLabel, nativeLink, ownerStatus: status, hashStatus, alternateQueries,
    candidates: rows, shortlisted: hashStatus && hashStatus !== 'unique' ? [] : rows.slice(0, 3), reference: null,
    related: {}, guides: [], baseline: [], combined: rows.map(row => row.id), flows: [...reads.flows],
    ...(nextCursor && { modelPager: { scope: 'models', nextCursor } }),
  });
  if (!context.hosted || !context.viewerUserId) return result([], 'sign-in');
  if (!context.token) return result([], 'unavailable');
  if (!['text', 'tag', 'version', 'model', 'hash'].includes(target.kind)) return result([], 'wrong-reference');
  const tags = [...new Set([filters.category, target.kind === 'tag' && target.value].filter(Boolean).map(nameKey))];
  const params = { baseModels: modelFilterParam(filters.baseModel), types: modelFilterParam(filters.resourceType), sort: filters.sort,
    supportsGeneration: filters.supportsGeneration === 'true' ? 'true' : undefined };
  onPhase('Searching your published models…');
  let page;
  if (target.kind === 'text' || target.kind === 'tag') {
    const query = target.kind === 'text' ? target.value : '';
    const state = { access: modelCatalogAccess(context), owned: true, query, filters, tags,
      params: { ...params, query, limit: modelPageSize }, seen: [], pending: [], rails: [{ previous: [] }] };
    page = await ownedModelPage(context, reads, state);
    if (query && page.firstPageRead && !page.cursorAvailable && !page.ranked.length) {
      const alternatives = await recoveryQueries(query, signal);
      const alternative = alternatives.find(plan => foldSearchText(plan.query) !== foldSearchText(query))?.query
        ?? (words(query).length > 3 ? modelQueryVariants(query)[1] : undefined);
      if (alternative) {
        const recovered = await ownedModelPage(context, reads, { ...state, query: alternative, params: { ...state.params, query: alternative } });
        if (recovered.ranked.length || recovered.status === 'ready' && recovered.nextCursor) {
          page = recovered;
          alternateQueries.push(alternative);
        } else if (recovered.status === 'unverified') {
          page = recovered;
        }
      }
    }
  } else {
    let status = 'ready';
    const versions = async ids => {
      if (!ids.length) return [];
      const response = await readOwnedModels(context, reads, { modelVersionIds: ids.join(','), limit: ids.length });
      status = response.status;
      return response.models.flatMap(model => {
        const modelVersions = model.modelVersions.filter(version => ids.includes(version.id));
        return modelVersions.length ? [{ ...model, modelVersions }] : [];
      });
    };
    let models;
    if (target.kind === 'hash') {
      const lookup = await exactDigestLookup(reads, versions, target.value);
      models = lookup.matches;
      hashStatus = lookup.status;
    } else if (target.kind === 'model') {
      const record = await reads.read('Published model version list', '/api/v1/models/' + target.id, {}, true);
      const ids = record?.id === target.id && Array.isArray(record.modelVersions)
        ? [...new Set(record.modelVersions.map(version => version?.id).filter(appVersionId))].slice(0, 12) : [];
      models = airFiles((await versions(ids)).filter(model => model.id === target.id), target);
    } else {
      const ids = appVersionId(target.id) ? [target.id] : [];
      models = airFiles((await versions(ids)).filter(model => !target.modelId || model.id === target.modelId), target);
    }
    page = { ranked: rankOwnedModels(models, '', filters, tags, true).slice(0, modelPageSize), status };
  }
  const { ranked, status, nextCursor } = page;
  const cards = modelCards(ranked, origin, modelCatalogCeiling(context));
  if (catalogOnly || !cards.length) return result(cards, status, nextCursor);
  onPhase('Loading previews for your models…');
  onRanked?.(result(cards, status, nextCursor));
  const items = await reads.finishCards(ranked, cards, { versionAssociation: true });
  signal?.throwIfAborted();
  return result(items, status, nextCursor);
}

export async function readRecordedVersions(context, plan, filters, options = {}) {
  const { signal, withExamples = false, includeMatchCards = false, evidenceLabel } = options;
  const records = plan.records.slice(0, 8);
  const reads = modelCatalogReads(context, filters, options);
  const hashes = records.filter(row => !row.versionId && /^[a-f\d]{64}$/iu.test(row.sha256 ?? '')).map(row => row.sha256);
  const { digests } = await readDigestCandidates(reads.read, hashes);
  const entries = records.map(record => ({ record, versions: record.versionId ? [[record.versionId, record.modelId]] :
    [...(digests.get(record.sha256?.toLowerCase()) ?? [])].filter(([, modelId]) => !record.modelId || !modelId || modelId === record.modelId) }));
  const ids = [...new Set(entries.filter(({ versions }) => versions.length === 1).map(({ versions }) => versions[0][0]))];
  for (const { record, versions } of entries) {
    if (!record.fileId || versions.length < 2) continue;
    const extra = versions.map(([id]) => id).filter(id => !ids.includes(id));
    if (ids.length + extra.length <= 12) ids.push(...extra);
  }
  const models = await reads.exactVersions(ids, true);
  const sales = filters.downloadAccess === 'sale' ? await reads.saleListings(models) : undefined;
  signal?.throwIfAborted();

  const strictSiteFilters = Boolean(filters.category || filters.checkpointType || filters.period || filters.fromPlatform === 'true');
  const ranked = new Map();
  const verified = [];
  const matchCards = includeMatchCards ? Array(records.length).fill(null) : null;
  let unavailable = 0;
  let filtered = 0;
  let unknownFit = 0;
  let ambiguous = 0;
  let unconfirmedClaims = 0;
  for (const [index, { record, versions }] of entries.entries()) {
    const shared = versions.length > 1;
    if (shared && (!record.fileId || versions.some(([id]) => !ids.includes(id)))) {
      ambiguous++;
      continue;
    }
    const exact = models.flatMap(model => {
      const modelVersions = model.modelVersions.filter(version => versions.some(([id, modelId]) => id === version.id && (!modelId || model.id === modelId)));
      return modelVersions.length ? [{ ...model, modelVersions, [saleListing]: sales?.has(model.id) }] : [];
    });
    const claims = record.claims ?? [record];
    const checkedClaims = claims.map(claim => ({ claim, models: recordedModelMatches(exact, claim) }));
    const matchedClaims = checkedClaims.filter(match => match.models.length);
    const matched = matchedClaims[0]?.models ?? [];
    const lists = [{ label: evidenceLabel ?? (plan.documents ? 'Recorded in a local reference' : 'Recorded in a local picture'), models: matched }];
    const found = rankVersions(lists, '', {}, 2, true);
    if (found.length > 1 || shared && !found.length) {
      ambiguous++;
      continue;
    }
    if (!found.length) {
      unavailable++;
      continue;
    }
    if (sales === null || modelDownloadFilter(filters.downloadAccess) && !found.some(row => row.downloadAccess)) {
      unknownFit++;
      continue;
    }
    const [fit] = rankVersions(lists, '', filters, 1, true);
    if (!fit || filters.supportsGeneration === 'true' && fit.generationListed === false) {
      filtered++;
      continue;
    }
    if (strictSiteFilters || filters.supportsGeneration === 'true' && fit.generationListed === null) {
      unknownFit++;
      continue;
    }
    const unconfirmed = checkedClaims.filter(match => !match.models.length);
    unconfirmedClaims += unconfirmed.length;
    verified.push({ versionId: fit.id, modelId: fit.modelId,
      fileIds: [fit.selectedFile, ...(fit.matchingFiles ?? [])].filter(Boolean).map(file => file.id),
      fields: record.claims ? [...new Set(matchedClaims.flatMap(({ claim }) => claim.fields))] : record.fields,
      ...(unconfirmed.length && { unconfirmedFields: [...new Set(unconfirmed.flatMap(({ claim }) => claim.fields))] }),
    });
    if (matchCards) matchCards[index] = modelCards([fit], context.origin, modelCatalogCeiling(context))[0];
    if (!ranked.has(fit.id) || fit.selectedFile && !ranked.get(fit.id).selectedFile) ranked.set(fit.id, fit);
  }
  const ordered = [...ranked.values()];
  const cards = modelCards(ordered, context.origin, modelCatalogCeiling(context));
  const extra = withExamples ? await reads.finishCards(ordered.slice(0, 3), cards.slice(0, 3)) : [];
  signal?.throwIfAborted();
  return { candidates: withExamples ? [...extra, ...cards.slice(3)] : cards, flows: reads.flows, verified,
    unavailable, filtered, unknownFit, ambiguous, unconfirmedClaims, checked: records.length, ...(matchCards && { matchCards }) };
}

export async function discover(context, filters, { signal, fetcher, onPhase = () => {}, onRanked, preferences, catalogOnly = false,
  rankModelEvidence = true, focusModelBrief = true, visualCrop, visualBrief, includePublishedSetup = false } = {}) {
  const { origin, token, hosted } = context;
  const scope = filters.scope || 'all';
  const gallery = isGalleryScope(scope);
  const target = filters.query?.trim() ? searchTarget(filters.query, { gallery, assets3d: scope === 'assets3d', aiServices: scope === 'aiServices' })
    : { kind: 'text', value: '' };
  if (visualBrief?.length) return discoverVisualComposition(context, target, { ...filters, scope }, visualBrief, {
    signal, fetcher, onPhase, onRanked,
    searchCatalog: () => discover(context, filters, { signal, fetcher, onPhase, catalogOnly, rankModelEvidence, focusModelBrief }),
  });
  if (scope === 'ownedModels') return discoverOwnedModels(context, target, filters, { signal, fetcher, onPhase, onRanked, catalogOnly });
  if (target.kind === 'aiService' || scope === 'aiServices' && ['text', 'tag'].includes(target.kind)) {
    return discoverAiServices(context, target, filters, { signal, fetcher, onPhase });
  }
  if (target.kind === 'similarMedia') return discoverVisualNeighbors(context, target, filters, { signal, fetcher, onPhase, onRanked, region: visualCrop });
  if (target.kind === 'library' || libraryScopes.includes(scope)) {
    return discoverLibrary(context, target, { ...filters, scope: target.scope ?? scope }, { signal, fetcher });
  }
  const linkedSocial = { hub: 'hubs', topic: 'topics', modelReviews: scope === 'comments' ? 'comments' : 'reviews',
    comment: 'comments', articleComments: 'comments' }[target.kind];
  const socialTargets = { hubs: [], topics: [], communities: ['collection'], reviews: ['model', 'version'],
    comments: ['model', 'version', 'article', 'image', 'post'] }[scope];
  if (linkedSocial || socialTargets && ['text', 'tag', ...socialTargets].includes(target.kind)) {
    return discoverSocial(context, target, linkedSocial ?? scope, { signal, fetcher });
  }
  if (target.kind === 'bounty') return discoverBounties(context, target, filters, { signal, fetcher });
  if (['challenge', 'challengeEvent'].includes(target.kind)) return discoverChallenges(context, target, { signal, fetcher });
  if (target.kind === 'crucible') return discoverCrucibles(context, target, { signal, fetcher });
  if (target.kind === 'leaderboard') return discoverLeaderboards(context, target);
  if (['service', 'serviceShop'].includes(target.kind)) return discoverMarketplace(context, target, 'services');
  if (target.kind === 'buzzMarketplace') return discoverMarketplace(context, target, 'marketplace', { signal, fetcher });
  if (target.kind === 'app' || scope === 'apps') return discoverAppStore(context, target, filters, { signal, fetcher });
  const exactDirectory = { article: 'articles', comic: 'comics', comicChapter: 'comics', user: 'users', tool: 'tools' }[target.kind];
  if (exactDirectory) return discoverDirectory(context, target, exactDirectory, {}, { signal, fetcher });
  if (['auction', 'prize'].includes(target.kind)) return discoverOpportunities(context, target, target.kind + 's', { signal, fetcher });
  if (scope === 'storylines' || target.kind === 'storyline') return discoverStorylines(context, target, { signal, fetcher });
  if (scope === 'bounties') return discoverBounties(context, target, filters, { signal, fetcher });
  if (scope === 'challenges') return discoverChallenges(context, target, { signal, fetcher });
  if (scope === 'crucibles') return discoverCrucibles(context, target, { signal, fetcher });
  if (scope === 'leaderboards') return discoverLeaderboards(context, target);
  if (scope === 'services' || scope === 'marketplace') return discoverMarketplace(context, target, scope, { signal, fetcher });
  if (directoryScopes.includes(scope) && (scope !== 'collections' || ['text', 'tag'].includes(target.kind))) {
    const options = { signal, fetcher };
    const result = await discoverDirectory(context, target, scope, filters, options);
    const plan = result.directory?.plan;
    if (scope !== 'collections' || target.kind !== 'text' || !target.value || result.related.collections.length || result.flows.length ||
        plan?.author || plan?.type || plan?.order) return result;
    const recovered = await recoveryQueries(target.value, signal);
    const alternative = recovered.find(({ query }) => foldSearchText(query) !== foldSearchText(target.value))?.query
      ?? (words(target.value).length > 3 ? queryVariants(target.value)[1] : undefined);
    if (!alternative) return result;
    const expanded = await discoverDirectory(context, { ...target, value: alternative }, scope, filters, options);
    return expanded.related.collections.length ? { ...expanded, target, alternateQueries: [alternative] } : result;
  }
  if (scope === 'auctions' || scope === 'prizes') return discoverOpportunities(context, target, scope, { signal, fetcher });
  if (scope === 'posts' || (target.kind === 'post' && !gallery)) {
    return discoverPosts(context, target, filters, { signal, fetcher }, { rankVersions, queryVariants });
  }
  if (scope === 'audio') return discoverAudio(context, target, filters, { signal, fetcher }, { rankVersions, queryVariants });
  if (scope === 'assets3d') return discover3D(context, target, { signal, fetcher });
  if (gallery) return discoverGallery(context, target, filters, { signal, fetcher, onPhase,
    resolveModel: query => galleryModelSources(context, query, filters, { signal, fetcher }) });
  const ceiling = modelCatalogCeiling(context);
  const { read, exactVersions, saleListings, confirmedLists, finishCards, flows, rateLimits, routeForModels, routeForImages } =
    modelCatalogReads(context, filters, { signal, fetcher });
  const access = modelDownloadFilter(filters.downloadAccess);
  const username = modelCreatorName(filters.modelAuthor);
  if (filters.modelAuthor && !username) throw new Error('Enter a Civitai username in the Creator filter.');
  const advanced = Boolean(filters.category || filters.checkpointType || filters.period || filters.fromPlatform === 'true' || access || username);
  const ordered = Boolean(filters.sort || filters.period);
  const common = {
    baseModels: modelFilterParam(filters.baseModel),
    types: modelFilterParam(filters.resourceType) ?? (filters.checkpointType ? 'Checkpoint' : undefined),
    sort: filters.sort,
    supportsGeneration: filters.supportsGeneration === 'true' ? 'true' : undefined,
  };
  const siteFilters = {
    ...common, nsfw: true, tag: filters.category, checkpointType: filters.checkpointType, username,
    period: filters.period, fromPlatform: filters.fromPlatform === 'true' ? 'true' : undefined,
    ...(access && { [access.parameter]: true }),
  };
  let reference = null;
  let hashStatus;

  const lists = [];
  const continuations = new Map();
  const alternateQueries = new Set();
  let related = {};
  let guideEvidence;
  let quickCatalog;
  let pendingRelated;
  let pendingQuick;
  let relatedFallback;
  let primaryCount = 0;
  const retrieveModels = async (plan, route, params, label = plan.label) => {
    const data = await read(label, route, params, true);
    const cursor = modelCursor(data?.metadata?.nextCursor);
    if (cursor) continuations.set(plan.label, { ...plan, route, params, cursor });
    return { ...plan, models: matchingModelRows(data, plan, undefined, params.onSale) };
  };
  if (target.kind === 'text') {
    const modelSearch = modelPageScopes.has(scope);
    const intent = target.value ? (modelSearch && !ordered && focusModelBrief ? modelQueryVariants(target.value) : queryVariants(target.value)) : [''];
    const recovery = scope !== 'creators' ? await recoveryQueries(target.value, signal) : [];
    const spelling = recovery.find(({ label }) => label === spellingLabel);
    const seenQueries = new Set();
    const variants = [
      { query: intent[0] ?? target.value, label: literalLabel },
      ...recovery.filter(plan => plan !== spelling),
      ...intent.slice(1).map((query, index) => ({ query, label: 'Query expansion ' + (index + 1) })),
    ].filter(({ query }) => {
      const key = query.normalize('NFKC').toLowerCase();
      if (seenQueries.has(key)) return false;
      seenQueries.add(key);
      return true;
    }).slice(0, 3);
    const rail = advanced || !hosted ? CATALOG.models : routeForModels;
    const retrieve = plan => retrieveModels(plan, rail, {
      ...(rail === CATALOG.models ? siteFilters : common), query: plan.query, limit: access ? 24 : filters.fileFormat ? 20 : 10,
    });
    const addModelLists = async sources => {
      if (hosted && rail === CATALOG.models) {
        const selected = ordered ? [sources.find(list => list.models.length) ?? sources[0]].filter(Boolean) : sources;
        lists.push(...await confirmedLists(selected, target.value));
      } else {
        lists.push(...sources);
      }
    };
    const lookup = modelSearch ? Promise.all(variants.map(retrieve)) : [];
    const relatedQuery = words(target.value).length > 3 ? intent[1] ?? target.value : target.value;
    relatedFallback = recovery.find(({ query }) => foldSearchText(query) !== foldSearchText(relatedQuery))?.query;
    // Tags can affect model ranking. The other Site result groups can finish
    // independently while exact-version pictures and details load.
    if (scope === 'all' && target.value) {
      const broad = !catalogOnly && !advanced && !ordered &&
        !common.baseModels && !common.types && !common.supportsGeneration && !filters.fileFormat && !filters.exclude &&
        !protectedReference(target.value) && terms(target.value).length > 0;
      pendingRelated = Promise.allSettled([
        searchSite(read, origin, relatedQuery, scope, ceiling, relatedFallback, { includeTags: false }),
      ]);
      if (broad) pendingQuick = Promise.allSettled([readQuickCatalog(context, target.value, { signal, fetcher })]);
    }
    const siteSearch = target.value || !modelSearch
      ? searchSite(read, origin, relatedQuery, modelSearch ? 'tags' : scope, ceiling, relatedFallback)
      : {};
    const [primary, extra] = await Promise.all([lookup, siteSearch]);
    await addModelLists(primary);
    if (modelSearch && spelling) {
      const focus = terms(intent[1] ?? target.value);
      const direct = rankVersions(lists, target.value, filters);
      const found = direct.some(candidate => candidate.nameMatch || focus.every(word => words(candidate.model).includes(word)));
      if (!found) {
        const query = words(spelling.query).length > 3 ? queryVariants(spelling.query)[1] ?? spelling.query : spelling.query;
        const key = query.normalize('NFKC').toLowerCase();
        if (!seenQueries.has(key)) await addModelLists([await retrieve({ ...spelling, query })]);
      }
    }
    related = extra;
    if (relatedFallback && flows.some(flow => flow.label.endsWith(' (expanded query)') && flow.count)) {
      alternateQueries.add(relatedFallback);
    }
    primaryCount = primary[0]?.models.length ?? 0;
    const tagQuery = primary[0]?.models.length ? target.value : relatedFallback ?? target.value;
    const queryTerms = terms(tagQuery);
    if (modelSearch && !advanced && !filters.sort && queryTerms.length && related.tags?.length) {
      const exactTags = related.tags.filter(item => queryTerms.every(word => terms(item.tag).includes(word)));
      if (exactTags.length) lists.push({ label: 'Catalog tag matches', models: await tagModels(exactTags[0].tag) });
    }
    if (rail === CATALOG.blockModels && token && modelSearch && !lists.some(list => list.models.length) && !rateLimits.has('app')) {
      const fallback = { label: 'Site name matches', query: variants[1]?.query ?? variants[0].query };
      const source = await retrieveModels(fallback, CATALOG.models, { ...siteFilters, query: fallback.query, limit: 12 });
      lists.push(...await confirmedLists([source], target.value));
    }
    if (modelSearch && (!hosted || token) && target.value && !rankVersions(lists, target.value, filters, 1).length) {
      const prefix = !rateLimits.has(rail === CATALOG.models ? 'site' : 'app') && spellingPrefix(target.value);
      if (prefix) {
        const near = await retrieve({ query: prefix, label: 'Near model name', recovery: true, nearName: nameKey(target.value) });
        await addModelLists([near]);
      }
    }
    for (const { query, recovery, models } of lists) {
      if (recovery && models.length) alternateQueries.add(query);
    }
  } else if (target.kind === 'tag') {
    lists.push({ label: 'Catalog tag matches', models: await tagModels(target.value) });
  } else if (target.kind === 'collection') {
    const data = await read('Public collection lookup', '/api/v1/collections/' + target.id, { nsfw: true }, true);
    const collection = data?.id === target.id ? collectionResult(origin, data, ceiling) : null;
    related.collections = collection ? [collection] : [];
  } else if (target.kind === 'hash') {
    const { matches, status } = await exactDigestLookup({ read }, ids => exactVersions(ids, true), target.value);
    hashStatus = status;
    lists.push({ label: 'Exact hash lookup', models: matches });
  } else if (target.kind === 'version') {
    const models = await exactVersions([target.id]);
    lists.push({ label: target.air ? 'Exact Civitai AIR' : 'Exact version',
      models: airFiles(models.filter(model => !target.modelId || model.id === target.modelId), target) });
  } else if (target.kind === 'model') {
    const model = await read('Exact model lookup', '/api/v1/models/' + target.id, {});
    const versions = Array.isArray(model?.modelVersions) ? model.modelVersions : [];
    const requested = target.air ? versions.slice(0, 1) : versions;
    const versionIds = requested.map(version => version?.id).filter(numericId).slice(0, 12);
    const data = hosted ? await exactVersions(versionIds) : model ? [{ ...model, modelVersions: requested }] : [];
    lists.push({ label: target.air ? 'Exact Civitai AIR' : 'Exact model', models: airFiles(data.filter(model => model?.id === target.id), target) });
  } else {
    const data = await read('Reference image', routeForImages, {
      imageId: target.id, limit: 1, withMeta: true, ...(hosted ? {} : { browsingLevel: ceiling }),
    });
    const image = listItems(data).find(item => item?.id === target.id && !item.needsReview && !item.blockedFor &&
      (hosted || visibleRating(item.browsingLevel, ceiling)) &&
      (!includePublishedSetup || visibleRating(item.browsingLevel ?? item.nsfwLevel, ceiling)));
    reference = extractImage(image, origin);
    if (reference) {
      if (includePublishedSetup && !reference.audio) {
        reference.publishedSetup = readPublishedSetup(image.meta);
        reference.recorded = reference.publishedSetup.recorded.map(record => record.versionId);
      }
      const ids = [...new Set([...reference.recorded, ...reference.associated])].slice(0, includePublishedSetup ? exampleVersionLimit : 5);
      const models = await exactVersions(ids);
      lists.push({ label: 'Reference resource links', models });
    }
  }

  async function tagModels(tag) {
    const source = await retrieveModels({ label: 'Catalog tag matches' }, CATALOG.models,
      { ...siteFilters, tag, limit: 12 }, 'Models with catalog tag');
    const [verified] = await confirmedLists([source], tag);
    return verified.models;
  }

  if (filters.downloadAccess === 'sale' && !['text', 'tag'].includes(target.kind)) {
    const sales = await saleListings(lists.flatMap(list => list.models));
    for (const list of lists) list.models = list.models.map(model => ({ ...model, [saleListing]: sales?.has(model.id) }));
  }

  const rankingLists = ordered ? lists.filter(list => list.models.length).slice(0, 1) : lists;
  const rankQuery = ordered ? '' : target.value ?? '';
  const baseline = rankVersions(lists.slice(0, 1), rankQuery, filters);
  const canPage = ['text', 'tag'].includes(target.kind) && modelPageScopes.has(scope);
  const preferenceEligible = canPage && !ordered && target.kind === 'text' && Boolean(target.value);
  const preferenceMode = preferenceEligible && preferences?.enabled === true;
  const resultLimit = includePublishedSetup && target.kind === 'image' ? exampleVersionLimit : modelPageSize;
  const catalogOrder = rankVersions(rankingLists, rankQuery, filters, canPage ? Number.POSITIVE_INFINITY : resultLimit,
    ['model', 'image', 'hash'].includes(target.kind));
  const standardOrder = preferenceEligible && rankModelEvidence
    ? orderModelRelevance(catalogOrder, rankQuery, { alternateQueries: [...alternateQueries] }) : catalogOrder;
  const ranked = (preferenceMode ? personalModelOrder(standardOrder.slice(0, modelPageSize + 1), preferences, ceiling) : standardOrder)
    .slice(0, catalogOnly && canPage ? 12 : resultLimit);
  const candidates = modelCards(ranked, origin, ceiling);
  const nativeLink = canPage ? nativeModelSearchLink(origin, target, filters) : null;
  const snapshot = (rows, nextCursor) => ({
    target, reference, candidates: rows, shortlisted: hashStatus && hashStatus !== 'unique' ? [] : rows.slice(0, 3), related,
    guides: guideEvidence ?? related.guides ?? [], ...(quickCatalog && { quickCatalog }),
    flows: [...flows], alternateQueries: [...alternateQueries].slice(0, 2),
    baseline: baseline.map(candidate => candidate.id), combined: rows.map(candidate => candidate.id), primaryCount,
    ...(nativeLink && { nativeLink, ...(filters.exclude && { nativeModelExclusions: true }) }),
    ...(nextCursor && { modelPager: { scope: 'models', nextCursor } }),
    ...(hashStatus && { hashStatus }),
    ...(preferenceEligible && { preferenceMode, preferenceChanges: ranked.filter((model, index) => model.id !== standardOrder[index]?.id).length }),
  });
  if (candidates.length && !catalogOnly) {
    onPhase('Finding pictures and checking model details…');
    if (scope !== 'pictures' || candidates.some(candidate => candidate.examples.length)) onRanked?.(snapshot(candidates));
  }

  const extra = pendingQuick?.then(([answer]) => sampleQuickCatalog(context, answer.value, candidates, { signal, fetcher }));
  const [complete, optionalRelated, broad] = await Promise.all([catalogOnly ? candidates : finishCards(ranked, candidates), pendingRelated, extra]);
  const [site] = optionalRelated ?? [];
  if (site?.status === 'rejected') throw site.reason;
  signal?.throwIfAborted();
  related = { ...related, ...site?.value };
  if (broad) {
    guideEvidence = related.guides ?? [];
    ({ related, quickCatalog } = mergeQuickCatalog(related, broad, complete, target.value));
  }
  if (relatedFallback && flows.some(flow => flow.label.endsWith(' (expanded query)') && flow.count)) alternateQueries.add(relatedFallback);

  const seen = new Set(ranked.map(row => row.modelId));
  const planned = !ordered ? lists : (rankingLists.length ? rankingLists : lists.slice(0, 1));
  const rails = planned.map(row => continuations.get(row.label)).filter(Boolean).slice(0, 4);
  const nextCursor = canPage && modelContinuation({
    access: modelCatalogAccess(context), query: rankQuery,
    filters: { baseModel: filters.baseModel, resourceType: filters.resourceType, fileFormat: filters.fileFormat,
      exclude: filters.exclude, sort: filters.sort, period: filters.period, downloadAccess: filters.downloadAccess,
      supportsGeneration: filters.supportsGeneration, modelAuthor: filters.modelAuthor },
    seen: [...seen], pending: standardOrder.filter(row => !seen.has(row.modelId)), rails,
  });
  return snapshot(complete, nextCursor);
}
