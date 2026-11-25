import { SITE_ORIGINS, text, visibleRating } from './catalog.mjs';
import { appEstimateBody, LIVE_QUOTE_MAX_AGE_MS, quotePrice } from './quotes.mjs';
import { isWorkflowId, WORKFLOW_REQUEST_TIMEOUT_MS } from './workflow-client.mjs';
import { researchMatches } from './research-matches.mjs';
import { aiServiceLink, aiServiceReference } from './ai-services.mjs';
import { findOriginalWorkflow, isRecoveryStep, markWorkflowBody, workflowRecoveryConflict, workflowRecoveryStep } from './workflow-recovery.mjs';
import { isSceneTranscript, sceneTranscriptEvidence } from './workflow-transcripts.mjs';

// The App bridge retains an idempotency claim for ten minutes. Leave time
// for the status check and in-flight request before that claim can expire.
const retryLifetime = 8 * 60_000;
const endings = new Set(['succeeded', 'failed', 'canceled', 'expired', 'refused', 'not-started', 'unconfirmed']);
const providerStates = new Set(['unassigned', 'pending', 'processing', 'queued', 'running', 'succeeded', 'failed', 'canceled', 'expired']);
const recordStates = new Set(['submitting', 'unknown', ...endings, ...providerStates]);
const quoteRefusals = new Map([
  ['workflow_quote_rejected', 'Civitai refused this workflow during pricing. Choose another Deep Search option.'],
  ['workflow_quote_unavailable', 'Civitai could not price the workflow just now. Try again shortly.'],
  ['workflow_quote_unpriced', 'Civitai returned no price for this workflow. Choose another Deep Search option.'],
]);
const boundedToken = /^[a-z\d_-]{1,64}$/iu;
const bodyHash = /^[a-f\d]{64}$/u;
const supportedSteps = ['chatCompletion', 'transcription', 'audioCaptioning', 'audioClassification', 'composeMedia',
  'multimodalEmbedding', 'videoFrameExtraction', 'mediaCaptioning'];
const evidenceSteps = new Set(['chatCompletion', 'transcription', 'audioCaptioning', 'audioClassification', 'mediaCaptioning']);
const undeliveredStates = new Set(['failed', 'canceled', 'expired']);
const snapshotOutputs = value => (Array.isArray(value) ? value.flatMap(item => typeof item === 'string' ? [text(item, 8000)] : []) : [])
  .filter(Boolean).slice(0, 8);

export function runFinished(status) {
  return endings.has(status);
}

function safeSource(item, origin) {
  try {
    const url = new URL(item.link);
    const title = text(item.title, 180);
    if (title && aiServiceLink(aiServiceReference(url.href)) === url.href) return { title, link: url.href };
    return title && url.origin === origin && !url.username && !url.password && !url.searchParams.has('chat') &&
      !/^\/(?:api|generate|user\/(?:notifications|downloads|vault))(?:\/|$)/u.test(url.pathname) ? { title, link: url.href } : null;
  } catch { return null; }
}

function normalizeSimilarity(value, steps, sources) {
  if (!value || !boundedToken.test(value.model ?? '') || !Number.isInteger(value.dimensions) ||
      value.dimensions < 16 || value.dimensions > 4096 || !Array.isArray(value.targets)) return null;
  const vectors = steps.filter(row => row.$type === 'multimodalEmbedding');
  const anchor = vectors.find(step => step.name === value.anchor);
  if (!anchor) return null;
  const seen = new Set([anchor.name]);
  const targets = [];
  for (const row of value.targets.slice(0, 7)) {
    const vector = vectors.find(step => step.name === row?.step);
    const source = sources.find(item => item.link === row?.link);
    if (!source || !vector || seen.has(vector.name) || vector.input &&
        (vector.input.model !== value.model || vector.input.dimensions !== value.dimensions)) continue;
    seen.add(vector.name);
    targets.push({ step: vector.name, ...source, ...(Number.isSafeInteger(row.previewRank) && { previewRank: row.previewRank }),
      ...(Number.isSafeInteger(row.subjectRank) && { subjectRank: row.subjectRank }) });
  }
  for (const key of ['previewRank', 'subjectRank']) {
    const ranks = new Set(targets.map(row => row[key]));
    if (ranks.size !== targets.length || targets.some(row => !(row[key] >= 1 && row[key] <= targets.length))) {
      for (const row of targets) delete row[key];
    }
  }
  return targets.length ? { model: value.model, dimensions: value.dimensions, anchor: anchor.name, targets,
    ...(value.previewBasis === 'posters' && { previewBasis: 'posters' }) } : null;
}

function stepRecord({ name, $type, sourceLink, purpose, seconds }, sources) {
  const label = text(purpose, 100);
  return { name, $type, ...(sources.some(item => item.link === sourceLink) && { sourceLink,
    ...(label && { purpose: label }),
    ...(Number.isFinite(seconds) && seconds >= 0 && seconds < 240 && { seconds }) }) };
}

