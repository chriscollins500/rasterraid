import { SITE_ORIGINS } from './catalog.mjs';

export const QUOTE_SCOPE = 'ai:write:budgeted';
export const WORKFLOW_REQUEST_TIMEOUT_MS = 25_000;

const operationKey = /^[a-z\d_-]{1,64}$/iu;
const workflowKey = /^[a-z\d_-]{1,64}$/iu;
export const isWorkflowId = value => typeof value === 'string' && workflowKey.test(value) && !['failed', 'whatif'].includes(value);

export function workflowIdBelongsToViewer(workflowId, viewerUserId) {
  if (!Number.isSafeInteger(viewerUserId) || viewerUserId < 1 || !isWorkflowId(workflowId)) return false;
  const prefix = viewerUserId + '-';
  return workflowId.startsWith(prefix) && workflowId.length > prefix.length;
}

const historyStates = new Set(['pending', 'processing', 'succeeded', 'failed', 'expired', 'canceled']);
const historyCursor = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

function historyRequest({ cursor, limit = 24 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || cursor != null && !historyCursor(cursor)) {
    throw new TypeError('Choose a valid page of Civitai run history.');
  }
  return { limit, ...(cursor && { cursor }) };
}

function historyPage(payload) {
  if (!Array.isArray(payload?.workflows) || payload.workflows.length > 50 ||
      payload.cursor != null && !historyCursor(payload.cursor)) return null;
  const workflows = [];
  for (const row of payload.workflows) {
    const createdAt = typeof row?.createdAt === 'string' ? Date.parse(row.createdAt) : NaN;
    if (!isWorkflowId(row?.workflowId) || !historyStates.has(row.status) || !Number.isFinite(createdAt)) continue;
    workflows.push({ workflowId: row.workflowId, status: row.status, createdAt,
      cost: Number.isSafeInteger(row.cost) && row.cost >= 0 ? row.cost : null });
  }
  return { workflows, cursor: payload.cursor ?? null };
}

export async function appWorkflowRequest(origin, token, operation, request, { fetcher = fetch, signal } = {}) {
  if (!SITE_ORIGINS.includes(origin) || !token || !['estimate', 'submit', 'poll', 'cancel', 'query'].includes(operation)) {
    throw new TypeError('Expected a Civitai App credential, origin and workflow operation.');
  }
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(operation === 'poll' ? 22_000 : WORKFLOW_REQUEST_TIMEOUT_MS);
  const response = await fetcher(new URL('/api/v1/blocks/workflows/' + operation, origin), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(request),
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const after = response.headers.get('retry-after');
  const seconds = Number(after);
  const retryAfter = Number.isFinite(seconds) && seconds > 0 ? seconds : Math.ceil((Date.parse(after) - Date.now()) / 1000);
  const payload = await response.json().catch(() => null);
  const result = operation === 'query' ? historyPage(payload) : typeof payload?.snapshot?.status === 'string' ? payload.snapshot : null;
  if (!response.ok || !result) {
    const error = new Error('Civitai App ' + operation + ' returned HTTP ' + response.status + '.');
    error.status = response.status;
    error.code = typeof payload?.code === 'string' && /^[\w-]{1,100}$/u.test(payload.code) ? payload.code : null;
    error.retryAfter = retryAfter > 0 ? retryAfter : null;
    throw error;
  }
  if (operation === 'submit' && payload.submissionUnconfirmed === true) return { ...result, submissionUnconfirmed: true };
  return result.throttled && retryAfter > 0 ? { ...result, retryAfter } : result;
}

function matchingViewer(binding, context) {
  return context?.hosted && context.signedIn && context.token && context.viewerUserId === binding.viewerUserId &&
    context.origin === binding.origin && context.scopes.includes(QUOTE_SCOPE);
}

export function appHistoryTransport(binding, getContext, { fetcher = fetch } = {}) {
  const { origin, viewerUserId, browsingLevel } = binding;
  if (!SITE_ORIGINS.includes(origin) || !Number.isSafeInteger(viewerUserId) || viewerUserId < 1) {
    throw new TypeError('A signed-in Civitai viewer is required.');
  }
  function allowedContext() {
    const current = getContext();
    if (!matchingViewer(binding, current) || current.browsingLevel !== browsingLevel) {
      throw new Error('Civitai access changed. Reopen the history to continue.');
    }
    return current;
  }
  async function read(operation, body, signal) {
    const current = allowedContext();
    const reply = await appWorkflowRequest(origin, current.token, operation, body, { fetcher, signal });
    signal?.throwIfAborted();
    allowedContext();
    return reply;
  }
  return {
    list(page, signal) {
      return read('query', historyRequest(page), signal);
    },
    poll(workflowId, signal) {
      if (!isWorkflowId(workflowId)) throw new TypeError('A workflow ID is required.');
      return read('poll', { workflowId }, signal);
    },
  };
}

export function appRunTransport(binding, getContext, { fetcher = fetch } = {}) {
  const { origin, viewerUserId, browsingLevel } = binding;
  if (!SITE_ORIGINS.includes(origin) || !Number.isSafeInteger(viewerUserId) || viewerUserId <= 0) {
    throw new TypeError('A signed-in Civitai viewer is required.');
  }

  function allowedContext() {
    const context = getContext();
    if (!matchingViewer(binding, context) || context.storageMode === 'local-preview' ||
        browsingLevel !== undefined && context.browsingLevel !== browsingLevel) {
      throw new Error('Open RasterRaid in your original Civitai account to manage this run.');
    }
    return context;
  }

  function request(operation, body, signal) {
    const context = allowedContext();
    return appWorkflowRequest(origin, context.token, operation, body, { signal, fetcher }).then(reply => {
      signal?.throwIfAborted();
      allowedContext();
      return reply;
    });
  }

  return {
    estimate(body, signal) {
      return request('estimate', { body }, signal);
    },
    submit(body, idempotencyKey, signal) {
      if (typeof idempotencyKey !== 'string' || !operationKey.test(idempotencyKey)) {
        throw new TypeError('A stable research operation key is required.');
      }
      return request('submit', { body, idempotencyKey }, signal);
    },
    list(page, signal) {
      return request('query', historyRequest(page), signal);
    },
    inspect(workflowId, signal) {
      if (!isWorkflowId(workflowId)) throw new TypeError('A workflow ID is required.');
      return request('poll', { workflowId }, signal);
    },
    poll(workflowId, signal) {
      if (!isWorkflowId(workflowId)) throw new TypeError('A workflow ID is required.');
      return request('poll', { workflowId, waitSeconds: 10 }, signal);
    },
    cancel(workflowId, signal) {
      if (!isWorkflowId(workflowId)) throw new TypeError('A workflow ID is required.');
      return request('cancel', { workflowId }, signal);
    },
  };
}
