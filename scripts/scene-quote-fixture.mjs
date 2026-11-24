import { clipAnalysisUrl } from '../src/catalog.mjs';
import { sceneResearch } from '../src/scene-research.mjs';

export const sceneQuoteBrief = { scope: 'report', reportType: 'media', query: 'citypop' };

export async function sceneQuoteFixture(context, discoverReport) {
  const { origin } = context;
  const { report } = await discoverReport(context, sceneQuoteBrief);
  const evidence = new Map(report.evidence.map(item => [item.link, item]));
  const selection = [80284056, 80205619].map((id, index) => {
    const link = origin + '/images/' + id;
    const timestamp = 71 + index;
    return { link, stream: clipAnalysisUrl(evidence.get(link)?.stream), timestamp, start: timestamp - 4, duration: 8 };
  });
  const plan = sceneResearch(report, origin, selection);
  if (plan?.picks.length !== 2) throw new Error('Both Citypop video samples must be eligible in the report.');
  return { report, selection: selection.map(({ link, timestamp, start, duration }) => ({ link, timestamp, start, duration })), ...plan };
}
