import { numericId, text, visibleRating } from './catalog.mjs';

const maximumFeedback = 40;
const maximumMediaTags = 24;
const key = (value, length) => text(value, length).normalize('NFKC').toLowerCase();
const tagIds = values => [...new Set((Array.isArray(values) ? values : []).slice(0, maximumMediaTags).filter(numericId))];

function features(model) {
  return {
    base: key(model.base, 80), type: key(model.type, 40), creator: key(model.creator, 80),
    tags: [...new Set((Array.isArray(model.tags) ? model.tags : []).slice(0, 16).map(tag => key(tag, 50)).filter(Boolean))].slice(0, 8),
  };
}

export function preferenceDocument(value) {
  const feedback = new Map();
  for (const row of (Array.isArray(value?.feedback) ? value.feedback : []).slice(0, maximumFeedback)) {
    if (!numericId(row?.id) || !numericId(row.modelId) || ![-1, 1].includes(row.vote) ||
        !visibleRating(row.level, 63) || feedback.has(row.id)) continue;
    feedback.set(row.id, { id: row.id, modelId: row.modelId, vote: row.vote, level: row.level, ...features(row) });
  }
  const mediaFeedback = new Map();
  for (const row of (Array.isArray(value?.mediaFeedback) ? value.mediaFeedback : []).slice(0, maximumFeedback)) {
    if (!numericId(row?.id) || ![-1, 1].includes(row.vote) || !visibleRating(row.level, 63) ||
        !['image', 'video'].includes(row.type) || mediaFeedback.has(row.id)) continue;
    mediaFeedback.set(row.id, { id: row.id, type: row.type, vote: row.vote, level: row.level, tags: tagIds(row.tags),
      ...(numericId(row.postId) && { postId: row.postId }) });
  }
  return { enabled: value?.enabled === true, feedback: [...feedback.values()],
    ...(value?.mediaEnabled === true && { mediaEnabled: true }),
    ...(mediaFeedback.size > 0 && { mediaFeedback: [...mediaFeedback.values()] }) };
}

export function visibleFeedback(value, ceiling) {
  return preferenceDocument(value).feedback.filter(row => visibleRating(row.level, ceiling));
}

export function saveFeedback(value, candidate, vote, level) {
  const state = preferenceDocument(value);
  if (!candidate || !numericId(candidate.id) || !numericId(candidate.modelId) || ![0, -1, 1].includes(vote) ||
      !visibleRating(level, 63)) throw new TypeError('Choose a visible Civitai model version.');
  const preceding = state.feedback.filter(row => row.id !== candidate.id);
  if (vote === 0) return { ...state, feedback: preceding };
  return { ...state, feedback: [{ id: candidate.id, modelId: candidate.modelId, vote, level, ...features(candidate) }, ...preceding]
    .slice(0, maximumFeedback) };
}

export function visibleMediaFeedback(value, ceiling) {
  return (preferenceDocument(value).mediaFeedback ?? []).filter(row => visibleRating(row.level, ceiling));
}

export function saveMediaFeedback(value, item, vote, ceiling) {
  const state = preferenceDocument(value);
  if (!numericId(item?.id) || item.audio || ![0, -1, 1].includes(vote) || !visibleRating(item.browsingLevel, ceiling) ||
      !Array.isArray(item.preferenceTags)) throw new TypeError('Choose a visible picture or clip.');
  const mediaFeedback = (state.mediaFeedback ?? []).filter(row => row.id !== item.id);
  if (vote) mediaFeedback.unshift({ id: item.id, type: item.video ? 'video' : 'image', vote,
    level: item.browsingLevel, tags: tagIds(item.preferenceTags), ...(numericId(item.postId) && { postId: item.postId }) });
  return preferenceDocument({ ...state, mediaFeedback: mediaFeedback.slice(0, maximumFeedback) });
}

function affinity(model, history) {
  const attributes = features(model);
  let signal = 0;
  let support = 0;
  for (const rated of history) {
    if (rated.id === model.id && rated.modelId === model.modelId) return rated.vote;
    const sameTag = attributes.tags.filter(tag => rated.tags.includes(tag)).length;
    const tagSupport = sameTag / Math.max(1, new Set([...attributes.tags, ...rated.tags]).size);
    const similar = .68 * tagSupport + (rated.base && rated.base === attributes.base ? .13 : 0) +
      (rated.type && rated.type === attributes.type ? .05 : 0) + (rated.creator && rated.creator === attributes.creator ? .14 : 0);
    signal += rated.vote * similar;
    support += similar;
  }
  return signal / Math.max(1, support);
}