function savedPrice(value, createdAt) {
  const price = quotePrice({ status: 'pending', cost: value });
  return price && Number.isSafeInteger(value.observedAt) && value.observedAt >= createdAt
    ? { ...price, observedAt: value.observedAt } : null;
}

function normalizeRun(value, origin) {
  if (value?.schema !== 1 || value.origin !== origin || !boundedToken.test(value.operationId ?? '') ||
      !Number.isSafeInteger(value.createdAt) || !bodyHash.test(value.bodyHash ?? '') ||
      !recordStates.has(value.status) || (value.workflowId !== null && !isWorkflowId(value.workflowId))) return null;
  const quote = quotePrice({ status: 'pending', cost: value.quote });
  if (!quote || !text(value.title, 180)) return null;
  if (Boolean(value.workflowId) !== providerStates.has(value.status)) return null;
  const receipt = savedPrice(value.receipt, value.createdAt);
  const retryQuote = savedPrice(value.retryQuote, value.createdAt);
  const submissionUntil = (value.status === 'submitting' || value.status === 'unknown') &&
    Number.isSafeInteger(value.submissionUntil) && value.submissionUntil > value.createdAt &&
    value.submissionUntil - value.createdAt <= retryLifetime + WORKFLOW_REQUEST_TIMEOUT_MS ? value.submissionUntil : null;
  const refusalPrice = value.status === 'refused' ? savedPrice(value.refusalPrice, value.createdAt) : null;
  const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 18).map(item => safeSource(item, origin)).filter(Boolean);
  const steps = (Array.isArray(value.steps) ? value.steps : []).slice(0, 8)
    .filter(row => boundedToken.test(row?.name ?? '') && supportedSteps.includes(row.$type))
    .map(row => stepRecord(row, sources));
  const similarity = normalizeSimilarity(value.similarity, steps, sources);
  return {
    schema: 1, origin, operationId: value.operationId, bodyHash: value.bodyHash, createdAt: value.createdAt,
    status: value.status === 'submitting' ? 'unknown' : value.status, workflowId: value.workflowId,
    title: text(value.title, 180), quote,
    ...(visibleRating(value.browsingLevel, 63) && { browsingLevel: value.browsingLevel }),
    ...(value.workflowId && receipt && { receipt: { ...receipt, ...(providerStates.has(value.receipt.status) && { status: value.receipt.status }) } }),
    ...(retryQuote && { retryQuote }), ...(refusalPrice && { refusalPrice }),
    ...(submissionUntil && { submissionUntil }),
    sources, steps, ...(similarity && { similarity }),
    ...(steps.length && isRecoveryStep(value.recoveryStep) && { recoveryStep: value.recoveryStep }),
  };
}

export function reportedReceipt(reply, current, now = Date.now) {
  const price = quotePrice({ status: 'pending', cost: reply.cost });
  const status = providerStates.has(reply.status) ? reply.status : undefined;
  if (!price || current?.total === price.total && current.authorFee === price.authorFee && current.status === status) return current;
  return { ...price, observedAt: now(), ...(status && { status }) };
}

export function workflowRecord(value, origin) {
  const run = normalizeRun(value, origin);
  if (!run) return null;
  const previous = normalizeRun(value.previous, origin);
  if (previous?.workflowId && runFinished(previous.status) && previous.operationId !== run.operationId &&
      previous.createdAt <= run.createdAt) run.previous = previous;
  return run;
}

function repeatedTranscript(value) {
  const words = value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 320) return false;
  const windows = new Set();
  const count = words.length - 7;
  for (let index = 0; index < count; index++) {
    windows.add(words.slice(index, index + 8).join(' '));
    if (windows.size * 16 > count) return false;
  }
  return true;
}

export function transcriptEvidence(output) {
  if (output?.hasAudio === false) return { scope: 'silent', lines: [] };
  const clock = seconds => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
  const lines = Array.isArray(output?.segments) ? output.segments.slice(0, 32).flatMap(segment =>
    Number.isFinite(segment?.start) && segment.start >= 0 && text(segment.text, 500)
      ? [clock(segment.start) + ' · ' + text(segment.text, 500)] : []) : [];
  if (lines.length) return { scope: 'timed', lines };
  const wordsByTime = new Map();
  if (Array.isArray(output?.timeStamps)) for (const word of output.timeStamps.slice(0, 512)) {
    const words = text(word?.text, 120);
    if (!words || !Number.isFinite(word.startTime) || word.startTime < 0) continue;
    const bucket = Math.floor(word.startTime / 5);
    if (!wordsByTime.has(bucket) && wordsByTime.size < 32) wordsByTime.set(bucket, { start: word.startTime, parts: [] });
    wordsByTime.get(bucket)?.parts.push(words);
  }
  if (wordsByTime.size) return { scope: 'timed',
    lines: [...wordsByTime.values()].map(({ start, parts }) => clock(start) + ' · ' + parts.join(' ')) };
  return fullClipTranscript(output);
}

