import { catalogRead, clipAnalysisUrl, mediaUrl, numericId, SITE_ORIGINS } from './catalog.mjs';
import { compareClipScenes } from './clip-scenes.mjs';
import { applyNativeGalleryFilters, gallerySourceFilters, isVisualGalleryScope, prepareGallery, readAppMediaByIds, readGalleryPage,
  readGalleryVersionParents, sampleMediaByPost } from './gallery.mjs';
import { describeMediaQuery } from './gallery-relevance.mjs';
import { searchWords } from './query-language.mjs';
import { loadPublicPreview, samplePublicClip, samplePublicMotion, visualPreview, visualRegion, visualRoles, visualScorer } from './visual-analysis.mjs';
import { comparePictureCopies, pictureCopyProfile } from './visual-copy.mjs';
import { bestMotionMatch, motionSamplePositions } from './video-motion.mjs';

const maximumCandidates = 24;
const postersPerBatch = 4;
const clipsToCheck = 3;
const motionClipsToCheck = 6;
const referenceQueryLanes = 2;
const referenceQueryMatches = 8;
const recordedVersionLimit = 4;
const basicTags = new Set(['image', 'video', 'outdoors', 'indoors', 'solo', 'standing', 'sitting', 'scenery', 'no humans', 'looking at viewer']);
export const visualReferenceLimit = 4;

export function visualReferenceLink(origin, id) {
  if (!numericId(id)) return null;
  const url = new URL('/images', origin);
  url.searchParams.set('similarTo', id);
  return url.href;
}

export function visualReferenceId(value) {
  try {
    const url = new URL(value);
    const id = /^\/images\/([1-9]\d{0,14})\/?$/u.exec(url.pathname)?.[1];
    return id && SITE_ORIGINS.includes(url.origin) && !url.username && !url.password ? Number(id) : null;
  } catch { return null; }
}

export function clipMatchLink(origin, id, mode = 'appearance') {
  if (!SITE_ORIGINS.includes(origin) || !numericId(id)) return null;
  const name = mode === true ? 'motion' : mode === false ? 'appearance' : mode;
  if (!['appearance', 'motion', 'scene'].includes(name)) return null;
  return new URL('/images/' + id + '#match-' + name, origin).href;
}

export function clipMatchTarget(url) {
  const mode = /^#match-(appearance|motion|scene)$/u.exec(url.hash)?.[1];
  if (url.search || !mode) return null;
  const id = visualReferenceId(url.href);
  return id ? { kind: 'similarMedia', id, scope: 'videos', ...(mode !== 'appearance' && { [mode]: true }) } : null;
}

export async function readVisualReferences(context, ids, options) {
  const requested = [...new Set(ids.filter(numericId))];
  if (!requested.length) return [];
  if (requested.length > visualReferenceLimit) throw new RangeError('Choose up to four visual references.');
  if (context.hosted && context.token) return (await readAppMediaByIds(context, requested, { ...options, withTags: true })).filter(row => !row.audio);
  return (await Promise.all(requested.map(async id => {
    const { items } = await readGalleryPage(context, { imageId: id, tags: [], withMeta: true, sort: 'Most Reactions' }, { ...options, limit: 1 });
    const row = items.find(item => item.id === id && !item.audio);
    return row && { ...row, associated: [], recorded: [], tagCount: row.tags.length };
  }))).filter(Boolean);
}

function sceneTags(reference) {
  const prompt = new Set(searchWords(reference.prompt));
  const terms = reference.tags.map(tag => {
    const words = searchWords(tag.name);
    const name = words.join(' ');
    const mentioned = words.length > 0 && words.every(word => prompt.has(word));
    const key = /^(?:black and white|gr[ae]yscale|monochrome)$/u.test(name) ? 'monochrome' : name;
    return { ...tag, key, mentioned, broad: basicTags.has(name) };
  }).filter(tag => tag.key && (reference.tagCount <= 96 || tag.mentioned));
  terms.sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || Number(a.broad) - Number(b.broad));
  const seen = new Set();
  const preferred = [];
  for (const tag of terms) {
    if (seen.has(tag.key)) continue;
    seen.add(tag.key);
    preferred.push(tag);
    if (preferred.length === 2) break;
  }
  return preferred;
}

