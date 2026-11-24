import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { publicMedia } from '../src/catalog-research.mjs';
import { isWorkflowId } from '../src/workflow-client.mjs';

const base = 'https://orchestration.civitai.com';
const tokenPattern = /^[A-Za-z0-9_.-]{12,4096}$/;
const freeOperation = /^rasterraid-free-[a-z\d-]{8,90}$/u;
const audioFile = /\.(?:mp3|mp4|m4a|aac|wav|ogg|opus|flac|webm)$/iu;

function locateFreeQuota(steps, quota) {
  if (quota?.enabled !== true || !Array.isArray(quota.models)) throw new Error('Civitai free inference is unavailable.');
  const counts = new Map();
  for (const { $type, input } of steps) {
    let model;
    if ($type === 'chatCompletion' && input?.model && !input.tools && !input.tool_choice) {
      model = quota.models.find(row => typeof row?.key === 'string' && row.key.endsWith('-chat') &&
        Array.isArray(row.airs) && row.airs.includes(input.model));
    } else if ($type === 'transcription' && publicMedia(input?.mediaUrl, audioFile)) {
      model = quota.models.find(row => row?.key === 'transcription' && Array.isArray(row.airs) && row.airs.length);
    }
    if (!model) throw new Error('A selected step is outside the verified free chat or public transcription paths.');
    const count = (counts.get(model)?.requested ?? 0) + 1;
    if (!Number.isSafeInteger(model.remaining) || model.remaining < count) {
      throw new Error('Civitai’s free inference quota is too low for these steps.');
    }
    counts.set(model, { key: model.key, remaining: model.remaining, requested: count });
  }
  return [...counts.values()];
}

export function isZeroBuzzWorkflow(snapshot) {
  const ledger = snapshot?.transactions;
  return snapshot?.tier === 'free' && snapshot.cost?.total === 0 &&
    (ledger == null || (Array.isArray(ledger.list) && ledger.list.length === 0 && ledger.insufficientBuzz !== true));
}

export async function getOrchestrationCredential({ useExistingCli = false, env = process.env } = {}) {
  const provided = env.CIVITAI_TOKEN || env.CIVITAI_API_KEY;
  if (provided && tokenPattern.test(provided)) return provided;
  if (!useExistingCli || process.platform !== 'win32') {
    throw new Error('Use a Civitai credential in the local environment or explicitly select the existing Windows CLI credential.');
  }

  // Only the documented CLI personal-key field is read. OAuth state and refresh
  // tokens remain with the official CLI. Nothing from this file is echoed.
  const path = join(homedir(), 'AppData', 'Roaming', 'civitai', 'config.yaml');
  let config;
  try {
    config = await readFile(path, 'utf8');
  } catch {
    throw new Error('The existing Civitai CLI configuration is unavailable.');
  }
  const entry = config.match(/^token:[ \t]*(?:"([\w.-]+)"|'([\w.-]+)'|([\w.-]+))[ \t]*\r?$/m);
  const token = entry?.[1] ?? entry?.[2] ?? entry?.[3];
  if (!token || !tokenPattern.test(token)) {
    throw new Error('The existing CLI configuration does not contain a supported personal API key.');
  }
  return token;
}

export function orchestrationClient(token, fetcher = fetch) {
  async function request(url, options = {}) {
    const { status, data } = await fetcher(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
        ...options.headers,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(25_000),
    }).then(async response => ({
      status: response.status,
      data: response.headers.get('content-type')?.includes('json') ? await response.json() : {},
    }));

    if (status >= 200 && status < 300) return data;
    const error = new Error('Civitai Orchestration returned HTTP ' + status + '.');
    error.status = status;
    // Log contract field paths and ordinary schema errors, never bodies or URLs.
    error.details = Object.entries(data.errors ?? {}).slice(0, 12).flatMap(([field, messages]) =>
      /^[\w.[\]$-]{1,180}$/.test(field) && Array.isArray(messages)
        ? [{ field, messages: messages.filter(entry => typeof entry === 'string' && !/https?:\/\/|bearer|token|authorization/i.test(entry)).slice(0, 2).map(entry => entry.slice(0, 220)) }]
        : []);
    return Promise.reject(error);
  }

  function workflowPost(body, whatif) {
    const url = new URL('/v2/consumer/workflows', base);
    url.searchParams.set('whatif', whatif ? 'true' : 'false');
    return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  const freeTier = () => request(new URL('/v2/consumer/free-tier', base));
  return Object.freeze({
    listServices({ category, query, limit = 20 } = {}) {
      const url = new URL('/v2/services', base);
      if (category) url.searchParams.set('category', category);
      if (query) url.searchParams.set('query', query);
      url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 50))));
      return request(url);
    },
    freeTier,
    service(id) {
      const route = '/v2/services/' + encodeURIComponent(id);
      return request(new URL(route, base));
    },
    estimate(body) {
      return workflowPost(body, true);
    },
    async prepareFree(steps, operationId) {
      if (!freeOperation.test(operationId) || !Array.isArray(steps) || !steps.length || steps.length > 2 ||
          !steps.every(row => row && typeof row === 'object')) {
        throw new TypeError('Choose one or two eligible free steps and a unique operation ID.');
      }
      const eligibleSteps = steps.map(({ $type, name, input }) => ({ $type, name, input: structuredClone(input) }));
      const quota = locateFreeQuota(eligibleSteps, await freeTier());
      const encoded = JSON.stringify({ tier: 'free', upgradeMode: 'manual', tags: [operationId], steps: eligibleSteps });
      const quote = await workflowPost(JSON.parse(encoded), true);
      if (quote?.status !== 'unassigned' || !isZeroBuzzWorkflow(quote)) {
        const stage = typeof quote?.status === 'string' && /^[a-z-]{1,30}$/u.test(quote.status) ? quote.status : 'missing';
        const tier = typeof quote?.tier === 'string' && /^[a-z-]{1,30}$/u.test(quote.tier) ? quote.tier : 'missing';
        const total = Number.isSafeInteger(quote?.cost?.total) && quote.cost.total >= 0 ? quote.cost.total : 'missing';
        throw new Error('Civitai must return an explicit 0 Buzz free-tier estimate. Received ' + stage + ', ' + tier + ', ' + total + ' Buzz.');
      }
      const capturedAt = Date.now();
      let submitted = false;
      return Object.freeze({
        encoded, quota, capturedAt,
        quote: { tier: quote.tier, total: quote.cost.total, status: quote.status },
        submit() {
          if (submitted || Date.now() - capturedAt > 120_000) throw new Error('A fresh free quote is required for one submission.');
          submitted = true;
          // A what-if request can reserve its external ID. Only the live call receives it.
          return workflowPost({ ...JSON.parse(encoded), externalId: operationId }, false);
        },
      });
    },
    getWorkflow(id) {
      if (!isWorkflowId(id)) throw new TypeError('Use a verified Civitai workflow ID.');
      const url = new URL('/v2/consumer/workflows/' + encodeURIComponent(id), base);
      url.searchParams.set('wait', '12');
      return request(url);
    },
    findFreeWorkflows(operationId) {
      if (!freeOperation.test(operationId)) throw new TypeError('Use a verified free-run operation ID.');
      const url = new URL('/v2/consumer/workflows', base);
      url.searchParams.set('tags', operationId);
      url.searchParams.set('take', '8');
      return request(url);
    },
  });
}
