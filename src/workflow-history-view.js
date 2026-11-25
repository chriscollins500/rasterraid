import { SITE_ORIGINS, visibleRating } from './catalog.mjs';
import { showReportExport } from './report-view.js';
import { appHistoryTransport, QUOTE_SCOPE, workflowIdBelongsToViewer } from './workflow-client.mjs';
import { appWorkflowJournal, sameWorkflowOperation } from './workflow-journal.mjs';
import { findOriginalWorkflow } from './workflow-recovery.mjs';
import { readWorkflowReportFile, workflowReportMaximumBytes } from './workflow-report-file.mjs';
import { historyResearchOutput, reportedReceipt, researchOutput, runFinished, workflowOutputPending, workflowRecord } from './workflow-session.mjs';
import { copyWorkflowReport, workflowCompletionLabel, workflowResultElements, workflowStatusLabel } from './workflow-results-view.js';
import { element, sourceLink } from './view.js';
import { canLoadTranscript, findTranscriptMatches, preparedTranscripts, transcriptBatchSize, transcriptSessionLimit } from './workflow-transcripts.mjs';

const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const storageGranted = context => context?.storageMode !== 'local-preview' && context?.scopes.includes('apps:storage');
const historyGranted = context => context?.scopes.includes(QUOTE_SCOPE);
const formatDate = value => Number.isFinite(new Date(value).getTime()) ? dateLabel.format(value) : '';
const matchesStatus = (status, requested) => !requested || (requested === 'active' ? !runFinished(status) : status === requested);
const hasResearchNotes = snapshot => snapshot && (snapshot.text.length || snapshot.steps.some(step => step.lines.length || step.transcriptScope) ||
  snapshot.similarity?.ranked.length);
const action = (name, callback) => {
  const button = element('button', name, 'chip');
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
};

function ownedContext(context) {
  return context?.hosted && context.signedIn && context.token && Number.isSafeInteger(context.viewerUserId) && context.viewerUserId > 0 &&
    SITE_ORIGINS.includes(context.origin);
}