function fullClipTranscript(output) {
  const words = text(output?.text, 24_000);
  if (!words) {
    const explicitEmpty = typeof output?.text === 'string' || [output?.segments, output?.timeStamps].some(rows => Array.isArray(rows) && !rows.length);
    return explicitEmpty ? { scope: 'empty', lines: [] } : null;
  }
  if (repeatedTranscript(words)) return { scope: 'repetitive', lines: [] };
  return { scope: 'clip', lines: [text(words, 8000)] };
}

function soundDescriptionLines(output) {
  if (output?.hasAudio === false) return ['Civitai reported that the clip has no audio track.'];
  const rows = output?.results && typeof output.results === 'object' ? Object.values(output.results).slice(0, 4) : [];
  return rows.flatMap(row => {
    const tempo = typeof row?.bpm === 'number' ? row.bpm : Number(text(row?.bpm, 32).replace(/\s*bpm$/iu, ''));
    const attributes = [Number.isFinite(tempo) && tempo > 0 && tempo <= 999 && tempo + ' BPM',
      ...[['Key', row?.keyScale], ['Time signature', row?.timeSignature], ['Language', row?.language]].flatMap(([label, value]) => {
        const detail = text(value, 56);
        return detail ? [label + ' ' + detail] : [];
      }),
    ].filter(Boolean);
    const lyric = text(row?.lyrics, 180);
    return [text(row?.caption, 1100) || text(row?.text, 1100), text(row?.genre, 120),
      attributes.length && 'Estimated ' + attributes.join(' · '), lyric && 'Possible lyric excerpt · ' + lyric].filter(Boolean);
  });
}

function soundClassificationLines(output) {
  if (output?.hasAudio === false) return ['Civitai reported that the clip has no audio track.'];
  const keys = ['musicScore', 'singingScore', 'speechScore'];
  const segments = (Array.isArray(output?.segments) ? output.segments : []).slice(0, 100).filter(segment =>
    Number.isFinite(segment?.durationSeconds) && segment.durationSeconds > 0 && segment.durationSeconds <= 300 &&
    keys.every(key => Number.isFinite(segment[key]) && segment[key] >= 0 && segment[key] <= 1));
  const duration = segments.reduce((sum, row) => sum + row.durationSeconds, 0);
  if (!duration) return [];
  const estimate = key => Math.round(100 * segments.reduce((sum, row) => sum + row.durationSeconds * row[key], 0) / duration) + '/100';
  return ['Estimated music ' + estimate('musicScore') + ' · Singing ' + estimate('singingScore') + ' · Speech ' + estimate('speechScore'),
    'Analyzed ' + Math.round(duration) + ' seconds across ' + segments.length + (segments.length === 1 ? ' segment.' : ' segments.')];
}

function linesFor(step) {
  const output = step.output;
  if (step.$type === 'chatCompletion') return snapshotOutputs(step.textOutputs);
  if (step.$type === 'mediaCaptioning') {
    const caption = text(output?.caption, 2800);
    return caption ? [caption] : snapshotOutputs(step.textOutputs);
  }
  if (step.$type === 'audioCaptioning') return soundDescriptionLines(output);
  if (step.$type === 'audioClassification') return soundClassificationLines(output);
  return [];
}

function acceptStep(reported, previous, registered, defaultStatus) {
  if (!reported || reported.$type !== registered.$type || !providerStates.has(reported.status)) {
    return previous ?? { ...registered, status: defaultStatus, lines: [] };
  }
  if (previous && runFinished(previous.status) && !runFinished(reported.status)) return previous;
  if (registered.$type === 'transcription') {
    let available = !reported.output ? null : isSceneTranscript(registered)
      ? sceneTranscriptEvidence(reported.output, registered.name) : transcriptEvidence(reported.output);
    if (available?.scope === 'untimed-window') {
      const full = fullClipTranscript(reported.output);
      if (full?.scope === 'clip' || full?.scope === 'repetitive') available = full;
    }
    const scope = available?.scope ?? previous?.transcriptScope;
    return { ...registered, status: reported.status, lines: available?.lines ?? previous?.lines ?? [],
      ...(scope && { transcriptScope: scope }) };
  }
  const lines = linesFor(reported);
  return { ...registered, status: reported.status, lines: lines.length ? lines : previous?.lines ?? [] };
}

