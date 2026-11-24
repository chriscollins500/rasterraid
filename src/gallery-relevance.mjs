import { text } from './catalog.mjs';
import { searchTerms, searchWords, translateCatalogTerms } from './query-language.mjs';

const links = /\b(?:above|across|at|behind|below|beneath|by|during|from|in|inside|near|of|on|onto|over|through|under|with)\b|[,.;!?]/gu;
const filler = new Set(['above', 'across', 'at', 'behind', 'below', 'beneath', 'by', 'clip', 'clips', 'during', 'from', 'gallery',
  'image', 'images', 'inside', 'near', 'on', 'onto', 'over', 'photo', 'picture', 'through', 'under', 'video', 'videos']);
const motion = new Set(['drive', 'fly', 'move', 'play', 'walk', 'wash']);
const roots = new Map(Object.entries({ driving: 'drive', flying: 'fly', foggy: 'fog', moving: 'move', nighttime: 'night',
  playing: 'play', rainy: 'rain', rocky: 'rock', snowy: 'snow', sunny: 'sun', walking: 'walk', washing: 'wash' }));

function termKey(word) {
  if (roots.has(word)) return roots.get(word);
  if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 3 && /[^sui]s$/u.test(word)) return word.slice(0, -1);
  return word;
}

const termsIn = value => searchTerms(value).filter(word => !filler.has(word)).map(termKey);

export function describeMediaQuery(value) {
  const source = text(value, 160);
  const localized = translateCatalogTerms(source)?.brief;
  const [positive, negative] = (localized ?? source.toLowerCase()).split(/\s+without\s+/u, 2);
  const words = searchTerms(positive).filter(word => !filler.has(word));
  const terms = [...new Set(words.map(termKey))];
  if (!terms.length || terms.length < 4 && !negative) return null;
  // Look up each clause's last useful word before its modifiers. Those words tend to name what must be in the scene.
  const clauses = positive.split(links).map(part => termsIn(part).filter(term => !motion.has(term)).reverse()).filter(part => part.length);
  const priority = [...new Set([...clauses.map(part => part[0]), ...clauses.flat()])];
  const variants = [...new Set([positive.trim(), ...priority, ...words])].filter(Boolean).slice(0, 10);
  const excluded = negative ? negative.split(/\s+or\s+|,/gu).map(termsIn).filter(part => part.length) : [];
  return { positive: positive.trim(), terms, priority, variants, excluded, clauses };
}

export function descriptiveMediaRoutes(brief, discovered, literal) {
  const oneWord = new Map();
  for (const tag of discovered) {
    const [word, extra] = searchWords(tag.name);
    if (!word || extra) continue;
    const key = termKey(word);
    if (!brief.priority.includes(key)) continue;
    if (!oneWord.has(key) || word === key) oneWord.set(key, tag);
  }
  const heads = brief.clauses.map(clause => clause.find(key => oneWord.has(key))).filter(Boolean);
  const featured = [...new Set([...heads, ...brief.priority])].flatMap(key => oneWord.has(key) ? [oneWord.get(key)] : []).slice(0, 3);
  const [first, second, third] = featured.map(tag => tag.id);
  const strict = literal.filter(tag => termsIn(tag.name).some(term => !motion.has(term))).map(tag => tag.id);
  const variants = [strict, [first, second], [first, third], [second, third], [first], [second]];
  const routes = new Map();
  for (const variant of variants) {
    if (!variant.length || variant.some(id => !id)) continue;
    routes.set([...variant].sort((a, b) => a - b).join(','), variant);
    if (routes.size === 4) break;
  }
  return { routes: [...routes.values()], subject: featured[0] ? termKey(searchWords(featured[0].name)[0]) : undefined };
}

function mediaEvidence({ tags, prompt, title }) {
  return [...tags.map(tag => termsIn(tag.name)), termsIn(prompt), termsIn(title)];
}

function matchesExclusion(fields, excluded) {
  return excluded.some(part => fields.some(field => (' ' + field.join(' ') + ' ').includes(' ' + part.join(' ') + ' ')));
}

export function filterMediaExclusions(rows, excluded) {
  return rows.filter(row => !matchesExclusion(mediaEvidence(row), excluded)).map(row => row.item);
}

export function rankMediaMatches(rows, { terms, subject, excluded }) {
  return rows.flatMap(({ item, tags, prompt, title }) => {
    const fields = mediaEvidence({ tags, prompt, title });
    if (matchesExclusion(fields, excluded)) return [];
    const tagWords = new Set(fields.slice(0, -2).flat());
    const descriptions = new Set(fields.slice(-2).flat());
    const tagTerms = terms.filter(term => tagWords.has(term));
    const promptTerms = terms.filter(term => descriptions.has(term) && !tagWords.has(term));
    const subjectMatch = tagWords.has(subject) ? 2 : descriptions.has(subject) ? 1 : 0;
    const score = tagTerms.length * 1.5 + promptTerms.length + [0, .75, 1.25][subjectMatch];
    if (!score) return [];
    const matchingTags = tags.filter(tag => termsIn(tag.name).some(term => tagTerms.includes(term))).map(tag => tag.name).slice(0, 4);
    return [{ score, item: { ...item, rankEvidence: { score, subject: subjectMatch, terms: tagTerms.length + promptTerms.length },
      mediaMatch: { tags: matchingTags, description: promptTerms.slice(0, 6) } } }];
  }).sort((a, b) => b.score - a.score).map(row => row.item);
}
