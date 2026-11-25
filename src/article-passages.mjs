import { articleCover, articleHeadingId, plainArticleText } from './article-sources.mjs';
import { catalogPause, numericId, SITE_ORIGINS, text } from './catalog.mjs';
import { readPublicArticle } from './directory.mjs';
import { foldSearchText, searchTerms, translateCatalogTerms } from './query-language.mjs';

export const articlePassageLimit = 6;
const bodyLimit = 80_000;
const blockLimit = 480;
const textBlocks = new Set(['heading', 'paragraph', 'codeBlock', 'tableCell', 'tableHeader']);
const containers = new Set(['doc', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow']);
const questionWords = new Set(['can', 'could', 'do', 'does', 'how', 'is', 'should', 'what', 'when',
  'where', 'which', 'who', 'why', 'would', 'you']);
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
const needsSegmentation = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const wordKey = value => foldSearchText(value).replace(/^([a-z]{3,}[^sui])s$/u, '$1');

function nativeHeadingId(heading) {
  // Civitai's CustomHeading renderer slugifies the heading text with slugify defaults.
  // This ASCII subset has no transliteration or symbol aliases.
  if (!/^[A-Za-z0-9 _.:!?()'-]+$/u.test(heading)) return null;
  const slug = heading.toLowerCase().replace(/\?/gu, '').replace(/-/gu, ' ').trim().replace(/ +/gu, '-');
  return articleHeadingId(slug);
}

function words(value) {
  if (segmenter && needsSegmentation.test(value)) {
    return [...segmenter.segment(value)].filter(part => part.isWordLike)
      .map(({ segment, index }) => ({ key: wordKey(segment), start: index, end: index + segment.length }));
  }
  return [...value.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map(match =>
    ({ key: wordKey(match[0]), start: match.index, end: match.index + match[0].length }));
}

function articleBlocks(article) {
  const blocks = [];
  const anchors = new Map();
  let section = null;
  let remainingText = bodyLimit;
  let remainingNodes = 4_000;
  let hasSpoiler = false;

  function inline(node, depth) {
    if (!node || depth > 12 || remainingNodes-- <= 0 || !remainingText) return '';
    if (node.type === 'spoilerBlock' || Array.isArray(node.marks) && node.marks.some(mark => mark?.type === 'spoiler')) {
      hasSpoiler = true;
      return '';
    }
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'text' && typeof node.text === 'string') {
      const part = node.text.slice(0, remainingText);
      remainingText -= part.length;
      return part;
    }
    if (!textBlocks.has(node.type) || !Array.isArray(node.content)) return '';
    let value = '';
    for (const child of node.content) {
      if (!remainingText || remainingNodes <= 0) break;
      const part = inline(child, depth + 1);
      value += child?.type === 'paragraph' && value ? ' ' + part : part;
    }
    return value;
  }

  function visit(node, depth = 0) {
    if (remainingNodes-- <= 0 || !node || depth > 12 || !remainingText || blocks.length >= blockLimit) return;
    if (textBlocks.has(node.type)) {
      hasSpoiler = false;
      const value = inline(node, depth).replace(/\s+/gu, ' ').trim();
      if (node.type === 'heading') {
        const textOnly = Array.isArray(node.content) && node.content.every(child => child?.type === 'text');
        const id = value && !hasSpoiler && textOnly ? nativeHeadingId(value) : null;
        if (id) anchors.set(id, (anchors.get(id) ?? 0) + 1);
        section = !value || hasSpoiler ? null : { title: text(value, 180), id, position: blocks.length };
      } else if (value && !hasSpoiler) blocks.push({ value, section });
      return;
    }
    if (!containers.has(node.type) || !Array.isArray(node.content)) return;
    for (const child of node.content) {
      if (!remainingText || remainingNodes <= 0 || blocks.length >= blockLimit) break;
      visit(child, depth + 1);
    }
  }

  if (article.contentJson?.type === 'doc') visit(article.contentJson);
  else {
    // Older article responses have HTML only. Keep plain text and use the article link.
    const html = text(article.content, bodyLimit);
    if (/data-type\s*=\s*(?:["']\s*)?spoiler\b/iu.test(html)) return blocks;
    const body = html.replace(/<\/(?:p|li|h[1-6]|pre|blockquote|td)>/giu, '\n');
    for (const part of body.split('\n', blockLimit)) {
      const value = plainArticleText(part, bodyLimit);
      if (value) blocks.push({ value, section: null });
    }
  }
  return blocks.map(block => anchors.get(block.section?.id) > 1
    ? { ...block, section: { ...block.section, id: null } } : block);
}

export function articlePassageCards(cards, origin) {
  if (!SITE_ORIGINS.includes(origin)) return [];
  const eligible = new Map();
  for (const card of cards) {
    if (numericId(card?.id) && card.id <= 2_147_483_647 && card.link === new URL('/articles/' + card.id, origin).href) {
      eligible.set(card.id, card);
    }
  }
  return [...eligible.values()];
}

export async function readArticlePassageSources(context, cards, plan, { fetcher, signal, onProgress } = {}) {
  const candidates = articlePassageCards(cards, context.origin).slice(0, articlePassageLimit);
  const result = { sources: [], requested: candidates.length, attempted: 0, paused: false };
  for (let index = 0; index < candidates.length; index += 2) {
    signal?.throwIfAborted();
    if (catalogPause(context.origin, fetcher)) {
      result.paused = true;
      break;
    }
    const batch = candidates.slice(index, index + 2);
    const replies = await Promise.allSettled(batch.map(card => readPublicArticle(context, card.id, { plan, signal, fetcher })));
    signal?.throwIfAborted();
    for (const [i, reply] of replies.entries()) {
      if (reply.status === 'rejected') {
        if (reply.reason?.status === 429) result.paused = true;
        continue;
      }
      const article = reply.value;
      if (!article) continue;
      const title = text(article.title, 160);
      const blocks = articleBlocks(article);
      if (!title || !blocks.length) continue;
      const date = Date.parse(article.updatedAt);
      const ceiling = context.hosted ? context.browsingLevel ?? 1 : 31;
      result.sources.push({
        id: article.id, title, creator: text(article.user?.username, 80), articleLink: batch[i].link,
        updatedAt: Number.isFinite(date) ? new Date(date).toISOString() : null, preview: articleCover(article, ceiling), blocks,
      });
    }
    result.attempted += batch.length;
    onProgress?.(result.attempted, result.requested);
    if (result.paused) break;
  }
  return result;
}

function windows(sources) {
  return sources.flatMap(source => source.blocks.flatMap(({ value, section }, block) => {
    const all = words(value);
    const heading = new Set(section ? words(section.title).map(word => word.key) : []);
    const ranges = [];
    for (let start = 0; start < all.length; start += 36) {
      const tokens = all.slice(start, start + 48);
      const frequency = new Map();
      for (const { key } of tokens) frequency.set(key, (frequency.get(key) ?? 0) + 1);
      ranges.push({ source, value, section, block, tokens, frequency, heading });
      if (start + tokens.length >= all.length) break;
    }
    return ranges;
  }));
}

function queryKeys(input) {
  const keys = words(input).map(word => word.key).filter(key => !questionWords.has(key));
  return searchTerms(keys.join(' ')).slice(0, 14);
}

function passageScores(entries, keys) {
  const weights = new Map(keys.map(key => {
    const count = entries.filter(({ frequency, heading }) => frequency.has(key) || heading.has(key)).length;
    return [key, Math.log(1 + (entries.length - count + .5) / (count + .5))];
  }));
  const mass = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const average = entries.reduce((sum, entry) => sum + entry.tokens.length, 0) / entries.length;
  const minimum = Math.min(keys.length, keys.length > 5 ? 3 : 2);
  return entries.flatMap(entry => {
    let matched = 0;
    let coverage = 0;
    let score = 0;
    const length = 1.2 * (.55 + .45 * entry.tokens.length / average);
    for (const [key, weight] of weights) {
      const count = entry.frequency.get(key) ?? 0;
      const inHeading = entry.heading.has(key);
      if (!count && !inHeading) continue;
      matched++;
      coverage += weight;
      score += weight * (2.2 * count / (count + length) + (inHeading ? .5 : 0));
    }
    return matched >= minimum ? [{ entry, weights, score: score * coverage / (mass * mass) }] : [];
  });
}

function excerptFor({ value, tokens }, weights) {
  let bestStart = 0;
  let bestScore = 0;
  const count = 22;
  for (let index = 0; index < tokens.length; index++) {
    const start = Math.max(0, Math.min(index - 6, tokens.length - count));
    const keys = new Set(tokens.slice(start, start + count).map(token => token.key));
    const score = [...keys].reduce((sum, key) => sum + (weights.get(key) ?? 0), 0);
    if (score > bestScore) {
      bestStart = start;
      bestScore = score;
    }
  }
  const selected = tokens.slice(bestStart, bestStart + count);
  const first = selected[0].start;
  const last = Math.min(value.length, selected.at(-1).end + (/[.,;:!?]/u.test(value[selected.at(-1).end] ?? '') ? 1 : 0), first + 300);
  const prefix = first > 0 ? '…' : '';
  const excerpt = prefix + value.slice(first, last) + (last < value.length ? '…' : '');
  const matches = selected.filter(token => weights.has(token.key) && token.end <= last)
    .map(({ start, end }) => [start - first + prefix.length, end - first + prefix.length]);
  return { excerpt, matches };
}

export function rankArticlePassages(sources, query) {
  const input = text(query, 200);
  const translated = translateCatalogTerms(input)?.brief;
  const variants = [queryKeys(input), ...(translated ? [queryKeys(translated)] : [])].filter(keys => keys.length);
  if (!variants.length) return [];
  const entries = windows(sources);
  if (!entries.length) return [];
  const ranked = variants.flatMap(keys => passageScores(entries, keys)).sort((first, second) => second.score - first.score);
  const rows = [];
  const used = new Set();
  for (const { entry, weights } of ranked) {
    const { source, section, block } = entry;
    const key = sources.length === 1 ? section?.position ?? block : source.id;
    if (used.has(key)) continue;
    used.add(key);
    const link = new URL(source.articleLink);
    if (section?.id) link.hash = section.id;
    const { blocks: _blocks, ...article } = source;
    rows.push({ ...article, heading: section?.title ?? null, sectionLink: section?.id ? link.href : null,
      ...excerptFor(entry, weights) });
    if (rows.length >= (sources.length === 1 ? 3 : articlePassageLimit)) break;
  }
  return rows;
}
