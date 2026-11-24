import { randomUUID } from 'node:crypto';
import { SITE_ORIGINS, numericId, text } from '../src/catalog.mjs';
import { MOCK_API } from './client.mjs';

const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/u;
const quoteLifetime = 120_000;
const recordLifetime = 30 * 60_000;
const cost = Object.freeze({ total: 6, authorFee: 1, buzzCharged: 0 });

function draftFrom(input) {
  if (!SITE_ORIGINS.includes(input?.origin) || !text(input.baseModel, 80) ||
      !Array.isArray(input.picks) || !input.picks.length || input.picks.length > 3) return null;
  const picks = input.picks.map(pick => ({
    id: numericId(pick?.id), modelId: numericId(pick?.modelId),
    title: text(pick?.title), baseModel: text(pick?.baseModel, 80),
  }));
  if (picks.some(pick => !pick.id || !pick.modelId || !pick.title) ||
      new Set(picks.map(pick => pick.id)).size !== picks.length) return null;
  return { origin: input.origin, baseModel: text(input.baseModel, 80), picks };
}

function compare(draft) {
  const order = { compatible: 0, other: 1, unknown: 2 };
  return draft.picks.map(pick => {
    const fit = !pick.baseModel ? 'unknown' : pick.baseModel === draft.baseModel ? 'compatible' : 'other';
    const link = new URL('/models/' + pick.modelId, draft.origin);
    link.searchParams.set('modelVersionId', pick.id);
    return { ...pick, fit, source: link.href };
  }).sort((a, b) => order[a.fit] - order[b.fit]);
}

export function createMockBackend({ now = Date.now } = {}) {
  const quotes = new Map();
  const jobs = new Map();
  const send = (status, body) => ({ status, body: { simulated: true, ...body } });
  const error = (status, message) => send(status, { error: message });

  function snapshot(job, time) {
    const elapsed = time - job.startedAt;
    const common = { id: job.id, ...cost, baseModel: job.draft.baseModel };
    if (job.cancelled) return { ...common, status: 'cancelled' };
    if (elapsed < 650) return { ...common, status: 'queued', step: 0 };
    if (elapsed < 2_600) return { ...common, status: 'running', step: elapsed < 1_550 ? 1 : 2 };
    return { ...common, status: 'succeeded', results: compare(job.draft) };
  }

  return function handle(method, path, input) {
    const time = now();
    for (const [id, quote] of quotes) if (time >= quote.expiresAt) quotes.delete(id);
    for (const [id, job] of jobs) if (time - job.startedAt >= recordLifetime) jobs.delete(id);

    if (path === MOCK_API + '/estimate') {
      if (method !== 'POST') return error(405, 'Use POST to estimate a mock run.');
      const draft = draftFrom(input);
      if (!draft) return error(400, 'Choose a base model and up to three distinct model versions.');
      if (quotes.size >= 128) return error(503, 'The local preview has too many open quotes. Try again shortly.');
      const id = randomUUID();
      const expiresAt = time + quoteLifetime;
      quotes.set(id, { draft, expiresAt });
      return send(200, { id, expiresAt, ...cost });
    }

    const prefix = MOCK_API + '/jobs/';
    const id = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (!uuid.test(id)) return error(404, 'Mock run not found.');
    const existing = jobs.get(id);
    if (method === 'PUT') {
      if (existing) {
        return existing.quoteId === input?.quoteId
          ? send(200, snapshot(existing, time))
          : error(409, 'That run ID already belongs to another quote.');
      }
      const quote = quotes.get(input?.quoteId);
      if (!quote) return error(410, 'This mock quote expired. Get a new quote.');
      if (quote.jobId) return error(409, 'That quote already started a run.');
      if (jobs.size >= 128) return error(503, 'The local preview has too many runs. Try again shortly.');
      const job = { id, quoteId: input.quoteId, draft: quote.draft, startedAt: time };
      jobs.set(id, job);
      quote.jobId = job.id;
      return send(201, snapshot(job, time));
    }
    if (!existing) return error(404, 'Mock run not found.');
    if (method === 'GET') return send(200, snapshot(existing, time));
    if (method === 'DELETE') {
      if (snapshot(existing, time).status !== 'succeeded') existing.cancelled = true;
      return send(200, snapshot(existing, time));
    }
    return error(405, 'Unsupported mock action.');
  };
}