async function versionLead(context, reference, options) {
  const version = reference.associated[0] ?? reference.recorded[0];
  if (version || !reference.postId || reference.postId > 2_147_483_647) return version;
  const { data } = await catalogRead(context.origin, '/api/v1/posts/' + reference.postId, {}, options);
  return data.id === reference.postId ? numericId(data.modelVersionId) : null;
}

const compatibleLead = (plan, query) => (!plan.modelId || !query.modelVersionId || plan.modelVersionId === query.modelVersionId) &&
  Object.keys(gallerySourceFilters).every(field => !plan[field] || !query[field] || plan[field] === query[field]);

async function readNeighbors(context, reference, plan, options) {
  const tagChoices = sceneTags(reference);
  const lanes = [];
  async function read(label, query, samePost = false, limit = 8) {
    if (!compatibleLead(plan, query)) return null;
    const page = await readGalleryPage(context, { ...plan, ...query }, { ...options, limit });
    return { label, items: page.items.filter(item => item.id !== reference.id && (!samePost || item.postId === reference.postId)) };
  }
  if (reference.postId) lanes.push(read('Same post', { postId: reference.postId }, true));
  lanes.push(versionLead(context, reference, options).then(id => id ? read('Model version #' + id, { modelVersionId: id }) : null));
  if (tagChoices.length > 1) {
    lanes.push(read('Shared tags · ' + tagChoices.map(tag => tag.name).join(', '), { tags: tagChoices.map(tag => tag.id) }));
  }
  if (tagChoices.length) lanes.push(read('Shared tag · ' + tagChoices[0].name, { tags: [tagChoices[0].id] }));
  if (plan.requiredTags?.length || Object.keys(gallerySourceFilters).some(field => plan[field])) {
    lanes.push(read('Selected gallery filters', {}));
  }
  const replies = await Promise.allSettled(lanes);
  options.signal?.throwIfAborted();
  const checked = replies.flatMap(reply => reply.status === 'fulfilled' && reply.value ? [reply.value] : []);
  const items = new Map();
  const length = Math.max(0, ...checked.map(lane => lane.items.length));
  for (let index = 0; index < length; index++) for (const { label, items: matches } of checked) {
    const match = matches[index];
    if (!match) continue;
    const prior = items.get(match.id);
    if (prior) prior.visualSources.push(label);
    else if (items.size < maximumCandidates) items.set(match.id, { ...match, visualSources: [label] });
  }
  return { items: [...items.values()], checked: checked.map(lane => lane.label), unavailable: replies.length - replies.filter(reply => reply.status === 'fulfilled').length };
}

export async function comparePublicPreviews(reference, items, { document = globalThis.document, signal, onPhase = () => {}, onPosters,
  referencePreview, region } = {}) {
  if (!document || !reference.preview || !items.length) return { items, compared: 0, sampled: 0 };
  const deadline = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(11_000)]);
  const checkCopies = !region && !reference.video && !reference.audio && items.some(item => item.preview && !item.video && !item.audio);
  let source;
  try {
    source = referencePreview ?? await preparePreview(document, reference.preview, deadline, { region, checkCopies });
  } catch {
    signal?.throwIfAborted();
    return { items, compared: 0, sampled: 0, referencePreviewUnavailable: true };
  }
  const { features, focus } = source;
  const score = visualScorer(Object.keys(visualRoles).map(role => ({ role, features, focus })));
  return rankPublicPreviews(items, score, { document, signal, onPhase, onPosters, deadline, copyReference: source.copyProfile });
}

async function preparePreview(document, url, signal, { checkCopies = false, ...options } = {}) {
  if (mediaUrl(url) !== url) throw new Error('This preview is outside Civitai’s media catalog.');
  const picture = await loadPublicPreview(document, url, signal);
  const preview = await visualPreview(picture, document, { ...options, signal });
  if (checkCopies) {
    try { preview.copyProfile = pictureCopyProfile(picture, document); } catch { /* Keep the appearance comparison. */ }
  }
  return preview;
}

