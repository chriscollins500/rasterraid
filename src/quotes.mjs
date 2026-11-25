import { readAiService } from './ai-services.mjs';
import { SITE_ORIGINS } from './catalog.mjs';
import { RESEARCH_MODEL } from './research.mjs';
import { appWorkflowRequest } from './workflow-client.mjs';

export { QUOTE_SCOPE } from './workflow-client.mjs';

export const APP_ESTIMATE_BATCH_MAX = 16;
export const LIVE_QUOTE_MAX_AGE_MS = 2 * 60_000;

export function appEstimateBody(plan) {
  const { tier, steps } = plan.body;
  if (tier !== 'paid' || !Array.isArray(steps) || steps.length === 0 || steps.length > 8) {
    throw new TypeError('Expected a bounded paid research plan for App estimation.');
  }
  return { kind: 'workflow', steps };
}

export function estimateAppWorkflow(origin, token, body, fetcher = fetch, signal) {
  return appWorkflowRequest(origin, token, 'estimate', { body }, { fetcher, signal });
}

const wholeBuzz = value => Number.isSafeInteger(value) && value >= 0;

export function quotePrice(snapshot) {
  const cost = snapshot?.cost;
  if (!snapshot?.status || snapshot.status === 'failed' || !wholeBuzz(cost?.total)) return null;
  return {
    total: cost.total,
    authorFee: wholeBuzz(cost.authorFee) && cost.authorFee <= cost.total ? cost.authorFee : null,
  };
}

export function batchQuotePrices(reply, count) {
  if (reply?.error === 'unsupported on this host') return null;
  if (!reply || Object.hasOwn(reply, 'error')) throw new Error('Civitai could not price these options together.');
  const { snapshots, aggregate } = reply;
  if (!Array.isArray(snapshots) || snapshots.length !== count || !Array.from(snapshots).every(snapshot =>
    typeof snapshot?.workflowId === 'string' && snapshot.workflowId.length > 0 && typeof snapshot.status === 'string' && snapshot.status.length > 0)) {
    throw new TypeError('The Civitai quote reply did not match the selected options.');
  }
  const prices = snapshots.map(quotePrice);
  const priced = prices.filter(Boolean);
  const total = priced.reduce((sum, price) => sum + price.total, 0);
  if (aggregate?.cellCount !== count || aggregate.pricedCells !== priced.length || !wholeBuzz(aggregate.total) || aggregate.total !== total) {
    throw new TypeError('The Civitai quote reply did not match the selected options.');
  }
  return prices;
}

export function expandedQuoteOptions(plans, prices) {
  const steps = plans.map(plan => plan.body.steps.map(step => JSON.stringify(step)));
  return plans.map((plan, index) => {
    const total = prices[index]?.total;
    if (!wholeBuzz(total)) return null;
    let best = null;
    for (const [otherIndex, broader] of plans.entries()) {
      const otherTotal = prices[otherIndex]?.total;
      if (!wholeBuzz(otherTotal) || steps[otherIndex].length <= steps[index].length) continue;
      if (best && otherTotal - total >= best.difference) continue;
      const added = broader.additionalPreviews;
      const previews = added?.baseId === plan.id ? added.count : 0;
      if (!previews) {
        let matched = 0;
        for (const step of steps[otherIndex]) {
          if (step === steps[index][matched]) matched++;
        }
        if (matched !== steps[index].length) continue;
      }
      best = { title: broader.title, previews, difference: otherTotal - total };
    }
    return best;
  });
}

const stepServices = new Map([
  ['chatCompletion', ['chat/' + RESEARCH_MODEL, 'Catalog analysis']],
  ['audioCaptioning', ['audio/audioCaptioning', 'Music description']],
  ['audioClassification', ['audio/audioClassification', 'Sound classification']],
  ['composeMedia', ['utility/composeMedia', 'Audio preparation']],
  ['mediaCaptioning', ['text/mediaCaptioning', 'Picture description']],
  ['multimodalEmbedding', ['text/multimodalEmbedding', 'Similarity ranking']],
  ['transcription', ['audio/transcription', 'Transcription']],
  ['videoFrameExtraction', ['video/videoFrameExtraction', 'Video frame extraction']],
]);

export async function quoteServiceAdvisories(plans, options) {
  const byPlan = plans.map(plan => new Set(plan.body.steps.flatMap(step => {
    if (step.$type === 'chatCompletion' && step.input?.model !== RESEARCH_MODEL) return [];
    const service = stepServices.get(step.$type);
    return service ? [service] : [];
  })));
  const services = new Set(byPlan.flatMap(steps => [...steps]));
  const checks = await Promise.all([...services].map(async service => {
    const [id, label] = service;
    const { item } = await readAiService(id, options);
    return [service, item?.status === 'degraded' || item?.status === 'unavailable' ? label + ' (' + item.status + ')' : null];
  }));
  const affected = new Map(checks);
  return byPlan.map(steps => [...steps].map(service => affected.get(service)).filter(Boolean));
}

export const PREVIEW_QUOTE_MAX_AGE_MS = 60 * 60 * 1000;

export async function matchPreviewQuotes(receipt, origin, plans, { now = Date.now(), digest = globalThis.crypto?.subtle } = {}) {
  const capturedAt = Date.parse(receipt?.capturedAt);
  if (!digest || !SITE_ORIGINS.includes(origin) || receipt?.origin !== origin || !Number.isFinite(capturedAt) ||
      capturedAt > now + 60_000 || now - capturedAt > PREVIEW_QUOTE_MAX_AGE_MS || !Array.isArray(receipt?.quotes)) return null;
  const matches = await Promise.all(plans.map(async plan => {
    const body = new TextEncoder().encode(JSON.stringify(appEstimateBody(plan)));
    const bytes = new Uint8Array(await digest.digest('SHA-256', body));
    const key = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const row = receipt.quotes.find(item => item?.id === plan.id && item.bodySha256 === key);
    return quotePrice(row && { status: 'pending', cost: row });
  }));
  if (!matches.length || matches.some(price => !price)) return null;
  return { capturedAt, prices: matches };
}