export function personalModelOrder(candidates, preferences, ceiling) {
  const history = preferences?.enabled ? visibleFeedback(preferences, ceiling) : [];
  if (!history.length) return candidates;
  const ranked = [...candidates];
  const scores = new Map(ranked.map(model => [model.id, affinity(model, history)]));
  for (let i = 0; i < ranked.length - 1; i++) {
    const [first, second] = [ranked[i], ranked[i + 1]];
    if (first.nameMatch || second.nameMatch || first.match !== second.match || first.phrase !== second.phrase ||
        second.rank < first.rank * .72 || scores.get(second.id) - scores.get(first.id) < .12) continue;
    if (i === 2 || i === 5) {
      const prefix = ranked.slice(0, i);
      if (first.creator && !prefix.some(row => row.creator === first.creator) &&
          (!second.creator || prefix.some(row => row.creator === second.creator))) continue;
    }
    ranked[i] = second;
    ranked[i + 1] = first;
    i++;
  }
  return ranked;
}

function rankTagWeights(items) {
  const counts = new Map();
  for (const item of items) for (const tag of tagIds(item.preferenceTags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  // Tags shared by the whole result page express the search, not a personal preference.
  return new Map([...counts].map(([tag, count]) => [tag, Math.log((items.length + 1) / (count + 1))]));
}

function mediaAffinities(items, history) {
  const weights = rankTagWeights(items);
  const weight = tag => weights.get(tag) ?? 0;
  const exact = new Map(history.map(row => [row.id, row.vote]));
  const posts = new Set();
  const independent = history.filter(row => !row.postId || !posts.has(row.postId) && posts.add(row.postId))
    .map(row => ({ ...row, tags: row.tags.filter(tag => weight(tag) > 0) }))
    .map(row => ({ ...row, strength: row.tags.reduce((sum, tag) => sum + weight(tag), 0) }));
  return new Map(items.map(item => {
    if (exact.has(item.id)) return [item.id, exact.get(item.id)];
    const tags = tagIds(item.preferenceTags).filter(tag => weight(tag) > 0);
    const strength = tags.reduce((sum, tag) => sum + weight(tag), 0);
    let evidence = 0;
    let signal = 0;
    for (const row of independent) {
      const overlap = tags.filter(tag => row.tags.includes(tag)).reduce((sum, tag) => sum + weight(tag), 0);
      if (!overlap) continue;
      const shared = overlap / Math.sqrt(strength * row.strength);
      evidence += shared;
      signal += row.vote * shared;
    }
    return [item.id, signal / (.65 + evidence)];
  }));
}

function weakerMediaMatch(next, prior) {
  if (!prior) return false;
  return !next || next.subject < prior.subject || next.terms < prior.terms || next.score < prior.score * .86;
}

function wouldNarrow(prefix, prior, next, key) {
  return prior[key] && !prefix.some(item => item[key] === prior[key]) &&
    (!next[key] || prefix.some(item => item[key] === next[key]));
}

export function adjustMediaOrder(items, affinity) {
  const ranked = [...items];
  const window = Math.min(12, ranked.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < window - 1; i++) {
      const [first, second] = [ranked[i], ranked[i + 1]];
      if ((affinity.get(second.id) ?? 0) - (affinity.get(first.id) ?? 0) < .10 ||
          weakerMediaMatch(second.rankEvidence, first.rankEvidence)) continue;
      if (i === 2 || i === 4) {
        const prefix = ranked.slice(0, i);
        if (wouldNarrow(prefix, first, second, 'creator') || wouldNarrow(prefix, first, second, 'postId')) continue;
      }
      ranked[i] = second;
      ranked[i + 1] = first;
      i++;
    }
  }
  return ranked;
}

export function personalMediaOrder(items, preferences, ceiling) {
  const history = preferences?.mediaEnabled ? visibleMediaFeedback(preferences, ceiling) : [];
  return history.length && items.length > 1 ? adjustMediaOrder(items, mediaAffinities(items, history)) : items;
}
