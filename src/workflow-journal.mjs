import { SITE_ORIGINS } from './catalog.mjs';
import { reportedReceipt, runFinished, workflowRecord } from './workflow-session.mjs';

const historyPrefix = 'research-history-';
const historyKey = /^research-history-[a-z\d_-]{1,64}$/iu;
const pageSize = 24;
const optionalStorageCursor = value => value == null || typeof value === 'string' && value.length > 0 && value.length <= 512;

function privateStorage({ origin, viewerUserId }, getContext, fetcher) {
  if (!SITE_ORIGINS.includes(origin) || !Number.isSafeInteger(viewerUserId) || viewerUserId <= 0) {
    throw new TypeError('A Civitai viewer is required.');
  }
  function allowedContext() {
    const current = getContext();
    if (current?.origin !== origin || current.viewerUserId !== viewerUserId || !current.signedIn || !current.token ||
        current.storageMode === 'local-preview' || !current.scopes.includes('apps:storage')) {
      throw new Error('Open the original Civitai account to use this workspace.');
    }
    return current;
  }
  return async (url, { body, signal } = {}) => {
    const current = allowedContext();
    const timeout = AbortSignal.timeout(7_000);
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + current.token };
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetcher(url, {
      method: body ? 'PUT' : 'GET', headers, body, credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const data = await response.json().catch(() => null);
    signal?.throwIfAborted();
    allowedContext();
    return { response, data };
  };
}

function storageError(response, data, fallback) {
  let message = fallback;
  let code;
  if (response.status === 413) {
    code = data?.code === 'too_large' || data?.code === 'quota_exceeded' ? data.code : undefined;
    message = code === 'too_large' ? 'This record exceeds Civitai’s per-item size limit.' :
      code === 'quota_exceeded' ? 'RasterRaid reached Civitai’s total storage limit. Check Private storage in Workspace Settings.' :
        'Civitai rejected the size of this save.';
  }
  if (response.status === 403 && data?.code === 'not_eligible' && data.details?.reason === 'app_not_approved') {
    message = 'Private storage becomes available after Civitai approves RasterRaid.';
  }
  if (response.status === 429) message = 'Civitai is limiting storage requests. Try again shortly.';
  const error = new Error(message);
  error.status = response.status;
  if (code) error.code = code;
  return error;
}

export async function readPrivateStorageUsage(binding, getContext, { fetcher = fetch, signal } = {}) {
  const call = privateStorage(binding, getContext, fetcher);
  const url = new URL('/api/v1/blocks/storage', binding.origin);
  const { response, data } = await call(url, { signal });
  const bytes = data?.usage?.viewer?.bytes;
  const docs = data?.usage?.viewer?.docs;
  const { viewerBytes: maxBytes, viewerDocs: maxDocs, docBytes: maxDocBytes } = data?.limits ?? {};
  if (!response.ok || data?.collections?.prefs?.visibility !== 'private' ||
      ![bytes, docs].every(value => Number.isSafeInteger(value) && value >= 0) ||
      ![maxBytes, maxDocs, maxDocBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw storageError(response, data, 'Civitai could not read private storage usage.');
  }
  return { bytes, docs, maxBytes, maxDocs, maxDocBytes };
}

export function appPrivateRecord(binding, getContext, key, { fetcher = fetch } = {}) {
  if (!['research-run', 'search-workspace', 'model-preferences'].includes(key) && !historyKey.test(key)) {
    throw new TypeError('Unknown private document.');
  }
  const call = privateStorage(binding, getContext, fetcher);
  const url = new URL('/api/v1/blocks/storage/prefs/' + key, binding.origin);
  let version;
  async function request(next, ifVersion, signal) {
    const body = next ? JSON.stringify({ data: next, ifVersion }) : undefined;
    const { response, data } = await call(url, { body, signal });
    if (!next && response.status === 404 && data?.code === 'not_found') {
      return { version: 0, data: null };
    }
    if (!response.ok || !Number.isSafeInteger(data?.version) || data.version < 1 || !data.data || typeof data.data !== 'object') {
      throw storageError(response, data, next ? 'Civitai could not update the private workspace.' : 'Civitai could not read the private workspace.');
    }
    const createdAt = typeof data.createdAt === 'string' && data.createdAt.length <= 64 ? data.createdAt : undefined;
    return { version: data.version, data: data.data, createdAt };
  }
  const readSnapshot = ({ signal } = {}) => request(undefined, undefined, signal);
  async function read(options) {
    const saved = await readSnapshot(options);
    version = saved.version;
    return saved.data;
  }
  return {
    read,
    async write(record, { signal } = {}) {
      signal?.throwIfAborted();
      if (version === undefined) await read({ signal });
      version = (await request(record, version, signal)).version;
    },
    readSnapshot,
    writeSnapshot(record, { ifVersion, signal }) {
      if (!Number.isSafeInteger(ifVersion) || ifVersion < 0) throw new TypeError('Read the workspace before saving.');
      return request(record, ifVersion, signal);
    },
  };
}

function archivedRecord(value, origin) {
  const run = workflowRecord(value, origin);
  return run && (run.workflowId || ['unconfirmed', 'refused'].includes(run.status)) ? run : null;
}

export function sameWorkflowOperation(first, second) {
  return Boolean(first && second && first.origin === second.origin && first.operationId === second.operationId &&
    first.bodyHash === second.bodyHash);
}

function sameRun(first, second) {
  return sameWorkflowOperation(first, second) && first.workflowId === second.workflowId;
}

function preservesReceipt(saved, incoming) {
  return sameRun(saved, incoming) && ['receipt', 'retryQuote', 'refusalPrice'].every(key =>
    !incoming[key] || saved[key]?.observedAt >= incoming[key].observedAt);
}

function keepCompletedRuns(origin, active, archive, listHistory) {
  let cached;

  async function read(options) {
    const raw = await active.read(options);
    cached = workflowRecord(raw, origin);
    if (raw != null && !cached) {
      cached = undefined;
      throw new Error('The saved Deep Search record could not be read.');
    }
    return cached;
  }

  async function preserve(run, signal) {
    const entry = archive(historyPrefix + run.operationId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await entry.read({ signal });
      const existing = archivedRecord(raw, origin);
      if (run.status === 'unconfirmed' && sameWorkflowOperation(existing, run) && existing.workflowId &&
          existing.recoveryStep === run.recoveryStep && run.recoveryStep) return;
      if (preservesReceipt(existing, run)) return;
      if (raw != null && !sameRun(existing, run)) throw new Error('A different research record already uses this history key.');
      try {
        await entry.write(run, { signal });
        return;
      } catch (error) {
        if (error.status !== 409 || attempt) throw error;
      }
    }
  }

  return {
    read,
    listHistory,
    async saveRecovered(run, reply, { signal } = {}) {
      if (run.status !== 'unconfirmed' || !run.recoveryStep) throw new Error('Choose an unresolved receipt from history.');
      const entry = archive(historyPrefix + run.operationId);
      for (let attempt = 0; attempt < 2; attempt++) {
        const saved = archivedRecord(await entry.read({ signal }), origin);
        signal?.throwIfAborted();
        if (!sameWorkflowOperation(saved, run) || saved.recoveryStep !== run.recoveryStep || saved.browsingLevel !== run.browsingLevel ||
            (saved.workflowId ? saved.workflowId !== reply.workflowId : saved.status !== 'unconfirmed')) {
          const error = new Error('The saved receipt changed. Reload Deep Search history to continue.');
          error.code = 'receipt-changed';
          throw error;
        }
        if (saved.workflowId) return saved;
        const receipt = reportedReceipt(reply, saved.receipt);
        const confirmed = archivedRecord({ ...saved, workflowId: reply.workflowId, status: reply.status, receipt }, origin);
        if (!confirmed?.workflowId) throw new Error('Civitai could not confirm the run’s status.');
        try {
          await entry.write(confirmed, { signal });
          return confirmed;
        } catch (error) {
          if (error.status !== 409 || attempt) throw error;
        }
      }
    },
    async write(next, { signal } = {}) {
      const record = workflowRecord(next, origin);
      if (!record) throw new Error('The Deep Search record is invalid.');
      signal?.throwIfAborted();
      if (cached === undefined) await read({ signal });
      if (cached?.operationId === record.operationId && (cached.bodyHash !== record.bodyHash ||
          cached.workflowId && cached.workflowId !== record.workflowId || runFinished(cached.status) && !runFinished(record.status))) {
        throw new Error('The saved Deep Search identity or status could not be confirmed.');
      }
      if (cached && cached.operationId !== record.operationId) {
        if (!runFinished(cached.status)) {
          const error = new Error('Resolve the current run before starting another.');
          error.code = 'receipt-conflict';
          throw error;
        }
        for (const prior of [cached.previous, cached]) {
          if (archivedRecord(prior, origin)) await preserve(prior, signal);
        }
      }
      await active.write(next.status === 'submitting' ? { ...record, status: 'submitting' } : record, { signal });
      cached = record;
    },
  };
}

export function localWorkflowJournal(window, origin) {
  const prefix = 'rasterraid:workflow-history:v1:' + origin + ':';
  const store = window.sessionStorage;
  const record = key => ({
    async read() { return JSON.parse(store.getItem(key) ?? 'null'); },
    async write(value) { store.setItem(key, JSON.stringify(value)); },
  });
  return keepCompletedRuns(origin, record('rasterraid:workflow-run:v1:' + origin), key => record(prefix + key),
    async ({ cursor } = {}) => {
      const offset = Number(cursor ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Choose a valid page of saved runs.');
      const entries = [];
      for (let index = 0; index < store.length; index++) {
        const key = store.key(index);
        if (!key?.startsWith(prefix) || !historyKey.test(key.slice(prefix.length))) continue;
        try {
          const saved = archivedRecord(await record(key).read(), origin);
          if (saved) entries.push(saved);
        } catch { /* A corrupt item does not hide other receipts. */ }
      }
      entries.sort((a, b) => b.createdAt - a.createdAt);
      const next = offset + pageSize;
      return { entries: entries.slice(offset, next), cursor: next < entries.length ? String(next) : null };
    });
}

export function tabPrivateRecord(window, key, memory) {
  return {
    read() {
      try { return JSON.parse(window.sessionStorage.getItem(key)) ?? memory.get(key); }
      catch { return memory.get(key); }
    },
    write(value) {
      memory.set(key, value);
      try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The hosted frame may have an opaque origin. */ }
    },
  };
}

export function appWorkflowJournal(binding, getContext, { fetcher = fetch } = {}) {
  function getBoundContext() {
    const current = getContext();
    if (binding.browsingLevel !== undefined && current?.browsingLevel !== binding.browsingLevel) {
      throw new Error('Civitai browsing access changed. Reopen Deep Search to continue.');
    }
    return current;
  }
  const record = key => appPrivateRecord(binding, getBoundContext, key, { fetcher });
  const call = privateStorage(binding, getBoundContext, fetcher);
  return keepCompletedRuns(binding.origin, record('research-run'), record, async ({ cursor, signal } = {}) => {
    if (!optionalStorageCursor(cursor)) throw new TypeError('Choose a valid page of saved runs.');
    const url = new URL('/api/v1/blocks/storage/prefs', binding.origin);
    url.searchParams.set('keyPrefix', historyPrefix);
    url.searchParams.set('sort', '-createdAt');
    url.searchParams.set('limit', String(pageSize));
    if (cursor) url.searchParams.set('cursor', cursor);
    const { response, data } = await call(url, { signal });
    if (!response.ok || !Array.isArray(data?.items) || data.items.length > pageSize || !optionalStorageCursor(data.nextCursor)) {
      throw storageError(response, data, 'Civitai could not read the saved Deep Search records.');
    }
    const entries = data.items.flatMap(item => {
      const run = archivedRecord(item?.data, binding.origin);
      return run && item.key === historyPrefix + run.operationId ? [run] : [];
    });
    return { entries, cursor: data.nextCursor ?? null };
  });
}