export function researchOutput(snapshot, run, previous = { steps: [], cost: null }) {
  const last = run.steps.at(-1);
  const rows = Array.isArray(snapshot.steps) ? snapshot.steps.map(step =>
    last && run.recoveryStep && step?.name === run.recoveryStep && step.$type === last.$type
      ? { ...step, name: last.name } : step) : [];
  const withheldNow = text(snapshot.textOutputWithheld?.reason, 600);
  const steps = run.steps.map(registered => acceptStep(rows.find(step => step?.name === registered.name),
    withheldNow && registered.$type === 'chatCompletion' ? undefined : previous.steps.find(step => step.name === registered.name),
    registered, runFinished(run.status) ? 'unknown' : 'pending'));
  const scopedTranscript = run.steps.some(isSceneTranscript);
  const topLevelText = scopedTranscript ? [] : snapshotOutputs(snapshot.textOutputs);
  const chats = steps.filter(step => step.$type === 'chatCompletion');
  const soleChat = chats.length === 1 && chats[0];
  if (!withheldNow && topLevelText.length && soleChat && !soleChat.lines.length && !undeliveredStates.has(soleChat.status)) {
    soleChat.lines = topLevelText;
    if (soleChat.status === 'unknown' && run.status === 'succeeded') soleChat.status = 'succeeded';
  }
  const assigned = new Set(chats.flatMap(step => step.lines));
  const notes = topLevelText.length || withheldNow || scopedTranscript ? topLevelText : previous.text ?? [];
  const reported = snapshot.cost?.total;
  const allChatsReturned = chats.length > 0 && chats.every(step => step.status === 'succeeded' && step.lines.length);
  const withheld = withheldNow || (!allChatsReturned && previous.withheld);
  const similarity = run.similarity ? researchMatches(rows, run.similarity, previous.similarity) : null;
  return { steps, text: notes.filter(note => !assigned.has(note)),
    cost: Number.isSafeInteger(reported) && reported >= 0 ? reported : previous.cost, ...(withheld && { withheld }),
    ...(similarity && { similarity }) };
}

export function workflowDelivery(run, snapshot) {
  if (!run?.steps?.length || snapshot?.restricted) return null;
  const observed = new Map(snapshot?.steps?.map(step => [step.name, step]));
  const missing = status => undeliveredStates.has(status) || undeliveredStates.has(run.status) ? 'unavailable' : 'waiting';
  const items = [];
  const unnamedChats = [];
  for (const step of run.steps) {
    if (!evidenceSteps.has(step.$type)) continue;
    const match = observed.get(step.name);
    const result = match?.$type === step.$type ? match : undefined;
    let state = missing(result?.status);
    if (result?.status === 'succeeded') {
      if (result.transcriptScope === 'silent') state = 'no-audio';
      else if (result.transcriptScope === 'empty') state = 'no-words';
      else if (result.transcriptScope === 'empty-window') state = 'no-words-in-window';
      else if (result.transcriptScope === 'repetitive') state = 'repetitive';
      else if (result.transcriptScope === 'clip' && isSceneTranscript(step)) state = 'full-clip-only';
      else if (result.lines.length) state = 'received';
      else if (step.$type === 'chatCompletion') unnamedChats.push(step.name);
    }
    if (state === 'waiting' && step.$type === 'chatCompletion' && snapshot?.withheld) state = 'unconfirmed';
    items.push({ ...step, state });
  }
  const groupedNotes = snapshot?.text?.length ?? 0;
  // The App bridge can return clean chat notes as a shared list. Different
  // notes can account for a group, but the list cannot prove any assignment.
  if (!snapshot?.withheld && unnamedChats.length && new Set(snapshot?.text).size >= unnamedChats.length) {
    for (const item of items) if (unnamedChats.includes(item.name)) item.state = 'grouped';
  }
  const similarity = run.similarity;
  if (similarity) {
    for (const target of similarity.targets) {
      const match = snapshot?.similarity?.ranked?.find(row => row.step === target.step && row.link === target.link &&
        Number.isFinite(row.score) && Math.abs(row.score) <= 1);
      const status = [similarity.anchor, target.step].map(name => observed.get(name)?.status).find(value => undeliveredStates.has(value));
      items.push({ name: target.step, $type: 'comparison', sourceLink: target.link, title: target.title,
        state: match ? 'received' : missing(status) });
    }
  }
  if (!items.length) return null;
  const resolved = items.filter(item => ['received', 'no-audio', 'no-words', 'no-words-in-window'].includes(item.state)).length;
  const grouped = items.filter(item => item.state === 'grouped').length;
  return { items, resolved, grouped, groupedNotes, incomplete: resolved + grouped !== items.length || Boolean(snapshot?.withheld) };
}

export function workflowOutputPending(run, snapshot) {
  return run?.status === 'succeeded' && Boolean(workflowDelivery(run, snapshot)?.items.some(item => item.state === 'waiting'));
}