async function rankPublicPreviews(items, score, { document = globalThis.document, signal, onPhase = () => {}, onPosters, deadline, copyReference } = {}) {
  if (!document || !items.length || !score) return { items, compared: 0, sampled: 0 };
  const end = deadline ?? AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(11_000)]);
  const focused = score.profiles.length > 0;
  const compared = [];
  let copiesChecked = 0;
  const previews = items.filter(item => item.preview);
  for (let start = 0; start < previews.length && !end.aborted; start += postersPerBatch) {
    onPhase((focused ? 'Finding matching areas' : 'Comparing preview pictures') + ' · ' + start + ' of ' + previews.length + '…');
    const batch = await Promise.allSettled(previews.slice(start, start + postersPerBatch).map(async item => {
      const checkCopies = copyReference && !item.video && !item.audio;
      const preview = await preparePreview(document, item.preview, end, { scorer: score, checkCopies });
      const row = { ...item, visualMatch: score(preview.features, preview.windows) };
      if (preview.copyProfile) {
        try {
          const match = comparePictureCopies(copyReference, preview.copyProfile);
          copiesChecked++;
          if (match) row.copyMatch = match;
        } catch { /* Keep the appearance comparison. */ }
      }
      return row;
    }));
    for (const reply of batch) if (reply.status === 'fulfilled') compared.push(reply.value);
  }
  signal?.throwIfAborted();
  const bestFirst = (a, b) => Number(Boolean(b.copyMatch)) - Number(Boolean(a.copyMatch)) ||
    b.visualMatch.score - a.visualMatch.score || b.visualMatch.mean - a.visualMatch.mean;
  const clips = compared.sort(bestFirst).filter(item => item.video && item.stream).slice(0, clipsToCheck);
  const seen = new Set(compared.map(item => item.id));
  const catalogOnly = items.filter(item => !seen.has(item.id));
  let sampled = 0;
  if (clips.length && !end.aborted) {
    onPosters?.({ items: [...compared.map(item => ({ ...item })), ...catalogOnly], compared: compared.length, sampled: 0 });
    onPhase('Checking frames inside ' + clips.length + (clips.length === 1 ? ' clip…' : ' clips…'));
    await Promise.allSettled(clips.map(async item => {
      const frames = await samplePublicClip(document, item.stream, end, score);
      const best = frames.map(frame => ({ ...score(frame.features, frame.windows), seconds: frame.timestamp,
        ...(focused && frame.preview && { frame: frame.preview }) }))
        .sort((a, b) => b.score - a.score || b.mean - a.mean)[0];
      if (!best) return;
      item.visualMatch = { ...best, frames: frames.length };
      sampled++;
    }));
  }
  signal?.throwIfAborted();
  return { items: [...compared.sort(bestFirst), ...catalogOnly], compared: compared.length, sampled,
    ...(copiesChecked > 0 && { copiesChecked, possibleCopies: compared.filter(item => item.copyMatch).length }) };
}

export async function refineVisualNeighbors(result, referencePreview, options) {
  const scope = result.gallery?.scope;
  if (!result.visualSearch || result.target?.motion || result.target?.scene || !result.reference?.preview || !['gallery', 'videos'].includes(scope)) {
    throw new Error('Choose a Civitai preview to refine its visual matches.');
  }
  const order = new Map((result.visualSearch.order ?? []).map((id, index) => [id, index]));
  const pool = result.related[scope].map(({ visualMatch, copyMatch, ...item }) => item).sort((a, b) => order.get(a.id) - order.get(b.id));
  const { items, ...counts } = await comparePublicPreviews(result.reference, pool, { ...options,
    referencePreview: referencePreview.region ? referencePreview : undefined });
  return { ...result, related: { ...result.related, [scope]: items },
    visualSearch: { ...result.visualSearch, copiesChecked: 0, possibleCopies: 0, ...counts, region: referencePreview.region } };
}

