import { numericId, SITE_ORIGINS, text } from './catalog.mjs';
import { catalogResearchItems } from './catalog-research.mjs';
import { collectionTraceCoverage, collectionTrailSources, tracePublicCollection } from './collection-trace.mjs';
import { followGuideReferences } from './guide-trace.mjs';
import { hydratePosts } from './community.mjs';
import { modelChoiceFields, modelDownloadFilter, modelDownloadLabel, modelFilterParam } from './model-access.mjs';
import { discover, galleryModelSources, hashLookupNote, readRecordedVersions, searchTarget } from './search.mjs';
import { describeReferenceEdits, editVerificationPriorities, pictureIntegrityText, recordedReferenceLimit, recordedReferencePlan, studioAuditReport,
  studioEditSession } from './reference-provenance.mjs';
import { readUpgradeEvidence, upgradeFacts, upgradeForSearch, upgradeGuideLabel, upgradeGuides, upgradeMemoryComparison, upgradeStorageChange } from './upgrade-evidence.mjs';
import { GROUPS, resultGroups } from './view.js';
import { foldSearchText } from './query-language.mjs';
import { releaseSampleCoverage, traceReleaseMedia } from './release-trail.mjs';
import { readReportMediaReferences, traceReportMediaModels } from './report-media-models.mjs';
import { exampleModelFacts, exampleVersionLimit, unlinkedUseLabel, verifiedExampleSetup } from './gallery-setup.mjs';
import { creatorBrief, creatorEdges, creatorReportSources, readCreatorTrail } from './creator-trail.mjs';
import { exampleComparisonSources, examplePairIds, exampleSide, exampleVersionUse, readExampleComparison } from './example-comparison.mjs';
import { maximumStorySources, readStoryProject, storyInput, storySources, storyStages } from './story-research.mjs';
import { reportSourceFailure } from './report-recovery.mjs';

export const reportSources = {
  models: 'Models', gallery: 'Gallery images', collections: 'Collections', articles: 'Articles',
  tools: 'Tools', aiServices: 'AI services', videos: 'Videos', audio: 'Audio & music', posts: 'Posts', users: 'Creators',
  comics: 'Comics', storylines: 'Storylines', assets3d: '3D collections', bounties: 'Bounties',
  challenges: 'Challenges', crucibles: 'Crucibles', services: 'Creator Services', hubs: 'Hubs',
  communities: 'Communities', topics: 'Topics', reviews: 'Reviews', comments: 'Discussions',
  leaderboards: 'Leaderboards', auctions: 'Auctions', prizes: 'Prizes', marketplace: 'Buzz articles', apps: 'App Store',
  ownedModels: 'My published models',
};
export const reportTypes = {
  style: { title: 'Find a look', sources: ['models', 'gallery', 'collections', 'articles'] },
  trace: { title: 'Trace an example', sources: ['gallery', 'models', 'posts', 'articles'] },
  examplePair: { title: 'Compare two examples', sources: exampleComparisonSources, fixed: true },
  release: { title: 'Explore a model release', sources: ['models', 'gallery', 'videos', 'posts'] },
  workflow: { title: 'Plan a workflow', sources: ['models', 'articles', 'tools', 'collections', 'users', 'apps'] },
  aiWorkflow: { title: 'Plan with AI services', sources: ['aiServices', 'tools', 'articles', 'models'] },
  guide: { title: 'Follow a guide', sources: ['articles', 'models', 'posts', 'gallery', 'tools'] },
  collection: { title: 'Explore a public collection', sources: ['collections', 'gallery', 'videos', 'posts', 'models'] },
  creator: { title: 'Explore a creator', sources: creatorReportSources.slice(0, 6), available: creatorReportSources },
  media: { title: 'Explore video and music', sources: ['videos', 'audio', 'posts', 'tools'] },
  opportunities: { title: 'Find project opportunities', sources: ['bounties', 'challenges', 'services', 'articles'] },
  stories: { title: 'Develop a story', sources: storySources },
  portfolio: { title: 'Review my releases', sources: ['ownedModels', 'gallery', 'posts'] },
};
export const maximumReportSources = 8;
const sourcesPerBatch = 3;
const cardLimit = 5;
const reportPostLinks = 2;
const limitedSources = new Set(['reviews', 'comments', 'hubs', 'challenges', 'crucibles', 'storylines',
  'services', 'auctions', 'prizes', 'leaderboards', 'marketplace', 'assets3d']);
const modelFields = ['category', 'modelAuthor', 'baseModel', 'resourceType', 'checkpointType', 'fileFormat', 'downloadAccess', 'exclude', 'sort', 'period',
  'supportsGeneration', 'fromPlatform'];
export const releaseModelFields = new Set(['category', 'modelAuthor', 'baseModel', 'resourceType', 'checkpointType', 'fileFormat', 'downloadAccess',
  'exclude', 'supportsGeneration']);

export function reportSettings(type, sources) {
  const selected = Object.hasOwn(reportTypes, type) ? reportTypes[type] : reportTypes.style;
  if (selected.fixed) return { title: selected.title, type, sources: selected.sources };
  const chosen = [...new Set(Array.isArray(sources) ? sources : selected.sources)];
  if (selected === reportTypes.portfolio) {
    if (chosen.some(scope => !selected.sources.includes(scope))) throw new TypeError('Choose sources linked to your releases.');
    return { title: selected.title, sources: selected.sources.filter(scope => scope !== 'posts' || chosen.includes(scope)) };
  }
  if (selected === reportTypes.creator) {
    if (!chosen.includes('users')) chosen.unshift('users');
    if (chosen.length < 2 || chosen.some(scope => !creatorReportSources.includes(scope))) {
      throw new TypeError('Choose the creator profile and at least one source of public work.');
    }
    return { title: selected.title, type: 'creator', sources: creatorReportSources.filter(scope => chosen.includes(scope)) };
  }
  if (selected === reportTypes.release && !chosen.includes('models')) chosen.unshift('models');
  if (chosen.includes('ownedModels')) throw new TypeError('Use Review my releases to search your own models.');
  const maximum = selected === reportTypes.stories ? maximumStorySources : maximumReportSources;
  if (chosen.length < 2 || chosen.length > maximum || chosen.some(scope => !Object.hasOwn(reportSources, scope))) {
    throw new TypeError('Choose between two and ' + (maximum === maximumStorySources ? 'twelve' : 'eight') + ' public sources for the report.');
  }
  if ([reportTypes.collection, reportTypes.release, reportTypes.trace, reportTypes.stories].includes(selected)) {
    const order = [...selected.sources, ...Object.keys(reportSources).filter(scope => !selected.sources.includes(scope))];
    chosen.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  return { title: selected.title, sources: chosen, ...(selected === reportTypes.stories && { type: 'stories' }) };
}

function nativeSource(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && !url.searchParams.has('chat') &&
      !/^\/(?:api\/|user\/(?:notifications|downloads|vault)(?:\/|$)|generate(?:\/|$))/u.test(url.pathname)
      ? url.href : null;
  } catch { return null; }
}

function modelEvidence(candidate, origin) {
  if (!numericId(candidate.id) || !numericId(candidate.modelId)) return null;
  const link = new URL('/models/' + candidate.modelId, origin);
  link.searchParams.set('modelVersionId', candidate.id);
  const title = [text(candidate.model, 145), text(candidate.version, 90)].filter(Boolean).join(' · ');
  if (!title || link.href !== candidate.link) return null;
  const facts = [text(candidate.base, 80), text(candidate.type, 60),
    candidate.creator && 'by ' + text(candidate.creator, 80), text(candidate.desc, 180),
    candidate.linkedFromReportPreview && 'Linked from a report preview',
    candidate.downloadAccess !== 'free' && modelDownloadLabel(candidate), candidate.listingOnSale && 'Civitai lists a sale on this model'].filter(Boolean);
  for (const file of candidate.savedFiles ?? candidate.matchingFiles ?? [candidate.selectedFile]) {
    if (numericId(file?.id)) facts.push('File #' + file.id);
  }
  return { key: link.href, group: 'models', title, link: link.href, facts, versionId: candidate.id };
}

function evidenceFor(result, origin) {
  if (!result || result.library) return [];
  return [
    ...result.candidates.map(candidate => modelEvidence(candidate, origin)).filter(Boolean),
    ...catalogResearchItems(result, resultGroups(result), 'all', origin),
  ];
}

function reportExample(anchor) {
  const item = anchor?.reference;
  if (!item?.preview || item.audio || !numericId(item.id) || item.video && !item.publishedSetup) return null;
  const label = item.video ? 'Clip' : 'Picture';
  return { ...item, tags: [], title: item.creator ? label + ' by ' + item.creator : 'Starting ' + label.toLowerCase() };
}

function anchorEvidence(anchor, origin) {
  const example = reportExample(anchor);
  const items = example ? evidenceFor({ candidates: [], related: { [example.video ? 'videos' : 'gallery']: [example] } }, origin) : [];
  return [...items, ...evidenceFor(anchor, origin)];
}

