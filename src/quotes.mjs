import { SITE_ORIGINS } from './catalog.mjs';
import { appWorkflowRequest } from './workflow-client.mjs';

export { QUOTE_SCOPE } from './workflow-client.mjs';

export const APP_ESTIMATE_BATCH_MAX = 16;

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
