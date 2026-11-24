import { text } from './catalog.mjs';
import { discoverDirectory } from './directory.mjs';
import { foldSearchText } from './query-language.mjs';

const auctionGuide = 12904;
const prizeAnnouncement = 39072;
const prizeWords = /\b(?:prizes?|contest|winners?|challenge|crucibles?|bount(?:y|ies)|rewards?)\b/iu;
const auctionWords = /\b(?:auctions?|checkpoints?|coverage)\b/iu;

export function opportunityReference(url) {
  const auction = /^\/auctions(?:\/([a-z\d][a-z\d-]{0,100}))?\/?$/u.exec(url.pathname);
  if (auction && auction[1] !== 'my-bids') return { kind: 'auction', slug: auction[1] };
  const prize = /^\/prizes(?:\/([1-9]\d{0,9}))?\/?$/u.exec(url.pathname);
  if (prize && (!prize[1] || Number(prize[1]) <= 2_147_483_647)) return { kind: 'prize', id: prize[1] ? Number(prize[1]) : null };
  return null;
}

export async function discoverOpportunities(context, target, scope, options = {}) {
  const { origin } = context;
  const auctions = scope === 'auctions';
  const direct = target.kind === (auctions ? 'auction' : 'prize');
  const query = text(target.value, 100);
  const wanted = foldSearchText(query);
  const featured = !query || /\b(?:featured|checkpoints?)\b/iu.test(query);
  const path = auctions ? '/auctions' + (target.slug ? '/' + target.slug : '')
    : '/prizes' + (target.id ? '/' + target.id : '');
  const result = { scope, target, related: { [scope]: [] }, reference: null, candidates: [], shortlisted: [], guides: [],
    flows: [], alternateQueries: [], baseline: [], combined: [], nativeLink: new URL(path, origin).href };
  if (direct && (target.slug || target.id)) return result;
  if (auctions && featured) {
    result.nativeActions = [{ label: 'Featured Checkpoints', link: new URL('/auctions/featured-checkpoints', origin).href }];
  }
  if (!auctions) {
    result.nativeActions = [{ label: 'Challenge winners', link: new URL('/challenges/winners', origin).href }];
  }
  const seed = auctions ? auctionGuide : prizeAnnouncement;
  const includeSeed = auctions ? featured || auctionWords.test(query) : !query || /\b(?:wan|runware|crucibles?)\b/u.test(wanted);
  const search = discoverDirectory(context, { kind: 'text', value: query || (auctions ? 'auction' : 'prizes') }, 'articles',
    { articleOfficial: auctions ? 'true' : '' }, options);
  const starter = includeSeed ? discoverDirectory(context, { kind: 'article', id: seed }, 'articles', {}, options) : null;
  const [matches, introduction] = await Promise.all([search, starter]);
  const cards = new Map();
  for (const card of [...(introduction?.related.articles ?? []), ...matches.related.articles]) {
    if (cards.has(card.id) || (auctions ? !auctionWords.test(card.title) : !prizeWords.test(card.title))) continue;
    cards.set(card.id, { ...card, summary: '', category: auctions ? 'Auction article' : 'Prize announcement' });
  }
  result.related[scope] = [...cards.values()].slice(0, 8);
  result.flows = [...matches.flows, ...(introduction?.flows ?? [])];
  return result;
}
