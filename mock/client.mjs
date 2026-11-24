export const MOCK_API = '/api/mock-deep-search';
export const MOCK_PAGE = '/mock-deep-search';

export function isLoopbackOrigin(origin) {
  const url = new URL(origin);
  return url.origin === origin && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
}

function localRequest(origin, fetcher) {
  if (!isLoopbackOrigin(origin)) throw new TypeError('The Deep Search mock runs on loopback.');

  return async function call(path, method, input, signal) {
    const url = new URL(MOCK_API + path, origin);
    const timeout = AbortSignal.timeout(5_000);
    const response = await fetcher(url, {
      method, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(input && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value || value.simulated !== true) {
      const error = new Error(value?.error || 'The local mock did not respond.');
      error.status = response.status;
      throw error;
    }
    return value;
  };
}

export function createMockClient(origin, fetcher = fetch) {
  const call = localRequest(origin, fetcher);
  const job = id => '/jobs/' + encodeURIComponent(id);
  return {
    estimate: draft => call('/estimate', 'POST', draft),
    confirm: (id, quoteId) => call(job(id), 'PUT', { quoteId }),
    read: id => call(job(id), 'GET'),
    cancel: id => call(job(id), 'DELETE'),
  };
}

export function createWorkflowSimulationClient(origin, fetcher = fetch) {
  const call = localRequest(origin, fetcher);
  async function workflow(operation, body, signal) {
    return (await call('/workflows/' + operation, 'POST', body, signal)).snapshot;
  }
  return {
    estimate: (body, signal) => workflow('estimate', { body }, signal),
    submit: (body, idempotencyKey, signal) => workflow('submit', { body, idempotencyKey }, signal),
    list: async (page, signal) => {
      const { workflows, cursor } = await call('/workflows/query', 'POST', page, signal);
      return { workflows, cursor };
    },
    inspect: (workflowId, signal) => workflow('poll', { workflowId }, signal),
    poll: (workflowId, signal) => workflow('poll', { workflowId }, signal),
    cancel: (workflowId, signal) => workflow('cancel', { workflowId }, signal),
  };
}