export async function compareClipMotion(reference, items, { document = globalThis.document, signal, onPhase = () => {},
  onCandidates, sample = samplePublicMotion } = {}) {
  signal?.throwIfAborted();
  const eligible = items.filter(item => item.video && !item.audio && clipAnalysisUrl(item.stream));
  const motion = { status: 'checking', eligible: eligible.length, attempted: 0, checked: 0, matched: 0 };
  const result = (status, rows = items) => ({ items: rows, compared: 0, sampled: 0, motion: { ...motion, status } });
  if (!document || !clipAnalysisUrl(reference.stream)) return result('unavailable');
  if (!eligible.length) return result('no-candidates');
  onCandidates?.(result('checking'));
  onPhase('Checking movement in the reference clip…');
  const end = signal ? AbortSignal.any([signal, AbortSignal.timeout(13_000)]) : AbortSignal.timeout(13_000);
  const signatures = windows => windows.flatMap(({ motion, ...time }) => motion ? [{ ...motion, ...time }] : []);
  let source;
  try { source = await sample(document, reference.stream, end); } catch { source = []; }
  signal?.throwIfAborted();
  const anchor = signatures(source);
  if (!anchor.length) return result(source.length === motionSamplePositions.length ? 'unsteady-reference' : 'unavailable');
  if (anchor[0].stream) motion.referenceStream = anchor[0].stream;
  const peers = sampleMediaByPost(eligible, motionClipsToCheck);
  const matches = new Map();
  for (let start = 0; start < peers.length && !end.aborted; start += clipsToCheck) {
    const batch = peers.slice(start, start + clipsToCheck);
    motion.attempted += batch.length;
    onPhase('Comparing movement in ' + peers.length + (peers.length === 1 ? ' clip…' : ' clips…'));
    const replies = await Promise.allSettled(batch.map(item => sample(document, item.stream, end)));
    signal?.throwIfAborted();
    for (const [index, reply] of replies.entries()) {
      if (reply.status !== 'fulfilled' || !reply.value.length) continue;
      const candidate = signatures(reply.value);
      const match = bestMotionMatch(anchor, candidate);
      if (candidate.length || reply.value.length === motionSamplePositions.length) motion.checked++;
      if (match) matches.set(batch[index].id, match);
    }
  }
  motion.matched = matches.size;
  const ranked = items.map(item => matches.has(item.id) ? { ...item, motionMatch: matches.get(item.id) } : item)
    .sort((a, b) => (b.motionMatch?.score ?? 0) - (a.motionMatch?.score ?? 0));
  return result(motion.checked ? 'complete' : 'unavailable', ranked);
}

export async function discoverVisualNeighbors(context, target, filters, { signal, fetcher, onPhase = () => {}, onRanked, region,
  compare = comparePublicPreviews, compareMotion = compareClipMotion, compareScene = compareClipScenes } = {}) {
  if (!numericId(target.id)) throw new TypeError('Choose a Civitai picture or clip.');
  const timed = target.motion || target.scene;
  const scope = target.scope === 'videos' || timed || filters.scope === 'videos' ? 'videos' : 'gallery';
  const options = { signal, fetcher };
  const native = scope === 'videos' ? new URL('/videos', context.origin) : new URL(visualReferenceLink(context.origin, target.id));
  const gallery = { scope, status: 'ready', tags: [], nativeLink: native.href, nextCursor: null };
  const result = { target, gallery, related: { [scope]: [] }, reference: null, candidates: [], shortlisted: [], guides: [],
    flows: [], alternateQueries: [], baseline: [], combined: [], primaryCount: 0,
    visualSearch: { checked: [], unavailable: 0, compared: 0, sampled: 0 } };
  onPhase('Checking the reference on Civitai…');
  let reference;
  try {
    [reference] = await readVisualReferences(context, [target.id], options);
  } catch {
    signal?.throwIfAborted();
    gallery.status = 'gallery-unavailable';
    return result;
  }
  if (!reference || reference.audio) {
    gallery.status = 'visual-reference-unavailable';
    return result;
  }
  if (timed && (!reference.video || !clipAnalysisUrl(reference.stream))) {
    gallery.status = 'motion-reference-required';
    return result;
  }
  result.reference = reference;
  region = timed ? null : visualRegion(region);
  if (scope === 'videos' && reference.tags.length) {
    gallery.query = sceneTags(reference).map(tag => tag.name).join(' ');
    if (gallery.query) native.searchParams.set('query', gallery.query);
    gallery.nativeLink = native.href;
  }
  onPhase('Finding related previews on Civitai…');
  const prepared = await prepareGallery(context, { kind: 'text', value: '' }, { ...filters, scope }, options);
  const { plan } = prepared;
  gallery.plan = plan;
  applyNativeGalleryFilters(native, plan, filters.mediaSort, plan.requiredTags);
  gallery.nativeLink = native.href;
  if (prepared.status !== 'ready') {
    gallery.status = prepared.status;
    gallery.throttled = prepared.throttled;
    return result;
  }
  const pool = await readNeighbors(context, reference, plan, options);
  gallery.incomplete = pool.unavailable > 0;
  function withMatches({ items, ...visualSearch }) {
    return { ...result, related: { [scope]: items }, primaryCount: items.length,
      visualSearch: { ...visualSearch, checked: pool.checked, unavailable: pool.unavailable, order: pool.items.map(item => item.id), region } };
  }
  const publish = onRanked && (matches => { signal?.throwIfAborted(); onRanked(withMatches(matches)); });
  const matches = target.scene ? await compareScene(reference, pool.items, { signal, fetcher, onPhase, onCandidates: publish })
    : target.motion ? await compareMotion(reference, pool.items, { signal, onPhase, onCandidates: publish })
    : await compare(reference, pool.items, { signal, onPhase, region, onPosters: publish });
  signal?.throwIfAborted();
  return withMatches(matches);
}