export function configureWorkflowHistory(document, { getContext, onLookup }) {
  const byId = id => document.getElementById(id);
  const section = byId('workspace-research-history');
  const dialog = byId('saved-workspace');
  const load = byId('history-load');
  const more = byId('history-more');
  const filters = byId('history-filters');
  const query = byId('history-query');
  const openId = byId('history-open-id');
  const openReport = byId('history-open-report');
  const reportFile = byId('history-report-file');
  const statusFilterLabel = byId('history-status-filter-label');
  const statusFilter = byId('history-filter-status');
  const status = byId('history-status');
  const results = byId('history-results');
  const detail = byId('history-detail');
  const intro = byId('history-intro');
  const transcriptPanel = byId('history-transcripts');
  const transcriptLoad = byId('history-transcript-load');
  const transcriptStop = byId('history-transcript-stop');
  const transcriptQuery = byId('history-transcript-query');
  const transcriptStatus = byId('history-transcript-status');
  const transcriptResults = byId('history-transcript-results');
  const transcripts = new Map();
  const entries = new Map();
  const savedKeys = new Map();
  const cursors = new Map();
  const seenCursors = new Map();
  let binding;
  let simulation;
  let busy;
  let copied;
  let transcriptBatch;
  let transcriptProgress = '';
  let transcriptRetryAt = 0;
  let transcriptRetryTimer;

  function makeBinding(context) {
    if (simulation) return { key: 'simulation', context, saved: true, granted: false, ...simulation };
    if (!ownedContext(context)) return null;
    return { key: [context.origin, context.viewerUserId, context.browsingLevel, context.storageMode ?? 'hosted'].join('#'),
      context, saved: storageGranted(context), granted: historyGranted(context) };
  }

  function resetRecords() {
    entries.clear();
    savedKeys.clear();
    cursors.clear();
    seenCursors.clear();
    status.textContent = '';
    detail.replaceChildren();
    detail.hidden = true;
    transcripts.clear();
    transcriptBatch = undefined;
    transcriptProgress = '';
    transcriptQuery.value = '';
    transcriptPanel.open = false;
  }

  function reset() {
    busy?.abort();
    busy = undefined;
    copied?.close();
    copied?.remove();
    copied = undefined;
    reportFile.value = '';
    query.value = '';
    statusFilter.value = '';
    resetRecords();
  }

  function bind(context) {
    const next = makeBinding(context);
    if (next?.key !== binding?.key || binding?.saved && !next?.saved || binding?.granted && !next?.granted) {
      clearTimeout(transcriptRetryTimer);
      transcriptRetryAt = 0;
      reset();
    }
    binding = next;
    section.hidden = !next;
    intro.textContent = simulation ? 'Browse the saved runs in this simulation.' :
      'Load this app’s runs or paste a workflow ID from a receipt. Civitai may ask for AI access. Reading uses 0 Buzz.';
    paint();
  }

  function addSaved(run, archived = false) {
    if (!run) return;
    const key = run.workflowId ?? 'operation:' + run.operationId;
    const existing = entries.get(key);
    const saved = existing?.saved;
    if (saved && !sameWorkflowOperation(saved, run)) return;
    const lastKey = savedKeys.get(run.operationId);
    if (lastKey && lastKey !== key) {
      const previous = entries.get(lastKey)?.saved;
      if (!sameWorkflowOperation(previous, run) || previous.workflowId || !run.workflowId) return;
      entries.delete(lastKey);
    }
    const keepSaved = saved && runFinished(saved.status) && (!runFinished(run.status) ||
      saved.receipt && (run.receipt?.observedAt ?? 0) < saved.receipt.observedAt);
    entries.set(key, { ...existing, saved: keepSaved ? saved : run, archived: archived || existing?.archived });
    savedKeys.set(run.operationId, key);
  }

  function addCivitai(row) {
    entries.set(row.workflowId, { ...entries.get(row.workflowId), civitai: row });
  }

  function displayed(entry) {
    const { saved, civitai } = entry;
    const restricted = Boolean(saved && !simulation && !visibleRating(saved.browsingLevel, binding?.context.browsingLevel));
    const current = civitai && (!runFinished(saved?.status) || runFinished(civitai.status)) ? civitai.status : saved?.status;
    const run = { ...saved, workflowId: saved?.workflowId ?? civitai?.workflowId, createdAt: saved?.createdAt ?? civitai?.createdAt,
      title: restricted ? 'Deep Search run' : saved?.title ?? 'Civitai run', status: current, cost: civitai?.cost,
      steps: restricted ? [] : saved?.steps ?? [], sources: restricted ? [] : saved?.sources ?? [] };
    return { run, restricted };
  }

  function pastedWorkflowId() {
    const id = query.value.trim();
    return !simulation && workflowIdBelongsToViewer(id, binding?.context.viewerUserId) ? id : null;
  }

  function openPastedWorkflow() {
    const workflowId = pastedWorkflowId();
    if (workflowId) void viewRun(entries.get(workflowId) ?? { civitai: { workflowId } });
  }

  function transcriptCandidates() {
    if (!binding || transcripts.size >= transcriptSessionLimit) return [];
    return [...entries.values()].flatMap(entry => {
      const { run, restricted } = displayed(entry);
      return !restricted && !transcripts.has(run.workflowId) &&
        canLoadTranscript(entry.saved, run, binding.context, Boolean(simulation)) ? [run] : [];
    }).sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.min(transcriptBatchSize, transcriptSessionLimit - transcripts.size));
  }

  function rememberTranscript(run, snapshot) {
    if (!transcripts.has(run.workflowId) && transcripts.size >= transcriptSessionLimit) return;
    transcripts.set(run.workflowId, preparedTranscripts(run, snapshot));
  }

  function paintTranscripts() {
    transcriptPanel.hidden = !binding || !entries.size && !transcripts.size;
    if (transcriptPanel.hidden) {
      transcriptStatus.textContent = '';
      transcriptResults.replaceChildren();
      return;
    }
    const pending = transcriptCandidates().length;
    transcriptLoad.disabled = Boolean(busy) || !pending || Date.now() < transcriptRetryAt;
    transcriptStop.hidden = !transcriptBatch || transcriptBatch.signal.aborted;
    transcriptLoad.textContent = transcripts.size && pending ? 'Load more completed transcripts' : 'Load completed transcripts';
    const records = [...transcripts.values()].filter(Boolean);
    const queryText = transcriptQuery.value.trim();
    const { matches, count, valid } = findTranscriptMatches(records, queryText);
    const coverage = transcripts.size ? records.length + (records.length === 1 ? ' searchable transcript.' : ' searchable transcripts.') :
      !transcriptProgress && (pending ? 'Load transcripts to search their spoken words.' : 'Open a completed transcript run to include its words.');
    const summary = queryText && (valid ? count ? (matches.length < count ? 'Showing ' + matches.length + ' of ' : '') +
      count + (count === 1 ? ' match.' : ' matches.') : 'No matches in the loaded transcripts.' : 'Enter up to 12 words.');
    const nextStatus = [transcriptProgress, coverage, summary].filter(Boolean).join(' ');
    if (transcriptStatus.textContent !== nextStatus) transcriptStatus.textContent = nextStatus;
    transcriptResults.replaceChildren();
    if (!matches.length) return;
    const list = element('ul');
    for (const { record, source, clock, before, phrase, after } of matches) {
      const row = element('li', null, 'history-row');
      const summary = element('div');
      summary.append(element('strong', record.run.title));
      const excerpt = element('p', clock ? 'Near ' + clock + ' · ' : '');
      excerpt.append(before, element('mark', phrase), after);
      summary.append(excerpt);
      if (source) summary.append(sourceLink(source.link, source.title, binding.context));
      const view = action('View transcript', () => {
        if (!binding || busy || transcripts.get(record.run.workflowId) !== record) return;
        paintDetail(record.run, false, record.snapshot).focus();
      });
      view.disabled = Boolean(busy);
      view.setAttribute('aria-label', 'View transcript in ' + record.run.title + (clock ? ' near ' + clock : ''));
      row.append(summary, view);
      list.append(row);
    }
    transcriptResults.append(list);
  }

  function paint() {
    const ready = Boolean(binding);
    load.disabled = !ready || Boolean(busy);
    openReport.disabled = load.disabled;
    more.hidden = ![...cursors.values()].some(Boolean);
    more.disabled = !ready || Boolean(busy);
    filters.hidden = !ready || Boolean(simulation && !entries.size);
    statusFilterLabel.hidden = !entries.size;
    query.placeholder = entries.size ? 'Title, workflow ID, or operation ID' : 'Workflow ID from a receipt';
    openId.hidden = !pastedWorkflowId();
    openId.disabled = Boolean(busy);
    results.setAttribute('aria-busy', String(Boolean(busy)));
    paintTranscripts();
    if (!entries.size) { results.replaceChildren(); return; }
    const filter = query.value.trim().toLowerCase();
    const rows = [...entries.values()].map(entry => ({ entry, ...displayed(entry) })).filter(({ run }) =>
      matchesStatus(run.status, statusFilter.value) && (!filter || [run.title, run.workflowId, run.operationId].join(' ').toLowerCase().includes(filter)));
    rows.sort((a, b) => b.run.createdAt - a.run.createdAt);
    if (!rows.length) { results.replaceChildren(element('p', 'No loaded runs match these filters.')); return; }
    const list = element('ul');
    for (const { entry, run } of rows) {
      const row = element('li', null, 'history-row');
      const summary = element('div');
      summary.append(element('strong', run.title), element('p', [formatDate(run.createdAt), workflowStatusLabel(run.status)]
        .filter(Boolean).join(' · ')));
      const view = action('View run', () => { void viewRun(entry); });
      view.setAttribute('aria-label', 'View run ' + run.title + ' ' + formatDate(run.createdAt));
      view.disabled = Boolean(busy);
      row.append(summary, view);
      list.append(row);
    }
    results.replaceChildren(list);
  }

  function started() {
    if (!binding || busy) return null;
    const controller = new AbortController();
    busy = controller;
    paint();
    return controller;
  }

  function assertCurrent(controller) {
    controller.signal.throwIfAborted();
    if (!dialog.open || busy !== controller) throw new DOMException('History access changed.', 'AbortError');
  }

  function finished(controller) {
    if (busy !== controller) return;
    busy = undefined;
    paint();
  }

  async function readSavedReport(file) {
    const controller = started();
    if (!controller) return;
    const { context } = binding;
    const simulated = Boolean(simulation);
    status.textContent = 'Opening saved report…';
    let report;
    try {
      if (file.size > workflowReportMaximumBytes) throw new RangeError('Choose a saved report up to 1 MiB.');
      report = await readWorkflowReportFile(await file.arrayBuffer(), context, simulated);
      assertCurrent(controller);
      status.textContent = '';
    } catch (error) {
      if (busy === controller && !controller.signal.aborted) status.textContent = error.message || 'The saved report could not open.';
      return;
    } finally { finished(controller); }
    const archive = showReportExport(report.markdown, {
      title: 'Saved Deep Search report', label: 'Saved research report in Markdown',
      note: 'Captured ' + formatDate(report.capturedAt) + ' · ' + (simulated ? 'Simulation' : new URL(report.origin).hostname),
      action: simulated ? undefined : {
        label: 'Check current Civitai run',
        run() {
          archive.close();
          return viewRun(entries.get(report.workflowId) ?? { civitai: { workflowId: report.workflowId } });
        },
      },
    });
    copied = archive;
    archive.addEventListener('close', () => {
      if (copied !== archive) return;
      copied = undefined;
      if (dialog.open && section.open && !openReport.disabled) openReport.focus({ preventScroll: true });
    }, { once: true });
  }

  async function civitaiClient(controller, requestAccess) {
    if (simulation) return simulation.client;
    let context = getContext();
    if (!ownedContext(context)) throw new Error('Sign in to Civitai to open this app’s run history.');
    if (requestAccess && !historyGranted(context)) {
      await context.requestWorkflowHistoryAccess?.(AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]));
      assertCurrent(controller);
      context = getContext();
    }
    if (!ownedContext(context) || !historyGranted(context)) throw new Error('Grant AI access on Civitai to load this app’s run history.');
    return appHistoryTransport(context, getContext);
  }

  function pauseTranscriptReads(retryAfter) {
    const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 15;
    const wait = 1000 * seconds;
    transcriptRetryAt = Date.now() + wait;
    clearTimeout(transcriptRetryTimer);
    transcriptRetryTimer = setTimeout(paint, Math.min(wait, 2_147_483_647));
  }

  async function loadTranscripts() {
    if (busy || Date.now() < transcriptRetryAt) return;
    const selected = transcriptCandidates();
    if (!selected.length) return;
    const controller = started();
    if (!controller) return;
    transcriptBatch = controller;
    let unavailable = 0;
    let notice = '';
    try {
      transcriptProgress = 'Loading completed transcripts…';
      paintTranscripts();
      const client = await civitaiClient(controller, true);
      for (const run of selected) {
        assertCurrent(controller);
        try {
          const reply = await client.poll(run.workflowId, AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]));
          assertCurrent(controller);
          if (reply?.throttled) {
            pauseTranscriptReads(reply.retryAfter);
            notice = 'Civitai is limiting transcript reads. Try again shortly.';
            break;
          }
          if (reply?.workflowId !== run.workflowId || reply.status !== 'succeeded') {
            unavailable++;
            continue;
          }
          const current = { ...run, receipt: reportedReceipt(reply, run.receipt) };
          rememberTranscript(current, historyResearchOutput(reply, current));
          paintTranscripts();
        } catch (error) {
          assertCurrent(controller);
          if (error.status === 429) {
            pauseTranscriptReads(error.retryAfter);
            notice = 'Civitai is limiting transcript reads. Try again shortly.';
            break;
          }
          unavailable++;
          if (error.status === 401 || error.status === 403) {
            notice = 'Civitai could not confirm access to more transcripts.';
            break;
          }
          if (error.status === 404 || error.status === 410) rememberTranscript(run, undefined);
        }
      }
    } catch {
      notice = controller.signal.aborted ? 'Transcript loading stopped.' : 'Civitai could not load the transcripts.';
    } finally {
      if (busy === controller) {
        transcriptBatch = undefined;
        transcriptProgress = [unavailable ? unavailable + (unavailable === 1 ? ' run unavailable.' : ' runs unavailable.') : '',
          notice].filter(Boolean).join(' ');
      }
      finished(controller);
    }
  }

  function trackCursor(source, cursor) {
    const seen = seenCursors.get(source) ?? new Set();
    const next = cursor && !seen.has(cursor) ? cursor : null;
    cursors.set(source, next);
    if (next) seen.add(next);
    seenCursors.set(source, seen);
  }

  async function readHistory(append) {
    if (!binding || busy) return;
    if (!append) resetRecords();
    const controller = started();
    status.textContent = 'Loading research history…';
    const current = binding;
    const tasks = [];
    const saved = simulation?.journal ?? (current.saved ? appWorkflowJournal(current.context, getContext) : null);
    const savedCursor = cursors.get('saved');
    const civitaiCursor = cursors.get('civitai');
    if (saved && !append) tasks.push(async () => {
      const run = await saved.read({ signal: controller.signal });
      assertCurrent(controller);
      addSaved(run?.previous);
      addSaved(run);
    });
    if (saved && (!append || savedCursor)) tasks.push(async () => {
      const page = await saved.listHistory({ cursor: savedCursor, signal: controller.signal });
      assertCurrent(controller);
      for (const run of page.entries) addSaved(run, true);
      trackCursor('saved', page.cursor);
    });
    if (!simulation && (!append || civitaiCursor)) tasks.push(async () => {
      const client = await civitaiClient(controller, !append);
      const page = await client.list({ cursor: civitaiCursor }, controller.signal);
      assertCurrent(controller);
      for (const row of page.workflows) addCivitai(row);
      trackCursor('civitai', page.cursor);
    });
    try {
      const responses = await Promise.allSettled(tasks.map(async task => {
        await task();
        paint();
      }));
      assertCurrent(controller);
      const loaded = responses.some(response => response.status === 'fulfilled');
      const failures = [...new Set(responses.flatMap(response => response.status === 'rejected' && response.reason?.name !== 'AbortError'
        ? [response.reason?.status === 429 ? 'Civitai is limiting history reads. Try again shortly.' :
          response.reason?.message || 'One history source was unavailable.'] : []))];
      status.textContent = [entries.size ? entries.size + (entries.size === 1 ? ' run loaded.' : ' runs loaded.')
        : loaded ? 'No Deep Search runs found.' : '', ...failures].filter(Boolean).join(' ');
    } catch (error) {
      if (busy === controller && !controller.signal.aborted) status.textContent = error.message || 'Research history is unavailable.';
    } finally { finished(controller); }
  }

  function paintDetail(run, restricted, snapshot, notice, followUp) {
    const heading = element('h4', run.title);
    heading.tabIndex = -1;
    const facts = [formatDate(run.createdAt), workflowCompletionLabel(run, restricted ? undefined : snapshot), run.workflowId && 'Workflow ID · ' + run.workflowId];
    if (run.quote) facts.push('Quoted total · ' + run.quote.total + (simulation ? ' simulated credits' : ' Buzz'));
    const buttons = element('div', null, 'workspace-actions');
    if (followUp) buttons.append(action(followUp.name, followUp.click));
    buttons.append(action('Copy receipt', () => {
      copied = copyWorkflowReport([{ run, restricted }], { simulated: Boolean(simulation), receipt: true });
    }));
    const earlier = !restricted && entries.get(run.previous?.workflowId);
    if (earlier) buttons.append(action('View earlier research', () => { void viewRun(earlier); }));
    if (!restricted && hasResearchNotes(snapshot)) {
      buttons.append(action('Copy report', () => {
        copied = copyWorkflowReport([{ run, snapshot }], { context: binding.context, simulated: Boolean(simulation) });
      }));
    }
    detail.replaceChildren(heading, element('p', facts.filter(Boolean).join(' · ')), buttons);
    if (notice) detail.append(element('p', notice));
    const openSource = (...args) => { dialog.close(); onLookup(...args); };
    detail.append(...workflowResultElements(run, snapshot, { context: binding.context, simulated: Boolean(simulation), onLookup: openSource,
      outputsAccessible: !restricted }));
    detail.hidden = false;
    return heading;
  }

  function recoveryAction(entry, next, reply) {
    return { name: reply ? 'Save recovered receipt' : next ? 'Continue looking' : 'Find original run',
      click: () => { void recoverRun(entry, next, reply); } };
  }

  async function recoverRun(entry, next, reply) {
    if (!binding?.saved || busy || !entry.archived || entry.saved?.status !== 'unconfirmed') return;
    const { run, restricted } = displayed(entry);
    if (restricted || !run.recoveryStep) return;
    const controller = started();
    const current = binding;
    const journal = simulation?.journal ?? appWorkflowJournal(current.context, getContext);
    status.textContent = reply ? 'Saving the recovered receipt…' : 'Looking for the original run on Civitai…';
    paintDetail(run, false, undefined);
    let heading;
    let recovered;
    try {
      if (!reply) {
        const client = await civitaiClient(controller, true);
        const batch = await findOriginalWorkflow({ list: client.list, inspect: client.poll }, run, controller.signal, next);
        assertCurrent(controller);
        if (!batch.snapshot) {
          const notice = batch.next ? 'There are more runs to check. Continuing uses 0 Buzz.' :
            'Civitai did not confirm the original run. The charge status is still unresolved.';
          heading = paintDetail(run, false, undefined, notice, recoveryAction(entry, batch.next));
          status.textContent = 'History checked.';
          return;
        }
        reply = batch.snapshot;
      }
      recovered = workflowRecord({ ...run, workflowId: reply.workflowId, status: reply.status, receipt: reportedReceipt(reply, run.receipt) }, run.origin);
      if (!recovered?.workflowId) throw new Error('Civitai could not confirm the run’s status.');
      const saved = await journal.saveRecovered(run, reply, { signal: controller.signal });
      assertCurrent(controller);
      addSaved(saved, true);
      heading = paintDetail(saved, false, researchOutput(reply, saved));
      status.textContent = 'Original run found and receipt saved.';
    } catch (error) {
      if (busy !== controller || controller.signal.aborted) return;
      if (recovered && error.code !== 'receipt-changed') {
        heading = paintDetail(recovered, false, researchOutput(reply, recovered),
          'Civitai confirmed the original run. Save the receipt again to keep it in history.', recoveryAction(entry, null, reply));
        status.textContent = 'The recovered receipt could not be saved.';
      } else {
        const changed = error.code === 'receipt-changed';
        const notice = error.status === 429 ? 'Civitai is limiting status reads. Try again shortly.' :
          error.name === 'TimeoutError' ? 'The history check took too long. Try again shortly.' : error.message || 'The history check failed.';
        heading = paintDetail(run, false, undefined, notice, changed ? null : recoveryAction(entry, next));
        status.textContent = 'The run’s saved details are shown.';
      }
    } finally {
      finished(controller);
      heading?.focus();
    }
  }

  async function viewRun(entry) {
    if (!binding || busy) return;
    const { run, restricted } = displayed(entry);
    if (restricted || !run.workflowId) {
      const recoverable = !restricted && binding.saved && entry.archived && run.status === 'unconfirmed' && run.recoveryStep;
      paintDetail(run, restricted, undefined, recoverable ? 'Find the original run in Civitai history at 0 Buzz.' : '',
        recoverable ? recoveryAction(entry) : null).focus();
      return;
    }
    const controller = started();
    status.textContent = 'Checking the selected run…';
    if (run.status) paintDetail(run, false, undefined);
    else detail.hidden = true;
    let heading;
    try {
      const client = await civitaiClient(controller, true);
      const reply = await client.poll(run.workflowId, controller.signal);
      assertCurrent(controller);
      if (reply?.throttled) throw new Error('Civitai is limiting status reads. Try again shortly.');
      if (reply?.workflowId !== run.workflowId || workflowStatusLabel(reply.status) === 'Status unavailable') {
        throw new Error('Civitai could not confirm the selected run.');
      }
      if (!runFinished(run.status) || runFinished(reply.status)) run.status = reply.status;
      run.receipt = reportedReceipt(reply, run.receipt);
      const snapshot = historyResearchOutput(reply, run);
      if (runFinished(run.status) && snapshot.steps.some(step => step.$type === 'transcription')) rememberTranscript(run, snapshot);
      const recheck = workflowOutputPending(run, snapshot) ? { name: 'Check for results', click: () => { void viewRun(entry); } } : null;
      heading = paintDetail(run, false, snapshot, hasResearchNotes(snapshot) || snapshot.withheld || recheck ? '' :
        'Civitai returned run details and no research notes.', recheck);
      status.textContent = 'Run checked.';
    } catch (error) {
      if (busy !== controller || controller.signal.aborted) return;
      const expired = error.status === 404 || error.status === 410;
      heading = paintDetail(run, false, undefined, expired ? 'Civitai no longer has the result. Any recorded costs are shown here.'
        : error.status === 403 ? 'Civitai could not open this run for your account. Check the workflow ID or load your history.'
        : error.message || 'Civitai could not load this run’s notes.');
      status.textContent = 'The run’s saved details are shown.';
    } finally { finished(controller); }
    heading?.focus();
  }

  load.addEventListener('click', () => { void readHistory(false); });
  more.addEventListener('click', () => { void readHistory(true); });
  query.addEventListener('input', paint);
  query.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !pastedWorkflowId() || event.isComposing) return;
    event.preventDefault();
    openPastedWorkflow();
  });
  openId.addEventListener('click', openPastedWorkflow);
  openReport.addEventListener('click', () => reportFile.click());
  reportFile.addEventListener('change', () => {
    const file = reportFile.files[0];
    reportFile.value = '';
    if (file) void readSavedReport(file);
  });
  statusFilter.addEventListener('change', paint);
  transcriptLoad.addEventListener('click', () => { void loadTranscripts(); });
  transcriptStop.addEventListener('click', () => {
    transcriptBatch?.abort();
    transcriptQuery.focus();
  });
  transcriptQuery.addEventListener('input', event => { if (!event.isComposing) paintTranscripts(); });
  transcriptQuery.addEventListener('compositionend', paintTranscripts);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    reset();
    paint();
  });
  return {
    bind,
    open() {
      if (!binding) return;
      byId('open-workspace').click();
      section.open = true;
      load.focus();
    },
    setSimulation(context, client, journal) {
      simulation = { client, journal };
      bind(context);
    },
  };
}
