import { numericId, SITE_ORIGINS, text } from './catalog.mjs';
import { readExampleMedia, sampleMediaByPost } from './gallery.mjs';
import { verifiedExampleSetup } from './gallery-setup.mjs';

export const storySources = ['gallery', 'comics', 'storylines', 'articles', 'collections', 'models', 'users', 'tools', 'apps'];
export const maximumStorySources = 12;
const opportunityScopes = { 'creator services': 'services', bounties: 'bounties', challenges: 'challenges' };
const comicGenreRules = [
  [/\b(?:cyberpunk|sci[ -]?fi|science fiction)\b/iu, 'SciFi', 'Science fiction'],
  [/\bfantasy\b/iu, 'Fantasy', 'Fantasy'],
  [/\bmystery\b/iu, 'Mystery', 'Mystery'],
];
const deferredScopes = new Set(['users', 'tools', 'apps']);
const storyOpening = /^(?:(?:please|help me|i want to|let['’]s)\s+)?(?:make|plan|develop|write|create|storyboard)\s+(?:(?:a|an|the|short|illustrated)\s+)*(?:story|comic|graphic novel|picture book)\s+(?:about|set in|based on)\s+/iu;
const sampleSize = 3;
const validId = id => numericId(id) && id <= 2_147_483_647;

export const startsStoryBrief = value => storyOpening.test(value);

export function storyInput(query) {
  let source;
  const parts = query.split(/\s+/u);
  if (parts.length === 1 && /^https?:\/\//iu.test(parts[0])) {
    try {
      const exact = new URL(parts[0]);
      if (SITE_ORIGINS.includes(exact.origin) && !exact.pathname.startsWith('/images/')) return null;
    } catch { /* The normal link validation supplies the input error below. */ }
  }
  const words = parts.filter(part => {
    if (!/^https?:\/\//iu.test(part)) return true;
    const url = new URL(part);
    const id = Number(/^\/images\/([1-9]\d{0,9})(?:\/[^/]{1,170})?\/?$/u.exec(url.pathname)?.[1]);
    if (source || !SITE_ORIGINS.includes(url.origin) || url.username || url.password || url.search || url.hash || !validId(id)) {
      throw new Error('Add one direct Civitai picture link to your story brief.');
    }
    source = id;
    return false;
  });
  if (!source && words.length === 2 && /^image:$/iu.test(words[0]) && /^[1-9]\d{0,9}$/u.test(words[1]) && validId(Number(words[1]))) {
    source = Number(words[1]);
    words.length = 0;
  }
  let topic = words.join(' ').replace(storyOpening, '').trim();
  const requested = [];
  const follow = /[,;]\s*(?:find|show|look for|include)\s+((?:creator services|bounties|challenges)(?:\s+(?:and|or)\s+(?:creator services|bounties|challenges))*)[.!]?$/iu.exec(topic);
  if (follow) {
    requested.push(...follow[1].toLowerCase().split(/\s+(?:and|or)\s+/u).map(value => opportunityScopes[value]));
    topic = topic.slice(0, follow.index).trim();
  }
  const runtime = /\s+(?:in|using|with)\s+ComfyUI[.!]?$/iu.exec(topic);
  if (runtime) topic = topic.slice(0, runtime.index).trim();
  const genre = comicGenreRules.find(([rule]) => rule.test(topic));
  return { topic: text(topic, 160), source, requested, runtime: runtime ? 'ComfyUI' : null,
    genre: genre ? { value: genre[1], label: genre[2] } : null };
}

const empty = (scope, details = {}) => ({ scope, candidates: [], related: { [scope]: [] }, flows: [], ...details });
const unavailable = (scope, label, error) => empty(scope, { flows: [{ label, status: error.status ?? null }] });
const sourceIssue = (result, status) => result?.flows?.some(flow => flow.status === status);

function exactMedia(item, origin) {
  return validId(item.id) && !item.audio && !item.video &&
    item.link === new URL('/images/' + item.id, origin).href;
}

export async function readStoryProject(context, input, scopes, modelFilters,
  { discoverSource, recordedSource, fetcher, signal, onPhase, onProgress, onCheckpoint, preferences }) {
  const { origin } = context;
  const options = { fetcher, signal };
  const rows = new Map();
  let relatedGenre = null;
  async function read(scope, query, extra = {}) {
    if (!query && !extra.comicGenre) return empty(scope, { skipped: true });
    try {
      return await discoverSource(context, { ...(scope === 'models' && modelFilters),
        ...(scope === 'gallery' && modelFilters.baseModel && { mediaBaseModels: modelFilters.baseModel }), scope, query, ...extra },
        scope === 'models' && preferences ? { ...options, preferences } : options);
    } catch (error) {
      signal?.throwIfAborted();
      return unavailable(scope, 'Civitai ' + scope, error);
    }
  }
  async function readPictures(ids) {
    if (!ids.length) return { items: [], partial: false };
    try {
      return await readExampleMedia(context, ids, options);
    } catch (error) {
      signal?.throwIfAborted();
      return { items: [], partial: true, status: error.status };
    }
  }
  async function readComic() {
    const direct = await read('comics', input.topic);
    if (!input.genre || direct.related.comics?.length || direct.flows.length) return direct;
    const genre = await read('comics', '', { comicGenre: input.genre.value });
    if (genre.related.comics?.length) relatedGenre = input.genre.label;
    return genre;
  }

  const explicit = input.source ? readPictures([input.source]) : null;
  // Cancellation can end the first batch before the explicit reference is awaited.
  explicit?.catch(() => {});
  const core = scopes.filter(scope => !deferredScopes.has(scope));
  for (let cursor = 0; cursor < core.length; cursor += 3) {
    const batch = core.slice(cursor, cursor + 3);
    onPhase(cursor === 0 ? 'Finding story and picture references…' : 'Checking related Civitai sources…');
    const finished = [];
    const answers = await Promise.all(batch.map(async (scope, index) => {
      const result = await (scope === 'comics' ? readComic() : read(scope, input.topic));
      signal?.throwIfAborted();
      finished[index] = [scope, result];
      onCheckpoint?.(() => new Map([...rows, ...finished.filter(Boolean)]));
      return result;
    }));
    signal?.throwIfAborted();
    batch.forEach((scope, index) => rows.set(scope, answers[index]));
    onProgress(rows);
  }

  const gallery = rows.get('gallery');
  const candidates = gallery?.related.gallery ?? [];
  const picked = sampleMediaByPost(candidates.filter(item => exactMedia(item, origin)), sampleSize);
  const useReference = Boolean(input.source || picked.length);
  if (useReference) onPhase('Checking published settings on the leading pictures…');
  const pictures = explicit ? await explicit : await readPictures(picked.map(item => item.id));
  const known = new Map(pictures.items.filter(item => exactMedia(item, origin)).map(item => [item.id, item]));
  const checked = explicit ? [known.get(input.source)].filter(Boolean) : picked.flatMap(item => known.has(item.id) ? [known.get(item.id)] : []);
  const example = explicit ? checked[0] : checked.find(item => item.publishedSetup.runtime) ??
    checked.find(item => item.recorded.length || item.publishedSetup.settings.length) ?? checked[0];
  const chosen = [...new Map([example, ...checked.filter(item => item.recorded.length)].filter(Boolean).map(item => [item.id, item])).values()].slice(0, 2);
  if (gallery && (chosen.length || pictures.partial)) {
    const pinned = chosen.map(item => ({ ...candidates.find(candidate => candidate.id === item.id), ...item }));
    rows.set('gallery', { ...gallery, related: { ...gallery.related,
      gallery: [...pinned, ...candidates.filter(item => !pinned.some(other => other.id === item.id))] },
      skipped: gallery.skipped && !pinned.length,
      flows: [...gallery.flows, ...(pictures.partial ? [{ label: 'Published picture settings', status: pictures.status ?? null }] : [])] });
  }

  const runtime = input.runtime ?? example?.publishedSetup.runtime ?? null;
  const toolSource = runtime ? input.runtime ? 'brief' : 'metadata' : null;
  const plan = { topic: input.topic, runtime, toolSource, relatedGenre, reference: example?.link ?? null,
    missingReference: Boolean(explicit && !example), sampled: checked.length };
  const exactAuthor = example && /^[\p{L}\p{N}_-]{1,80}$/u.test(example.creator) ? example.creator : '';
  const actor = exactAuthor && scopes.includes('users') ? read('users', '@' + exactAuthor) : null;
  const modelRow = rows.get('models');
  const present = new Map((modelRow?.candidates ?? []).map(item => [item.id, item]));
  const recorded = [...new Set(chosen.flatMap(item => item.recorded).filter(validId))].slice(0, 8);
  const left = recorded.filter(id => !present.has(id));
  const checkModels = modelRow && left.length && !sourceIssue(modelRow, 429);
  const toolScopes = scopes.filter(scope => scope === 'tools' || scope === 'apps');
  if (toolScopes.length || actor || checkModels) onPhase('Finding tools and verifying the sources behind the examples…');
  const [account, models, tools] = await Promise.all([
    actor,
    checkModels ? recordedSource(context, { records: left.map(versionId => ({ versionId })) }, modelFilters,
      { ...options, evidenceLabel: 'Recorded in a story reference' }).catch(error => {
      signal?.throwIfAborted();
      return unavailable('models', 'Recorded model versions', error);
    }) : null,
    Promise.all(toolScopes.map(scope => read(scope, runtime ?? input.topic))),
  ]);
  signal?.throwIfAborted();
  if (scopes.includes('users')) {
    const profile = account?.related.users?.find(item => validId(item.id) && item.title.toLowerCase() === exactAuthor.toLowerCase() &&
      item.link === new URL('/user/' + encodeURIComponent(item.title), origin).href);
    rows.set('users', account ? { ...account, related: { users: profile ? [profile] : [] } } : empty('users', { skipped: true }));
    if (profile) plan.profile = profile.link;
  }
  for (const item of models?.candidates ?? []) {
    if (left.includes(item.id) && validId(item.modelId) &&
        item.link === new URL('/models/' + item.modelId + '?modelVersionId=' + item.id, origin).href) present.set(item.id, item);
  }
  if (modelRow) {
    const ordered = [...recorded.map(id => present.get(id)).filter(Boolean), ...[...present.values()].filter(item => !recorded.includes(item.id))];
    rows.set('models', { ...modelRow, candidates: ordered, skipped: modelRow.skipped && !ordered.length,
      flows: [...modelRow.flows, ...(models?.flows ?? [])] });
  }
  toolScopes.forEach((scope, index) => rows.set(scope, tools[index]));
  if (example) plan.setup = verifiedExampleSetup(example, [...present.values()], origin);
  return { rows, plan };
}

export function storyStages(evidence, plan, connections) {
  const first = group => evidence.find(item => item.group === group);
  const reference = evidence.find(item => item.link === plan.reference);
  const profile = evidence.find(item => item.link === plan.profile);
  const recorded = new Set(plan.setup?.recorded.map(entry => entry.model?.link));
  const model = evidence.find(item => item.group === 'models' && recorded.has(item.link)) ?? first('models');
  const proof = model && connections.find(edge => edge.kind === 'recorded' && edge.items.some(item => item.link === model.link))
    ?.items.find(item => item.group === 'gallery');
  const guide = evidence.find(item => item.group === 'articles' && !/\b(?:bounty|contest|challenge|ended|completed)\b/iu.test(item.title));
  const modelChoice = model && { ...model, storyBasis: proof?.link === plan.reference ? 'Recorded in the reference picture'
    : proof ? 'Recorded in another sampled picture' : 'Model search match',
    ...(proof && proof.link !== plan.reference && { storyProof: proof.link }) };
  const stages = [
    { title: 'Choose story references', items: [first('comics'), first('storylines'), guide, first('collections')].filter(Boolean) },
    { title: 'Study the visual setup', items: [reference, modelChoice, profile].filter(Boolean) },
    { title: 'Find tools and apps', items: ['tools', 'apps'].map(first).filter(Boolean) },
    { title: 'Explore project opportunities', items: ['services', 'bounties', 'challenges'].map(first).filter(Boolean) },
  ];
  return stages.filter(stage => stage.items.length);
}
