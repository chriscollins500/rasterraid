import { CATALOG, catalogRead, listItems } from './catalog.mjs';
import { catalogOrders } from './catalog-orders.mjs';
import { bountyTypeLabel } from './bounties.mjs';
import { collectionTypeLabel } from './directory.mjs';
import { appCategoryLabel } from './app-store.mjs';
import { aiServiceLabel } from './ai-services.mjs';
import { filterOptions } from './filter-options.mjs';
import { quickSearchIntent, suggestedCatalogSearch } from './search-intent.mjs';
import { FILTER_REFRESH_MS, applyFilterChoices, fetchFilterMetadata, toolFilterChoices } from './filter-sources.mjs';
import { galleryBaseModels, galleryCreator, galleryCreatorPattern, gallerySourceFilters, galleryTagIds, isGalleryScope, isVisualGalleryScope } from './gallery.mjs';
import { leaderboardMatches, leaderboardNames } from './leaderboards.mjs';
import { libraryHandoffs } from './library.mjs';
import { modelChoiceKey, modelCreatorName, modelDownloadFilter, modelDownloadFilters, modelFilterParam, modelFilterValues } from './model-access.mjs';
import { audioFamilies } from './specialty.mjs';
import { configureReportControls } from './report-view.js';
import { releaseModelFields } from './report.mjs';
import { releaseMediaSources } from './release-trail.mjs';
import { attachInputAssist } from './input-assist.js';
import { createProofreader, draftSuggestions, filterMatches, labelKey, protectedReference, searchStarts } from './text-assist.mjs';
import { element } from './view.js';

const typeLabels = {
  LORA: 'LoRA', Controlnet: 'ControlNet', TextualInversion: 'Textual Inversion', AestheticGradient: 'Aesthetic Gradient',
  MotionModule: 'Motion Module', TextEncoder: 'Text Encoder', CLIPVision: 'CLIP Vision',
  ComfyWorkflows: 'ComfyUI Workflow', VisionLanguage: 'Vision-Language Model',
};
export const modelTypeLabel = value => Object.hasOwn(typeLabels, value) ? typeLabels[value] : value;

const modelScopes = new Set(['all', 'models', 'pictures', 'ownedModels']);
const publicOnlyFields = new Set(['checkpointType', 'period', 'fromPlatform', 'downloadAccess', 'modelAuthor']);
const usernamePattern = /^[\p{L}\p{N}_-]{2,80}$/u;
const scopeSuggestions = { crucibles: 'Contest searches', leaderboards: 'Leaderboard names',
  services: 'Service searches', marketplace: 'Buzz topics', auctions: 'Auction searches', prizes: 'Prize searches',
  users: 'Username searches', articles: 'Article topics', tools: 'Tools', aiServices: 'AI service searches', comics: 'Comic titles', collections: 'Collection searches',
  hubs: 'Hub searches', topics: 'Topics', communities: 'Community searches', reviews: 'Model reviews', comments: 'Discussions',
  report: 'Research topics' };
const typeHelp = {
  Checkpoint: 'Full model', LORA: 'Small model add-on', TextualInversion: 'Prompt embedding',
  Controlnet: 'Pose or composition control', VAE: 'Image encoder and decoder', Upscaler: 'Increase image resolution',
};
const aiServiceChoices = [
  ['serviceCategory', 'Any category'], ['serviceInput', 'Any input type'], ['serviceOutput', 'Any output type'],
  ['serviceState', 'Any status'], ['serviceTag', 'Any tag'],
];
const galleryPeriodLabels = { Day: 'Past day', Week: 'Past week', Month: 'Past month', Year: 'Past year' };

function option(value, label = value) {
  const node = element('option', label);
  node.value = value;
  return node;
}

const selectValues = select => [...select.options].map(item => item.value).filter(Boolean);
function replaceSelect(select, values, fallback, label = value => value) {
  if (JSON.stringify(selectValues(select)) === JSON.stringify(values)) return false;
  const previous = select.value;
  select.replaceChildren(option('', fallback), ...values.map(value => option(value, label(value))));
  select.value = values.includes(previous) ? previous : '';
  return Boolean(previous && !select.value);
}