export function historyResearchOutput(snapshot, run) {
  const output = researchOutput(snapshot, run);
  if (run.steps.length) return output;
  const rows = Array.isArray(snapshot.steps) ? snapshot.steps.slice(0, 8) : [];
  const names = new Set();
  const steps = [];
  for (const row of rows) {
    if (!['mediaCaptioning', 'transcription', 'audioCaptioning', 'audioClassification'].includes(row?.$type) ||
        typeof row.name !== 'string' || !boundedToken.test(row.name) || names.has(row.name)) continue;
    names.add(row.name);
    const step = acceptStep(row, undefined, { name: row.name, $type: row.$type }, 'unknown');
    if (step.lines.length || step.transcriptScope) steps.push(step);
  }
  const stepText = new Set(steps.flatMap(step => step.lines));
  return { ...output, steps, text: rows.some(isSceneTranscript) ? [] : output.text.filter(line => !stepText.has(line)), civitaiHistoryOnly: true,
    ...(rows.some(row => row?.$type === 'multimodalEmbedding' && row.status === 'succeeded' &&
      Array.isArray(row.output?.embedding)) && { historyIncludesEmbeddings: true }) };
}

async function planBody(plan, recoveryStep) {
  const original = appEstimateBody(plan);
  const names = new Set();
  for (const step of original.steps) {
    if (!step || !boundedToken.test(step.name ?? '') || names.has(step.name) || !supportedSteps.includes(step.$type) ||
        !step.input || typeof step.input !== 'object' || Array.isArray(step.input)) throw new Error('Choose a supported research workflow.');
    names.add(step.name);
  }
  const body = recoveryStep ? markWorkflowBody(original, recoveryStep) : original;
  const json = JSON.stringify(body);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > 150_000) throw new Error('Choose fewer sources to prepare this workflow.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { body: JSON.parse(json), steps: original.steps,
    hash: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}

function sameReceipt(first, second) {
  return first?.operationId === second?.operationId && first?.bodyHash === second?.bodyHash && first?.workflowId === second?.workflowId;
}

function mayHaveChangedReceipt(error) {
  const status = error?.status;
  return status === 409 || status >= 500 || status >= 200 && status < 300 || error?.code === 'receipt-conflict' ||
    error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error?.name);
}

