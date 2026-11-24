import { soundCandidates, soundResearch } from '../src/sound-research.mjs';

export const soundQuoteBrief = { scope: 'audio', query: 'citypop' };

export async function soundQuoteFixture(context, discover, resultGroups) {
  const { origin } = context;
  const result = await discover(context, soundQuoteBrief);
  const available = soundCandidates(result, resultGroups(result), origin);
  const selection = [80284056, 80205619].map(id => ({ link: origin + '/images/' + id, seconds: 0 }));
  return { selection, ...soundResearch(available, selection, origin) };
}
