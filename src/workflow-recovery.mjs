import { isWorkflowId } from './workflow-client.mjs';

export const isRecoveryStep = value => typeof value === 'string' && /^rra_[a-f\d]{28}$/u.test(value);
export const workflowRecoveryConflict = 'workflow-recovery-conflict';
const historyPageSize = 24;
const historyPageLimit = 3;
const statusReadLimit = 8;
const clockAllowance = 5 * 60_000;
const initiationWindow = 15 * 60_000;

export async function workflowRecoveryStep(operationId) {
  if (typeof operationId !== 'string' || !/^[a-z\d_-]{1,64}$/iu.test(operationId)) {
    throw new TypeError('A stable research operation key is required.');
  }
  const key = new TextEncoder().encode(operationId);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return 'rra_' + Array.from(bytes.subarray(0, 14), value => value.toString(16).padStart(2, '0')).join('');
}

export function markWorkflowBody(body, recoveryStep) {
  if (!isRecoveryStep(recoveryStep) || !body.steps.length || body.steps.some(step => step.name === recoveryStep)) {
    throw new Error('The workflow could not be identified for recovery.');
  }
  // References can point only to earlier steps. The final step's wire name
  // leaves all provider references intact.
  return { ...body, steps: [...body.steps.slice(0, -1), { ...body.steps.at(-1), name: recoveryStep }] };
}

async function matchingSnapshot(client, workflowId, expected, signal) {
  let result;
  try { result = await client.inspect(workflowId, signal); }
  catch (error) {
    signal.throwIfAborted();
    if (error.status === 404 || error.status === 410) return null;
    throw error;
  }
  signal.throwIfAborted();
  if (result?.throttled) {
    const error = new Error('Civitai is limiting workflow status reads. Try again shortly.');
    error.status = 429;
    error.retryAfter = result.retryAfter;
    throw error;
  }
  const steps = result?.steps;
  return result?.workflowId === workflowId && Array.isArray(steps) && steps.length === expected.size &&
    new Set(steps.map(step => step?.name)).size === expected.size &&
    steps.every(step => expected.has(step?.name) && expected.get(step.name) === step.$type) ? result : null;
}

export async function findOriginalWorkflow(client, run, signal, continuation) {
  if (run.recoveryStep !== await workflowRecoveryStep(run.operationId) || !run.steps.length) {
    throw new Error('The saved operation could not be verified for recovery.');
  }
  const expected = new Map(run.steps.map(({ name, $type }, index) =>
    [index === run.steps.length - 1 ? run.recoveryStep : name, $type]));
  if (expected.size !== run.steps.length) throw new Error('The saved workflow steps could not be verified.');
  const earliest = run.createdAt - clockAllowance;
  const latest = run.createdAt + initiationWindow;
  const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const cursors = new Set(continuation?.cursors);
  const checked = new Set(continuation?.checked);
  let cursor = continuation?.cursor;
  let candidates = [...(continuation?.candidates ?? [])];
  let matchId = continuation?.matchId;
  let pages = 0;
  let reads = 0;
  let snapshot;
  const pending = () => candidates.length || cursor != null || matchId ? { cursor, candidates, cursors, checked, matchId } : null;
  try {
    while (reads < statusReadLimit) {
      lookupSignal.throwIfAborted();
      if (!candidates.length) {
        if (pages >= historyPageLimit || cursor === null) break;
        const history = await client.list({ limit: historyPageSize, cursor }, lookupSignal);
        lookupSignal.throwIfAborted();
        pages++;
        const nextCursor = history.cursor && !history.workflows.some(row => row.createdAt < earliest) ? history.cursor : null;
        if (nextCursor && cursors.has(nextCursor)) throw new Error('Civitai repeated a history page. Try again to finish checking the original run.');
        candidates = history.workflows.filter(({ workflowId, createdAt }) =>
          isWorkflowId(workflowId) && !checked.has(workflowId) && createdAt >= earliest && createdAt <= latest)
          .sort((a, b) => Math.abs(a.createdAt - run.createdAt) - Math.abs(b.createdAt - run.createdAt))
          .map(({ workflowId }) => workflowId);
        cursor = nextCursor;
        if (cursor) cursors.add(cursor);
        continue;
      }
      const workflowId = candidates[0];
      if (checked.has(workflowId)) {
        candidates.shift();
        continue;
      }
      reads++;
      const result = await matchingSnapshot(client, workflowId, expected, lookupSignal);
      checked.add(workflowId);
      candidates.shift();
      if (!result) continue;
      if (matchId && matchId !== workflowId) {
        const error = new Error('Civitai returned multiple runs for this operation. Check Deep Search history.');
        error.code = workflowRecoveryConflict;
        return { snapshot: null, next: null, error };
      }
      matchId = workflowId;
      snapshot = result;
    }

    // Continue until the history window is covered, even when an earlier poll
    // already matched the operation. Across checks retain only its exact ID.
    const more = candidates.length || cursor !== null;
    if (more || matchId && !snapshot && reads >= statusReadLimit) return { snapshot: null, next: pending() };
    if (matchId && !snapshot) {
      snapshot = await matchingSnapshot(client, matchId, expected, lookupSignal);
      if (!snapshot) throw new Error('Civitai could not verify the matching run again. The submission remains unresolved.');
    }
  } catch (error) {
    signal.throwIfAborted();
    return { snapshot: null, next: pending(), error };
  }
  return { snapshot: snapshot ?? null, next: null };
}
