import { text } from './catalog.mjs';
import { translateCatalogTerms } from './query-language.mjs';
import { filterMatches } from './text-assist.mjs';

// Board names and IDs verified against Civitai's native leaderboard pages.
// Civitai supplies the full directory and current standings on those pages.
const boards = [
  ['overall', 'Creators', 'Model creators', 'Overall rankings for people who publish models.'],
  ['challenge', 'Daily Challenges', 'Competitions', 'Rankings by Daily Challenge points.'],
  ['crucible-judges', 'Crucible Judges', 'Competitions', 'People who judge head-to-head contests.', 'judging'],
  ['crucible-competitors', 'Crucible Competitors', 'Competitions', 'People who place in head-to-head contests.', 'winners, entrants'],
  ['crucible-hosts', 'Crucible Hosts', 'Competitions', 'People who run head-to-head contests.', 'organizers'],
  ['writer', 'Writers', 'Articles', 'Rankings for Civitai article writers.', 'authors, writing'],
  ['videos-overall', 'Master Generators (Video)', 'Videos', 'People whose eligible videos are most popular.', 'video creators, video generation'],
  ['flux', 'Creators (Flux)', 'Model creators', 'Rankings for Flux model creators.'],
  ['zimage', 'Creators (Z-Image)', 'Model creators', 'Rankings for Z-Image model creators.', 'zimage turbo'],
  ['sdxl', 'Creators (SDXL)', 'Model creators', 'Rankings for SDXL model creators.'],
  ['pony', 'Creators (Pony)', 'Model creators', 'Rankings for Pony model creators.'],
  ['krea2', 'Creators (Krea 2)', 'Model creators', 'Rankings for Krea 2 model creators.'],
];
const redBoards = [
  ['overall_nsfw', 'Creators (mature)', 'Model creators', 'Civitai’s mature model creator board.', 'mature models, nsfw models'],
  ['images-nsfw', 'Master Generators (mature)', 'Images', 'Civitai’s mature image creator board.', 'mature images, nsfw images'],
];
const boardRows = origin => {
  const choices = origin === 'https://civitai.red' ? [...boards, ...redBoards] : boards;
  return choices.map(([value, label, category, description, aliases = '']) => {
    const family = /^Creators \((.+)\)$/u.exec(label)?.[1];
    return { value, label, category, description,
      aliases: [value, category, family && family + ' creators', ...aliases.split(', ')].filter(Boolean) };
  });
};

export const leaderboardNames = origin => boardRows(origin).map(row => row.label);

export function leaderboardReference(url) {
  const match = url.pathname.match(/^\/leaderboard(?:\/([a-z\d][a-z\d_-]{0,63}))?\/?$/u);
  if (!match) return null;
  const id = match[1] ?? 'overall';
  const legacy = url.searchParams.get('board') === 'legend';
  const position = url.hash.slice(1) || url.searchParams.get('position') || '';
  const rank = !legacy && /^[1-9]\d{0,3}$/u.test(position) && Number(position) <= 1000 ? Number(position) : null;
  const value = url.searchParams.get('date') ?? '';
  const time = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? Date.parse(value) : NaN;
  const date = Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : '';
  return { kind: 'leaderboard', id, legacy, rank, date };
}

export function leaderboardLink(origin, { id = 'overall', legacy, date, rank } = {}) {
  const url = new URL('/leaderboard/' + id, origin);
  if (legacy) url.searchParams.set('board', 'legend');
  if (date) url.searchParams.set('date', date);
  if (rank) url.hash = String(rank);
  return url.href;
}

const boardQuery = value => text(value, 140).replace(/\b(?:civitai|(?:leader)?boards?|rankings?|top)\b/giu, ' ').replace(/\s+/gu, ' ').trim();
export const leaderboardMatches = (origin, value) => filterMatches(boardQuery(value), boardRows(origin));

export function discoverLeaderboards({ origin }, target) {
  const exact = target.kind === 'leaderboard';
  const input = boardQuery(target.value);
  const localized = translateCatalogTerms(input)?.focus;
  const matches = exact ? [] : leaderboardMatches(origin, input);
  const related = matches.length || !localized ? matches : leaderboardMatches(origin, localized);
  const leaderboards = related.map(({ value, label, category, description }) => ({
    id: value, title: label, category, description,
    link: leaderboardLink(origin, { id: value }),
    legacyLink: leaderboardLink(origin, { id: value, legacy: true }),
  }));
  return {
    target, scope: 'leaderboards', related: { leaderboards },
    nativeLink: leaderboardLink(origin, exact ? target : {}),
    reference: null, candidates: [], shortlisted: [], guides: [], flows: [], alternateQueries: [], baseline: [], combined: [],
  };
}
