import { pastedExamplePair } from './example-comparison.mjs';
import { searchTarget } from './search.mjs';
import { startsStoryBrief, storyInput } from './story-research.mjs';

const referenceTasks = [
  { reportType: 'trace', label: 'Find source models', kinds: ['image', 'post'],
    prefix: /^(?:find what made|find the models (?:used )?in|what made|what models (?:made|were used in)|trace)\s+(?:this\s+)?/iu },
  { reportType: 'guide', label: 'Follow guide', kinds: ['article'], prefix: /^follow (?:the |this )?(?:guide\s+)?/iu },
  { reportType: 'collection', label: 'Explore collection', kinds: ['collection'], prefix: /^explore (?:the |this )?(?:collection\s+)?/iu },
  { reportType: 'release', label: 'Explore release', kinds: ['model', 'version'],
    prefix: /^explore (?:the |this )?(?:(?:model|release)\s+)?/iu },
];
const handle = /^(?:(?:explore|show me|find work by)\s+)?(@[\p{L}\p{N}_-]{1,80}(?:\s+[^@\r\n]+)?)$/iu;
const singleLink = /^https:\/\/[^\s]+$/iu;

const catalogTasks = [
  ['gallery', 'Find gallery pictures', /^(?:(?:find|show(?: me)?|search for)\s+)?(?:pictures|photos|images|illustrations)\s+(?:of|with|about)\s+/iu,
    /^(?:(?:buscar|muestra)\s+)?(?:imágenes|imagenes|fotos)\s+(?:de|sobre)\s+/iu,
    /^(?:(?:trouver|cherche)\s+(?:des\s+)?)?(?:photos|images)\s+(?:de|sur)\s+/iu],
  ['videos', 'Find videos', /^(?:(?:find|show(?: me)?|search for)\s+)?(?:videos|clips|animations)\s+(?:of|with|about)\s+/iu,
    /^(?:(?:buscar|muestra)\s+)?(?:vídeos|videos|clips)\s+(?:de|sobre)\s+/iu,
    /^(?:(?:trouver|cherche)\s+(?:des\s+)?)?(?:vidéos|clips)\s+(?:de|sur)\s+/iu],
  ['audio', 'Find audio and music', /^(?:(?:find|show(?: me)?|search for)\s+)?(?:songs|music|audio|soundtracks)\s+(?:like|in the style of)\s+/iu,
    /^(?:(?:buscar|muestra)\s+)?(?:música|musica|canciones)\s+(?:como|de)\s+/iu],
  ['articles', 'Find articles and guides', /^(?:(?:find|show(?: me)?|search for)\s+)?(?:articles|guides|tutorials)\s+(?:for|on|about)\s+/iu,
    /^(?:(?:buscar|muestra)\s+)?(?:artículos|articulos|guías|guias|tutoriales)\s+(?:de|sobre|para)\s+/iu,
    /^(?:(?:trouver|cherche)\s+(?:des\s+)?)?(?:articles|guides|tutoriels)\s+(?:sur|pour)\s+/iu],
  ['models', 'Find models', /^(?:(?:find|show(?: me)?|search for)\s+)?(?:models|checkpoints|loras)\s+(?:for|with)\s+/iu],
  ['posts', 'Find posts', /^(?:(?:find|show(?: me)?|search for)\s+)?posts\s+(?:about|with|by(?=\s+@))\s+/iu],
  ['collections', 'Find collections', /^(?:(?:find|show(?: me)?|search for)\s+)?collections\s+(?:of|about|with)\s+/iu],
  ['tools', 'Find tools', /^(?:(?:find|show(?: me)?|search for)\s+)?(?:tools|software)\s+(?:for|to)\s+/iu],
  ['aiServices', 'Find AI services', /^(?:(?:find|show(?: me)?|search for)\s+)?(?:an? )?ai services?\s+(?:for|to)\s+/iu],
  ['reviews', 'Find model reviews', /^(?:(?:find|show(?: me)?|search for)\s+)?reviews\s+(?:of|for)\s+/iu],
];

export function suggestedCatalogSearch(value) {
  const draft = value.trim();
  if (draft.length > 300 || /[\r\n]|:\/\//u.test(draft)) return null;
  for (const [scope, label, ...prefixes] of catalogTasks) {
    const prefix = prefixes.map(pattern => pattern.exec(draft)).find(Boolean)?.[0];
    if (!prefix) continue;
    const query = draft.slice(prefix.length).trim();
    return /[\p{L}\p{N}]/u.test(query) ? { scope, label, query } : null;
  }
  return null;
}

export function quickSearchIntent(value) {
  const query = value.trim();
  if (!query || query.length > 500) return null;
  if (pastedExamplePair(query)) return { reportType: 'examplePair', label: 'Compare settings', query };
  if (startsStoryBrief(query)) {
    try {
      if (storyInput(query)?.topic) return { reportType: 'stories', label: 'Plan story', query, literal: true };
    } catch { return null; }
  }
  const creator = handle.exec(query)?.[1];
  if (creator && !creator.includes('://')) return { reportType: 'creator', label: 'Find creator’s work', query: creator, literal: true };
  for (const { reportType, label, prefix, kinds } of referenceTasks) {
    const match = prefix.exec(query);
    if (!match) continue;
    const link = query.slice(match[0].length);
    if (!singleLink.test(link)) continue;
    try {
      if (kinds.includes(searchTarget(link).kind)) return { reportType, label, query: link, literal: true };
    } catch { return null; }
  }
  return null;
}
