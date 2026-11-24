import { catalogResearchItems } from '../src/catalog-research.mjs';

export const visualQuoteBrief = origin => ({ scope: 'report', reportType: 'trace', query: origin + '/images/135405057' });

export async function visualQuoteFixture(context, discoverReport, discover) {
  const { origin } = context;
  const brief = visualQuoteBrief(origin);
  const video = origin + '/images/91967639';
  const [trace, clips] = await Promise.all([
    discoverReport(context, brief),
    discover(context, { scope: 'videos', query: video }),
  ]);
  const media = catalogResearchItems(clips, clips.related, 'videos', origin);
  return {
    report: { ...trace.report, evidence: [...trace.report.evidence, ...media] },
    selection: [{ link: video, timestamp: .63 }, { link: brief.query }],
  };
}
