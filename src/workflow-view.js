import { createWorkflowSession, runFinished, workflowOutputPending } from './workflow-session.mjs';
import { reportSynthesisPlan } from './report-research.mjs';
import { element } from './view.js';
import { copyWorkflowReport, workflowResultElements, workflowStatusLabel } from './workflow-results-view.js';

const busyMessages = { restoring: 'Restoring your run…', quoting: 'Pricing the exact workflow…',
  confirming: 'Checking the latest price before starting the run…', submitting: 'Starting the run…',
  reconciling: 'Looking for the original run on Civitai…', archiving: 'Saving the unresolved receipt…',
  saving: 'Saving the receipt…', checking: 'Checking for results…', canceling: 'Requesting cancellation…' };
const outputCheckLimit = 3;

export function installWorkflowRun(container, { client, journal, context, simulated = false, onLookup, onOpenHistory, onAvailability }) {
  const session = createWorkflowSession({ client, journal, origin: context.origin, browsingLevel: simulated ? undefined : context.browsingLevel });
  const heading = element('h2', simulated ? 'Simulated Deep Search' : 'Deep Search run');
  const quote = element('p', '', 'workflow-quote');
  quote.id = container.id + '-estimate';
  const status = element('p', '', 'quote-status');
  status.id = container.id + '-status';
  status.setAttribute('role', 'status');
  status.tabIndex = -1;
  const actions = element('div', null, 'workflow-actions');
  const output = element('div', null, 'workflow-results');
  container.replaceChildren(heading, quote, status, actions, output);
  let disposed = false;
  let receiptAccess = 'checking';
  let selected;
  let checkedAt;
  let checkedPrevious;
  let checkedRun;
  let timer;
  let exported;
  let problem = '';
  let readFailures = 0;
  let checkAfter = 0;
  let outputCheckId;
  let outputChecks = 0;
  const units = simulated ? ' simulated credits' : ' Buzz';
  const viewOptions = { context, simulated, onLookup };

  function updateActions(rows) {
    const focused = actions.contains(document.activeElement) ? document.activeElement : null;
    const existing = new Map([...actions.children].map(node => [node.textContent, node]));
    for (const [index, { name, run, description }] of rows.entries()) {
      const node = existing.get(name) ?? element('button', name, 'chip');
      existing.delete(name);
      node.type = 'button';
      if (description) node.setAttribute('aria-describedby', description);
      node.onclick = () => { void act(run); };
      const position = actions.children[index];
      if (node !== position) actions.insertBefore(node, position ?? null);
    }
    for (const node of existing.values()) node.remove();
    if (focused && focused !== document.activeElement && !container.hidden) {
      (focused.isConnected ? focused : status).focus({ preventScroll: true });
    }
  }

  function paint() {
    if (disposed) return;
    const state = session.state();
    const { busy, run, snapshot, previousSnapshot, outputsAccessible, recoveryAvailable, recoveryContinuing, retryAvailable,
      originalInTab, receiptPending } = state;
    const ticket = state.quote;
    container.hidden = (!simulated && receiptAccess !== 'ready') || (!busy && !run && !ticket && !problem);
    const estimateLabel = ticket?.revised ? ' · Updated estimate ' : ticket?.retry ? ' · New retry estimate ' : ' · Estimated ';
    quote.textContent = ticket ? ticket.title + estimateLabel + ticket.price.total + units :
      run ? (outputsAccessible ? run.title : 'Deep Search run') + ' · Estimated ' + run.quote.total + units : '';
    const fee = ticket ? ticket.price.authorFee : run?.quote.authorFee ?? null;
    if (fee !== null) quote.textContent += ' · Includes ' + fee + units + ' author fee';
    else if (ticket) quote.textContent += ' · Author fee unavailable';
    const unknown = run?.status === 'unknown';
    const done = runFinished(run?.status);
    const availableResults = run?.workflowId && outputsAccessible && !snapshot?.restricted && Boolean(
      snapshot?.similarity?.ranked.length || snapshot?.text?.length || snapshot?.steps?.some(step => step.lines.length || step.transcriptScope));
    const outputsPending = outputsAccessible && workflowOutputPending(run, snapshot);
    const outputsMissing = outputsPending || outputsAccessible && run?.status === 'succeeded' && Boolean(snapshot?.withheld);
    const canCheckOutput = outputsPending && outputChecks < outputCheckLimit;
    const waitingForUpdate = !done && availableResults && snapshot.steps.length > 0 &&
      snapshot.steps.every(step => step.status === 'succeeded');
    const retry = unknown && !originalInTab ? selected?.plan ?? reportSynthesisPlan(run.previous, previousSnapshot) : undefined;
    const message = problem || (busy ? busyMessages[busy] : ticket
      ? ticket.retry && !simulated ? 'Confirming uses the original operation. If Civitai has yet to start it, a run may start and cost Buzz.'
        : simulated ? 'This simulation uses 0 Buzz.' : 'Civitai can charge the final workflow cost if it changes.'
      : receiptPending ? 'Save the current receipt to continue.'
        : unknown ? recoveryContinuing ? 'There are more Civitai runs to check. Continuing uses 0 Buzz.'
        : recoveryAvailable ? 'The submission outcome is unknown. Find the original run on Civitai for free.'
        : !retryAvailable ? 'The submission outcome is unknown. Review history or keep the unresolved receipt.'
        : originalInTab || retry ? 'The submission outcome is unknown. Check history or review a fresh estimate to retry the original operation.'
          : 'The submission outcome is unknown. Check history or recreate the original picks to review a retry.'
        : canCheckOutput ? 'Analysis finished · Waiting for Civitai to return results'
          : outputsMissing ? 'Analysis finished · Some results are unavailable'
          : waitingForUpdate ? 'Analysis steps finished · Waiting for Civitai’s final update'
        : run ? workflowStatusLabel(run.status) : '');
    status.textContent = ticket?.revised && !busy && !problem
      ? 'The estimate changed. Review the updated price before confirming. ' + message : message;
    const available = [];
    const button = (name, run, description) => available.push({ name, run, description });
    if (!busy && ticket) {
      const label = ticket.retry ? (simulated ? 'Confirm simulation retry' : 'Confirm paid retry') :
        simulated ? 'Confirm simulation' : 'Confirm paid run';
      button(label, session.confirm, quote.id + ' ' + status.id);
      button('Dismiss estimate', session.discardQuote);
    }
    if (!busy && !ticket && unknown) {
      if (!receiptPending && recoveryAvailable) {
        button(recoveryContinuing ? 'Continue looking' : 'Find original run', session.recoverOriginal, status.id);
      }
      if (onOpenHistory) button('View Deep Search history', onOpenHistory);
      if (!receiptPending && outputsAccessible && retryAvailable && (originalInTab || retry)) {
        button('Review retry estimate', () => session.prepareRetry(retry), status.id);
      }
      if (!receiptPending) button('Keep unresolved receipt', session.archiveUnconfirmed, status.id);
    }
    if (!busy && !ticket && receiptPending) button('Save receipt again', session.saveReceiptAgain, status.id);
    if (!busy && !ticket && run && (receiptPending || run.workflowId || ['unknown', 'unconfirmed', 'refused', 'not-started'].includes(run.status))) {
      button('Copy receipt', () => {
        exported = copyWorkflowReport([{ run, restricted: !outputsAccessible }], { simulated, receipt: true });
      });
    }
    if (!busy && run?.workflowId) {
      if (Date.now() >= checkAfter) button('Check status', session.refresh);
      if (!runFinished(run.status)) button('Cancel run', session.cancel);
    }
    if (!busy && run?.previous && !previousSnapshot) button('Load previous research', session.refreshPrevious);
    if (!busy && availableResults) button(done && !outputsMissing ? 'Copy research results' : 'Copy available results', () => {
      const records = previousSnapshot ? [{ run: run.previous, snapshot: previousSnapshot }] : [];
      exported = copyWorkflowReport([...records, { run, snapshot }], { context, simulated, partial: !done || outputsMissing });
    });
    const synthesis = !busy && !ticket && !receiptPending && outputsAccessible && !canCheckOutput ? reportSynthesisPlan(run, snapshot) : null;
    if (synthesis) button('Quote a final synthesis', () => {
      selected = { plan: synthesis, sources: run.sources };
      return session.prepare(synthesis, run.sources, { continueRun: true });
    });
    updateActions(available);
    if (run !== checkedRun || snapshot !== checkedAt || previousSnapshot !== checkedPrevious) {
      checkedRun = run;
      checkedAt = snapshot;
      checkedPrevious = previousSnapshot;
      output.replaceChildren(...workflowResultElements(run, snapshot, { ...viewOptions, outputsAccessible }));
      if (previousSnapshot && run.previous) {
        const previous = element('details', null, 'workflow-previous');
        const title = previousSnapshot.restricted ? 'Previous research' : 'Previous research · ' + run.previous.title;
        previous.append(element('summary', title), ...workflowResultElements(run.previous, previousSnapshot, viewOptions));
        output.append(previous);
      }
    }
  }

  function nextCheck() {
    clearTimeout(timer);
    const { busy, run, snapshot, outputsAccessible } = session.state();
    const pending = outputsAccessible && outputChecks < outputCheckLimit && workflowOutputPending(run, snapshot);
    if (disposed || busy || problem && !checkAfter || !run?.workflowId || runFinished(run.status) && !checkAfter && !pending) return;
    timer = setTimeout(() => { void act(session.refresh); }, Math.max(simulated ? 750 : 2800, checkAfter - Date.now()));
  }

  async function act(task) {
    if (disposed || session.state().busy) return;
    clearTimeout(timer);
    problem = '';
    try {
      const pending = task();
      paint();
      await pending;
      const { run, snapshot } = session.state();
      if (run?.workflowId !== outputCheckId) {
        outputCheckId = run?.workflowId;
        outputChecks = 0;
      }
      if (task === session.refresh && workflowOutputPending(run, snapshot)) outputChecks++;
      if (task === session.refresh || runFinished(run?.status)) { readFailures = 0; checkAfter = 0; }
    } catch (error) {
      if (!disposed && error.name !== 'AbortError') {
        const temporary = task === session.refresh && (error.code === 'workflow-throttled' ||
          [429, 502, 503, 504].includes(error.status) || error.name === 'TimeoutError');
        if (temporary && ++readFailures <= 3) {
          const serverDelay = Number.isFinite(error.retryAfter) ? error.retryAfter * 1000 : 0;
          const wait = Math.max(2 ** readFailures * 1200, serverDelay);
          checkAfter = Date.now() + wait;
          problem = 'Civitai is temporarily unavailable. The status check will retry.';
        } else {
          checkAfter = 0;
          problem = error.message || 'The workflow action could not be completed.';
        }
      }
    } finally {
      paint();
      nextCheck();
    }
  }

  async function restore() {
    if (disposed || receiptAccess === 'ready' || session.state().busy) return;
    receiptAccess = 'checking';
    onAvailability?.();
    await act(async () => {
      await session.restore();
      receiptAccess = 'ready';
    });
    if (disposed) return;
    if (receiptAccess === 'checking') receiptAccess = 'unavailable';
    onAvailability?.();
    if (session.state().run?.workflowId) void act(session.refresh);
  }

  void restore();
  return {
    availability: () => receiptAccess,
    restore,
    clearOffer() {
      if (!session.discardQuote()) return;
      selected = undefined;
      problem = '';
      paint();
      nextCheck();
    },
    offer(plan, sources) {
      if (disposed || receiptAccess !== 'ready') return;
      if (session.state().busy) {
        status.focus({ preventScroll: true });
        return;
      }
      selected = { plan, sources };
      if (session.state().run?.status === 'unknown') {
        paint();
        container.scrollIntoView({ block: 'nearest' });
        status.focus({ preventScroll: true });
        return;
      }
      void act(() => session.prepare(plan, sources));
      container.scrollIntoView({ block: 'nearest' });
      status.focus({ preventScroll: true });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      exported?.close();
      exported?.remove();
      session.stopChecking();
      container.replaceChildren();
      container.hidden = true;
    },
  };
}