function constrainedReferencePlan(plan, query, textCursor) {
  const { tags: relatedTags = [], ...relation } = query;
  const required = plan.ranking ? [] : plan.tags;
  const tags = [...new Set([...required, ...relatedTags])];
  const sameRoute = relatedTags.length ? (plan.ranking?.routes ?? [required]).findIndex(route =>
    route.length === tags.length && route.every(id => tags.includes(id))) : -1;
  const next = sameRoute < 0 ? undefined : plan.ranking ? textCursor?.positions?.[sameRoute] : textCursor;
  if (sameRoute >= 0 && (typeof next !== 'string' || !next)) return null;
  return { request: { ...plan, ...relation, tags, ...(plan.ranking && { ranking: { ...plan.ranking, routes: [tags] } }) },
    cursor: next && plan.ranking ? { positions: [next] } : next };
}

function recordedVersionClaims(references) {
  const recorded = new Map();
  for (const ref of references) {
    if (ref.mediaId || ref.polarity === 'avoid' || !Array.isArray(ref.recordedVersions)) continue;
    for (const claim of ref.recordedVersions) {
      const id = claim?.id;
      if (!numericId(id) || id > 2_147_483_647 || (!recorded.has(id) && recorded.size >= recordedVersionLimit)) continue;
      if (!recorded.has(id)) recorded.set(id, new Set());
      if (numericId(claim.modelId)) recorded.get(id).add(claim.modelId);
    }
  }
  return recorded;
}

async function readCompositionLeads(context, references, recorded, plan, options, { matchQuery = false, requireAllTerms = false, textCursor } = {}) {
  const lanes = new Map();
  function add(query, label, local = false) {
    if (!compatibleLead(plan, query)) return;
    const key = JSON.stringify(query);
    if (!lanes.has(key)) lanes.set(key, { query, labels: [], local: false });
    const lane = lanes.get(key);
    lane.labels.push(label);
    lane.local ||= local;
  }
  for (const ref of references) {
    const version = ref.associated[0] ?? ref.recorded[0];
    const tag = sceneTags(ref)[0];
    if (version) add({ modelVersionId: version }, 'Model version #' + version + ' from reference #' + ref.id);
    else if (ref.postId) add({ postId: ref.postId }, 'Post #' + ref.postId + ' from reference #' + ref.id);
    if (tag) add({ tags: [tag.id] }, tag.name + ' tag from reference #' + ref.id);
    else if (version && ref.postId) add({ postId: ref.postId }, 'Post #' + ref.postId + ' from reference #' + ref.id);
  }
  let recordedUnavailable = recorded.size;
  if (recorded.size) {
    try {
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(2_500)].filter(Boolean));
      const parents = await readGalleryVersionParents(context, [...recorded.keys()], { ...options, signal });
      const eligible = [...recorded].filter(([id, models]) => parents.has(id) &&
        (!models.size || models.size === 1 && models.has(parents.get(id))));
      recordedUnavailable -= eligible.length;
      const limit = matchQuery && lanes.size ? 1 : referenceQueryLanes;
      for (const [id] of eligible.slice(0, limit)) {
        add({ modelVersionId: id }, 'Recorded model version #' + id + ' from your picture', true);
      }
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  const checked = [];
  let unavailable = 0;
  const available = [...lanes.values()].flatMap(lane => {
    const source = matchQuery ? constrainedReferencePlan(plan, lane.query, textCursor) : { request: { ...plan, ...lane.query } };
    return source ? [{ ...lane, ...source }] : [];
  });
  const goals = matchQuery ? available.sort((a, b) => Number(b.local) - Number(a.local) + Number(Boolean(a.query.tags)) - Number(Boolean(b.query.tags)))
    .slice(0, referenceQueryLanes) : available;
  const limit = matchQuery ? 12 : goals.length <= 2 ? 12 : 8;
  const ranking = matchQuery && plan.ranking;
  const minimumTerms = ranking && (requireAllTerms ? ranking.terms.length : Math.min(2, ranking.terms.length));
  const readOptions = matchQuery || recorded.size ? { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(2_500)].filter(Boolean)) } : options;
  for (let start = 0; start < goals.length; start += postersPerBatch) {
    const batch = await Promise.allSettled(goals.slice(start, start + postersPerBatch).map(async lane => {
      const { items } = await readGalleryPage(context, lane.request, { ...readOptions, limit, cursor: lane.cursor });
      return { ...lane, items: items.filter(item => (!lane.query.postId || item.postId === lane.query.postId) &&
        (!ranking || (!ranking.subject || item.rankEvidence?.subject) && item.rankEvidence?.terms >= minimumTerms)) };
    }));
    options.signal?.throwIfAborted();
    for (const reply of batch) {
      if (reply.status === 'fulfilled') checked.push(reply.value);
      else unavailable++;
    }
  }
  const unique = new Map();
  const length = Math.max(0, ...checked.map(lane => lane.items.length));
  for (let index = 0; index < length; index++) for (const { labels, items } of checked) {
    const item = items[index];
    if (!item) continue;
    const prior = unique.get(item.id);
    if (prior) prior.visualSources.push(...labels);
    else unique.set(item.id, { ...item, visualSources: [...labels] });
  }
  return { items: [...unique.values()], checked: checked.flatMap(lane => lane.labels), unavailable, recordedUnavailable };
}

