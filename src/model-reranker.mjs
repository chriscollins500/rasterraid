import { text } from './catalog.mjs';
import { searchTerms, searchWords } from './query-language.mjs';

export const modelRerankWindow = 12;
export const rankingFeatureNames = Object.freeze(['catalogFusion', 'titleCoverage', 'tagCoverage', 'descriptionCoverage',
  'allFieldsCoverage', 'titlePhrase', 'titleOrTags', 'literalPosition']);
export const fieldWeights = Object.freeze([.44, .24, .15, .14, .24, .13, .17, .04]);
// Fit on seven public-catalog briefs. See the committed grading and replay receipt.
export const learnedModelWeights = Object.freeze([.20002990017509625, .43172711283099774, .34918196819568187,
  .5013987856389809, .636140565194246, .4154997477570057, .47191754969737565, 0]);

function wordKey(term) {
  return /^[a-z]{4,}[^sui]s$/u.test(term) ? term.slice(0, -1) : term;
}

function tagWords(candidate) {
  const triggers = candidate.triggers ?? candidate.trainedWords ?? [];
  return new Set([...(candidate.tags ?? []), ...triggers.map(word => text(word, 100)).filter(Boolean).slice(0, 6)]
    .slice(0, 24).flatMap(searchWords).map(wordKey));
}

function catalogStrength(candidate) {
  return candidate.rank + .02 * candidate.match + (candidate.phrase ? .012 : 0);
}

export function modelRerankFeatures(candidates, query, alternateQueries = []) {
  const original = searchTerms(query);
  if (original.length < 4 || candidates.length < 3) return [];
  const wordsByKey = new Map();
  for (const term of [...(alternateQueries[0] ? searchTerms(alternateQueries[0]) : []), ...original]) {
    if (!wordsByKey.has(wordKey(term))) wordsByKey.set(wordKey(term), term);
  }
  const queryWords = [...wordsByKey.keys()].slice(0, 16);
  const briefs = [query, ...alternateQueries.slice(0, 1)];
  const phrases = new Set(briefs.flatMap(brief => {
    const tokens = searchWords(brief).map(wordKey);
    return tokens.slice(1).map((term, i) => tokens[i] + ' ' + term).filter((_, i) =>
      queryWords.includes(tokens[i]) && queryWords.includes(tokens[i + 1]));
  }));
  const documents = candidates.slice(0, modelRerankWindow).map(candidate => {
    const titleWords = searchWords(candidate.model).map(wordKey);
    const inTitle = new Set(titleWords);
    const inTags = tagWords(candidate);
    const inDescription = new Set(searchWords(candidate.desc).map(wordKey));
    const all = new Set([...inTitle, ...inTags, ...inDescription]);
    const phraseMatch = titleWords.slice(1).some((term, i) => phrases.has(titleWords[i] + ' ' + term));
    return { candidate, inTitle, inTags, inDescription, all, phraseMatch };
  });
  const weighted = queryWords.flatMap(word => {
    const frequency = documents.filter(document => document.all.has(word)).length;
    return frequency ? [[word, Math.log(1 + (documents.length - frequency + .5) / (frequency + .5))]] : [];
  });
  if (!weighted.length) return [];
  const mass = weighted.reduce((total, [, weight]) => total + weight, 0);
  const strongest = Math.max(.01, ...documents.map(({ candidate }) => catalogStrength(candidate)));
  const coverage = include => weighted.reduce((total, [word, weight]) => total + (include(word) ? weight : 0), 0) / mass;
  return documents.map(({ candidate, inTitle, inTags, inDescription, all, phraseMatch }) => ({
    candidate,
    features: [
      catalogStrength(candidate) / strongest,
      coverage(word => inTitle.has(word)),
      coverage(word => inTags.has(word)),
      coverage(word => inDescription.has(word)),
      coverage(word => all.has(word)),
      phraseMatch ? 1 : 0,
      coverage(word => inTitle.has(word) || inTags.has(word)),
      1 / (1 + candidate.literalPosition),
    ],
    terms: weighted.filter(([word]) => all.has(word)).sort(([a, first], [b, second]) =>
      Number(inTitle.has(b)) - Number(inTitle.has(a)) || second - first).slice(0, 4)
      .map(([word]) => wordsByKey.get(word)),
  }));
}

export function orderModelRelevance(candidates, query, { alternateQueries = [], weights = learnedModelWeights } = {}) {
  const featured = modelRerankFeatures(candidates, query, alternateQueries);
  if (!featured.length) return candidates;
  const ranked = featured.filter(({ candidate }) => !candidate.nameMatch).map(({ candidate, features, terms }) => ({
    candidate, terms, score: weights.reduce((sum, weight, i) => sum + weight * features[i], 0),
  })).sort((first, second) => second.score - first.score);
  let next = 0;
  return [...featured.map(({ candidate }) => {
    if (candidate.nameMatch) return candidate;
    const chosen = ranked[next++];
    return chosen.candidate !== candidate && chosen.terms.length ? { ...chosen.candidate, matchedCatalogTerms: chosen.terms } : chosen.candidate;
  }),
    ...candidates.slice(featured.length)];
}
