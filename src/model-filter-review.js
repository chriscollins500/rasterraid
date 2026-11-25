import { catalogPause } from './catalog.mjs';
import { modelChoiceKey, modelDownloadFilter, modelFilterParam, modelFilterValues } from './model-access.mjs';
import { modelTypeLabel } from './filter-controls.js';
import { sampleModelFilterChange } from './search.mjs';
import { element, sourceLink } from './view.js';

function activeFields(filters) {
  return [
    ...(modelFilterValues(filters.baseModel).length ? ['baseModel'] : []),
    ...(!filters.checkpointType && modelFilterValues(filters.resourceType).length ? ['resourceType'] : []),
    ...(filters.fileFormat ? ['fileFormat'] : []),
    ...(filters.supportsGeneration === 'true' ? ['supportsGeneration'] : []),
    ...(modelDownloadFilter(filters.downloadAccess) ? ['downloadAccess'] : []),
  ];
}

function optionFor(field, filters, results, previous) {
  const addedValue = field === 'baseModel' ? 'base' : field === 'resourceType' ? 'type' : null;
  const matches = results.filter(row => {
    if (previous.has(row.modelId)) return false;
    if (addedValue) return Boolean(row[addedValue]);
    if (field === 'fileFormat') return row.formats.length > 0;
    if (field === 'supportsGeneration') return row.generationListed === false;
    return Boolean(row.downloadAccess);
  });
  if (!matches.length) return null;
  const [example] = matches;
  const added = addedValue ? example[addedValue] : null;
  const candidates = added ? matches.filter(row => modelChoiceKey(row[addedValue]) === modelChoiceKey(added)) : matches;
  const value = added ? modelFilterParam([...modelFilterValues(filters[field]), added]) : '';
  return { field, added, example, count: new Set(candidates.map(row => row.modelId)).size, filters: { ...filters, [field]: value } };
}

export function canReviewModelFilters(search, current) {
  return Boolean(current && search && search.context === current && !current.connectionLost &&
    search.phase === 'complete' && !search.catalogFailure &&
    ['models', 'all'].includes(search.filters.scope) && search.result.target.kind === 'text' &&
    search.result.candidates.length <= 2 && activeFields(search.filters).length);
}

export async function reviewModelFilters(search, { signal, fetcher, onProgress = () => {} } = {}) {
  const { filters, result, context } = search;
  const fields = activeFields(filters);
  const previous = new Set(result.candidates.map(row => row.modelId));
  const state = { total: fields.length, tested: 0, options: [], incomplete: false, pause: null };
  for (let index = 0; index < fields.length; index += 2) {
    signal?.throwIfAborted();
    const pause = catalogPause(context.origin, fetcher);
    if (pause) {
      state.pause = pause.message;
      break;
    }
    const group = fields.slice(index, index + 2);
    const replies = await Promise.all(group.map(field => sampleModelFilterChange(context, result.target.value, filters, field, { signal, fetcher })));
    signal?.throwIfAborted();
    for (const [position, reply] of replies.entries()) {
      if (!reply.incomplete) state.tested++;
      state.incomplete ||= reply.incomplete;
      const option = optionFor(group[position], filters, reply.items, previous);
      if (option) state.options.push(option);
    }
    onProgress(state);
    if (replies.some(reply => reply.throttled)) {
      state.pause = catalogPause(context.origin, fetcher)?.message ?? 'Civitai paused catalog reads. Try again shortly.';
      break;
    }
  }
  return state;
}

function offerCaption({ field, added }) {
  if (field === 'baseModel') return 'Also show ' + added + ' models';
  if (field === 'resourceType') return 'Also show ' + modelTypeLabel(added);
  return { fileFormat: 'Allow any file format', supportsGeneration: 'Allow models without on-site generation',
    downloadAccess: 'Show any download access' }[field];
}

export function configureModelFilterReview(document, { getContext, onApply }) {
  const panel = document.getElementById('model-filter-review');
  const button = document.getElementById('check-model-filters');
  const status = document.getElementById('model-filter-status');
  const choices = document.getElementById('model-filter-options');
  let search;
  let activeCheck;
  let busy = false;

  function stop() {
    activeCheck?.abort();
  }

  function reset(next) {
    stop();
    activeCheck = null;
    search = canReviewModelFilters(next, getContext()) ? next : null;
    panel.hidden = !search;
    button.textContent = 'Check model filters';
    status.textContent = '';
    choices.replaceChildren();
  }

  function drawOptions(options, current) {
    const items = options.map(option => {
      const { example, count } = option;
      const row = element('li', null, 'model-filter-option');
      const preview = example.examples[0]?.preview;
      if (preview) {
        const image = element('img');
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.src = preview;
        image.addEventListener('error', () => image.remove(), { once: true });
        row.append(image);
      }
      const evidence = element('div');
      evidence.append(element('p', count === 1 ? '1 additional model in this sample' : count + ' additional models in this sample'),
        sourceLink(example.link, [example.model, example.version].filter(Boolean).join(' · ') + ' ↗', current.context));
      const apply = element('button', offerCaption(option), 'chip');
      apply.type = 'button';
      apply.disabled = busy;
      apply.addEventListener('click', () => {
        if (!busy && current === search && current.context === getContext()) void onApply(current, option.filters, apply);
      });
      row.append(evidence, apply);
      return row;
    });
    choices.replaceChildren(...items);
  }

  button.addEventListener('click', async () => {
    if (activeCheck) { stop(); return; }
    const current = search;
    if (busy || !canReviewModelFilters(current, getContext())) return;
    const controller = new AbortController();
    activeCheck = controller;
    button.textContent = 'Stop filter check';
    choices.replaceChildren();
    status.textContent = 'Checking one filter change at a time…';
    let progress = { tested: 0, options: [] };
    const currentCheck = () => activeCheck === controller && search === current && getContext() === current.context;
    try {
      progress = await reviewModelFilters(current, { signal: controller.signal, onProgress(state) {
        progress = state;
        if (currentCheck() && state.tested < state.total) status.textContent = 'Checked ' + state.tested + ' of ' + state.total + ' filters…';
      } });
      if (!currentCheck()) return;
      drawOptions(progress.options, current);
      const note = progress.pause ?? (progress.incomplete ? 'Some filter changes could not be checked.' : '');
      status.textContent = [progress.options.length ? 'Choose one change to search again.' :
        progress.tested ? 'The checked samples returned no additional models.' : '', note].filter(Boolean).join(' ');
    } catch {
      if (!currentCheck()) return;
      drawOptions(progress.options, current);
      status.textContent = controller.signal.aborted ? 'Filter check stopped.' : 'The filter check was interrupted. Try again.';
    } finally {
      if (activeCheck === controller) {
        activeCheck = null;
        button.textContent = 'Check again';
      }
    }
  });

  return {
    show: reset,
    setBusy(value) {
      busy = value;
      if (busy) stop();
      button.disabled = busy;
      choices.querySelectorAll('button').forEach(control => { control.disabled = busy; });
    },
  };
}