function mergeCompositionResults(textMatches, referenceMatches) {
  const byId = new Map(referenceMatches.map(item => [item.id, item]));
  const primary = textMatches.map(item => {
    const linked = byId.get(item.id);
    byId.delete(item.id);
    return linked ? { ...item, visualSources: [...new Set([...(item.visualSources ?? []), ...linked.visualSources])] } : item;
  });
  const previews = new Set(primary.map(item => item.preview).filter(Boolean));
  const extras = sampleMediaByPost([...byId.values()].filter(item => !item.preview || !previews.has(item.preview)), referenceQueryMatches);
  return { items: [...primary.slice(0, maximumCandidates - extras.length), ...extras], added: extras.length };
}

export async function discoverVisualComposition(context, target, filters, brief,
  { searchCatalog, signal, fetcher, onPhase = () => {}, onRanked, rank = rankPublicPreviews } = {}) {
  const scope = filters.scope;
  if (!isVisualGalleryScope(scope) || !['text', 'tag', 'image', 'model', 'version', 'post'].includes(target.kind)) {
    throw new Error('Use a gallery search or a Civitai picture, post, or model link with visual references.');
  }
  const selected = brief.filter(ref => Object.hasOwn(visualRoles, ref.role) && ref.features?.[ref.role]).slice(0, visualReferenceLimit);
  const ids = selected.flatMap(ref => numericId(ref.mediaId) ? [ref.mediaId] : []);
  if (ids.length) onPhase('Rechecking selected references on Civitai…');
  const options = { signal, fetcher };
  const checkedRefs = new Map((await readVisualReferences(context, ids, options)).map(row => [row.id, row]));
  signal?.throwIfAborted();
  const references = selected.filter(ref => !ref.mediaId || ref.publicPreview && checkedRefs.get(ref.mediaId)?.preview === ref.publicPreview);
  const anchors = [...new Set(references.flatMap(ref => ref.mediaId && ref.polarity !== 'avoid' ? [ref.mediaId] : []))]
    .map(id => checkedRefs.get(id));
  const hasQuery = target.kind !== 'text' || Boolean(target.value?.trim());
  const fromBrief = hasQuery || !anchors.length;
  const base = fromBrief && references.length ? await searchCatalog() : null;
  const gallery = { ...(base?.gallery ?? await prepareGallery(context, target, filters, options)), scope,
    nextCursor: null, preferenceEligible: false };
  if (!references.length) gallery.status = 'visual-reference-unavailable';
  const { plan } = gallery;
  const textMatches = base?.related?.[scope] ?? [];
  const fixedSource = Object.keys(gallerySourceFilters).some(field => plan[field]);
  const canExpand = ['text', 'tag'].includes(target.kind) && !gallery.modelSource && !gallery.throttled;
  const metadataBrief = canExpand && target.kind === 'text' && ['ready', 'no-tag'].includes(gallery.status) &&
    !textMatches.length && !plan.ranking && !fixedSource && !filters.selectedMediaTag && !gallery.incomplete &&
    !gallery.correctedTag && !gallery.suggestions?.length ? describeMediaQuery(gallery.query, { allowShort: true }) : null;
  const searchableBrief = metadataBrief || plan.ranking || (plan.tags.length && !gallery.partial) || (!gallery.query && plan.username);
  const expandable = canExpand && (gallery.status === 'ready' || metadataBrief);
  const recorded = expandable && (!hasQuery || searchableBrief) && !fixedSource
    ? recordedVersionClaims(references) : new Map();
  const combine = expandable && (hasQuery ? searchableBrief && (anchors.length > 0 || recorded.size > 0) : fromBrief && recorded.size > 0);
  if (recorded.size) onPhase('Checking model versions recorded in your picture…');
  else if (combine) onPhase('Checking your references for additional matches to this search…');
  // Required tags stay in the request. When inferred tags yielded nothing, check the written terms against related media instead.
  const leadPlan = metadataBrief ? { ...plan, tags: [], ranking: { routes: [[]], terms: metadataBrief.terms, excluded: metadataBrief.excluded } } : plan;
  const leads = combine || gallery.status === 'ready' && !fromBrief ? await readCompositionLeads(context, anchors, recorded, leadPlan, options,
    { matchQuery: Boolean(combine && hasQuery), requireAllTerms: Boolean(metadataBrief),
      textCursor: textMatches.length < maximumCandidates ? base?.gallery.nextCursor : null }) : null;
  if (leads?.unavailable) gallery.incomplete = true;
  const referenceIds = new Set(ids);
  function removeReferences(items) {
    const previews = new Set(references.flatMap(ref => ref.publicPreview ? [ref.publicPreview] : []));
    return items.filter(item => {
      if (referenceIds.has(item.id) || item.preview && previews.has(item.preview)) return false;
      if (item.preview) previews.add(item.preview);
      return true;
    });
  }
  const fromText = removeReferences(textMatches);
  const fromReferences = removeReferences(leads?.items ?? []);
  const { items: pool, added } = combine ? mergeCompositionResults(fromText, fromReferences) : {
    items: leads ? sampleMediaByPost(fromReferences, maximumCandidates) : fromText.slice(0, maximumCandidates), added: 0,
  };
  if (metadataBrief && added && gallery.status === 'no-tag') gallery.status = 'ready';
  const cues = references.map(ref => {
    const item = checkedRefs.get(ref.mediaId);
    return { role: ref.role, polarity: ref.polarity, label: ref.label, region: ref.region, public: item && {
      id: item.id, title: ref.label, preview: item.preview, link: item.link, video: item.video,
    } };
  });
  const order = pool.map(item => item.id);
  function withMatches({ items, compared, sampled }) {
    return { ...(base ?? { candidates: [], shortlisted: [], guides: [], flows: [], alternateQueries: [], baseline: [], combined: [] }),
      target, gallery, related: { [scope]: items }, reference: null, primaryCount: items.length, candidates: [], shortlisted: [],
      visualComposition: { cues, checked: leads?.checked ?? [], unavailableReferences: selected.length - references.length,
        compared, sampled, candidates: items.length, order, ...(added && { referenceMatchesAdded: added }),
        ...(metadataBrief && leads?.checked.length && { referenceTextChecked: true }),
        ...(leads?.recordedUnavailable && { recordedVersionsUnavailable: leads.recordedUnavailable }) } };
  }
  const score = visualScorer(references);
  if (!score) return withMatches({ items: pool, compared: 0, sampled: 0 });
  const matches = await rank(pool, score, { signal, onPhase,
    onPosters: onRanked && (matches => { signal?.throwIfAborted(); onRanked(withMatches(matches)); }) });
  signal?.throwIfAborted();
  return withMatches(matches);
}