export function createFilterControls(form, getContext) {
  const byId = id => document.getElementById(id);
  const reportControls = configureReportControls(form);
  const { category, resourceType, baseModel, modelAuthor, query, scope, sort, period, checkpointType, exclude, mediaSort,
    catalogSort } = form.elements;
  replaceSelect(form.elements.downloadAccess, Object.keys(modelDownloadFilters), 'Any access', value => modelDownloadFilter(value).label);
  const { mediaBaseModels, mediaCreator, mediaPeriod, mediaPublishedPrompt } = form.elements;
  const mediaBaseInput = byId('media-base-model');
  const mediaFields = [mediaCreator, mediaPeriod, mediaPublishedPrompt];
  const mediaTags = form.elements.mediaTags;
  const mediaLinkFields = [mediaTags, ...Object.values(gallerySourceFilters).map(name => form.elements[name])];
  const galleryTagNames = new Map();
  const { bountyType, bountyBase, bountyStatus, bountySort } = form.elements;
  const bountyFields = [bountyType, bountyBase, bountyStatus, bountySort];
  const directoryGroups = [...form.querySelectorAll('[data-directory-filters]')].map(group =>
    ({ group, inputs: [...group.querySelectorAll('input, select')] }));
  const directoryFields = directoryGroups.flatMap(({ inputs }) => inputs);
  const panel = byId('search-filters');
  const examples = [...form.querySelectorAll('[data-search-examples]')];
  const status = byId('filter-freshness');
  const fields = [...form.querySelectorAll('[data-model-filter]')].map(field => ({ field, input: field.querySelector('input, select') }));
  const activeFilters = byId('active-filters');
  const clearButton = byId('clear-filters');
  const count = byId('filter-count');
  const localFeed = /^(127\.0\.0\.1|localhost|dev-[a-f\d]+\.civit\.ai)$/u.test(location.hostname)
    ? new URL('../filter-options.json', import.meta.url).href : undefined;
  const proofread = createProofreader();
  let tagNames = filterOptions.categoryTags;
  let tagLookup;
  let tagTimer;
  let update;
  let nextRefreshAt = 0;
  let lastGoodAt = 0;
  let liveFilters = false;
  let filterNotice = '';
  let orderScope;
  const orderPreferences = new Map();
  let available = {
    modelTypes: filterOptions.modelTypes, baseModels: filterOptions.baseModels,
    activeBaseModels: filterOptions.activeBaseModels ?? filterOptions.baseModels,
    sorts: selectValues(sort), periods: selectValues(period),
  };
  const baseFacet = { input: baseModel, picks: byId('base-model-picks'), source: 'baseModels', label: value => value, selected: [] };
  const typeFacet = { input: resourceType, picks: byId('resource-type-picks'), source: 'modelTypes', label: modelTypeLabel, selected: [] };
  const modelFacets = [baseFacet, typeFacet];
  const modelDrafts = new Set(modelFacets.map(facet => facet.input));

  function modelChoice(facet, value) {
    if (!value) return;
    const names = available[facet.source];
    const exact = modelChoiceKey(value);
    const match = names.find(name => modelChoiceKey(name) === exact);
    if (match) return match;
    const key = labelKey(value);
    const suggestions = names.filter(name => labelKey(name) === key || labelKey(facet.label(name)) === key);
    if (suggestions.length === 1) return suggestions[0];
  }

  function addModelChoice(facet, value) {
    facet.selected = modelFilterValues([...facet.selected, value]);
    clear(facet.input);
    sync();
  }

  function baseMatches(value, selected = []) {
    const active = new Set(available.activeBaseModels);
    const matches = filterMatches(value, available.baseModels.filter(name => !selected.includes(name)).map(name => ({
      value: name, label: name, group: active.has(name) ? 'Current base models' : 'Older base models',
    })));
    return [...matches.filter(row => active.has(row.value)), ...matches.filter(row => !active.has(row.value))];
  }

  function addMediaBase(name) {
    mediaBaseModels.value = [...new Set([...galleryBaseModels(mediaBaseModels.value), name])].join(',');
    clear(mediaBaseInput);
    paintChips();
  }

  const baseAssist = attachInputAssist(baseModel, {
    emptyMessage: 'No other matching base models.',
    getRows: value => baseMatches(value, baseFacet.selected),
    onChoose: value => addModelChoice(baseFacet, value),
  });
  const mediaBaseAssist = attachInputAssist(mediaBaseInput, {
    emptyMessage: 'No other matching base models.',
    getRows: value => baseMatches(value, galleryBaseModels(mediaBaseModels.value)),
    onChoose: addMediaBase,
  });
  const typeAssist = attachInputAssist(resourceType, {
    emptyMessage: 'No other matching model types.',
    getRows: value => filterMatches(value, available.modelTypes.filter(type => !typeFacet.selected.includes(type)).map(type => ({
      value: type, label: modelTypeLabel(type), detail: typeHelp[type], aliases: [type, typeHelp[type] ?? ''],
    }))),
    onChoose: value => addModelChoice(typeFacet, value),
  });
  const tagAssist = attachInputAssist(category, {
    getRows: value => filterMatches(value, tagNames.map(name => ({ value: name, label: name, group: 'Civitai tags' }))).slice(0, 20),
  });
  const draftAssists = [query, exclude].map(input => attachInputAssist(input, {
    getRows(value) {
      if (input === query && Object.hasOwn(scopeSuggestions, scope.value)) {
        if (value.trim().length < 2 || protectedReference(value)) return [];
        const boards = scope.value === 'leaderboards';
        const origin = getContext()?.origin;
        const labels = boards ? leaderboardNames(origin)
          : examples.filter(example => example.dataset.searchExamples === scope.value).map(example => example.dataset.example);
        const proposals = boards ? leaderboardMatches(origin, value) : filterMatches(value, labels.map(label => ({ label })));
        const corrections = draftSuggestions(value, labels, input.name).filter(row => row.group === 'Spelling and grammar');
        const completions = proposals.map(({ label }) => ({ value: label, label, group: scopeSuggestions[scope.value] }));
        return [...new Map([...completions, ...corrections].filter(row => row.value !== value.trim()).map(row => [row.value, row])).values()].slice(0, 7);
      }
      return draftSuggestions(value, [...searchStarts, ...tagNames], input.name);
    },
    getWritingHelp: proofread,
  }));
  const authorAssists = [modelAuthor, form.elements.articleAuthor, form.elements.comicAuthor, form.elements.collectionAuthor, mediaCreator].map(input => {
    let rows = [];
    let timer;
    let pending;
    const assist = attachInputAssist(input, { getRows: () => rows });
    const stop = () => { clearTimeout(timer); pending?.abort(); };
    input.addEventListener('blur', stop);
    input.addEventListener('input', event => {
      stop();
      rows = [];
      assist.refresh();
      const current = getContext();
      const value = input.value;
      const prefix = value.trim().replace(/^@/u, '');
      if (event.isComposing || !current || !usernamePattern.test(prefix)) return;
      timer = setTimeout(async () => {
        pending = new AbortController();
        const { signal } = pending;
        try {
          const { data } = await catalogRead(current.origin, CATALOG.users, { query: prefix, limit: 8 }, { signal });
          if (signal.aborted || input.disabled || input.value !== value || getContext()?.origin !== current.origin) return;
          rows = listItems(data).flatMap(item => usernamePattern.test(item?.username ?? '') && item.username !== value
            ? [{ value: item.username, label: item.username, group: 'Civitai users' }] : []).slice(0, 8);
          assist.refresh();
        } catch { /* Exact usernames still work when suggestions are unavailable. */ }
      }, 300);
    });
    return assist;
  });
  const assists = [baseAssist, mediaBaseAssist, typeAssist, tagAssist, ...draftAssists, ...authorAssists];
  let pictureSearchReady = false;
  const ownerSearch = () => scope.value === 'ownedModels' || scope.value === 'report' && form.elements.reportType.value === 'portfolio';
  const releaseReport = () => scope.value === 'report' && form.elements.reportType.value === 'release';
  const releaseGallerySearch = () => releaseReport() && reportControls.sources().some(source => releaseMediaSources.has(source));
  const showModelFilters = () => modelScopes.has(scope.value) || scope.value === 'report' &&
    (ownerSearch() || reportControls.sources().includes('models'));

  function searchAction() {
    if (scope.value === 'all') return quickSearchIntent(query.value);
    if (pictureSearchReady && isVisualGalleryScope(scope.value) && !protectedReference(query.value)) {
      return { picture: true, label: scope.value === 'videos' ? 'Find clips by picture' : 'Search with picture', literal: true };
    }
    return null;
  }

  function paintSearchAction() {
    const action = searchAction();
    const suggestion = !action && scope.value === 'all' ? suggestedCatalogSearch(query.value) : null;
    const label = byId('search-label');
    const alternate = byId('search-as-typed');
    const announcement = byId('search-action-announcement');
    const suggestionButton = byId('search-suggestion');
    const submitLabel = action?.label ?? (query.disabled ? 'Show options' : scope.value === 'report' ? 'Build free report' : 'Search free');
    const hint = action?.picture ? 'Using your picture as a reference' : action?.reportType ? 'Free research report' : '';
    if (label.textContent !== submitLabel) label.textContent = submitLabel;
    if (announcement.textContent !== hint) announcement.textContent = hint;
    alternate.hidden = !action?.literal;
    form.toggleAttribute('data-with-picture', Boolean(action?.picture));
    const alternateLabel = action?.picture ? query.value.trim() ? 'Use words only' : 'Browse without reference' : 'Search as typed';
    if (alternate.textContent !== alternateLabel) alternate.textContent = alternateLabel;
    suggestionButton.hidden = !suggestion;
    if (suggestion) {
      const subject = 'for “' + suggestion.query + '”';
      const title = byId('search-suggestion-label');
      const preview = byId('search-suggestion-query');
      if (title.textContent !== suggestion.label) title.textContent = suggestion.label;
      if (preview.textContent !== subject) preview.textContent = subject;
    }
  }

  function chipText(input) {
    if (input.disabled || modelDrafts.has(input)) return '';
    if (input.type === 'checkbox') return input.checked ? input.labels[0].textContent.trim() : '';
    if (!input.value.trim()) return '';
    if (input === mediaCreator) return 'By @' + galleryCreator(input.value);
    if (input === modelAuthor) return modelCreatorName(input.value) ? 'By @' + modelCreatorName(input.value) : '';
    return input.selectedOptions?.[0]?.textContent.trim() ?? (input === exclude ? 'Exclude ' : '') + input.value.trim();
  }

  function clear(input) {
    if (input instanceof HTMLSelectElement) input.selectedIndex = 0;
    else if (input.type === 'checkbox') input.checked = false;
    else input.value = '';
    input.setCustomValidity('');
  }

  function paintChips() {
    const selected = [mediaSort, catalogSort, ...mediaFields, ...bountyFields, ...directoryFields, ...fields.map(record => record.input)].flatMap(input => {
      const name = chipText(input);
      return name ? [[input, name]] : [];
    });
    let inlineCount = 0;
    for (const facet of modelFacets) {
      const picks = !facet.input.disabled ? facet.selected.map(value => [facet.input, facet.label(value), () => {
        facet.selected = facet.selected.filter(name => name !== value);
      }]) : [];
      if (!panel.open) selected.push(...picks);
      const inline = panel.open ? picks : [];
      facet.picks.replaceChildren(...inline.map(entry => chip(entry, facet.input)));
      facet.picks.hidden = !inline.length;
      inlineCount += inline.length;
    }
    if (!mediaBaseModels.disabled) {
      const selectedBases = galleryBaseModels(mediaBaseModels.value);
      selected.push(...selectedBases.map(name => [mediaBaseModels, name, () => {
        mediaBaseModels.value = selectedBases.filter(base => base !== name).join(',');
      }]));
    }
    if (!mediaTags.disabled) {
      const tagIds = galleryTagIds(mediaTags.value);
      for (const id of tagIds) {
        const label = galleryTagNames.has(id) ? 'Tag ' + galleryTagNames.get(id) : 'Tag #' + id;
        selected.push([mediaTags, label, () => { mediaTags.value = tagIds.filter(tag => tag !== id).join(','); }]);
      }
      for (const [field, label] of Object.entries({ mediaModelId: 'Model', mediaModelVersionId: 'Version', mediaPostId: 'Post' })) {
        const input = form.elements[field];
        if (input.value) selected.push([input, label + ' #' + input.value]);
      }
    }
    activeFilters.replaceChildren(...selected.map(entry => chip(entry, panel.querySelector(':scope > summary'))));
    activeFilters.hidden = !selected.length;
    const total = selected.length + inlineCount;
    clearButton.hidden = !total;
    count.hidden = !total;
    count.textContent = String(total);

    function chip([input, name, remove], focus) {
      const button = element('button', null, 'active-filter');
      button.type = 'button';
      button.setAttribute('aria-label', 'Remove filter ' + name);
      const mark = element('span', '×');
      mark.setAttribute('aria-hidden', 'true');
      button.append(element('span', name), mark);
      button.addEventListener('click', () => {
        if (remove) remove();
        else clear(input);
        sync();
        focus.focus();
      });
      return button;
    }
  }

  function sync() {
    reportControls.sync(scope.value === 'report');
    const modelSearch = showModelFilters();
    const bountySearch = scope.value === 'bounties';
    const releaseGallery = releaseGallerySearch();
    const mediaSearch = isGalleryScope(scope.value) || releaseGallery;
    const gallerySearch = isVisualGalleryScope(scope.value) || releaseGallery;
    const orders = catalogOrders[scope.value];
    if (orderScope !== scope.value) {
      if (orderScope) orderPreferences.set(orderScope, catalogSort.value);
      orderScope = scope.value;
      replaceSelect(catalogSort, Object.keys(orders ?? {}), 'Recommended', value => orders[value].label);
      catalogSort.value = orderPreferences.get(orderScope) ?? '';
    }
    byId('catalog-order').hidden = !orders;
    catalogSort.disabled = !orders;
    byId('bounty-filters').hidden = !bountySearch;
    for (const input of bountyFields) input.disabled = !bountySearch;
    for (const { group, inputs } of directoryGroups) {
      group.hidden = group.dataset.directoryFilters !== scope.value;
      for (const input of inputs) input.disabled = group.hidden;
    }
    panel.hidden = !(orders || modelSearch || mediaSearch || bountySearch || directoryGroups.some(({ group }) => !group.hidden));
    if (panel.hidden) panel.open = false;
    status.hidden = !modelSearch && !gallerySearch;
    if (!status.hidden) {
      const info = (liveFilters ? 'Live from Civitai · ' : 'Saved Civitai choices · ') +
        (modelSearch ? available.modelTypes.length + ' model types · ' : '') + available.baseModels.length + ' base models' +
        (filterNotice ? ' · ' + filterNotice : '');
      if (status.textContent !== info) status.textContent = info;
    }
    byId('visual-gallery-filters').hidden = !gallerySearch;
    for (const input of [mediaBaseInput, mediaBaseModels, ...mediaFields]) input.disabled = !gallerySearch;
    for (const input of mediaLinkFields) input.disabled = !isVisualGalleryScope(scope.value);
    byId('media-sort').hidden = !mediaSearch;
    byId('media-sort-caption').textContent = scope.value === 'posts' ? 'Sort matching pictures and clips by' : 'Sort gallery by';
    mediaSort.options[0].textContent = gallerySearch && !releaseGallery ? 'Best match' : 'Recommended';
    mediaSort.disabled = !mediaSearch;
    for (const button of byId('search-scope-buttons').querySelectorAll('[data-search-scope]')) {
      button.setAttribute('aria-pressed', String(button.dataset.searchScope === scope.value));
    }
    const scopeLabel = scope.selectedOptions[0]?.textContent.trim();
    const focusedArea = scope.value !== 'all' && scopeLabel;
    byId('current-search-area').textContent = focusedArea || 'Search areas';
    byId('open-search-areas').setAttribute('aria-label', focusedArea ? 'Change search area · ' + focusedArea : 'Search areas');
    byId('reset-search-area').hidden = !focusedArea;
    byId('add-search-picture').hidden = scope.value !== 'all' && !isVisualGalleryScope(scope.value);
    form.dataset.scope = scope.value;
    const scopeWithExamples = examples.some(example => example.dataset.searchExamples === scope.value);
    for (const example of examples) {
      example.hidden = example.dataset.searchExamples !== (scopeWithExamples ? scope.value : 'catalog') ||
        scope.value === 'report' && example.dataset.reportType !== form.elements.reportType.value;
    }
    byId('search-examples').hidden = ['notifications', 'messages'].includes(scope.value) || examples.every(example => example.hidden);
    const prompt = {
      all: 'Search a style, name, or link',
      audio: 'Search a genre, audio model or Civitai link',
      assets3d: 'Search 3D collection names or paste a 3D asset link',
      posts: 'Search themes, @creators, or paste a post link',
      storylines: 'Find a linked story or paste a Storyline URL',
      bounties: 'Search bounty titles, @creators, or paste a bounty link',
      challenges: 'Search challenge references or paste a Civitai challenge link',
      crucibles: 'Find a contest by name or paste a Crucible link',
      leaderboards: 'Search for a leaderboard by name or topic',
      services: 'Search commission topics or paste a service link',
      marketplace: 'Find official articles about Buzz',
      auctions: 'Find auction information or paste an auction link',
      prizes: 'Search public prize announcements',
      users: 'Find a username, user ID, or profile link',
      articles: 'Search article text, @authors, or paste an article link',
      tools: 'Search tools by name, company, or purpose',
      apps: 'Find an app by name or purpose, or paste a listing link',
      aiServices: 'Describe a task or paste an exact service ID',
      comics: 'Find a comic, @creator, or chapter link',
      collections: 'Find public collections or paste a collection link',
      hubs: 'Find hub guides and shared links, or paste a hub link',
      topics: 'Search a theme, style, or Civitai tag',
      communities: 'Search community articles and collections',
      reviews: 'Enter a model name or paste a Civitai model link',
      comments: 'Find a model or article discussion, or paste a comment link',
      vault: 'Open your Vault on Civitai',
      saved: 'Search your collections by name or paste a collection link',
      ownedModels: 'Search your model names, paste a model link, or leave blank to browse',
      downloads: 'Open your download history on Civitai',
      creations: 'Open your creation history or select pictures',
      notifications: 'View notifications on Civitai',
      messages: 'View private conversations in Civitai Chat',
      report: form.elements.reportType.value === 'collection' ? 'Paste a public collection link or enter its name'
        : form.elements.reportType.value === 'guide' ? 'Paste a Civitai guide link or search for a guide'
        : form.elements.reportType.value === 'release' ? 'Enter the exact model name or paste a model release link'
        : form.elements.reportType.value === 'creator' ? 'Describe the work or type @creator and an optional topic'
        : form.elements.reportType.value === 'examplePair' ? 'Two Civitai links or IDs'
        : form.elements.reportType.value === 'stories' ? 'Story idea or Civitai picture link'
        : ownerSearch() ? 'Search your releases or leave blank to review recent models'
        : 'Describe what you want to find or paste a public Civitai link',
    }[scope.value] ?? (mediaSearch ? 'Search by tag, @creator or Civitai link' : 'Search or paste a link');
    query.disabled = libraryHandoffs.includes(scope.value);
    paintSearchAction();
    query.placeholder = prompt;
    byId('query-label').textContent = prompt;
    for (const { field, input } of fields) {
      const supported = modelSearch && !(ownerSearch() && publicOnlyFields.has(input.name)) && (!releaseReport() || releaseModelFields.has(input.name));
      field.hidden = !supported;
      input.disabled = !supported;
    }
    byId('advanced-filters').hidden = !modelSearch;
    const types = modelFilterValues([...typeFacet.selected, modelChoice(typeFacet, resourceType.value)]);
    const checkpoints = modelSearch && !ownerSearch() && types.length === 1 && types[0] === 'Checkpoint';
    byId('checkpoint-filter').hidden = !checkpoints;
    checkpointType.disabled = !checkpoints;
    period.disabled = !modelSearch || ownerSearch() || releaseReport() || Boolean(query.value.trim() && !/^tag:\s/i.test(query.value));
    paintChips();
  }

  function refresh() {
    if (update) return update;
    const current = getContext();
    if (!current || Date.now() < nextRefreshAt) return;
    const signal = AbortSignal.timeout(9_000);
    update = (async () => {
      const [enums, schema] = await Promise.allSettled([
        fetchFilterMetadata(current.origin, { localFeed, signal }),
        current.token ? catalogRead(current.origin, CATALOG.blockTools, {}, { token: current.token, signal }) : null,
      ]);
      if (getContext()?.origin !== current.origin) return;
      const live = enums.status === 'fulfilled' && enums.value?.checkedAt >= lastGoodAt ? enums.value : null;
      const declarations = toolFilterChoices(schema.status === 'fulfilled' ? schema.value?.data : null);
      const next = applyFilterChoices(available, {
        types: declarations.modelTypes ?? live?.modelTypes, bases: live?.baseModels, activeBases: live?.activeBaseModels,
        sorts: declarations.sorts, periods: declarations.periods,
      });
      let retired = false;
      for (const facet of modelFacets) {
        const selected = facet.selected.filter(name => {
          const previous = modelChoice(facet, name);
          return !previous || next[facet.source].includes(previous);
        });
        if (selected.length !== facet.selected.length) {
          facet.selected = selected;
          retired = true;
        }
        const draft = modelChoice(facet, facet.input.value);
        if (draft && !next[facet.source].includes(draft)) {
          clear(facet.input);
          retired = true;
        }
      }
      if (live && !live.stale) {
        const bases = galleryBaseModels(mediaBaseModels.value).filter(name => next.baseModels.includes(name)).join(',');
        if (mediaBaseModels.value !== bases) { mediaBaseModels.value = bases; retired = true; }
      }
      retired = replaceSelect(sort, next.sorts, 'Relevancy') || retired;
      retired = replaceSelect(period, next.periods.filter(value => value !== 'AllTime'), 'All time') || retired;
      const galleryPeriods = [...new Set([...Object.keys(galleryPeriodLabels), ...next.periods])]
        .filter(value => value !== 'AllTime' && next.periods.includes(value));
      retired = replaceSelect(mediaPeriod, galleryPeriods, 'Any time', value => galleryPeriodLabels[value] ?? value) || retired;
      available = next;
      const fresh = live && !live.stale;
      if (fresh) lastGoodAt = live.checkedAt;
      liveFilters = Boolean(fresh);
      if (retired) filterNotice = 'Removed a retired filter';
      nextRefreshAt = fresh ? Math.min(Date.now() + FILTER_REFRESH_MS, Math.max(Date.now() + 5_000, live.checkedAt + FILTER_REFRESH_MS))
        : Date.now() + FILTER_REFRESH_MS;
      sync();
      baseAssist.refresh();
      mediaBaseAssist.refresh();
      typeAssist.refresh();
    })().finally(() => { update = undefined; });
    return update;
  }

  function lookupTags() {
    clearTimeout(tagTimer);
    tagLookup?.abort();
    const current = getContext();
    const value = category.value.trim();
    tagNames = filterOptions.categoryTags;
    tagAssist.refresh();
    if (!current || value.length < 2) return;
    tagTimer = setTimeout(async () => {
      const controller = new AbortController();
      tagLookup = controller;
      try {
        const reply = await catalogRead(current.origin, CATALOG.tags, { query: value, limit: 15 }, { signal: controller.signal });
        if (!controller.signal.aborted && category.value.trim() === value) {
          tagNames = [...new Set(listItems(reply.data).map(item => item?.name).filter(name => typeof name === 'string' && name.length <= 100))];
          tagAssist.refresh();
        }
      } catch {
        // The saved tag suggestions remain when Civitai is unavailable.
      }
    }, 300);
  }

  async function readFilters() {
    sync();
    const reportSources = scope.value === 'report' ? reportControls.sources() : null;
    const useMediaFilters = isVisualGalleryScope(scope.value) || releaseGallerySearch();
    const priorBases = mediaBaseModels.value;
    const priorPeriod = mediaPeriod.value;
    const modelSnapshot = () => JSON.stringify([
      modelFacets.map(facet => [facet.selected, facet.input.value]),
      sort.value,
      period.disabled ? '' : period.value,
    ]);
    const priorModels = modelSnapshot();
    if (scope.value === 'audio' || reportSources?.includes('audio') ||
        useMediaFilters && (panel.open || priorBases || mediaBaseInput.value || priorPeriod) ||
        showModelFilters() && (panel.open || modelFacets.some(facet => facet.input.value || facet.selected.length) || sort.value || period.value)) await refresh();
    if (showModelFilters() && priorModels !== modelSnapshot()) {
      panel.open = true;
      return null;
    }
    if (useMediaFilters && (isVisualGalleryScope(scope.value) || releaseGallerySearch())) {
      if (priorBases !== mediaBaseModels.value || priorPeriod !== mediaPeriod.value) {
        panel.open = true;
        return null;
      }
      const availableBases = galleryBaseModels(priorBases).filter(name => available.baseModels.includes(name)).join(',');
      if (availableBases !== priorBases) {
        mediaBaseModels.value = availableBases;
        filterNotice = 'Removed a base model unavailable in the current list';
        panel.open = true;
        sync();
        return null;
      }
      const draft = mediaBaseInput.value.trim();
      if (draft) {
        const matches = available.baseModels.filter(name => name.toLowerCase() === draft.toLowerCase());
        if (matches.length !== 1) {
          mediaBaseInput.setCustomValidity('Choose a Civitai base model from the suggestions.');
          panel.open = true;
          mediaBaseInput.reportValidity();
          return null;
        }
        addMediaBase(matches[0]);
      }
      if (mediaCreator.value.trim() && !galleryCreatorPattern.test(galleryCreator(mediaCreator.value))) {
        mediaCreator.setCustomValidity('Enter a Civitai username.');
        panel.open = true;
        mediaCreator.reportValidity();
        return null;
      }
    }
    for (const facet of modelFacets.filter(facet => !facet.input.disabled)) {
      const draft = facet.input.value.trim();
      const values = [...facet.selected, ...(draft ? [draft] : [])];
      const canonical = values.map(value => modelChoice(facet, value));
      if (canonical.some(value => !value)) {
        const remaining = canonical.filter(Boolean);
        facet.selected = modelFilterValues(remaining);
        if (!draft || modelChoice(facet, draft)) {
          clear(facet.input);
          filterNotice = 'Removed a base model or type unavailable in the current list';
          sync();
        } else {
          facet.input.setCustomValidity('Choose a Civitai option from the suggestions.');
          facet.input.reportValidity();
        }
        panel.open = true;
        return null;
      }
      facet.selected = modelFilterValues(canonical);
      clear(facet.input);
    }
    sync();
    const filters = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value).trim()]));
    for (const facet of modelFacets.filter(facet => !facet.input.disabled)) {
      filters[facet.input.name] = modelFilterParam(facet.selected) ?? '';
    }
    if (useMediaFilters && filters.mediaCreator) filters.mediaCreator = galleryCreator(filters.mediaCreator);
    if (filters.modelAuthor) filters.modelAuthor = modelCreatorName(filters.modelAuthor);
    if (reportSources) filters.reportSources = reportSources;
    if (filters.scope === 'audio' || reportSources?.includes('audio')) filters.audioFamilies = audioFamilies(available.baseModels);
    assists.forEach(assist => assist.close());
    paintChips();
    return filters;
  }

  category.addEventListener('input', lookupTags);
  form.addEventListener('input', event => {
    if ([baseModel, resourceType, mediaBaseInput, mediaCreator].includes(event.target)) event.target.setCustomValidity('');
    sync();
  });
  form.addEventListener('change', sync);
  panel.addEventListener('toggle', () => { paintChips(); if (panel.open) refresh(); });
  setInterval(() => { if (panel.open && document.visibilityState === 'visible') refresh(); }, 30_000);
  clearButton.addEventListener('click', () => {
    [mediaSort, mediaBaseInput, mediaBaseModels, ...mediaFields, ...mediaLinkFields, catalogSort, ...bountyFields, ...directoryFields,
      ...fields.map(record => record.input)].forEach(clear);
    galleryTagNames.clear();
    for (const facet of modelFacets) facet.selected = [];
    filterNotice = '';
    orderPreferences.clear();
    tagNames = filterOptions.categoryTags;
    sync();
    panel.querySelector(':scope > summary').focus();
  });
  sync();
  return {
    sync, readFilters, searchAction,
    async retiredReportFilter(filters) {
      const models = [...modelFilterValues(filters.baseModel), ...galleryBaseModels(filters.mediaBaseModels)];
      const types = modelFilterValues(filters.resourceType);
      if (models.length || types.length || filters.sort || filters.period || filters.mediaPeriod) await refresh();
      return models.find(name => !available.baseModels.includes(name))
        ?? types.find(name => !available.modelTypes.includes(name))
        ?? (filters.sort && !available.sorts.includes(filters.sort) ? filters.sort : undefined)
        ?? (filters.period && !available.periods.includes(filters.period) ? filters.period : undefined)
        ?? (filters.mediaPeriod && !selectValues(mediaPeriod).includes(filters.mediaPeriod) ? filters.mediaPeriod : undefined);
    },
    setPictureSearchReady(ready) {
      pictureSearchReady = ready;
      paintSearchAction();
    },
    showGalleryTagNames(items) {
      const unknown = new Set(galleryTagIds(mediaTags.value).filter(id => !galleryTagNames.has(id)));
      if (mediaTags.disabled || !unknown.size) return;
      let matched = false;
      for (const item of items) for (const tag of item.tags ?? []) {
        if (!unknown.delete(tag.id)) continue;
        galleryTagNames.set(tag.id, tag.name);
        matched = true;
      }
      if (matched) paintChips();
    },
    selectReportType(type) { reportControls.restore(type); },
    restore(filters) {
      assists.forEach(assist => assist.close());
      galleryTagNames.clear();
      scope.value = filters.scope;
      if (filters.scope === 'report') reportControls.restore(filters.reportType, filters.reportSources);
      sync();
      const apply = input => {
        clear(input);
        if (input.disabled || typeof filters[input.name] !== 'string') return;
        const value = filters[input.name];
        if (input.type === 'checkbox') input.checked = value === 'true';
        else {
          if (input instanceof HTMLSelectElement && value && ![...input.options].some(choice => choice.value === value) &&
              [...bountyFields, ...directoryFields].includes(input)) input.append(option(value));
          input.value = value;
        }
      };
      apply(query);
      for (const facet of modelFacets) {
        clear(facet.input);
        facet.selected = facet.input.disabled ? [] : modelFilterValues(filters[facet.input.name]);
      }
      clear(mediaBaseInput);
      sync();
      const candidates = [mediaSort, mediaBaseModels, ...mediaFields, ...mediaLinkFields, catalogSort, ...bountyFields, ...directoryFields,
        ...fields.map(record => record.input)];
      candidates.filter(input => !modelDrafts.has(input)).forEach(apply);
      sync();
    },
    applyBountyFacets({ types, bases }) {
      replaceSelect(bountyType, types, 'Any type', bountyTypeLabel);
      replaceSelect(bountyBase, bases, 'Any base model');
      sync();
    },
    applyDirectoryFacets(facets, { append = false } = {}) {
      const choices = [
        ['tags.name', 'articleTag', 'Any tag'], ['type', 'toolType', 'Any type'],
        ['company', 'toolCompany', 'Any company'], ['genre', 'comicGenre', 'Any genre'],
        ['collectionType', 'collectionType', 'Anything'],
        ['appCategory', 'appCategory', 'Any category'],
      ];
      for (const [key, field, fallback] of choices) {
        if (!facets[key]) continue;
        const input = form.elements[field];
        const values = append && key === 'appCategory'
          ? [...new Set([...selectValues(input), ...facets[key]])].sort((a, b) => a.localeCompare(b)) : facets[key];
        replaceSelect(input, values, fallback, key === 'appCategory' ? appCategoryLabel : key === 'collectionType' ? collectionTypeLabel
          : label => label === 'SciFi' ? 'Science fiction' : label.replace(/([a-z])([A-Z])/gu, '$1 $2'));
      }
      sync();
    },
    applyServiceFacets(facets, { partial = false } = {}) {
      let retired = false;
      for (const [field, label] of aiServiceChoices) {
        const input = form.elements[field];
        const choices = partial ? [...new Set([...selectValues(input), ...facets[field]])].sort() : facets[field];
        retired = replaceSelect(input, choices, label, aiServiceLabel) || retired;
      }
      sync();
      return retired;
    },
    onHostReady() { if (panel.open) refresh(); },
  };
}
