import { modelChoiceKey, modelFilterParam, modelFilterValues } from './model-access.mjs';
import { labelKey } from './text-assist.mjs';

const grammar = [
  { opening: /^(?:find(?: me)?|show(?: me)?|search for|look for)\s+(?:(?:some|the)\s+)?/iu,
    subject: /\s+for\s+/iu, either: /\s+or\s+/iu, free: /^free$/iu, general: ['model', 'models'],
    author: /\s+by\s+@([\p{L}\p{N}_-]{2,80})$/iu,
    format: /\s+(?:in(?: the)?(?: format)?|as)\s+/giu,
    exclude: /\s+without\s+(?:"([^"\r\n,]{1,80})"|([\p{L}\p{N}_-]{1,40}))$/iu,
    generation: /\s+with\s+Civitai generation$/iu },
  { opening: /^(?:buscar|encuentra|muestra|mu[eé]strame)\s+(?:(?:los|las)\s+)?/iu,
    subject: /\s+para\s+/iu, either: /\s+o\s+/iu, free: /^(?:gratis|gratuitos?|gratuitas?)$/iu,
    general: ['modelo', 'modelos'], author: /\s+(?:de|por)\s+@([\p{L}\p{N}_-]{2,80})$/iu,
    format: /\s+en(?:\s+formato)?\s+/giu,
    exclude: /\s+sin\s+(?:"([^"\r\n,]{1,80})"|([\p{L}\p{N}_-]{1,40}))$/iu,
    generation: /\s+con generaci[oó]n (?:de|en) Civitai$/iu },
  { opening: /^(?:trouver|trouve|cherche(?:r)?|montre)\s+(?:(?:des|les)\s+)?/iu,
    subject: /\s+pour\s+/iu, either: /\s+ou\s+/iu, free: /^(?:gratuits?|gratuites?)$/iu,
    general: ['modèle', 'modèles'], author: /\s+par\s+@([\p{L}\p{N}_-]{2,80})$/iu,
    format: /\s+au format\s+/giu,
    exclude: /\s+sans\s+(?:"([^"\r\n,]{1,80})"|([\p{L}\p{N}_-]{1,40}))$/iu,
    generation: /\s+avec g[eé]n[eé]ration Civitai$/iu },
];

const baseAliases = { SDXL: 'SDXL 1.0', 'Stable Diffusion XL': 'SDXL 1.0' };
const typeAliases = { loras: 'LORA', checkpoints: 'Checkpoint', controlnets: 'Controlnet', vaes: 'VAE',
  upscalers: 'Upscaler', 'text encoders': 'TextEncoder' };
const formatAliases = { safetensors: 'SafeTensor' };
const unresolved = /@|(?:^|\s)(?:without|sin|sans|format|formato)\s+|(?:^|\s)(?:by|de|par|without|sin|sans|format|formato|in|en)\s*$/iu;
const compoundFields = ['baseModel', 'resourceType'];