export function referenceFileFacts(item) {
  return item.group === 'models' ? (item.facts ?? []).filter(fact => /^File #[1-9]\d*$/u.test(fact)) : [];
}

function connectionsFor(candidates, related, evidence, origin, verifiedEdges, limit = 8) {
  const connections = new Map();
  const byLink = new Map(evidence.map(item => [item.link, item]));
  const media = new Map(['gallery', 'videos', 'audio', 'audioExamples', 'postMedia', 'topicImages']
    .flatMap(group => related[group] ?? []).map(item => [item.id, item]));
  const versions = new Map(candidates.map(candidate => [candidate.id, candidate]));
  function add(kind, label, first, second) {
    if (first === second || connections.size >= limit || !byLink.has(first) || !byLink.has(second)) return;
    const pair = [first, second].sort().join('|');
    if (!connections.has(pair)) connections.set(pair, { kind, label, items: [byLink.get(first), byLink.get(second)] });
  }
  for (const { kind, label, first, second } of verifiedEdges) add(kind, label, first, second);
  for (const candidate of candidates) {
    for (const image of candidate.examples ?? []) {
      const match = media.get(image.id);
      if (!match) continue;
      if (image.recorded?.includes(candidate.id)) add('recorded', 'This example records the exact model version', candidate.link, match.link);
      else if (image.associated?.includes(candidate.id)) add('catalog', 'Civitai links this example to the model version', candidate.link, match.link);
    }
    if (candidate.creator) add('creator', 'The model is by this Civitai creator', candidate.link,
      new URL('/user/' + encodeURIComponent(candidate.creator), origin).href);
  }
  for (const item of [...(related.gallery ?? []), ...(related.videos ?? [])]) {
    for (const id of item.recorded ?? []) {
      const model = versions.get(id);
      if (model) add('recorded', 'This example records the exact model version', item.link, model.link);
    }
    for (const id of item.associated ?? []) {
      const model = versions.get(id);
      if (model) add('catalog', 'Civitai links this example to the model version', item.link, model.link);
    }
    const listed = versions.get(item.exampleSource?.versionId);
    if (listed?.link && listed.link === item.exampleSource.link) {
      add('catalog', 'Civitai lists this example for the exact release', item.link, listed.link);
    }
  }
  for (const post of related.posts ?? []) {
    const model = versions.get(post.modelVersionId);
    if (model) add('post-model', 'The post lists this exact model version', post.link, model.link);
    for (const preview of post.previews ?? []) {
      const linked = media.get(preview.id);
      if (linked?.postId === post.id) add('post-media', 'The picture or clip is part of this public post', linked.link, post.link);
    }
  }
  for (const item of evidence) if (item.source) add('citation', 'Civitai source for this result', item.link, item.source);
  return [...connections.values()];
}

const statusLabels = {
  ready: 'Matches available', limited: 'Matches from an available part of Civitai', partial: 'Some results available',
  unavailable: 'Source unavailable', empty: 'No matches returned', native: 'Browse on Civitai', waiting: 'Waiting to search',
  linked: 'Examples linked from the other results', traced: 'Follows a Civitai reference', cited: 'Includes verified guide links',
  noquery: 'This reference has no searchable title',
  'sign-in': 'Sign in on Civitai',
};
export const reportSourceStatus = state => statusLabels[state];

function modelExampleCards(candidates) {
  const cards = new Map();
  for (const model of candidates) for (const image of model.examples ?? []) {
    if (image.preview && !image.video && !image.audio && numericId(image.id) && !cards.has(image.id)) cards.set(image.id, {
      ...image, title: 'Example for ' + model.model, description: model.version, tags: [], source: model.link, sourceTitle: model.model,
    });
  }
  return [...cards.values()];
}

async function discoverPortfolio(context, settings, filters, target, { signal, fetcher, onPhase, discoverSource }) {
  const { origin } = context;
  const options = { signal, fetcher };
  const models = await discoverSource(context, { ...filters, scope: 'ownedModels' }, { ...options, onPhase });
  signal?.throwIfAborted();
  const candidates = models.ownerStatus === 'ready' ? models.candidates.slice(0, cardLimit) : [];
  // Give each checked release its first example before adding second examples.
  const pictures = modelExampleCards([
    ...candidates.map(model => ({ ...model, examples: model.examples.slice(0, 1) })),
    ...candidates.map(model => ({ ...model, examples: model.examples.slice(1) })),
  ]).slice(0, cardLimit);
  const qualified = pictures.filter(item => numericId(item.postId) && item.postId <= 2_147_483_647);
  let posts;
  if (settings.sources.includes('posts') && qualified.length) {
    onPhase('Checking the public posts linked to your previews…');
    posts = await hydratePosts(context, qualified, '', options);
  }
  const checked = {
    ownedModels: { ...models, candidates },
    gallery: { candidates: [], related: { gallery: pictures }, flows: models.flows.filter(flow => flow.label.startsWith('Examples for version ')) },
    posts: { candidates: [], related: { posts: posts?.items ?? [] }, flows: posts?.partial ? [{ status: null }] : [] },
  };
  const rows = settings.sources.map(scope => ({ scope, result: checked[scope],
    traced: scope !== 'ownedModels', items: evidenceFor(checked[scope], origin) }));
  const result = assemble(context, settings, target, target.value, filters, rows);
  result.hashStatus = models.hashStatus;
  if (models.hashStatus && models.hashStatus !== 'unique') result.shortlisted = [];
  result.report.hashStatus = models.hashStatus;
  const ownerRail = result.report.rails.find(rail => rail.scope === 'ownedModels');
  if (models.ownerStatus !== 'ready') ownerRail.status = models.ownerStatus === 'sign-in' ? 'sign-in' :
    models.ownerStatus === 'wrong-reference' ? 'noquery' : 'unavailable';
  result.report.portfolio = {
    limited: Boolean(models.modelPager?.nextCursor || models.candidates.length > candidates.length),
    pictures: pictures.length,
    posts: posts?.items.length ?? 0,
    checkPosts: settings.sources.includes('posts'),
    releases: candidates.map(model => {
      const sample = model.examples.filter(image => pictures.some(picture => picture.id === image.id));
      const recorded = sample.filter(image => image.recorded.includes(model.id)).length;
      const linkedPosts = new Set(posts?.items.filter(post => sample.some(image => post.previews.some(preview => preview.id === image.id)))
        .map(post => post.id));
      return { ...modelEvidence(model, origin), publishedAt: model.publishedAt?.slice(0, 10),
        fileCount: model.files.length, formats: [...new Set(model.formats)].filter(format => typeof format === 'string').slice(0, 6),
        triggers: model.triggers.length, pictures: sample.length, recorded, posts: linkedPosts.size };
    }),
  };
  return result;
}

function linkMediaEvidence(rows, origin) {
  return rows.map(row => {
    const { scope, items } = row;
    if (items.length || !['gallery', 'videos'].includes(scope)) return row;
    const cards = new Map();
    for (const { result } of rows) {
      if (!result || result.library) continue;
      if (scope === 'gallery') for (const image of modelExampleCards(result.candidates)) {
        if (!cards.has(image.id)) cards.set(image.id, image);
      }
      if (scope === 'videos') for (const clip of [...(result.related.audioExamples ?? []), ...(result.related.postMedia ?? [])]) {
        if (clip.video && clip.stream && !cards.has(clip.id)) cards.set(clip.id, clip);
      }
    }
    if (!cards.size) return row;
    const linked = { ...row.result, scope, candidates: [], related: { [scope]: [...cards.values()].slice(0, cardLimit) } };
    const evidence = evidenceFor(linked, origin);
    return evidence.length ? { ...row, result: linked, items: evidence, linked: true } : row;
  });
}

async function linkReportPosts(context, rows, posts, query, options, onPending) {
  const leads = new Map();
  for (const { scope, result } of rows) {
    if (scope !== 'gallery' && scope !== 'videos') continue;
    for (const item of (result?.related[scope] ?? []).slice(0, cardLimit)) {
      if (!numericId(item.postId) || item.postId > 2_147_483_647 || !numericId(item.id) ||
          item.link !== new URL('/images/' + item.id, context.origin).href) continue;
      if (!leads.has(item.postId)) leads.set(item.postId, new Map());
      leads.get(item.postId).set(item.id, item);
    }
  }
  if (!leads.size) return;
  const source = posts.result ?? { scope: 'posts', candidates: [], related: {}, flows: [{ label: 'Post search', status: null }] };
  const knownLinks = new Set();
  const direct = (source.related.posts ?? []).map(post => {
    const sample = leads.get(post.id);
    if (!sample) return post;
    const previews = new Map((post.previews ?? []).map(item => [item.id, item]));
    const members = new Set(post.verifiedMediaIds ?? []);
    for (const [id, item] of sample) {
      if (members.has(id) && !previews.has(id)) previews.set(id, item);
      if (previews.get(id)?.postId === post.id) knownLinks.add(post.id);
    }
    return { ...post, previews: [...previews.values()] };
  });
  const existing = new Map(direct.map(post => [post.id, post]));
  const first = direct.slice(0, cardLimit);
  const head = new Set(first.map(post => post.id));
  const connected = first.filter(post => knownLinks.has(post.id)).length;
  const need = Math.max(0, reportPostLinks - connected);
  const ranked = [...leads.keys()].sort((a, b) => leads.get(b).size - leads.get(a).size);
  const reused = ranked.filter(id => knownLinks.has(id) && !head.has(id)).slice(0, need).map(id => existing.get(id));
  const covered = new Set([...first, ...reused].flatMap(post => post.previews ?? [])
    .filter(item => leads.get(item.postId)?.has(item.id)).map(item => Boolean(item.video)));
  const pending = ranked.filter(id => !existing.has(id)).map(id => [...leads.get(id).values()]);
  const sample = [];
  for (let left = need - reused.length; left > 0 && pending.length; left--) {
    const newKinds = items => new Set(items.map(item => Boolean(item.video)).filter(kind => !covered.has(kind))).size;
    pending.sort((a, b) => newKinds(b) - newKinds(a) || b.length - a.length);
    const items = pending.shift();
    sample.push(...items);
    for (const item of items) covered.add(Boolean(item.video));
  }
  if (sample.length) onPending();
  const verified = sample.length
    ? await hydratePosts(context, sample, query, options)
    : { items: [], partial: false };
  options.signal?.throwIfAborted();
  const linked = [...reused, ...verified.items];
  if (!knownLinks.size && !linked.length && !verified.partial) return;
  const displaced = new Set(first.filter(post => !knownLinks.has(post.id)).reverse()
    .slice(0, Math.max(0, first.length + linked.length - cardLimit)).map(post => post.id));
  const leading = [...first.filter(post => !displaced.has(post.id)), ...linked];
  const leadingIds = new Set(leading.map(post => post.id));
  const ordered = [...leading, ...direct.filter(post => !leadingIds.has(post.id))];
  const result = { ...source, related: { ...source.related, posts: ordered },
    flows: [...(source.flows ?? []), ...(verified.partial ? [{ label: 'Linked post details', status: null }] : [])] };
  Object.assign(posts, { result, items: evidenceFor(result, context.origin), traced: !direct.length && linked.length > 0 });
}

function fuseEvidence(items) {
  const sources = new Map();
  for (const item of items) {
    const earlier = sources.get(item.key);
    sources.set(item.key, earlier ? { ...earlier, facts: [...new Set([...earlier.facts, ...item.facts])].slice(0, 8),
      cover: earlier.cover ?? item.cover, stream: earlier.stream ?? item.stream, video: earlier.video || item.video, music: earlier.music || item.music,
      source: earlier.source ?? item.source, sourceTitle: earlier.sourceTitle || item.sourceTitle } : item);
  }
  return [...sources.values()];
}

async function checkReportSources(scopes, read, origin, signal, onCheckpoint) {
  const rows = [];
  await Promise.all(scopes.map(async (scope, index) => {
    let result, status;
    try {
      result = await read(scope);
    } catch (error) {
      status = error?.status;
    }
    signal?.throwIfAborted();
    rows[index] = { scope, result, status, items: evidenceFor(result, origin), traced: result?.traced };
    onCheckpoint?.(rows);
  }));
  return rows;
}

function assemble(context, settings, target, interpreted, filters, rows, anchor, guideTrace, collectionTrail, releaseSample, mediaModels) {
  const { origin } = context;
  if (!releaseSample && !['creator', 'examplePair'].includes(settings.type)) rows = linkMediaEvidence(rows, origin);
  const reference = anchorEvidence(anchor, origin);
  const localTrace = anchor?.localTrace;
  const exampleSetup = anchor?.exampleSetup;
  const upgrade = anchor?.upgrade;
  const guided = (guideTrace?.records ?? []).map(row => ({ ...row, items: evidenceFor(row.result, origin) }));
  const matches = [...guided, ...rows];
  const all = anchor ? [{ scope: 'reference', result: anchor, items: reference }, ...matches] : matches;
  const modelLimit = settings.type === 'examplePair' ? 18 : localTrace ? recordedReferenceLimit : exampleSetup ? exampleVersionLimit + 1 : cardLimit;
  const proofLinks = new Set(collectionTrail?.edges.flatMap(edge => [edge.first, edge.second]));
  const proof = proofLinks.size ? evidenceFor({ candidates: [], related: collectionTrail.related }, origin).filter(item => proofLinks.has(item.link)) : [];
  const linkedModels = (mediaModels?.candidates ?? []).map(candidate => modelEvidence(candidate, origin)).filter(Boolean);
  const evidence = fuseEvidence([...all.flatMap(row => row.items.slice(0, ['models', 'reference'].includes(row.scope) ? modelLimit : cardLimit)),
    ...proof, ...linkedModels]);
  const models = new Map();
  const groups = {};
  for (const { result, items } of matches) {
    if (!result || result.library) continue;
    const links = new Set(items.map(item => item.link));
    for (const model of result.candidates.slice(0, modelLimit)) {
      if (links.has(model.link) && !models.has(model.id)) models.set(model.id, model);
    }
    for (const [group, cards] of Object.entries(result.related)) {
      if (!Object.hasOwn(GROUPS, group)) continue;
      const kept = groups[group] ??= new Map();
      for (const card of cards.slice(0, cardLimit)) {
        const key = group === 'comicPages' ? card.link + '#' + card.id : card.link;
        if (links.has(card.link) && !kept.has(key) && kept.size < cardLimit) kept.set(key, card);
      }
    }
  }
  const directCandidates = [...models.values()].slice(0, 10);
  for (const candidate of mediaModels?.candidates ?? []) if (!models.has(candidate.id)) models.set(candidate.id, candidate);
  const candidates = [...models.values()].slice(0, 10);
  const modelRanking = rows.find(row => row.scope === 'models')?.result;
  const related = Object.fromEntries(Object.entries(groups).map(([group, cards]) => [group, [...cards.values()]]));
  const constraints = modelFields.flatMap(field => {
    const value = modelChoiceFields.includes(field) ? modelFilterParam(filters[field]) : text(filters[field], 100);
    return value ? [[field, value]] : [];
  });
  const rails = settings.sources.map(scope => {
    const row = rows.find(source => source.scope === scope);
    if (!row) return { scope, label: reportSources[scope], status: 'waiting', count: 0, picks: [] };
    const { result, items } = row;
    const matchesFromGuides = guided.filter(source => source.scope === scope).flatMap(source => source.items)
      .filter(item => item.group === scope);
    const direct = ['models', 'posts'].includes(scope) ? items.filter(item => item.group === scope) : items;
    if (scope === 'models') direct.push(...linkedModels.filter(model => !direct.some(item => item.key === model.key)));
    const matching = matchesFromGuides.length ? fuseEvidence([...matchesFromGuides, ...direct]) : direct;
    const nativeLink = nativeSource(result?.gallery?.nativeLink ?? result?.nativeLink, origin);
    const issue = reportSourceFailure(result, row.status) ?? (scope === 'models' && mediaModels?.partial ? 'retryable' : null);
    const limited = limitedSources.has(scope) || (scope === 'apps' && result?.directory?.nextCursor);
    const status = result?.skipped ? 'noquery' : row.linked ? 'linked' : issue ? matching.length ? 'partial' : 'unavailable'
      : matchesFromGuides.length ? 'cited' : row.traced && matching.length ? 'traced' : limited && (matching.length || scope === 'apps') ? 'limited'
        : matching.length ? 'ready' : nativeLink ? 'native' : 'empty';
    return { scope, label: reportSources[scope], status, count: matching.length, picks: matching.slice(0, 2), nativeLink,
      ...(['unavailable', 'partial'].includes(status) && issue === 'retryable' && { retryable: true }),
      ...(result?.nativeModelExclusions && { nativeModelExclusions: true }) };
  });
  return {
    scope: 'report', target, candidates, related, reference: anchor?.reference ?? null,
    shortlisted: anchor?.hashStatus && anchor.hashStatus !== 'unique' ? [] : candidates.slice(0, 3), guides: [], baseline: [], combined: [],
    ...(anchor?.hashStatus && { hashStatus: anchor.hashStatus }),
    flows: rails.filter(rail => ['unavailable', 'partial'].includes(rail.status)).map(rail => ({ label: rail.label, status: null })),
    alternateQueries: [...new Set(all.flatMap(row => row.result?.alternateQueries ?? []))].slice(0, 5),
    ...(typeof modelRanking?.preferenceMode === 'boolean' && { preferenceMode: modelRanking.preferenceMode,
      preferenceChanges: modelRanking.preferenceChanges }),
    report: { title: settings.title, query: target.value, interpreted, rails, evidence, constraints,
      connections: connectionsFor(directCandidates, related, evidence, origin,
        [...(collectionTrail?.edges ?? []), ...(guideTrace?.edges ?? []), ...(mediaModels?.edges ?? []), ...rows.flatMap(row => row.edges ?? [])],
        releaseSample || ['creator', 'examplePair'].includes(settings.type) ? 24 : collectionTrail ? 20 : 8 + (mediaModels?.edges.length ?? 0)),
      anchor: reference.slice(0, 2),
      ...(anchor?.hashStatus && { hashStatus: anchor.hashStatus }),
      ...(localTrace && { localTrace }),
      ...(exampleSetup && { exampleSetup }),
      ...(upgrade && { upgrade }),
      ...(guideTrace && { guideTrace: guideTrace.summary }),
      ...(collectionTrail && { collectionTrace: collectionTrail.summary }),
      ...(mediaModels && { mediaModelTrace: { previews: mediaModels.checkedPreviews, links: linkedModels.map(model => model.link),
        partial: mediaModels.partial } }),
      ...(releaseSample && { releaseSample }) },
  };
}

async function discoverCreatorReport(context, settings, filters, brief, options) {
  const { origin } = context;
  const input = creatorBrief(brief, origin, filters.modelAuthor);
  const modelFilters = Object.fromEntries(modelFields.filter(key => filters[key]).map(key => [key, filters[key]]));
  const { rows, summary } = await readCreatorTrail(context, settings.sources, input, modelFilters, options);
  const profiles = rows.get('users').related.users;
  const records = settings.sources.map(scope => {
    const result = rows.get(scope);
    return { scope, result, items: evidenceFor(result, origin), edges: creatorEdges(scope, result, profiles) };
  });
  const interpreted = summary.profile ? ['@' + summary.profile.title, input.topic].filter(Boolean).join(' · ') : input.topic;
  const result = assemble(context, settings, { kind: 'text', value: brief }, interpreted, modelFilters, records);
  if (summary.unavailable) result.report.rails = result.report.rails.filter(rail => rail.scope === 'users');
  const links = new Set(result.report.evidence.map(item => item.link));
  result.report.creator = { ...summary, ...(summary.leads && { leads: summary.leads.map(lead => ({ ...lead,
    examples: lead.examples.filter(item => links.has(item.link)),
  })) }) };
  return result;
}

async function discoverExamplePair(context, settings, filters, brief, options) {
  const ids = examplePairIds(brief);
  const modelFilters = Object.fromEntries(modelFields.filter(key => filters[key]).map(key => [key, filters[key]]));
  const pair = await readExampleComparison(context, ids, modelFilters, options);
  const media = pair.summary.examples.flatMap(({ item }) => item ? [item] : []);
  const sources = {
    gallery: { items: media.filter(item => !item.video), flows: pair.mediaFlow },
    videos: { items: media.filter(item => item.video), flows: pair.mediaFlow },
    models: { items: pair.models, flows: pair.modelFlows },
    posts: { items: pair.posts, flows: pair.postFlows },
  };
  const rows = settings.sources.map(scope => {
    const { items, flows } = sources[scope];
    const result = { scope, candidates: scope === 'models' ? items : [],
      related: scope === 'models' ? {} : { [scope]: items }, flows };
    return { scope, result, items: evidenceFor(result, context.origin) };
  });
  const target = { kind: 'text', value: ids.join(' ') };
  const result = assemble(context, settings, target, target.value, filters, rows);
  result.report.exampleComparison = pair.summary;
  return result;
}

async function discoverStoryReport(context, settings, filters, brief, input, options) {
  const sources = [...new Set([...settings.sources, ...input.requested])];
  if (sources.length > maximumStorySources) throw new Error('Choose up to twelve sources including the opportunities in your brief.');
  const selected = { ...settings, sources };
  const target = { kind: 'text', value: brief };
  const modelFilters = Object.fromEntries(modelFields.filter(key => filters[key]).map(key => [key, filters[key]]));
  function snapshot(rows, plan) {
    const prepared = [...rows].map(([scope, result]) => ({ scope, result, items: evidenceFor(result, context.origin) }));
    if (plan?.profile && plan.reference) prepared.find(row => row.scope === 'users').edges = [{
      kind: 'creator-credit', label: 'This account uploaded the reference picture', first: plan.reference, second: plan.profile,
    }];
    const result = assemble(context, selected, target, input.topic, filters, prepared);
    if (plan) result.report.story = { ...plan, stages: storyStages(result.report.evidence, plan, result.report.connections) };
    return result;
  }
  const { rows, plan } = await readStoryProject(context, input, sources, modelFilters, {
    ...options, onProgress: rows => options.onRanked?.(snapshot(rows)),
    onCheckpoint: options.onCheckpoint && (finished => options.onCheckpoint(() => snapshot(finished()))),
  });
  return snapshot(rows, plan);
}

async function discoverReleaseReport(context, settings, filters, brief, { signal, fetcher, onPhase, onRanked, onCheckpoint, discoverSource }) {
  const { origin } = context;
  const target = { kind: 'text', value: brief };
  const options = { signal, fetcher };
  const modelFilters = Object.fromEntries([...releaseModelFields].filter(key => filters[key]).map(key => [key, filters[key]]));
  let parsed = searchTarget(brief);
  if (!['text', 'model', 'version', 'hash'].includes(parsed.kind)) throw new Error('Enter a model name or paste a Civitai model release link.');
  function unavailable(choices, modelResult) {
    const result = assemble(context, settings, target, '', modelFilters, []);
    result.report.rails = [];
    result.report.releaseLookup = { choices: choices ?? [], query: brief };
    if (modelResult?.hashStatus) result.report.hashStatus = modelResult.hashStatus;
    return result;
  }
  onPhase('Verifying the Civitai model release…');
  let lookup = brief;
  if (parsed.kind === 'text') {
    const { releases, choices } = await galleryModelSources(context, parsed.value,
      { mediaBaseModels: filters.baseModel, downloadAccess: modelFilters.downloadAccess }, options);
    signal?.throwIfAborted();
    if (!releases?.length) return unavailable(choices);
    lookup = releases[0].link;
    parsed = searchTarget(lookup);
  }
  const verified = await discoverSource(context, { ...modelFilters, scope: 'models', query: lookup }, { ...options, catalogOnly: true });
  signal?.throwIfAborted();
  if (parsed.kind === 'hash' && verified.hashStatus !== 'unique') return unavailable([], verified);
  const pinnedModel = parsed.modelId ?? (parsed.kind === 'model' ? parsed.id : null);
  const model = verified.candidates.find(candidate => (!pinnedModel || candidate.modelId === pinnedModel) &&
    (parsed.kind !== 'version' || candidate.id === parsed.id) && modelEvidence(candidate, origin) &&
    (!modelFilters.category || candidate.tags?.some(tag => foldSearchText(tag) === foldSearchText(modelFilters.category))) &&
    (!modelFilters.checkpointType || candidate.checkpointRole === modelFilters.checkpointType) &&
    (modelFilters.supportsGeneration !== 'true' || candidate.generationListed === true));
  if (!model) return unavailable([], verified);
  const anchor = { ...verified, candidates: [model], related: {}, traced: true };
  const first = { scope: 'models', result: anchor, items: evidenceFor(anchor, origin), traced: true };
  onRanked?.(assemble(context, settings, target, model.model, modelFilters, [first], anchor));
  const trail = await traceReleaseMedia(context, model, settings.sources, filters, { ...options, onPhase });
  const other = settings.sources.filter(scope => scope !== 'models');
  const rows = [first];
  for (let index = 0; index < other.length; index += sourcesPerBatch) {
    const batch = other.slice(index, index + sourcesPerBatch);
    const prior = rows.slice();
    const read = scope => trail.results.get(scope) ??
      discoverSource(context, { scope, query: model.model, ...(scope === 'audio' && { audioFamilies: filters.audioFamilies }) }, options);
    const current = await checkReportSources(batch, read, origin, signal, onCheckpoint && (finished => onCheckpoint(() =>
      assemble(context, settings, target, model.model, modelFilters, [...prior, ...finished.filter(Boolean)], anchor,
        undefined, undefined, trail.sample))));
    rows.push(...current);
  }
  return assemble(context, settings, target, model.model, modelFilters, rows, anchor, undefined, undefined, trail.sample);
}

export async function discoverReport(context, filters, {
  signal, fetcher, onPhase = () => {}, onRanked, onCheckpoint, discoverSource = discover, followLinks = true, preferences,
  recordedReferences, editPairs, recordedSource = readRecordedVersions,
} = {}) {
  if (!SITE_ORIGINS.includes(context.origin)) throw new TypeError('Use a Civitai host for the report.');
  const pairKind = editPairs?.[0]?.kind;
  const pictureComparison = pairKind === 'pictures';
  const sidecarComparison = pairKind === 'sidecars';
  const brief = sidecarComparison ? '' : text(filters.query, 500);
  const references = editPairs ? editPairs.flatMap(({ original, draft, kind }) => [original,
    kind === 'pictures' || kind === 'sidecars' ? draft : { source: studioEditSession, references: [...draft.references, ...draft.removed] }]) : recordedReferences;
  const upgrade = references ? null : upgradeForSearch(filters);
  const local = recordedReferencePlan(references, editPairs ? { priority: editVerificationPriorities(editPairs) } : undefined);
  const hasLocal = local.records.length > 0;
  if (references && !hasLocal) throw new Error('Choose a reference file with recorded Civitai versions or an exact model file hash.');
  const settings = reportSettings(filters.reportType, filters.reportSources);
  if (filters.reportType === 'portfolio' && !references) {
    const fields = ['category', 'baseModel', 'resourceType', 'fileFormat', 'exclude', 'sort', 'supportsGeneration'];
    const ownerFilters = Object.fromEntries(fields.filter(name => filters[name]).map(name => [name, filters[name]]));
    if (!brief && !ownerFilters.sort) ownerFilters.sort = 'Newest';
    return discoverPortfolio(context, settings, { ...ownerFilters, query: brief }, { kind: 'text', value: brief },
      { signal, fetcher, onPhase, discoverSource });
  }
  if (filters.reportType === 'portfolio') throw new Error('Choose a catalog release to review or use a reference report for local files.');
  if (!brief && !hasLocal) throw new Error('Describe what you are looking for or paste a public Civitai link.');
  if (settings.type === 'creator' && !references && !upgrade) {
    return discoverCreatorReport(context, settings, filters, brief, { signal, fetcher, onPhase, discoverSource });
  }
  if (settings.type === 'examplePair') {
    if (references || upgrade) throw new Error('Use two public Civitai examples for this comparison.');
    return discoverExamplePair(context, settings, filters, brief, { signal, fetcher, onPhase, recordedSource });
  }
  if (settings.type === 'stories' && !references && !upgrade && followLinks) {
    const input = storyInput(brief);
    if (input) return discoverStoryReport(context, settings, filters, brief, input,
      { signal, fetcher, onPhase, onRanked, onCheckpoint, discoverSource, recordedSource, preferences });
  }
  if (filters.reportType === 'release' && !references && !upgrade) {
    return discoverReleaseReport(context, settings, filters, brief, { signal, fetcher, onPhase, onRanked, onCheckpoint, discoverSource });
  }
  if (hasLocal) settings.title = pictureComparison ? 'Compare picture models'
    : sidecarComparison ? 'Compare sidecar models' : editPairs ? 'Compare model edits'
      : local.documents ? 'Trace local model references' : 'Trace a local picture';
  if (upgrade) settings.title = 'Review a workflow upgrade';
  const is3D = /^https:\/\/civitai\.(?:com|red)\/3d-models\//iu.test(brief);
  let parsed = brief ? searchTarget(brief, { assets3d: is3D }) : { kind: 'text', value: '' };
  if (parsed.kind === 'library') throw new Error('Choose a public Civitai link or a topic for this report.');
  const target = { kind: 'text', value: brief };
  const modelFilters = Object.fromEntries(modelFields.filter(key => filters[key]).map(key => [key, filters[key]]));
  const options = { signal, fetcher };
  const trace = !hasLocal && !upgrade && filters.reportType === 'trace';
  const exampleOptions = trace && parsed.kind === 'image' ? { ...options, catalogOnly: true, includePublishedSetup: true } : options;
  const followGuides = followLinks && !hasLocal && !upgrade && (filters.reportType === 'guide' || parsed.kind === 'article');
  let interpreted = parsed.kind === 'tag' || parsed.kind === 'topic' ? parsed.value : brief;
  let anchor;
  let collectionSearch;
  if (filters.reportType === 'collection' && parsed.kind === 'text' && !hasLocal && !upgrade) {
    onPhase('Finding the public collection…');
    collectionSearch = await discoverSource(context, { scope: 'collections', query: interpreted }, options);
    const matches = (collectionSearch.related.collections ?? []).filter(item => foldSearchText(item.title).trim() === foldSearchText(brief).trim());
    if (matches.length === 1) parsed = { kind: 'collection', id: matches[0].id };
  }
  if (hasLocal) {
    onPhase(editPairs ? 'Checking the original and revised model references…' : 'Checking recorded versions against Civitai…');
    const result = await recordedSource(context, local, modelFilters, { ...options, withExamples: settings.sources.includes('gallery') });
    signal?.throwIfAborted();
    const { candidates, flows, verified, checked, filtered, unavailable, unknownFit, ambiguous, unconfirmedClaims } = result;
    anchor = { candidates, related: {}, flows, localTrace: {
      pictures: local.pictures, documents: local.documents, unchecked: local.unchecked,
      verified, checked, filtered, unavailable, unknownFit, ambiguous, unconfirmedClaims,
      ...(editPairs && { edits: describeReferenceEdits(editPairs) }),
    } };
    const typed = ['text', 'tag', 'topic'].includes(parsed.kind) ? interpreted : '';
    interpreted = typed || text(candidates[0]?.model, 150);
  } else if (upgrade) {
    onPhase('Verifying the two exact releases and files…');
    anchor = await readUpgradeEvidence(context, upgrade, modelFilters,
      { ...options, withExamples: settings.sources.includes('gallery'), recordedSource });
    interpreted = text(anchor.candidates.at(-1)?.model, 150);
  } else if (!['text', 'tag', 'topic'].includes(parsed.kind)) {
    onPhase('Checking your Civitai reference…');
    const query = parsed.kind === 'collection' ? new URL('/collections/' + parsed.id, context.origin).href : brief;
    const exactFilters = exampleOptions.includePublishedSetup ? modelFilters
      : modelFilters.downloadAccess ? { downloadAccess: modelFilters.downloadAccess } : {};
    anchor = await discoverSource(context, { ...exactFilters, scope: is3D ? 'assets3d' : 'all', query }, exampleOptions);
    const unresolvedHash = parsed.kind === 'hash' && anchor.hashStatus && anchor.hashStatus !== 'unique';
    interpreted = unresolvedHash ? '' : text(anchor.candidates[0]?.model ?? evidenceFor(anchor, context.origin)[0]?.title, 150);
    if (!interpreted && !anchor.candidates.length && !reportExample(anchor) && !(trace && anchor.reference?.postId)) {
      const result = assemble(context, settings, target, '', filters, [], anchor);
      result.nativeLink = nativeSource(anchor.nativeLink ?? anchor.reference?.link ?? (parsed.kind === 'collection' ? query : undefined), context.origin);
      result.report.referenceUnavailable = true;
      result.report.rails = [];
      return result;
    }
  }
  const collection = !hasLocal && !upgrade && parsed.kind === 'collection'
    ? anchor?.related.collections?.find(item => item.id === parsed.id) : null;
  let collectionTrail;
  if (collection && followLinks && settings.sources.some(source => collectionTrailSources.includes(source))) {
    settings.title = reportTypes.collection.title;
    onRanked?.(assemble(context, settings, target, interpreted, filters,
      [{ scope: 'collections', result: anchor, items: evidenceFor(anchor, context.origin), traced: true }], anchor));
    collectionTrail = await tracePublicCollection(context, collection, settings.sources, modelFilters, { ...options, onPhase });
    signal?.throwIfAborted();
  }
  const example = reportExample(anchor);
  const postId = trace && followLinks && settings.sources.includes('posts') ? numericId(anchor?.reference?.postId) : null;
  async function verifiedRead(sourceFilters, confirms) {
    try {
      const result = await discoverSource(context, sourceFilters, options);
      signal?.throwIfAborted();
      return confirms(result) ? result : null;
    } catch {
      signal?.throwIfAborted();
      return null;
    }
  }
  let exactPost = trace && parsed.kind === 'post' && anchor.related.posts?.some(post => post.id === parsed.id) ? anchor : null;
  if (postId && postId <= 2_147_483_647) {
    onPhase('Checking the public post for your example…');
    const query = new URL('/posts/' + postId, context.origin).href;
    const imageId = anchor.reference.id;
    const matchingPost = result => result.related.posts?.find(post => post.id === postId && post.link === query &&
      (post.verifiedMediaIds?.includes(imageId) || post.previews?.some(item => item.id === imageId && item.postId === postId)));
    const result = await verifiedRead({ scope: 'posts', query }, matchingPost);
    if (result) {
      const post = matchingPost(result);
      const previews = post.previews ?? [];
      const members = example ? [example, ...previews.filter(item => item.id !== imageId)].slice(0, cardLimit) : previews;
      exactPost = { ...result, related: { posts: [{ ...post, previews: members }], postMedia: members } };
    }
  }
  let exactModels = (hasLocal || upgrade) && anchor.candidates.length ? anchor : undefined;
  const pinnedFile = parsed.kind === 'version' && parsed.fileId;
  if ((trace || pinnedFile || parsed.kind === 'hash') && anchor && ['image', 'model', 'version', 'hash'].includes(parsed.kind) && settings.sources.includes('models')) {
    exactModels = !exampleOptions.includePublishedSetup && Object.keys(modelFilters).length && anchor.candidates.length
      ? await discoverSource(context, { ...modelFilters, scope: 'models', query: brief }, options) : anchor;
  }
  const linkedVersion = numericId(exactPost?.related.posts?.[0]?.modelVersionId);
  const matchesPostVersion = model => model.id === linkedVersion && numericId(model.modelId) &&
    model.link === new URL('/models/' + model.modelId + '?modelVersionId=' + linkedVersion, context.origin).href;
  if (followLinks && linkedVersion && settings.sources.includes('models') && !exactModels?.candidates.some(matchesPostVersion)) {
    onPhase('Checking the exact model version listed on the post…');
    const confirmed = await verifiedRead({ ...modelFilters, scope: 'models', query: 'version: ' + linkedVersion },
      result => result.candidates.some(matchesPostVersion));
    if (confirmed) {
      const linked = confirmed.candidates.filter(matchesPostVersion);
      if (!exactModels?.candidates.length) interpreted = text(linked[0].model, 150) || interpreted;
      exactModels = { ...confirmed, candidates: [...(exactModels?.candidates ?? []), ...linked],
        flows: [...(exactModels?.flows ?? []), ...confirmed.flows] };
    }
  }
  if (trace && anchor?.reference?.publishedSetup) {
    const needsSiteFilters = modelFilters.category || modelFilters.period || modelFilters.checkpointType || modelFilters.fromPlatform === 'true';
    const matchingModels = needsSiteFilters ? [] : (exactModels?.candidates ?? []).filter(model =>
      modelFilters.supportsGeneration !== 'true' || model.generationListed === true);
    anchor = { ...anchor, candidates: matchingModels, exampleSetup: verifiedExampleSetup(anchor.reference, matchingModels, context.origin) };
    if (exactModels) exactModels = needsSiteFilters ? undefined : { ...exactModels, candidates: matchingModels };
  }
  const runGuideTrace = rows => followGuideReferences({
    origin: context.origin, scopeList: settings.sources, modelFilters, rows, anchor, signal, onPhase, verifiedRead,
  });
  const preferGuide = followGuides && filters.reportType === 'guide' && parsed.kind === 'article';
  const firstGuide = preferGuide ? await runGuideTrace([]) : null;
  const coveredByGuide = new Set(firstGuide?.records.map(row => row.scope));
  const linkedExamples = (upgrade || pinnedFile && !hasLocal || hasLocal && !brief) && settings.sources.includes('gallery')
    ? modelExampleCards(anchor.candidates).slice(0, cardLimit) : [];
  async function readSource(scope) {
    const sourceFilters = { ...(scope === 'models' ? modelFilters : {}),
      ...(scope === 'audio' && { audioFamilies: filters.audioFamilies }), scope, query: interpreted };
    if (scope === 'collections' && collection) return { ...anchor, traced: true };
    if (scope === 'collections' && collectionSearch) return collectionSearch;
    if (collectionTrail && collectionTrailSources.includes(scope)) return { scope, target, traced: true,
      candidates: scope === 'models' ? collectionTrail.candidates : [],
      related: scope === 'models' ? {} : { [scope]: collectionTrail.related[scope] }, flows: collectionTrail.flows[scope],
      ...(['access-needed', 'unavailable', 'native'].includes(collectionTrail.summary.status) && { nativeLink: collection.link }),
    };
    if (trace && example && scope === (example.video ? 'videos' : 'gallery')) {
      return { scope, target, candidates: [], related: { [scope]: [example] }, flows: [], traced: true };
    }
    if (scope === 'gallery' && linkedExamples.length) {
      return { scope, target, candidates: [], related: { gallery: linkedExamples }, flows: [], traced: true };
    }
    if (scope === 'models' && exactModels) return { ...exactModels, related: {}, traced: true };
    if (scope === 'aiServices' && parsed.kind === 'aiService' && anchor?.related.aiServices?.length) return { ...anchor, traced: true };
    if (scope === 'models' && (hasLocal || upgrade) && !interpreted) return { ...anchor, traced: true };
    if (scope === 'posts' && exactPost) return { ...exactPost, traced: true };
    if (scope === 'articles' && parsed.kind === 'article' && anchor?.related.articles?.length) return { ...anchor, traced: true };
    if (scope === 'apps' && parsed.kind === 'app' && anchor?.related.apps?.length) return { ...anchor, traced: true };
    if (coveredByGuide.has(scope)) return { scope, target, candidates: [], related: {}, flows: [] };
    if (!interpreted) return { scope, candidates: [], related: {}, skipped: true };
    return discoverSource(context, sourceFilters, scope === 'models' && preferences ? { ...options, preferences } : options);
  }
  const rows = [];
  for (let i = 0; i < settings.sources.length; i += sourcesPerBatch) {
    signal?.throwIfAborted();
    const batch = settings.sources.slice(i, i + sourcesPerBatch);
    const pending = batch.filter(scope => !coveredByGuide.has(scope));
    if (pending.length) onPhase('Checking ' + pending.map(scope => reportSources[scope]).join(' · ') + '…');
    const first = rows.slice();
    const current = await checkReportSources(batch, readSource, context.origin, signal,
      onCheckpoint && (finished => onCheckpoint(() => assemble(context, settings, target, interpreted, filters,
        [...first, ...finished.filter(Boolean)], anchor, firstGuide, collectionTrail))));
    rows.push(...current);
    if (i + sourcesPerBatch < settings.sources.length) {
      onRanked?.(assemble(context, settings, target, interpreted, filters, rows, anchor, firstGuide, collectionTrail));
    }
  }
  const posts = rows.find(row => row.scope === 'posts');
  let publishedPartial = false;
  function followup(phase) {
    if (!publishedPartial) onRanked?.(assemble(context, settings, target, interpreted, filters, rows, anchor, firstGuide, collectionTrail));
    publishedPartial = true;
    onPhase(phase);
  }
  const traceMedia = followLinks && !hasLocal && !upgrade && !collectionTrail && !coveredByGuide.has('models') &&
    ['text', 'tag', 'topic'].includes(parsed.kind);
  const tracePosts = followLinks && !collectionTrail && posts && !coveredByGuide.has('posts') && !exactPost && !postId &&
    !posts.result?.flows?.some(flow => flow.status === 429);
  const [, media] = await Promise.all([
    tracePosts && linkReportPosts(context, rows, posts, interpreted, options, () =>
      followup('Verifying published posts for the matching pictures and clips…')),
    traceMedia && readReportMediaReferences(context, rows, cardLimit, { ...options, onRead: () =>
      followup('Checking model references on the matching pictures and clips…') }),
  ]);
  const mediaModels = media ? await traceReportMediaModels(context, media, posts, modelFilters, cardLimit, {
    ...options, recordedSource, onRead: () => followup('Verifying the exact model versions linked to these previews…'),
  }) : null;
  if (upgrade && followLinks && settings.sources.includes('articles')) {
    const articles = rows.find(row => row.scope === 'articles')?.result;
    if (articles?.related.articles?.length) onPhase('Checking which releases the articles cite…');
    const guidance = await upgradeGuides(anchor.upgrade, articles, verifiedRead, context.origin);
    signal?.throwIfAborted();
    anchor.upgrade = { ...anchor.upgrade, ...guidance };
  }
  const guideTrace = followGuides && !preferGuide ? await runGuideTrace(rows) : firstGuide;
  return assemble(context, settings, target, interpreted, filters, rows, anchor, guideTrace, collectionTrail, undefined, mediaModels);
}

const modelFilterLabels = {
  category: 'Tag', modelAuthor: 'Creator', baseModel: 'Base model', resourceType: 'Model type', checkpointType: 'Checkpoint type',
  fileFormat: 'File format', downloadAccess: 'Download access', exclude: 'Exclude', sort: 'Sort', period: 'Time period',
  supportsGeneration: 'Generate on Civitai', fromPlatform: 'Trained on Civitai',
};
export function reportConstraint([key, value]) {
  const label = key === 'downloadAccess' ? modelDownloadFilter(value)?.label : Array.isArray(value) ? value.join(' or ') : value;
  return modelFilterLabels[key] + ' · ' + (label === 'true' ? 'Yes' : label ?? value);
}

export function portfolioCoverage({ releases, pictures, posts, checkPosts, limited }) {
  const figures = [releases.length + (releases.length === 1 ? ' model version' : ' model versions'),
    pictures + (pictures === 1 ? ' preview' : ' previews')];
  if (checkPosts) figures.push(posts + (posts === 1 ? ' linked public post' : ' linked public posts'));
  return figures.join(' · ') + '. ' + (limited ? 'This report checks up to five versions from the first page. Use My published models to browse more.'
    : 'Counts reflect the releases and example pictures checked here.');
}

export function portfolioReleaseFacts(release, checkPosts) {
  return [
    release.publishedAt && 'Published ' + release.publishedAt,
    release.fileCount + (release.fileCount === 1 ? ' catalog file' : ' catalog files'),
    release.formats.join(', '),
    release.triggers + (release.triggers === 1 ? ' listed trigger phrase shown' : ' listed trigger phrases shown'),
    release.pictures ? release.recorded + ' of ' + release.pictures + ' sampled previews record this version' : 'No eligible preview sampled',
    checkPosts && release.posts + (release.posts === 1 ? ' verified post from those previews' : ' verified posts from those previews'),
  ].filter(Boolean);
}

export function guideTraceCoverage({ guides, unreadGuides, confirmed, unavailable, unchecked, needFilterEvidence }) {
  const count = (value, noun) => value + ' ' + noun + (value === 1 ? '' : 's');
  return [
    count(guides.length, 'guide') + ' read', count(confirmed, 'link') + ' verified',
    unavailable && count(unavailable, 'reference') + ' unavailable for this search',
    unchecked && count(unchecked, 'reference') + ' beyond this check',
    unreadGuides && count(unreadGuides, 'guide') + ' unavailable',
    needFilterEvidence && count(needFilterEvidence, 'model link') +
      (needFilterEvidence === 1 ? ' needs' : ' need') + ' catalog filter evidence',
  ].filter(Boolean).join(' · ');
}

export function localTraceCoverage(trace) {
  const sources = [
    trace.pictures && trace.pictures + (trace.pictures === 1 ? ' picture' : ' pictures'),
    trace.documents && trace.documents + (trace.documents === 1 ? ' metadata document' : ' metadata documents'),
  ].filter(Boolean).join(' and ');
  return [
    sources && sources + ' with references',
    trace.verified.length + ' of ' + trace.checked + ' references verified under these filters',
    trace.ambiguous && trace.ambiguous + (trace.ambiguous === 1 ? ' reference matches' : ' references match') + ' multiple versions',
    trace.unavailable && trace.unavailable + ' unavailable',
    trace.filtered && trace.filtered + ' outside the filters',
    trace.unknownFit && trace.unknownFit + ' need more filter evidence',
    trace.unconfirmedClaims && trace.unconfirmedClaims + (trace.unconfirmedClaims === 1 ? ' additional claim' : ' additional claims') + ' without catalog confirmation',
    trace.unchecked && trace.unchecked + ' beyond this check',
  ].filter(Boolean).join(' · ');
}

function recordedFieldLabel(field) {
  if (field === 'CiviScribe sidecar' || field === 'Metadata Studio identity export' || field === studioAuditReport || field === studioEditSession) return field;
  const key = field.toLowerCase().replace(/[_ -]/gu, '');
  if (key.startsWith('pngcivitai') || key === 'pngextrametadata') return 'Embedded Civitai record';
  if (key === 'pngprompt' || key === 'pngworkflow') return 'Embedded workflow';
  if (key.startsWith('exif') || key === 'pngcomment') return 'Image comment';
  return 'Generation settings';
}

export function localTraceRows(report) {
  const rows = new Map();
  for (const verified of report.localTrace?.verified ?? []) {
    const source = report.evidence.find(item => item.group === 'models' && item.versionId === verified.versionId);
    if (!source) continue;
    const files = [...verified.fileIds].sort((first, second) => first - second);
    const key = source.key + '#' + files.join(',');
    const row = rows.get(key) ?? { source, files, fields: new Set(), unconfirmed: new Set() };
    for (const field of verified.fields) row.fields.add(recordedFieldLabel(field));
    for (const field of verified.unconfirmedFields ?? []) row.unconfirmed.add(recordedFieldLabel(field));
    rows.set(key, row);
  }
  return [...rows.values()].map(({ source, files, fields, unconfirmed }) => ({ source,
    description: [...files.map(id => 'File #' + id), ...fields, ...[...unconfirmed].map(field => 'Unconfirmed claim from ' + field)].join(' · '),
  }));
}

export function editReferenceLabel({ versionId, fileId }) {
  return [versionId ? 'Version #' + versionId : 'Model file referenced by SHA-256', fileId && 'File #' + fileId].filter(Boolean).join(' · ');
}

export function editPictureSummary(picture, index) {
  if (picture.revisedFormat || picture.sidecars) {
    const shared = picture.sidecars ? 'Both sidecars' : 'Both pictures';
    return [
      picture.sidecars ? 'Original and revised sidecars' : 'Original ' + picture.format.toUpperCase() + ' → Revised ' + picture.revisedFormat.toUpperCase(),
      ...[[shared, 'shared'], ['Original only', 'original only'], ['Revised only', 'revised only']].map(([label, countLabel]) =>
        picture.rows.filter(row => row.labels.includes(label)).length + ' ' + countLabel),
      picture.omitted && picture.omitted + ' more references beyond this comparison',
    ].filter(Boolean).join(' · ');
  }
  return [
    'Picture ' + (index + 1) + ' · ' + picture.format.toUpperCase(),
    picture.unresolved && picture.unresolved + (picture.unresolved === 1 ? ' edit entry needs more identity evidence' : ' edit entries need more identity evidence'),
    picture.omitted && picture.omitted + ' beyond this comparison',
  ].filter(Boolean).join(' · ');
}

export function editComparisonText(edits) {
  if (edits[0]?.sidecars) return {
    title: 'Sidecar model comparison',
    description: 'Each sidecar records the active model roles and strengths for one save. Civitai checks the published model identities.',
  };
  return edits[0]?.revisedFormat ? {
    title: 'Picture model comparison',
    description: 'Each row shows where the model or file was recorded. Civitai checks the published identities.',
  } : {
    title: 'Original and proposed model references',
    description: 'Original picture files matched to the edit sessions by SHA-256.',
  };
}

export function editReferenceSource(report, reference) {
  if (!reference.versionId || !report.localTrace.verified.some(row => row.versionId === reference.versionId &&
      (!reference.fileId || row.fileIds.includes(reference.fileId)))) return null;
  return report.evidence.find(item => item.group === 'models' && item.versionId === reference.versionId) ?? null;
}

const markdownLine = value => String(value ?? '').replace(/\r?\n|\r/gu, ' ').replace(/[\\[\]\u0060*<>|]/gu, '\\$&');
const markdownLink = item => '[' + markdownLine(item.title) + '](<' + item.link.replaceAll('|', '%7C') + '>)';

export function reportMarkdown(report, graphicsMemory) {
  const lines = ['# ' + markdownLine(report.title), ''];
  if (report.query) lines.push('**Search** ' + markdownLine(report.query));
  if (report.interpreted && report.interpreted !== report.query) lines.push('**Reference used for search** ' + markdownLine(report.interpreted));
  if (report.constraints.length) lines.push('**Model filters** ' + report.constraints.map(value => markdownLine(reportConstraint(value))).join(' · '));
  const hashNote = hashLookupNote(report.hashStatus);
  if (hashNote) lines.push('', hashNote);
  if (report.portfolio) {
    lines.push('', '## Published release evidence', portfolioCoverage(report.portfolio),
      ...report.portfolio.releases.map(release => '- ' + markdownLink(release) + ' · ' +
        portfolioReleaseFacts(release, report.portfolio.checkPosts).map(markdownLine).join(' · ')));
  }
  if (report.creator?.profile) {
    lines.push('', '## Verified public profile', '- ' + markdownLink(report.creator.profile),
      'The report samples public listings credited to this account. Each connection names the role recorded by Civitai.');
  } else if (report.creator?.leads) {
    lines.push('', '## Creator leads from public work');
    for (const lead of report.creator.leads) lines.push('- ' + markdownLink(lead.profile) + ' · ' +
      lead.examples.map(item => reportSources[item.scope] + ' – ' + markdownLink(item)).join(' · '));
  }
  if (report.exampleComparison) {
    const { examples, settings, versions, limited } = report.exampleComparison;
    lines.push('', '## Compared examples');
    for (const [index, { item, post, postModel }] of examples.entries()) {
      lines.push('- ' + exampleSide(index) + ' · ' + (item ? markdownLink(item) : 'Unavailable through Civitai') +
        (post ? ' · Published post ' + markdownLink(post) : '') +
        (postModel ? ' · Version listed by the post ' + markdownLink({ title: postModel.model + ' · ' + postModel.version, link: postModel.link }) : ''));
    }
    if (settings.length) {
      lines.push('', '### Recorded settings', '| Setting | First example | Second example |', '|---|---|---|');
      for (const { label, values } of settings) lines.push('| ' + [label, ...values.map(value => value ?? 'Unreported')].map(markdownLine).join(' | ') + ' |');
    }
    if (versions.length) {
      lines.push('', '### Recorded model versions', '| Version | First example | Second example |', '|---|---|---|');
      for (const { id, model, values } of versions) {
        const version = model ? markdownLink({ title: model.model + ' · ' + model.version + ' · #' + id, link: model.link })
          : 'Version #' + id + ' · Listing unverified';
        lines.push('| ' + [version, ...values.map(value => markdownLine(exampleVersionUse(value)))].join(' | ') + ' |');
      }
    }
    const unlinked = examples.map(({ item }) => item?.publishedSetup.unlinked.length ?? 0);
    if (unlinked.some(Boolean)) lines.push('', 'Strengths awaiting a version · ' + unlinked.join(' / '));
    if (limited) lines.push('', 'The comparison uses a bounded sample of recorded model entries.');
    lines.push('', 'The settings and strengths come from published metadata. Remix ancestry is unverified.');
  }
  if (report.story) {
    const { stages, runtime, toolSource, setup, relatedGenre, missingReference } = report.story;
    lines.push('', '## Story plan');
    if (relatedGenre) lines.push('Comic results include the ' + markdownLine(relatedGenre) + ' genre.');
    if (missingReference) lines.push('The selected picture was unavailable through Civitai.');
    if (runtime) lines.push('Tool search · ' + markdownLine(runtime) +
      (toolSource === 'metadata' && setup ? ' · ' + markdownLink({ title: 'Published picture metadata', link: setup.link }) : ' · Requested in the brief'));
    for (const stage of stages) {
      lines.push('', '### ' + stage.title, ...stage.items.map(item => ['- ' + markdownLink(item), item.storyBasis,
        item.storyProof && markdownLink({ title: 'Source picture', link: item.storyProof })].filter(Boolean).join(' · ')));
    }
    if (setup?.settings.length) lines.push('', '### Published picture settings',
      ...setup.settings.map(({ label, value }) => '- ' + label + ' · ' + markdownLine(value)));
  }
  if (report.anchor.length && !report.upgrade && !report.exampleSetup) {
    lines.push('', '## Reference', ...report.anchor.map(item => ['- ' + markdownLink(item), ...referenceFileFacts(item)].join(' · ')));
  }
  if (report.exampleSetup) {
    const { video, link, settings, recorded, unlinked, associated, limited } = report.exampleSetup;
    lines.push('', '## Recorded settings', '- ' + markdownLink({ title: video ? 'Source clip' : 'Source picture', link }));
    for (const { label, value } of settings) lines.push('- ' + label + ' · ' + markdownLine(value));
    if (!settings.length) lines.push('', 'Generation settings are unavailable for this example.');
    if (recorded.length) lines.push('', '### Model versions recorded in this example');
    for (const row of recorded) lines.push('- ' + [row.model && markdownLink(row.model), ...exampleModelFacts(row).map(markdownLine)].filter(Boolean).join(' · '));
    if (unlinked.length) lines.push('', '### Strengths awaiting a version', ...unlinked.map(row => '- ' + markdownLine(unlinkedUseLabel(row))));
    if (associated.length) lines.push('', '### Catalog associations');
    for (const row of associated) lines.push('- ' + [markdownLink(row.model), ...exampleModelFacts(row).map(markdownLine)].join(' · '));
    if (limited) lines.push('', 'The report samples up to eight entries per list.');
    lines.push('', 'The settings come from published metadata. A run with your own files and tools can verify the result.');
  }
  if (report.upgrade) {
    const comparison = report.upgrade;
    lines.push('', '## Release comparison', markdownLine(comparison.fit), 'Checked ' + comparison.checkedAt, '');
    if (comparison.previous) lines.push('- Current · ' + markdownLink(comparison.previous));
    if (comparison.next) lines.push('- Proposed · ' + markdownLink(comparison.next));
    lines.push('', '| Catalog detail | Current | Proposed |', '| --- | --- | --- |');
    for (const { label, current, next } of upgradeFacts(comparison)) {
      lines.push('| ' + [label, current, next].map(markdownLine).join(' | ') + ' |');
    }
    const size = upgradeStorageChange(comparison);
    lines.push('', ...(size ? [size] : []), 'Generation access is the signed-out check. Loader behavior and memory use require a local test.');
    const memory = upgradeMemoryComparison(comparison, graphicsMemory);
    if (memory) {
      lines.push('', '### Graphics memory', ...[memory.setup, memory.empty].filter(Boolean), '');
      for (const source of memory.sources) {
        lines.push('- ' + markdownLink(source));
        for (const claim of source.claims) lines.push('  - ' + [claim.label, claim.difference, claim.note].filter(Boolean).map(markdownLine).join(' · '));
      }
      lines.push('', memory.note);
    }
    if (comparison.termsLink) lines.push('', '### Creator’s listing terms',
      '- [Model listing](<' + comparison.termsLink + '>) · ' + comparison.usage.map(markdownLine).join(' · '));
    const notes = [comparison.previous, comparison.next].filter(release => release?.notes || release?.hardware);
    if (notes.length) lines.push('', '### Creator release notes', ...notes.map(release => '- ' + markdownLink(release) + ' · ' +
      [release.notes, release.hardware && !release.notes?.includes(release.hardware) && release.hardware].filter(Boolean).map(markdownLine).join(' · ')));
    if (comparison.guides.length || comparison.guidesUnavailable) lines.push('', '### Related articles',
      ...comparison.guides.map(guide => '- ' + markdownLink(guide) + ' · ' + upgradeGuideLabel(guide) +
        (guide.updatedAt ? ' · Civitai updated ' + guide.updatedAt : '')),
      ...(comparison.guidesUnavailable ? [comparison.guidesUnavailable + ' article sources unavailable for a link check.'] : []));
  }
  if (report.guideTrace) {
    lines.push('', '## Guide references', guideTraceCoverage(report.guideTrace), 'Checked ' + report.guideTrace.checkedAt,
      ...report.guideTrace.guides.map(guide => '- ' + markdownLink(guide) +
        (guide.updatedAt ? ' · Civitai updated ' + guide.updatedAt : '')));
  }
  if (report.collectionTrace) {
    lines.push('', '## Collection trail', collectionTraceCoverage(report.collectionTrace), '- ' + markdownLink(report.collectionTrace));
  }
  if (report.releaseSample) {
    lines.push('', '## Release gallery sample', releaseSampleCoverage(report.releaseSample),
      '- ' + markdownLink({ title: [report.releaseSample.title, report.releaseSample.version].filter(Boolean).join(' · '), link: report.releaseSample.link }));
  }
  if (report.releaseLookup) {
    lines.push('', '## Choose a release', ...report.releaseLookup.choices.map(choice =>
      '- ' + markdownLink({ title: [choice.title, choice.version].filter(Boolean).join(' · '), link: choice.link })));
    if (!report.releaseLookup.choices.length) lines.push('Use an exact model name or model release link.');
  }
  if (report.localTrace) {
    if (report.localTrace.edits) {
      const { title, description } = editComparisonText(report.localTrace.edits);
      lines.push('', '## ' + title, description);
      for (const [index, picture] of report.localTrace.edits.entries()) {
        lines.push('', '### ' + editPictureSummary(picture, index));
        const integrity = pictureIntegrityText(picture.integrity);
        if (integrity) lines.push('', integrity, '');
        for (const row of picture.rows) {
          const source = editReferenceSource(report, row);
          lines.push('- ' + (source ? markdownLink(source) + ' · ' : '') + editReferenceLabel(row) + ' · ' + row.labels.join(' · '));
          for (const use of row.recordedUses ?? []) lines.push('  - ' + markdownLine(use));
        }
      }
    }
    lines.push('', '## Recorded model references', localTraceCoverage(report.localTrace));
    if (report.localTrace.ambiguous) lines.push('An exact version or file ID can identify the intended listing.');
    for (const { source, description } of localTraceRows(report)) {
      lines.push('- ' + markdownLink(source) + (description ? ' · ' + markdownLine(description) : ''));
    }
  }
  for (const rail of report.rails) {
    lines.push('', '## ' + rail.label, reportSourceStatus(rail.status));
    for (const item of rail.picks) lines.push('- ' + markdownLink(item) +
      (item.facts.length ? ' · ' + item.facts.slice(0, 2).map(markdownLine).join(' · ') : ''));
    if (rail.nativeLink) lines.push('- [Browse this source on Civitai](<' + rail.nativeLink + '>)');
    if (rail.nativeModelExclusions) lines.push('- Word exclusions apply in RasterRaid.');
  }
  if (report.connections.length) {
    lines.push('', '## Verified connections', ...report.connections.map(connection =>
      '- ' + connection.label + ' · ' + connection.items.map(markdownLink).join(' · ')));
  }
  if (report.localMatches?.length) lines.push('', '## Visual reference matches', ...report.localMatches.map(item =>
    '- ' + markdownLink(item) + (item.detail ? ' · ' + markdownLine(item.detail) : '')));
  if (report.localScenes?.length) lines.push('', '## Matched picture and sound excerpts', ...report.localScenes.map(item =>
    '- ' + markdownLink(item) + ' · ' + markdownLine(item.detail)));
  if (report.referenceUnavailable) lines.push('', 'Civitai did not return readable catalog details for this reference.');
  return lines.join('\n') + '\n';
}
