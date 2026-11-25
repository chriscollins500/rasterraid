import { catalogPause } from './catalog.mjs';
import { galleryBaseModels, isVisualGalleryScope, readGalleryPage } from './gallery.mjs';
import { modelChoiceKey, modelDownloadFilter, modelFilterParam, modelFilterValues } from './model-access.mjs';
import { modelTypeLabel } from './filter-controls.js';
import { sampleModelFilterChange } from './search.mjs';
import { element, sourceLink } from './view.js';

function modelFields(filters) {
  return [
    ...(modelFilterValues(filters.baseModel).length ? ['baseModel'] : []),
    ...(!filters.checkpointType && modelFilterValues(filters.resourceType).length ? ['resourceType'] : []),
    ...(filters.fileFormat ? ['fileFormat'] : []),
    ...(filters.supportsGeneration === 'true' ? ['supportsGeneration'] : []),
    ...(modelDownloadFilter(filters.downloadAccess) ? ['downloadAccess'] : []),
  ];
}

function modelOption(field, filters, results, previous) {
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

function reviewable(search, current) {
  return current && search && search.context === current && !current.connectionLost &&
    search.phase === 'complete' && !search.catalogFailure;
}

export function canReviewModelFilters(search, current) {
  return Boolean(reviewable(search, current) &&
    ['models', 'all'].includes(search.filters.scope) && search.result.target.kind === 'text' &&
    search.result.candidates.length <= 2 && modelFields(search.filters).length);
}

async function reviewFilterChanges(context, fields, sample, { signal, fetcher, onProgress = () => {} }, batchSize = 1) {
  const state = { total: fields.length, tested: 0, options: [], incomplete: false, pause: null };
  for (let index = 0; index < fields.length; index += batchSize) {
    signal?.throwIfAborted();
    const pause = catalogPause(context.origin, fetcher);
    if (pause) {
      state.pause = pause.message;
      break;
    }
    const replies = await Promise.all(fields.slice(index, index + batchSize).map(sample));
    signal?.throwIfAborted();
    for (const { option, incomplete } of replies) {
      if (!incomplete) state.tested++;
      state.incomplete ||= incomplete;
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

export function reviewModelFilters(search, options = {}) {
  const { filters, result, context } = search;
  const previous = new Set(result.candidates.map(row => row.modelId));
  return reviewFilterChanges(context, modelFields(filters), async field => {
    const reply = await sampleModelFilterChange(context, result.target.value, filters, field, options);
    return { ...reply, option: modelOption(field, filters, reply.items, previous) };
  }, options, 2);
}

const periodDays = new Map([['Day', 1], ['Week', 7], ['Month', 31], ['Year', 366]]);

function galleryFields(plan) {
  return [
    ...(galleryBaseModels(plan.baseModels).length ? ['mediaBaseModels'] : []),
    ...(periodDays.has(plan.period) ? ['mediaPeriod'] : []),
    ...(plan.hasPublishedPrompt ? ['mediaPublishedPrompt'] : []),
  ];
}

function galleryItems(search) {
  const { scope } = search.result.gallery;
  return search.groups?.[scope] ?? search.result.related[scope] ?? [];
}

export function canReviewGalleryFilters(search, current) {
  if (!reviewable(search, current)) return false;
  const { gallery, visualComposition } = search.result;
  return Boolean(gallery?.plan && gallery.scope === search.filters.scope && isVisualGalleryScope(gallery.scope) && gallery.status === 'ready' &&
    !gallery.modelSource && !gallery.incomplete && !gallery.throttled && !gallery.plan.userId && !visualComposition &&
    galleryItems(search).length <= 2 && galleryFields(gallery.plan).length);
}

function galleryOption(field, filters, plan, items, previous) {
  const bases = galleryBaseModels(plan.baseModels);
  // Civitai measures from server midnight. Require a margin around the largest possible period.
  const earliest = Date.now() - ((periodDays.get(plan.period) ?? 0) + 2) * 86_400_000;
  const matches = items.filter(item => {
    if (previous.has(item.id)) return false;
    if (field === 'mediaBaseModels') return item.description && !item.description.includes(',') && !bases.includes(item.description);
    if (field === 'mediaPublishedPrompt') return item.hasPublishedPrompt === false;
    return /^\d{4}-\d\d-\d\dT/u.test(item.createdAt) && Date.parse(item.createdAt) < earliest;
  });
  if (!matches.length) return null;
  const added = field === 'mediaBaseModels' ? matches[0].description : null;
  const candidates = added ? matches.filter(item => item.description === added) : matches;
  const example = candidates.find(item => item.preview) ?? candidates[0];
  const value = added ? [...bases, added].join(',') : '';
  return { field, added, example, count: new Set(candidates.map(item => item.id)).size, filters: { ...filters, [field]: value } };
}

export function reviewGalleryFilters(search, options = {}) {
  const { filters, result: { gallery }, context } = search;
  const { plan } = gallery;
  const previous = new Set(galleryItems(search).map(item => item.id));
  return reviewFilterChanges(context, galleryFields(plan), async field => {
    const changed = { ...plan };
    if (field === 'mediaBaseModels') delete changed.baseModels;
    else if (field === 'mediaPeriod') changed.period = 'AllTime';
    else {
      delete changed.hasPublishedPrompt;
      changed.withMeta = true;
    }
    try {
      const page = await readGalleryPage(context, changed, { ...options, limit: 12 });
      return { incomplete: Boolean(page.partial), throttled: page.throttled,
        option: galleryOption(field, filters, plan, page.items, previous) };
    } catch (error) {
      options.signal?.throwIfAborted();
      return { incomplete: true, throttled: error?.status === 429 };
    }
  }, options);
}

function offerCaption({ field, added }, noun) {
  if (field === 'baseModel') return 'Also show ' + added + ' models';
  if (field === 'resourceType') return 'Also show ' + modelTypeLabel(added);
  if (field === 'mediaBaseModels') return 'Also show ' + noun + 's made with ' + added;
  if (field === 'mediaPublishedPrompt') return 'Include ' + noun + 's without a published prompt';
  return { fileFormat: 'Allow any file format', supportsGeneration: 'Allow models without on-site generation',
    downloadAccess: 'Show any download access', mediaPeriod: 'Search any time' }[field];
}

const canReview = (search, current) => canReviewModelFilters(search, current) || canReviewGalleryFilters(search, current);

export function configureFilterReview(document, { getContext, onApply }) {
  const panel = document.getElementById('filter-review');
  const button = document.getElementById('check-result-filters');
  const status = document.getElementById('filter-review-status');
  const choices = document.getElementById('filter-review-options');
  let search;
  let activeCheck;
  let busy = false;

  function stop() {
    activeCheck?.abort();
  }

  function reset(next) {
    stop();
    activeCheck = null;
    search = canReview(next, getContext()) ? next : null;
    panel.hidden = !search;
    button.textContent = isVisualGalleryScope(search?.filters.scope) ? 'Check media filters' : 'Check model filters';
    status.textContent = '';
    choices.replaceChildren();
  }

  function drawOptions(options, current, noun) {
    const items = options.map(option => {
      const { example, count } = option;
      const row = element('li', null, 'filter-review-option');
      const preview = example.preview ?? example.examples?.[0]?.preview;
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
      const title = example.title ?? [example.model, example.version].filter(Boolean).join(' · ');
      evidence.append(element('p', count + ' additional ' + noun + (count === 1 ? '' : 's') + ' in this sample'),
        sourceLink(example.link, title + ' ↗', current.context));
      const apply = element('button', offerCaption(option, noun), 'chip');
      apply.type = 'button';
      apply.disabled = busy;
      apply.addEventListener('click', () => {
        if (!busy && current === search && canReview(current, getContext())) void onApply(current, option.filters, apply);
      });
      row.append(evidence, apply);
      return row;
    });
    choices.replaceChildren(...items);
  }

  button.addEventListener('click', async () => {
    if (activeCheck) { stop(); return; }
    const current = search;
    if (busy || !canReview(current, getContext())) return;
    const kind = current.filters.scope;
    const review = isVisualGalleryScope(kind) ? reviewGalleryFilters : reviewModelFilters;
    const noun = { gallery: 'picture', videos: 'clip' }[kind] ?? 'model';
    const controller = new AbortController();
    activeCheck = controller;
    button.textContent = 'Stop filter check';
    choices.replaceChildren();
    status.textContent = 'Checking one filter change at a time…';
    let progress = { tested: 0, options: [] };
    const currentCheck = () => activeCheck === controller && search === current && getContext() === current.context;
    try {
      progress = await review(current, { signal: controller.signal, onProgress(state) {
        progress = state;
        if (currentCheck() && state.tested < state.total) status.textContent = 'Checked ' + state.tested + ' of ' + state.total + ' filters…';
      } });
      if (!currentCheck()) return;
      drawOptions(progress.options, current, noun);
      const note = progress.pause ?? (progress.incomplete ? 'Some filter changes could not be checked.' : '');
      status.textContent = [progress.options.length ? 'Choose one change to search again.' :
        progress.tested ? 'The checked samples returned no additional ' + noun + 's.' : '', note].filter(Boolean).join(' ');
    } catch {
      if (!currentCheck()) return;
      drawOptions(progress.options, current, noun);
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
      else if (search && !canReview(search, getContext())) reset(null);
      button.disabled = busy;
      choices.querySelectorAll('button').forEach(control => { control.disabled = busy; });
    },
  };
}
