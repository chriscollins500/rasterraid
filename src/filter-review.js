import { catalogPause } from './catalog.mjs';
import { galleryBaseModels, isVisualGalleryScope, readGalleryPage } from './gallery.mjs';
import { modelChoiceKey, modelDownloadFilter, modelFilterParam, modelFilterValues } from './model-access.mjs';
import { modelTypeLabel } from './filter-controls.js';
import { sampleModelFilterChanges } from './search.mjs';
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

function modelChange(field, filters, row) {
  const addedValue = field === 'baseModel' ? 'base' : field === 'resourceType' ? 'type' : null;
  if (addedValue) {
    const added = row[addedValue];
    const choices = modelFilterValues(filters[field]);
    if (!added || choices.some(value => modelChoiceKey(value) === modelChoiceKey(added))) return null;
    return { field, added, value: modelFilterParam([...choices, added]) };
  }
  const known = field === 'fileFormat' ? row.formats.length > 0 : field === 'supportsGeneration' ?
    row.generationListed === false : Boolean(row.downloadAccess);
  return known ? { field, added: null, value: '' } : null;
}

function sampledOption(fields, filters, rows, previous, identity, describe, previewFirst = false) {
  const matches = rows.flatMap(row => {
    if (previous.has(row[identity])) return [];
    const changes = fields.map(field => describe(field, row));
    return changes.every(Boolean) ? [{ row, changes }] : [];
  });
  if (!matches.length) return null;
  const [{ changes }] = matches;
  const candidates = matches.filter(candidate => changes.every(({ added }, index) =>
    modelChoiceKey(candidate.changes[index].added) === modelChoiceKey(added)));
  const example = (previewFirst && candidates.find(({ row }) => row.preview) || candidates[0]).row;
  const updates = Object.fromEntries(changes.map(({ field, value }) => [field, value]));
  const labels = changes.map(({ field, added }) => ({ field, added }));
  return { ...(fields.length === 1 ? labels[0] : { changes: labels }), example,
    count: new Set(candidates.map(({ row }) => row[identity])).size, filters: { ...filters, ...updates } };
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
  async function check(probes, counter, concurrency) {
    for (let index = 0; index < probes.length; index += concurrency) {
      signal?.throwIfAborted();
      const pause = catalogPause(context.origin, fetcher);
      if (pause) {
        state.pause = pause.message;
        return;
      }
      const replies = await Promise.all(probes.slice(index, index + concurrency).map(sample));
      signal?.throwIfAborted();
      for (const { option, incomplete } of replies) {
        if (!incomplete) counter.tested++;
        state.incomplete ||= incomplete;
        if (option) state.options.push(option);
      }
      onProgress(state);
      if (replies.some(reply => reply.throttled)) {
        state.pause = catalogPause(context.origin, fetcher)?.message ?? 'Civitai paused catalog reads. Try again shortly.';
        return;
      }
      if (state.pairs && (state.options.length || state.incomplete)) return;
    }
  }
  await check(fields.map(field => [field]), state, batchSize);
  if (fields.length > 1 && !state.options.length && !state.incomplete && !state.pause) {
    const pairs = fields.flatMap((first, index) => fields.slice(index + 1).map(second => [first, second]));
    state.pairs = { tested: 0, total: pairs.length };
    onProgress(state);
    await check(pairs, state.pairs, 1);
  }
  return state;
}

export function reviewModelFilters(search, options = {}) {
  const { filters, result, context } = search;
  const previous = new Set(result.candidates.map(row => row.modelId));
  return reviewFilterChanges(context, modelFields(filters), async fields => {
    const reply = await sampleModelFilterChanges(context, result.target.value, filters, fields, options);
    const option = fields.length > 1 && reply.incomplete ? null : sampledOption(fields, filters, reply.items, previous, 'modelId',
      (field, row) => modelChange(field, filters, row));
    return { ...reply, option };
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

function galleryChange(field, bases, earliest, item) {
  if (field === 'mediaBaseModels') {
    const added = item.description;
    if (!added || added.includes(',') || bases.includes(added) || galleryBaseModels(added)[0] !== added) return null;
    return { field, added, value: [...bases, added].join(',') };
  }
  // Civitai measures from server midnight. Require a margin around the largest possible period.
  const known = field === 'mediaPublishedPrompt' ? item.hasPublishedPrompt === false :
    /^\d{4}-\d\d-\d\dT/u.test(item.createdAt) && Date.parse(item.createdAt) < earliest;
  return known ? { field, added: null, value: '' } : null;
}

export function reviewGalleryFilters(search, options = {}) {
  const { filters, result: { gallery }, context } = search;
  const { plan } = gallery;
  const bases = galleryBaseModels(plan.baseModels);
  const earliest = Date.now() - ((periodDays.get(plan.period) ?? 0) + 2) * 86_400_000;
  const previous = new Set(galleryItems(search).map(item => item.id));
  return reviewFilterChanges(context, galleryFields(plan), async fields => {
    const changed = { ...plan };
    if (fields.includes('mediaBaseModels')) delete changed.baseModels;
    if (fields.includes('mediaPeriod')) changed.period = 'AllTime';
    if (fields.includes('mediaPublishedPrompt')) {
      delete changed.hasPublishedPrompt;
      changed.withMeta = true;
    }
    try {
      const page = await readGalleryPage(context, changed, { ...options, limit: 12 });
      const option = fields.length > 1 && page.partial ? null : sampledOption(fields, filters, page.items, previous, 'id',
        (field, row) => galleryChange(field, bases, earliest, row), true);
      return { incomplete: Boolean(page.partial), throttled: page.throttled, option };
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
    const items = options.map((option, index) => {
      const { example, count, changes } = option;
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
      const apply = element('button', changes ? 'Apply both changes' : offerCaption(option, noun), 'chip');
      if (changes) {
        const details = element('ul', null, 'filter-review-changes');
        details.id = 'filter-review-changes-' + index;
        details.setAttribute('role', 'list');
        details.append(...changes.map(change => element('li', offerCaption(change, noun))));
        evidence.prepend(details);
        apply.setAttribute('aria-describedby', details.id);
      }
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
        if (!currentCheck()) return;
        if (state.pairs) status.textContent = state.pairs.tested ?
          'Checked ' + state.pairs.tested + ' of ' + state.pairs.total + ' filter combinations…' : 'Checking two filters together…';
        else if (state.tested < state.total) status.textContent = 'Checked ' + state.tested + ' of ' + state.total + ' filters…';
      } });
      if (!currentCheck()) return;
      drawOptions(progress.options, current, noun);
      const note = progress.pause ?? (progress.incomplete ? 'Some filter changes could not be checked.' : '');
      status.textContent = [progress.options[0]?.changes ? 'This sample found matches that need both changes.' :
        progress.options.length ? 'Choose one change to search again.' :
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
