import { catalogImagePreview, numericId, SITE_ORIGINS, text, visibleRating } from './catalog.mjs';

const entities = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
export const plainArticleText = (value, max = 180) => text(
  text(value, 80_000).replace(/<[^>]*>/gu, ' ')
    .replace(/&(amp|apos|gt|lt|nbsp|quot|#39);/gu, (_match, name) => entities[name] ?? "'")
    .replace(/\s+/gu, ' '),
  max,
);

export const publicArticle = (article, ceiling) => numericId(article?.id) && article.status === 'Published' &&
  article.availability === 'Public' && !article.unlisted && visibleRating(article.nsfwLevel, ceiling);

export const articleCover = (article, ceiling) => article.coverImageWithheld ? null
  : catalogImagePreview(article.coverImage, ceiling);

export function* articleAnchors(content) {
  for (const [, href, inner] of text(content, 80_000).matchAll(/<a(?=\s)[^>]*?\shref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)) {
    yield { href: href.replace(/&amp;/gu, '&'), label: plainArticleText(inner, 130) };
  }
}

function citationTarget(url, origin) {
  const item = /^\/(models|posts|images|articles|collections)\/([1-9]\d{0,14})(?:\/[^/]{1,170})?\/?$/u.exec(url.pathname);
  if (item) {
    const [, kind, rawId] = item;
    const id = Number(rawId);
    if (['articles', 'posts'].includes(kind) && id > 2_147_483_647) return null;
    const source = new URL('/' + kind + '/' + id, origin);
    let versionId;
    if (kind === 'models' && url.searchParams.has('modelVersionId')) {
      const values = url.searchParams.getAll('modelVersionId');
      if (values.length !== 1 || !/^[1-9]\d{0,14}$/u.test(values[0])) return null;
      versionId = Number(values[0]);
      source.searchParams.set('modelVersionId', String(versionId));
    }
    return { scope: kind === 'images' ? 'gallery' : kind, id, versionId, link: source.href };
  }
  const tool = /^\/tools\/([a-z\d][a-z\d-]{0,149})\/?$/u.exec(url.pathname);
  if (tool) return { scope: 'tools', link: new URL('/tools/' + tool[1], origin).href };
  const app = /^\/apps\/(?:run|store-preview)\/([a-z\d][a-z\d-]{0,63})\/?$/u.exec(url.pathname);
  if (app) return { scope: 'apps', link: new URL('/apps/store-preview/' + app[1], origin).href };
  const user = /^\/user\/([^/]{1,240})\/?$/u.exec(url.pathname);
  const handle = user ? decodeURIComponent(user[1]) : '';
  if (/^[\p{L}\p{N}_-]{1,80}$/u.test(handle) && !/^(?:vault|downloads|notifications|settings)$/iu.test(handle) && !url.search && !url.hash) {
    return { scope: 'users', handle, link: new URL('/user/' + encodeURIComponent(handle), origin).href };
  }
  return null;
}

export function articleCitations(content, origin) {
  if (!SITE_ORIGINS.includes(origin)) return [];
  const citations = new Map();
  for (const { href } of articleAnchors(content)) {
    if (href.length > 550 || (!href.startsWith('https://') && !/^\/(?!\/)/u.test(href))) continue;
    try {
      const url = new URL(href, origin);
      if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password) continue;
      const target = citationTarget(url, origin);
      if (target && !citations.has(target.link)) citations.set(target.link, target);
      if (citations.size === 16) break;
    } catch {
      // A malformed or unsupported link carries no verifiable catalog identity.
    }
  }
  return [...citations.values()];
}