export function createWorkflowSession({ client, journal, origin, browsingLevel, now = Date.now, operationId = () => crypto.randomUUID() }) {
  if (!SITE_ORIGINS.includes(origin)) throw new TypeError('Expected a Civitai site origin.');
  let run;
  let draft;
  let snapshot;
  let previousSnapshot;
  let retryBody;
  let recoveryNext;
  let recoveryConflict = false;
  let receiptPending = false;
  let receiptCheckRequired = false;
  let receiptRefreshed = false;
  let busy;
  let command;
  const canRead = record => browsingLevel === undefined || visibleRating(record?.browsingLevel, browsingLevel);
  const retryDeadline = () => run?.createdAt + retryLifetime;
  const submissionPending = () => run?.status === 'unknown' && now() < run.submissionUntil;
  const retryAvailable = () => run?.status === 'unknown' && !submissionPending() && canRead(run) &&
    !recoveryNext?.matchId && !recoveryConflict && now() < retryDeadline();
  const supportsRecovery = typeof client.list === 'function' && typeof client.inspect === 'function';
  const recoveryAvailable = () => supportsRecovery && run?.status === 'unknown' && Boolean(run.recoveryStep) &&
    !recoveryConflict && canRead(run);

  function outputFor(reply, record, previous) {
    return canRead(record) ? researchOutput(reply, record, previous) : {
      steps: [], text: [], cost: record.receipt?.total ?? null, restricted: true,
    };
  }

  async function exclusive(action, callback) {
    if (busy) throw new Error('A research action is already in progress.');
    busy = action;
    receiptRefreshed = false;
    command = new AbortController();
    try { return await callback(command.signal); }
    finally { busy = undefined; command = undefined; }
  }

  async function save(value) {
    run = value;
    receiptPending = true;
    await journal.write(value);
    receiptPending = false;
  }

  function requireCurrentReceipt() {
    if (receiptCheckRequired) throw new Error('Check the saved Deep Search run before continuing.');
  }

  function requireSavedReceipt() {
    requireCurrentReceipt();
    if (receiptPending) throw new Error('Save the current receipt before using another workflow action.');
  }

  async function syncCurrentReceipt(signal) {
    const saved = workflowRecord(await journal.read({ signal }), origin);
    signal.throwIfAborted();
    const same = sameReceipt(run, saved);
    const changed = !same || run?.status !== saved?.status || run?.submissionUntil !== saved?.submissionUntil ||
      run?.receipt?.observedAt !== saved?.receipt?.observedAt || run?.retryQuote?.observedAt !== saved?.retryQuote?.observedAt;
    if (!sameReceipt(run?.previous, saved?.previous)) {
      previousSnapshot = saved?.previous && sameReceipt(run, saved.previous) ? snapshot : undefined;
    }
    if (!same) snapshot = undefined;
    if (!same || saved?.status !== 'unknown') retryBody = undefined;
    if (!same || run?.status !== saved?.status || run?.createdAt !== saved?.createdAt ||
        run?.recoveryStep !== saved?.recoveryStep || run?.browsingLevel !== saved?.browsingLevel) {
      recoveryNext = undefined;
      recoveryConflict = false;
    }
    run = saved;
    draft = undefined;
    receiptCheckRequired = false;
    receiptRefreshed = changed;
    return changed;
  }

  async function writeCurrentReceipt(record, signal) {
    try {
      await journal.write(record, { signal });
      return true;
    } catch (error) {
      if (!mayHaveChangedReceipt(error)) throw error;
      receiptCheckRequired = true;
      signal.throwIfAborted();
      const changed = await syncCurrentReceipt(signal);
      if (!changed && error.status !== 409 && error.code !== 'receipt-conflict') throw error;
      receiptRefreshed = true;
      return false;
    }
  }

  async function apply(reply, { retry = false } = {}) {
    if (reply?.throttled === true) {
      const error = new Error('Civitai is limiting workflow status requests.');
      error.code = 'workflow-throttled';
      error.retryAfter = reply.retryAfter;
      throw error;
    }
    if (!providerStates.has(reply?.status)) throw new Error('The workflow status could not be confirmed.');
    if (reply.workflowId === 'failed' && reply.status === 'failed' && !run.workflowId) {
      const price = quotePrice({ status: 'pending', cost: reply.cost });
      if (retry) throw new Error('Civitai refused the retry. The original submission is still unconfirmed.');
      if (!price || reply.submissionUnconfirmed === true) throw new Error('Civitai could not confirm the submission outcome.');
      retryBody = undefined;
      await save({ ...run, status: 'refused', submissionUntil: undefined, refusalPrice: { ...price, observedAt: now() } });
      return;
    }
    if (!isWorkflowId(reply.workflowId) || (run.workflowId && run.workflowId !== reply.workflowId)) {
      throw new Error('The workflow identity could not be confirmed.');
    }
    if (run.workflowId && runFinished(run.status) && !runFinished(reply.status)) return;
    const receipt = reportedReceipt(reply, run.receipt, now);
    const updated = { ...run, workflowId: reply.workflowId, status: reply.status, submissionUntil: undefined, ...(receipt && { receipt }) };
    snapshot = outputFor(reply, updated, snapshot);
    retryBody = undefined;
    recoveryNext = undefined;
    recoveryConflict = false;
    if (run.workflowId !== updated.workflowId || run.status !== updated.status || run.receipt !== updated.receipt) await save(updated);
  }

  async function submit(body, signal, { retry = false } = {}) {
    try {
      const reply = await client.submit(body, run.operationId, signal);
      signal.throwIfAborted();
      await apply(reply, { retry });
    } catch (error) {
      if (run.status === 'submitting') await save({ ...run, status: 'unknown', submissionUntil: undefined });
      throw error;
    }
  }

  async function estimate(body, signal) {
    signal.throwIfAborted();
    const reply = await client.estimate(body, signal);
    signal.throwIfAborted();
    const price = quotePrice(reply);
    if (!price) throw new Error(quoteRefusals.get(reply?.errorCode) ?? 'Civitai could not price this workflow.');
    return price;
  }

  async function reconcile(signal, startFromLatest = false) {
    if (!recoveryAvailable()) return false;
    const { snapshot: reply, next, error } = await findOriginalWorkflow(client, run, signal, startFromLatest ? undefined : recoveryNext);
    signal.throwIfAborted();
    recoveryNext = next;
    if (error) {
      recoveryConflict = error.code === workflowRecoveryConflict;
      throw error;
    }
    if (!reply) return false;
    await apply(reply);
    return true;
  }

  return {
    state: () => ({ busy, run, snapshot, previousSnapshot, outputsAccessible: !run || canRead(run),
      retryAvailable: retryAvailable(), recoveryAvailable: recoveryAvailable(), recoveryContinuing: Boolean(recoveryNext), recoveryConflict,
      originalInTab: Boolean(retryBody), receiptPending, receiptCheckRequired, receiptRefreshed, submissionPending: submissionPending(),
      quote: draft ? { price: draft.price, title: draft.title, expiresAt: draft.expiresAt, retry: Boolean(draft.retry),
        revised: Boolean(draft.revised) } : null }),
    restore: () => exclusive('restoring', async signal => {
      const saved = await journal.read({ signal });
      signal.throwIfAborted();
      run = workflowRecord(saved, origin);
      snapshot = undefined;
      previousSnapshot = undefined;
      retryBody = undefined;
      recoveryNext = undefined;
      recoveryConflict = false;
      receiptPending = false;
      receiptCheckRequired = false;
    }),
    checkSavedRun: () => exclusive('checkingReceipt', async signal => {
      if (receiptPending) throw new Error('Save the current receipt before checking for another run.');
      await syncCurrentReceipt(signal);
    }),
    prepare: (plan, sources, { continueRun = false } = {}) => exclusive('quoting', async signal => {
      requireSavedReceipt();
      if (run && !runFinished(run.status)) throw new Error('Resolve the current run before starting another.');
      if (continueRun && (!run?.workflowId || !canRead(run))) throw new Error('Check the prior results before preparing a synthesis.');
      draft = undefined;
      const id = supportsRecovery ? operationId() : undefined;
      const recoveryStep = supportsRecovery ? await workflowRecoveryStep(id) : undefined;
      const { body, hash, steps } = await planBody(plan, recoveryStep);
      const checkedSources = sources.slice(0, 18).map(source => safeSource(source, origin)).filter(Boolean);
      const primary = steps.find(step => step.$type === 'multimodalEmbedding' && step.name === plan.similarity?.anchor);
      const similarity = primary ? normalizeSimilarity({ ...plan.similarity, model: primary.input.model, dimensions: primary.input.dimensions },
        steps, checkedSources) : null;
      if (plan.similarity && !similarity) throw new Error('Choose public sources for the similarity comparison.');
      const price = await estimate(body, signal);
      draft = { body, hash, price, title: text(plan.title, 180), expiresAt: now() + LIVE_QUOTE_MAX_AGE_MS,
        sources: checkedSources, similarity, operationId: id, recoveryStep,
        steps: steps.map(({ name, $type }) => stepRecord({ ...plan.stepEvidence?.[name], name, $type }, checkedSources)),
        previous: continueRun ? normalizeRun(run, origin) : undefined };
    }),
    discardQuote() {
      const checkingQuote = busy === 'quoting' || busy === 'confirming';
      const hadQuote = Boolean(draft || checkingQuote);
      draft = undefined;
      if (checkingQuote) command?.abort();
      return hadQuote;
    },
    confirm: () => exclusive('confirming', async signal => {
      requireSavedReceipt();
      const approved = draft;
      draft = undefined;
      if (!approved || now() >= approved.expiresAt) throw new Error('Get a current quote before confirming.');
      if (approved.retry) {
        if (!retryAvailable() || run.bodyHash !== approved.hash || run.operationId !== approved.retry) {
          throw new Error('The original submission can no longer be retried safely.');
        }
        if (await reconcile(signal, true) || recoveryNext?.matchId) return;
        if (!retryAvailable() || now() >= approved.expiresAt) {
          throw new Error('The retry estimate expired while checking history. Review a new estimate if the retry window is still open.');
        }
      } else if (run && !runFinished(run.status)) {
        throw new Error('Resolve the current run before starting another.');
      }
      let price;
      try {
        price = await estimate(approved.body, signal);
      } catch (error) {
        if (!signal.aborted && now() < approved.expiresAt) draft = approved;
        throw error;
      }
      const checkedAt = now();
      if (checkedAt >= approved.expiresAt) throw new Error('The estimate expired during the price check. Get a new quote.');
      if (price.total !== approved.price.total || price.authorFee !== approved.price.authorFee) {
        draft = { ...approved, price, revised: true,
          expiresAt: Math.min(checkedAt + LIVE_QUOTE_MAX_AGE_MS, approved.retry ? retryDeadline() : Infinity) };
        return;
      }
      busy = 'submitting';
      const submissionUntil = approved.expiresAt + WORKFLOW_REQUEST_TIMEOUT_MS;
      if (approved.retry) {
        const reviewed = { ...run, status: 'submitting', submissionUntil, retryQuote: { ...approved.price, observedAt: now() } };
        if (!await writeCurrentReceipt(reviewed, signal)) return;
        run = reviewed;
        if (signal.aborted || now() >= approved.expiresAt) {
          await save({ ...reviewed, status: 'unknown', submissionUntil: undefined });
          signal.throwIfAborted();
          throw new Error('The retry estimate expired before submission. Review a new estimate.');
        }
        await submit(approved.body, signal, { retry: true });
        return;
      }
      const nextRun = {
        schema: 1, origin, operationId: approved.operationId ?? operationId(), bodyHash: approved.hash, createdAt: now(), status: 'submitting', workflowId: null,
        title: approved.title, quote: approved.price, sources: approved.sources,
        steps: approved.steps, submissionUntil,
        ...(approved.recoveryStep && { recoveryStep: approved.recoveryStep }),
        ...(approved.similarity && { similarity: approved.similarity }),
        ...(visibleRating(browsingLevel, 63) && { browsingLevel }),
        ...(approved.previous && { previous: approved.previous }),
      };
      if (!workflowRecord(nextRun, origin)) throw new Error('The workflow could not be recorded safely.');
      if (!await writeCurrentReceipt(nextRun, signal)) return;
      run = nextRun;
      previousSnapshot = approved.previous ? snapshot : undefined;
      snapshot = undefined;
      if (signal.aborted || now() >= approved.expiresAt) {
        const stopped = { ...nextRun, status: 'not-started', submissionUntil: undefined };
        run = { ...nextRun, status: 'unknown' };
        await journal.write(stopped);
        run = stopped;
        signal.throwIfAborted();
        throw new Error('The estimate expired before submission. Get a new quote.');
      }
      retryBody = approved.body;
      await submit(approved.body, signal);
    }),
    prepareRetry: plan => exclusive('quoting', async signal => {
      requireSavedReceipt();
      if (run?.status === 'unknown' && !canRead(run)) throw new Error('Restore the original browsing access to review this retry.');
      if (!retryAvailable()) {
        throw new Error('The original submission can no longer be retried safely.');
      }
      draft = undefined;
      if (await reconcile(signal) || recoveryNext?.matchId) return;
      if (!retryAvailable()) throw new Error('The original retry window closed while checking Civitai history.');
      if (!retryBody && !plan) throw new Error('Recreate the original Deep Search picks to review a retry.');
      const { body, hash } = retryBody ? { body: retryBody, hash: run.bodyHash } : await planBody(plan, run.recoveryStep);
      if (hash !== run.bodyHash) throw new Error('Choose the original workflow to check its submission.');
      const price = await estimate(body, signal);
      if (!retryAvailable()) throw new Error('The original retry window closed while Civitai priced the workflow.');
      draft = { body, hash, price, title: run.title, retry: run.operationId,
        expiresAt: Math.min(now() + LIVE_QUOTE_MAX_AGE_MS, retryDeadline()) };
    }),
    recoverOriginal: () => exclusive('reconciling', async signal => {
      requireSavedReceipt();
      if (!recoveryAvailable()) throw new Error('The current receipt is unavailable for automatic recovery.');
      if (!await reconcile(signal) && !recoveryNext) {
        throw new Error('Civitai did not confirm the original run in this history check. The submission remains unresolved.');
      }
    }),
    archiveUnconfirmed: () => exclusive('archiving', async signal => {
      requireSavedReceipt();
      if (run?.status !== 'unknown') return;
      if (submissionPending()) throw new Error('The confirmation is still being checked. Check the saved run before keeping the receipt.');
      const archived = { ...run, status: 'unconfirmed', submissionUntil: undefined };
      if (!await writeCurrentReceipt(archived, signal)) return;
      run = archived;
      draft = undefined;
      retryBody = undefined;
      recoveryNext = undefined;
      recoveryConflict = false;
    }),
    saveReceiptAgain: () => exclusive('saving', async signal => {
      if (!receiptPending) return;
      const saved = workflowRecord(await journal.read({ signal }), origin);
      signal.throwIfAborted();
      if (saved?.operationId !== run.operationId || saved.bodyHash !== run.bodyHash || saved.status === 'unconfirmed' ||
          saved.workflowId && run.workflowId && saved.workflowId !== run.workflowId) {
        throw new Error('The saved run changed in another session. Copy this receipt to keep its details.');
      }
      const savedProviderState = saved.workflowId && (!run.workflowId || runFinished(saved.status));
      const savedRefusal = !run.workflowId && runFinished(saved.status);
      const base = savedProviderState || savedRefusal ? saved : run;
      const latest = {};
      const fields = ['retryQuote', ...(base.workflowId ? ['receipt'] : base.status === 'refused' ? ['refusalPrice'] : [])];
      for (const field of fields) {
        const first = run[field];
        const second = saved[field];
        const terminalReceipt = field === 'receipt' && runFinished(base.status);
        const firstSettled = terminalReceipt && first?.status === base.status;
        const secondSettled = terminalReceipt && second?.status === base.status;
        const useFirst = firstSettled !== secondSettled ? firstSettled : first && (!second || first.observedAt > second.observedAt);
        const value = useFirst ? first : second;
        if (value) latest[field] = value;
      }
      if (base.workflowId) retryBody = undefined;
      await save({ ...base, ...latest });
    }),
    refresh: () => exclusive('checking', async signal => {
      requireCurrentReceipt();
      if (run?.workflowId) await apply(await client.poll(run.workflowId, signal));
    }),
    refreshPrevious: () => exclusive('checking', async signal => {
      requireCurrentReceipt();
      const previous = run?.previous;
      if (!previous?.workflowId) return;
      const reply = await client.poll(previous.workflowId, signal);
      if (reply?.workflowId !== previous.workflowId || !runFinished(reply.status)) throw new Error('Civitai could not confirm the previous run.');
      const receipt = reportedReceipt(reply, previous.receipt, now);
      const checked = receipt === previous.receipt ? previous : { ...previous, receipt };
      previousSnapshot = outputFor(reply, checked, previousSnapshot);
      if (checked !== previous) await save({ ...run, previous: checked });
    }),
    cancel: () => exclusive('canceling', async signal => {
      requireCurrentReceipt();
      if (!run?.workflowId || runFinished(run.status)) return;
      const reply = await client.cancel(run.workflowId, signal);
      if (reply?.throttled) throw new Error('Civitai did not issue the cancellation. The run can still be active.');
      await apply(reply);
    }),
    stopChecking: () => command?.abort(),
  };
}
