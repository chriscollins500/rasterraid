import { text } from './catalog.mjs';
import { protectedReference } from './text-assist.mjs';

// Seed terms for art and model discovery in the embedded app, where the
// browser's translation features may be unavailable to cross-origin frames.
const catalogGlossary = {
  watercolor: ['watercolour', 'acuarela', 'aquarelle', 'aquarela', 'aquarell', 'acquerello', 'акварель', '水彩画', '水彩', '수채화'],
  linocut: ['linograbado', 'grabado en linóleo', 'linogravure', 'linoleogravura', 'linolschnitt', 'linoleografia', 'линогравюра', 'リノカット', '油毡版画', '油氈版畫', '리노컷'],
  woodcut: ['xilografía', 'gravure sur bois', 'xilogravura', 'holzschnitt', 'xilografia', 'ксилография', '木版画', '木刻', '목판화'],
  'oil painting': ['pintura al óleo', 'peinture à l’huile', 'peinture à l\'huile', 'pintura a óleo', 'ölgemälde', 'pittura a olio', 'масляная живопись', '油彩画', '油画', '油畫', '유화'],
  'charcoal sketch': ['boceto al carbón', 'dessin au fusain', 'esquisse au fusain', 'desenho a carvão', 'kohlezeichnung', 'disegno a carboncino', 'рисунок углём', '木炭画', '炭笔画', '목탄화'],
  'pencil sketch': ['boceto a lápiz', 'dessin au crayon', 'esboço a lápis', 'bleistiftskizze', 'schizzo a matita', 'карандашный набросок', '鉛筆画', '铅笔画', '연필 스케치'],
  'pixel art': ['arte de píxeles', 'arte en píxeles', 'arte em pixels', 'pixelkunst', 'пиксельная графика', 'ドット絵', '像素画', '像素畫', '픽셀 아트'],
  'ink illustration': ['ilustración a tinta', 'dessin à l’encre', 'dessin à l\'encre', 'ilustração a tinta', 'tuschezeichnung', '水墨画', '水墨畫', '수묵화'],
  'cinematic lighting': ['iluminación cinematográfica', 'éclairage cinématographique', 'iluminação cinematográfica', 'filmische beleuchtung', 'illuminazione cinematografica', 'кинематографическое освещение', 'シネマティックライティング', '电影光效', '영화 조명'],
  photorealistic: ['fotorrealista', 'photoréaliste', 'fotorealistisch', 'fotorealistico', 'фотореализм', 'フォトリアル', '照片级写实', '실사풍'],
  landscape: ['paisaje', 'paysage', 'paisagem', 'landschaft', 'paesaggio', 'пейзаж', '風景', '风景', '풍경'],
  portrait: ['retrato', 'porträt', 'ritratto', 'портрет', '肖像画', '人像', '초상화'],
  'black and white': ['blanco y negro', 'noir et blanc', 'preto e branco', 'schwarzweiß', 'bianco e nero', 'чёрно-белый', 'モノクロ', '黑白', '흑백'],
};

export const foldSearchText = value => value.normalize('NFKD').toLowerCase()
  .replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFKC').replace(/’/gu, "'");

const stopWords = new Set(['a', 'an', 'and', 'for', 'find', 'i', 'in', 'like', 'looking', 'me', 'of', 'please', 'show', 'some', 'something', 'the', 'to', 'want', 'with']);
export const searchWords = value => foldSearchText(text(value, 600)).match(/[\p{L}\p{N}]+/gu) ?? [];
export const searchTerms = value => [...new Set(searchWords(value).filter(word => !stopWords.has(word)))];

const byAlias = new Map(Object.entries(catalogGlossary)
  .flatMap(([canonical, aliases]) => aliases.map(alias => [foldSearchText(alias), canonical])));
export const catalogWords = [...Object.keys(catalogGlossary), ...byAlias.keys()];

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const unspacedScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const aliasesByLength = [...byAlias.keys()].sort((a, b) => b.length - a.length);
const spacedAliases = aliasesByLength.filter(alias => !unspacedScript.test(alias)).map(escapeRegex).join('|');
const unspacedAliases = aliasesByLength.filter(alias => unspacedScript.test(alias)).map(escapeRegex).join('|');
// Match compounds such as 風景の水彩画 without requiring spaces around their terms.
const aliasPattern = new RegExp('(?<![\\p{L}\\p{N}])(?:' + spacedAliases + ')(?![\\p{L}\\p{N}])|(?:' + unspacedAliases + ')', 'gu');

export function translateCatalogTerms(input) {
  if (protectedReference(input)) return null;
  const concepts = new Set();
  const brief = foldSearchText(input).replace(aliasPattern, alias => {
    const concept = byAlias.get(alias);
    concepts.add(concept);
    return ' ' + concept + ' ';
  }).trim().replace(/\s+/gu, ' ');
  return concepts.size ? { focus: [...concepts].join(' '), brief } : null;
}

export async function translateOnDevice(input, signal, { LanguageDetector, Translator } = globalThis) {
  if (!LanguageDetector || !Translator || input.length < 16 || protectedReference(input)) return null;
  const timeout = AbortSignal.timeout(750);
  const budget = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let detector;
  let translator;
  try {
    budget.throwIfAborted();
    if (await LanguageDetector.availability() !== 'available' || budget.aborted) return null;
    detector = await LanguageDetector.create({ signal: budget });
    const [language] = await detector.detect(input, { signal: budget });
    const sourceLanguage = language?.detectedLanguage;
    if (!sourceLanguage || /^(?:en|und)(?:-|$)/iu.test(sourceLanguage) || language.confidence < .85) return null;
    const options = { sourceLanguage, targetLanguage: 'en' };
    if (await Translator.availability(options) !== 'available' || budget.aborted) return null;
    translator = await Translator.create({ ...options, signal: budget });
    const translated = text(await translator.translate(input, { signal: budget }), 160);
    if (!translated || protectedReference(translated) || foldSearchText(translated) === foldSearchText(input)) return null;
    return translated;
  } catch {
    return null;
  } finally {
    translator?.destroy?.();
    detector?.destroy?.();
  }
}
