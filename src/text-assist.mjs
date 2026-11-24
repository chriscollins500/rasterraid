const commonTypos = new Map(Object.entries({
  teh: 'the', hte: 'the', adn: 'and', annd: 'and', wtih: 'with', wiht: 'with', tehre: 'there',
  recieve: 'receive', differnt: 'different', similiar: 'similar', beutiful: 'beautiful',
  photorealisitc: 'photorealistic', linocutt: 'linocut',
}));

export const searchStarts = [
  'linocut', 'watercolor', 'ComfyUI guides', 'retro anime', 'photorealistic', 'cinematic lighting',
  'pixel art', 'ink illustration', 'risograph', 'cel shading', 'charcoal sketch', 'low-poly',
];

export const labelKey = value => value.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function editDistance(left, right) {
  let older;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) {
      const replace = previous[j - 1] + Number(left[i - 1] !== right[j - 1]);
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, replace);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        row[j] = Math.min(row[j], older[j - 2] + 1);
      }
    }
    older = previous;
    previous = row;
  }
  return previous[right.length];
}

export function filterMatches(value, rows) {
  const query = labelKey(value.trim()).slice(0, 100);
  if (!query) return rows;
  const limit = query.length > 6 ? 2 : 1;
  return rows.map(row => {
    const names = [row.label, ...(row.aliases ?? [])].map(labelKey);
    const key = names[0];
    let rank = Infinity;
    if (names.includes(query)) rank = 0;
    else if (names.some(name => name.startsWith(query))) rank = 1;
    else if (names.some(name => name.includes(query))) rank = 2;
    else if (query.length >= 3 && Math.abs(key.length - query.length) <= limit) {
      const distance = editDistance(query, key);
      if (distance <= limit) rank = 3 + distance;
    }
    return { row, rank };
  }).filter(entry => Number.isFinite(entry.rank)).sort((a, b) => a.rank - b.rank).map(entry => entry.row);
}

function preserveCase(word, replacement) {
  return word[0] === word[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

export function protectedReference(value) {
  return /\/\/|\bcivitai\.(?:com|red)\/|^\s*urn:air:|^\s*(?:version|tag|model|image|crucible|article|comic|user|comment)\s*[:#]|\b[a-f\d]{64}\b/iu.test(value);
}

export function correctSpelling(value, vocabulary) {
  if (protectedReference(value) || value.trim().length < 3) return null;
  const words = [...new Set(vocabulary.filter(word => /^\p{L}{5,35}$/u.test(word)).map(word => word.toLowerCase()))];
  const draft = value.trim().replace(/\p{L}+/gu, word => {
    const key = word.toLowerCase();
    const common = commonTypos.get(key);
    if (common) return preserveCase(word, common);
    if (word.length < 5 || words.includes(key)) return word;
    const near = words.filter(candidate => candidate[0] === key[0] && Math.abs(candidate.length - key.length) <= 1 && editDistance(key, candidate) === 1);
    return near.length === 1 ? preserveCase(word, near[0]) : word;
  });
  return draft === value.trim() ? null : draft;
}

export function reviseDraft(value, vocabulary) {
  if (protectedReference(value) || value.trim().length < 3) return null;
  const draft = (correctSpelling(value, vocabulary) ?? value.trim())
    .replace(/\b(the|a|an|and|or|of|in|for|with|to)\s+\1\b/giu, '$1')
    .replace(/\b(a) (anime|image|illustration|oil painting)\b/giu, (_, article, noun) => preserveCase(article, 'an') + ' ' + noun)
    .replace(/\b(an) (watercolor|watercolour|portrait|linocut|sketch|photo)\b/giu, (_, article, noun) => preserveCase(article, 'a') + ' ' + noun)
    .replace(/[ \t]{2,}/gu, ' ');
  return draft === value.trim() ? null : draft;
}

export function draftSuggestions(value, vocabulary, kind) {
  const input = value.trim();
  if (input.length < 2 || protectedReference(input)) return [];
  const corrected = reviseDraft(input, vocabulary);
  const rows = corrected ? [{ value: corrected, label: corrected, group: 'Spelling and grammar', detail: 'Apply correction' }] : [];
  const split = kind === 'exclude' ? input.lastIndexOf(',') + 1 : input.lastIndexOf(' ') + 1;
  const end = input.slice(split).trim();
  const prefix = input.slice(0, split).trimEnd();
  if (!end || !/[\p{L}\p{N}]$/u.test(input)) return rows;
  const proposals = [...new Set(vocabulary)].filter(word => word.toLowerCase().startsWith(end.toLowerCase()) &&
    word.toLowerCase() !== end.toLowerCase()).slice(0, 5);
  for (const word of proposals) {
    const candidate = prefix ? prefix + ' ' + word : word;
    if (candidate !== corrected) rows.push({ value: candidate, label: candidate, group: 'Autocomplete' });
  }
  return rows;
}

export function createProofreader(api = globalThis.Proofreader) {
  let session;
  const options = { expectedInputLanguages: ['en'] };
  return async function proofread(text, signal) {
    if (!api || protectedReference(text) || !/^(?:[^\p{L}]*\p{L}{2,}[^\p{L}]+){2,}\p{L}/u.test(text)) return null;
    try {
      if (!session) {
        if (await api.availability(options) !== 'available' || signal.aborted) return null;
        session = api.create(options).catch(error => { session = undefined; throw error; });
      }
      const model = await session;
      signal.throwIfAborted();
      const { correctedInput } = await model.proofread(text, { signal });
      return typeof correctedInput === 'string' && correctedInput.trim() !== text.trim() ? correctedInput.trim() : null;
    } catch {
      return null;
    }
  };
}