function phrase(value) {
  const draft = value.trim();
  if (draft.length > 300 || /[\p{Cc}\p{Cf}]|:\/\//u.test(draft)) return null;
  for (const locale of grammar) {
    const opening = locale.opening.exec(draft);
    if (!opening) continue;
    const words = draft.slice(opening[0].length);
    const boundary = locale.subject.exec(words);
    if (boundary) return { locale, selector: words.slice(0, boundary.index).trim(),
      topic: words.slice(boundary.index + boundary[0].length).trim() };
  }
  return null;
}

export function looksLikeModelBrief(value) {
  return Boolean(phrase(value));
}

function choices(rows, aliases) {
  const values = new Set(rows.map(row => typeof row === 'string' ? row : row.value));
  const allowed = new Map();
  function add(label, value) {
    const key = labelKey(label);
    allowed.set(key, allowed.has(key) && allowed.get(key) !== value ? null : value);
  }
  for (const row of rows) {
    if (typeof row === 'string') add(row, row);
    else { add(row.value, row.value); add(row.label, row.value); }
  }
  for (const [alias, value] of Object.entries(aliases)) if (values.has(value)) add(alias, value);
  return value => allowed.get(labelKey(value)) ?? null;
}

function group(value, resolve, separator) {
  const exact = resolve(value);
  if (exact) return [exact];
  const parts = value.split(separator);
  if (parts.length < 2 || parts.length > 4) return null;
  const names = parts.map(resolve);
  return names.every(Boolean) ? [...new Set(names)] : null;
}

function header(selector, locale, base, type) {
  const words = selector.split(/\s+/u);
  const startsFree = locale.free.test(words[0]);
  const endsFree = locale.free.test(words.at(-1));
  if (startsFree) words.shift();
  else if (endsFree) words.pop();
  if (!words[0] || words.length > 18) return null;
  const general = locale.general.map(labelKey);
  const types = value => general.includes(labelKey(value)) ? [] : group(value, type, locale.either);
  const interpretations = new Map();
  function add(bases, kind) {
    if (!bases || !kind) return;
    const filters = { ...(bases.length && { baseModel: modelFilterParam(bases) }),
      ...(kind.length && { resourceType: modelFilterParam(kind) }),
      ...((startsFree || endsFree) && { downloadAccess: 'free' }) };
    interpretations.set(JSON.stringify(filters), filters);
  }
  add([], types(words.join(' ')));
  for (let split = 1; split < words.length; split++) {
    const first = words.slice(0, split).join(' ');
    const second = words.slice(split).join(' ');
    add(group(first, base, locale.either), types(second));
    add(group(second, base, locale.either), types(first));
  }
  return interpretations.size === 1 ? interpretations.values().next().value : null;
}

function subject(topic, locale, format) {
  let words = topic.trim();
  const fields = {};
  const literal = /^"([^"\r\n]+)"$/u;
  // A clause is consumed only at the end and only when its value is complete.
  for (let step = 0; step < 4; step++) {
    if (literal.test(words)) break;
    const author = locale.author.exec(words);
    const generation = locale.generation.exec(words);
    const exclude = locale.exclude.exec(words);
    const file = !author && !generation && !exclude && [...words.matchAll(locale.format)].reverse().map(marker => ({
      index: marker.index, value: format(words.slice(marker.index + marker[0].length).replace(/\s+(?:format|files?)$/iu, '')),
    })).find(marker => marker.value);
    const match = author ?? generation ?? exclude ?? file;
    if (!match) break;
    const field = author ? 'modelAuthor' : generation ? 'supportsGeneration' : exclude ? 'exclude' : 'fileFormat';
    if (Object.hasOwn(fields, field) || words.slice(0, match.index).split('"').length % 2 === 0) return null;
    fields[field] = author ? match[1] : generation ? 'true' : exclude ? (match[1] ?? match[2]).trim() : file.value;
    words = words.slice(0, match.index).trimEnd();
  }
  const quoted = literal.exec(words);
  if (quoted) words = quoted[1].trim();
  else if (words.includes('"') || unresolved.test(words)) return null;
  if (!/[\p{L}\p{N}]/u.test(words) || fields.exclude !== undefined && !/[\p{L}\p{N}]/u.test(fields.exclude)) return null;
  return { query: words, filters: fields };
}

export function compileModelBrief(value, { bases, types, formats }) {
  const parts = phrase(value);
  if (!parts) return null;
  const { selector, topic, locale } = parts;
  const requested = header(selector, locale, choices(bases, baseAliases), choices(types, typeAliases));
  if (!requested) return null;
  const result = subject(topic, locale, choices(formats, formatAliases));
  if (!result) return null;
  const filters = { ...requested, ...result.filters };
  return Object.keys(filters).length ? { query: result.query, filters } : null;
}

export function mergeModelBriefFilters(filters, selected) {
  const next = {};
  for (const [field, value] of Object.entries(filters)) {
    const existing = selected[field];
    if (compoundFields.includes(field)) {
      const before = modelFilterValues(existing);
      const keys = new Set(modelFilterValues(value).map(modelChoiceKey));
      const overlap = before.filter(choice => keys.has(modelChoiceKey(choice)));
      if (before.length && !overlap.length) return { conflict: field };
      next[field] = before.length ? modelFilterParam(overlap) : value;
    } else if (field === 'exclude') {
      const merged = [...new Set([...(existing ?? '').split(',').map(item => item.trim()).filter(Boolean), value])].join(', ');
      if (merged.length > 200) return { conflict: field };
      next[field] = merged;
    } else {
      const key = choice => modelChoiceKey(field === 'modelAuthor' ? choice.replace(/^@/u, '') : choice);
      if (existing && key(existing) !== key(value)) return { conflict: field };
      next[field] = value;
    }
  }
  return { filters: next };
}
