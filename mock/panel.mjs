import { element, sourceLink } from '../src/view.js';
import { createMockClient } from './client.mjs';

const storageKey = 'rasterraid.mock.deep-search';
const fits = {
  compatible: 'Matches your model family',
  other: 'For a different model family',
  unknown: 'Compatibility unknown',
};

function storedRun() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (typeof saved?.id === 'string' && typeof saved?.quoteId === 'string') return saved;
  } catch {
    // The current tab still works when browser storage is unavailable.
  }
  return null;
}

export function installMockPanel(container) {
  const client = createMockClient(location.origin);
  const panel = element('section', null, 'mock-research');
  const heading = element('h3', 'Check compatibility');
  heading.id = 'mock-heading';
  panel.setAttribute('aria-labelledby', heading.id);

  const family = element('select');
  family.id = 'mock-family';
  const label = element('label', 'Your model family');
  label.htmlFor = family.id;
  const estimateButton = element('button', 'Get mock quote', 'primary');
  const confirmButton = element('button', 'Confirm mock run', 'primary');
  const retryButton = element('button', 'Recover run', 'primary');
  const cancelButton = element('button', 'Cancel mock run', 'chip');
  const resetButton = element('button', 'Compare again', 'chip');
  for (const button of [estimateButton, confirmButton, retryButton, cancelButton, resetButton]) button.type = 'button';

  const quoteCard = element('div', null, 'quote-card');
  const price = element('strong');
  const fee = element('p');
  quoteCard.append(price, fee);
  const status = element('p', '', 'mock-status');
  status.setAttribute('role', 'status');
  const progress = element('progress');
  progress.max = 3;
  progress.setAttribute('aria-label', 'Mock comparison progress');
  const outcome = element('div', null, 'mock-outcome');
  panel.append(heading, label, family, quoteCard, estimateButton, confirmButton,
    progress, status, outcome, retryButton, cancelButton, resetButton);
  container.append(panel);

  let draft;
  let quote;
  let job;
  let run = storedRun();
  let busy = false;
  let retry = false;
  let message = '';
  let timer;
  let paintedResult;

  function setRun(value) {
    run = value;
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Only refresh recovery depends on session storage.
    }
  }

  function paint() {
    const finished = job?.status === 'succeeded' || job?.status === 'cancelled';
    label.hidden = family.hidden = Boolean(run);
    family.disabled = !draft?.picks.length;
    quoteCard.hidden = !quote || Boolean(run);
    if (!quoteCard.hidden) {
      price.textContent = quote.total + ' mock credits';
      fee.textContent = 'Includes ' + quote.authorFee + ' mock author credit. 0 Buzz charged.';
    }
    estimateButton.hidden = Boolean(run || quote);
    estimateButton.disabled = busy || !draft?.picks.length || !draft.baseModel;
    confirmButton.hidden = !quote || Boolean(run);
    confirmButton.disabled = busy;
    retryButton.hidden = !retry || finished;
    cancelButton.hidden = !job || finished;
    cancelButton.disabled = busy;
    resetButton.hidden = !finished;

    progress.hidden = !job || finished || retry;
    if (!progress.hidden) progress.value = job.step;
    if (status.textContent !== message) status.textContent = message;

    const result = job?.status === 'succeeded' ? job : null;
    if (paintedResult === result) return;
    paintedResult = result;
    outcome.replaceChildren();
    if (!result) return;

    const count = result.results.filter(row => row.fit === 'compatible').length;
    const title = element('h4', count + ' of ' + result.results.length + ' match ' + result.baseModel);
    const list = element('ol');
    for (const row of result.results) {
      const item = element('li');
      item.dataset.fit = row.fit;
      item.append(sourceLink(row.source, row.title, {}), element('p', fits[row.fit] + (row.baseModel ? ' · ' + row.baseModel : '')));
      list.append(item);
    }
    outcome.append(title, list, element('p', 'Checks the base model recorded for each version.'));
  }

  function updateDraft(picks, baseModel, origin) {
    const next = { origin, baseModel, picks };
    if (JSON.stringify(draft) !== JSON.stringify(next)) {
      draft = next;
      quote = null;
      if (!run) message = picks.length ? '' : 'Pick a model to compare.';
    }
    paint();
  }

  async function sync(action) {
    if (!run || busy) return;
    clearTimeout(timer);
    busy = true;
    retry = false;
    paint();
    try {
      job = await action();
      message = {
        queued: 'Mock run queued.',
        running: job.step === 1 ? 'Checking model families…' : 'Comparing the versions…',
        succeeded: 'Comparison ready. 0 Buzz charged.',
        cancelled: 'Mock run cancelled. 0 Buzz charged.',
      }[job.status];
      if (job.status === 'queued' || job.status === 'running') {
        timer = setTimeout(() => sync(() => client.read(run.id)), 350);
      }
    } catch (error) {
      if (error.status === 410 || error.status === 409) {
        setRun(null);
        quote = job = null;
        message = error.message;
      } else {
        retry = true;
        message = 'Connection interrupted. Recover this run to continue.';
      }
    } finally {
      busy = false;
      paint();
    }
  }

  function recover() {
    return sync(async () => {
      try {
        return await client.read(run.id);
      } catch (error) {
        if (error.status !== 404) throw error;
        return client.confirm(run.id, run.quoteId);
      }
    });
  }

  family.addEventListener('change', () => updateDraft(draft.picks, family.value, draft.origin));
  estimateButton.addEventListener('click', async () => {
    if (busy) return;
    const current = draft;
    busy = true;
    message = 'Preparing the mock quote…';
    paint();
    try {
      const value = await client.estimate(current);
      if (draft !== current) return;
      quote = value;
      message = 'Quote ready. Review the total and confirm to run the comparison.';
    } catch (error) {
      if (draft === current) message = error.message;
    } finally {
      busy = false;
      paint();
      if (quote) confirmButton.focus();
    }
  });
  confirmButton.addEventListener('click', () => {
    if (!quote || run || busy) return;
    setRun({ id: crypto.randomUUID(), quoteId: quote.id });
    message = 'Starting the mock run…';
    sync(() => client.confirm(run.id, run.quoteId));
  });
  retryButton.addEventListener('click', recover);
  cancelButton.addEventListener('click', () => sync(() => client.cancel(run.id)));
  resetButton.addEventListener('click', () => {
    setRun(null);
    job = quote = null;
    message = '';
    paint();
    (estimateButton.disabled ? container : estimateButton).focus();
  });

  if (run) recover();

  return function configure(picks, filters, origin) {
    const chosen = family.value || filters.baseModel;
    const families = [...new Set([chosen, ...picks.map(row => row.base)].filter(Boolean))];
    family.replaceChildren(...families.map(value => {
      const option = element('option', value);
      option.value = value;
      return option;
    }));
    updateDraft(picks.map(row => ({ id: row.id, modelId: row.modelId, title: row.model, baseModel: row.base })),
      family.value, origin);
  };
}
