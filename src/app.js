import { watchHost } from './civitai-host.js';
import { createFilterControls, modelTypeLabel } from './filter-controls.js';
import { catalogOrder } from './catalog-orders.mjs';
import { catalogPause } from './catalog.mjs';
import { runHostProbe, HOST_PROBES } from './probe.mjs';
import { discover, hashLookupNote, readModelPage, readRecordedVersions } from './search.mjs';
import { showModelHandoff } from './model-handoff.js';
import { catalogSearchText, civitaiDownloadReference, downloadReferenceNote, modelChoiceFields, modelDownloadFilter, modelFilterValues } from './model-access.mjs';
import { readNativeModelSearch } from './native-model-search.mjs';
import { suggestedCatalogSearch } from './search-intent.mjs';
import { isGalleryScope, isVisualGalleryScope, readGalleryPage, readNativeGallerySearch, tagRecord } from './gallery.mjs';
import { readPostPage } from './community.mjs';
import { readBountyPage } from './bounties.mjs';
import { directoryScopes, readDirectoryPage } from './directory.mjs';
import { socialScopes } from './social-search.mjs';
import { configureSearchButtons } from './button-layout.mjs';
import { catalogResearch } from './catalog-research.mjs';
import { discoverReport } from './report.mjs';
import { catalogSearchFailure, createReportRecovery } from './report-recovery.mjs';
import { reportResearchPlans } from './report-research.mjs';
import { renderReport, renderReportChanges } from './report-view.js';
import { captureCatalogCheckpoint, reviewCatalogCheckpoint, reviewReportCheckpoint } from './report-checkpoint.mjs';
import { appRunTransport } from './workflow-client.mjs';
import { appWorkflowJournal, localWorkflowJournal } from './workflow-journal.mjs';
import { installWorkflowRun } from './workflow-view.js';
import { configureWorkflowHistory } from './workflow-history-view.js';
import { configureWorkspace } from './workspace-view.js';
import { configurePublishedWorkflow } from './published-workflow-view.js';
import { configurePreferences } from './preference-view.js';
import { personalMediaOrder } from './preferences.mjs';
import { reopenShortlist } from './workspace.mjs';
import { labelKey } from './text-assist.mjs';
import { upgradeForSearch } from './upgrade-evidence.mjs';
import { configureLocalReferences, isReferencePictureFile } from './visual-view.js';
import { createVisualCropEditor } from './visual-crop.js';
import { loadPublicPreview, visualRegionLabel, visualRoles } from './visual-analysis.mjs';
import { clipMatchTarget, refineVisualNeighbors } from './visual-discovery.mjs';
import { galleryCandidateResearch, galleryCompositionResearch, gallerySimilarityResearch, visualPickLimit, visualResearch } from './visual-research.mjs';
import { configureSubjectComparison } from './subject-view.js';
import { configureSoundMatch } from './sound-view.js';
import { soundPickLimit, soundResearch } from './sound-research.mjs';
import { configureSceneMatch } from './scene-view.js';
import { scenePickLimit, sceneResearch, sceneTime } from './scene-research.mjs';
import { creationPicks, hasCollectionAccess, libraryHandoffs, libraryScopes, PRIVATE_COLLECTION_SCOPE, readLibraryPage } from './library.mjs';
import { RESEARCH_MODEL, researchPlans } from './research.mjs';
import { QUOTE_SCOPE, LIVE_QUOTE_MAX_AGE_MS, PREVIEW_QUOTE_MAX_AGE_MS, appEstimateBody, estimateAppWorkflow,
  expandedQuoteOptions, matchPreviewQuotes, quotePrice, quoteServiceAdvisories } from './quotes.mjs';
import { GROUPS, appendResultCards, element, evidenceSource, paintCompare, quoteCard, renderModelComparison, renderResults, reorderGalleryCards,
  resultGroupOrder, resultGroups, showQuote, sourceLink } from './view.js';

const byId = id => document.getElementById(id);
const host = byId('host');
const form = byId('search-form');
const searchTools = byId('search-tools');
const searchButton = byId('search-button');
const filterPanel = byId('search-filters');
const pictureButton = byId('add-search-picture');
const searchPictureFiles = byId('search-picture-files');
const alternateSearch = byId('search-as-typed');
const pictureSearch = byId('visual-compose-search');
const cancelButton = byId('cancel-search');
const continueButton = byId('continue-report');
const retryButton = byId('retry-catalog-search');
const searchStatus = byId('search-status');
const resultArea = byId('results');
const resultFilters = byId('result-filters');
const workbench = byId('workbench');
const resultsTitle = byId('results-title');
const resultsJump = byId('results-jump');
const reportThisSearch = byId('report-this-search');
const returnToSearch = byId('return-to-search');
const resultTools = byId('result-tools');
const reviewReleases = byId('review-my-releases');
const exploreGalleryRelease = byId('explore-gallery-release');
const researchArea = byId('deep-search');
const researchTitle = byId('research-title');
const researchToggle = byId('research-jump');
const researchSummary = byId('research-summary');
const compareTray = byId('compare-tray');
const compareFeedback = byId('compare-feedback');
const compareDialog = byId('compare-models');
const quoteButton = byId('quote-button');
const quoteStatus = byId('quote-status');
const receiptStatus = byId('workflow-receipt-status');
const receiptRetry = byId('workflow-receipt-retry');
const accessChange = new DOMException('Civitai access changed. Search again to refresh your results.', 'AbortError');
const connectionNotice = 'The Civitai connection ended. Public search is available. Refresh the page to reconnect.';
const referenceChange = new DOMException('Reference files changed. Run the check again to refresh this report.', 'AbortError');
const visualBriefChange = new DOMException('Visual references changed. Run the reference search again.', 'AbortError');
const probeButton = byId('probe');
const galleryMore = byId('gallery-more');
const galleryStatus = byId('gallery-status');
const galleryActions = byId('gallery-actions');
const libraryActions = byId('library-actions');
const libraryButtons = byId('library-buttons');
const libraryStatus = byId('library-status');
const catalogHandoffs = ['crucibles', 'leaderboards', 'services', 'marketplace', 'auctions', 'prizes', 'apps', ...directoryScopes, ...socialScopes, ...libraryScopes];
const developerPreview = /^dev-[a-f\d]{16}\.civit\.ai$/u.test(location.hostname);
const publishedApp = location.origin === 'https://rasterraid.civit.ai';
const mockPreview = window.parent === window && location.protocol === 'http:' &&
  ['127.0.0.1', 'localhost'].includes(location.hostname) && location.pathname === '/mock-deep-search';
const previewReceipts = new Map();
let context;
let mounted = false;
let activeSearch;
let addingSearchPicture = false;
let activeReferenceSearch;
let activeVisualBrief;
let referenceRevision = 0;
let visualBriefRevision = 0;
let searchPreparation = 0;
let activeQuote;
let quoteExpiry;
let serviceCheck;
let search;
const searchTrail = [];
let reportRecovery;
let configureMock;
let workflowRun;
let workflowOwner;
let selectedMediaTag;
let upgradeDraft;
let libraryRequest;
let probeRequest;
let libraryMode;
let libraryPrivate = false;
const { query, scope } = form.elements;

function completeStartup() {
  if (!mounted || !context || !searchTools.inert) return;
  searchTools.inert = false;
  byId('startup-status').hidden = true;
  byId('startup-recovery').hidden = true;
  document.dispatchEvent(new Event('rasterraid:ready'));
}

function showResults(visible) {
  workbench.hidden = resultsJump.hidden = !visible;
  form.toggleAttribute('data-showing-results', visible && scope.value === search?.filters.scope);
}

function paintSearchPath() {
  const query = search?.filters.query?.trim();
  reportThisSearch.hidden = search?.phase !== 'complete' || search.filters.scope !== 'all' || search.result.target.kind !== 'text' ||
    !query || !Object.values(search.groups).some(group => group.length);
  reportThisSearch.disabled = Boolean(activeSearch);
  const previous = searchTrail.at(-1);
  returnToSearch.hidden = !previous || previous.state.context !== context || search === previous.state;
  returnToSearch.disabled = Boolean(activeSearch);
  if (!returnToSearch.hidden) {
    const label = previous.state.result.target.kind === 'text' && previous.state.filters.query;
    const title = label || previous.title;
    returnToSearch.textContent = title ? 'Back to “' + (title.length > 72 ? title.slice(0, 71) + '…' : title) + '”' : 'Back to previous results';
    returnToSearch.setAttribute('aria-label', returnToSearch.textContent);
  }
}

reportThisSearch.addEventListener('click', () => {
  if (reportThisSearch.hidden || activeSearch || search.context !== context) return;
  rerunSearch({ ...search.filters, scope: 'report', reportType: 'style' }, reportThisSearch);
});

returnToSearch.addEventListener('click', () => {
  if (returnToSearch.hidden || activeSearch) return;
  const { state: original, toolsOpen } = searchTrail.pop();
  clearReportRecovery();
  scope.value = original.filters.scope;
  syncLibraryScope();
  filterControls.restore(original.filters);
  selectedMediaTag = isGalleryScope(original.filters.scope) ? tagRecord(original.filters.selectedMediaTag) ?? undefined : undefined;
  upgradeDraft = upgradeForSearch(original.filters);
  search = original;
  renderSearch(original.result, original.filters, original.context);
  resultTools.open = toolsOpen;
  resultsTitle.focus();
});

function resultBranch(nextScope) {
  if (search?.phase !== 'complete' || search.context !== context || libraryScopes.includes(nextScope) || nextScope === 'ownedModels' ||
      search.result.library || search.result.report || search.result.visualComposition || ['ownedModels', 'report'].includes(search.filters.scope)) return undefined;
  return { state: search, title: resultsTitle.textContent, toolsOpen: resultTools.open };
}

function setResearchOpen(open) {
  if (open && !researchArea.hidden && !researchArea.open) {
    researchArea.showModal();
    researchToggle.setAttribute('aria-expanded', 'true');
    researchTitle.focus();
    checkResearchServices();
  } else if (!open && researchArea.open) {
    researchArea.close();
    researchToggle.setAttribute('aria-expanded', 'false');
  }
}

function showResearchPrices(prices = [], expiresAt) {
  clearTimeout(quoteExpiry);
  const quotes = search?.quotes ?? [];
  const expansions = prices.length ? expandedQuoteOptions(quotes.map(view => view.plan), prices) : [];
  quotes.forEach((view, index) => showQuote(view, prices[index], expansions[index]));
  const totals = prices.flatMap(price => Number.isSafeInteger(price?.total) ? [price.total] : []);
  researchSummary.textContent = totals.length && totals.length === quotes.length ? 'From ' + Math.min(...totals) + ' Buzz' : 'Free quotes';
  if (totals.length && expiresAt) quoteExpiry = setTimeout(() => {
    if (search?.quotes !== quotes) return;
    search.recordedQuote = null;
    showResearchPrices();
    if (activeQuote) return;
    quoteButton.textContent = 'Get live quotes';
    quoteStatus.textContent = 'These estimates expired. Get fresh quotes for the current picks.';
  }, Math.max(0, expiresAt - Date.now()));
}

function checkResearchServices() {
  const views = search?.quotes;
  if (!researchArea.open || !views?.length || mockPreview) return;
  const startedAt = Date.now();
  if (serviceCheck?.views === views && startedAt - serviceCheck.startedAt < LIVE_QUOTE_MAX_AGE_MS) return;
  serviceCheck?.controller.abort();
  const controller = new AbortController();
  const { signal } = controller;
  serviceCheck = { controller, views, startedAt };
  for (const { advisory } of views) {
    advisory.textContent = '';
    advisory.hidden = true;
  }
  void quoteServiceAdvisories(views.map(view => view.plan), { signal }).then(results => {
    if (signal.aborted || search?.quotes !== views || !researchArea.open) return;
    const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date());
    views.forEach(({ advisory }, index) => {
      if (!results[index].length) return;
      advisory.textContent = 'Civitai service advisory · ' + results[index].join(', ') + ' · 24-hour window checked at ' + time;
      advisory.hidden = false;
    });
  }).catch(() => {});
}

researchToggle.addEventListener('click', () => setResearchOpen(true));
byId('close-research').addEventListener('click', () => setResearchOpen(false));
researchArea.addEventListener('close', () => {
  researchToggle.setAttribute('aria-expanded', String(researchArea.open));
  if (researchArea.open) return;
  serviceCheck?.controller.abort();
  serviceCheck = undefined;
});
for (const button of document.querySelectorAll('button[data-close-dialog]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}
byId('review-picks').addEventListener('click', () => {
  if (!search || activeSearch) return;
  const picked = search.result.candidates.filter(candidate => search.chosen.has(candidate.id));
  if (!picked.length) return;
  renderModelComparison(byId('comparison-results'), picked, search.context);
  compareDialog.showModal();
  byId('compare-title').focus();
});
byId('comparison-prices').addEventListener('click', () => {
  if (!search || activeSearch) return;
  compareDialog.close();
  if (!['all', 'models'].includes(search.filter) || search.result.report) selectResultType('models');
  setResearchOpen(true);
});
compareDialog.addEventListener('close', () => {
  if (!compareDialog.open) byId('comparison-results').replaceChildren();
});
workbench.addEventListener('click', event => {
  if (event.target.closest('button[data-open-research]')) setResearchOpen(true);
});

function clearReportRecovery() {
  reportRecovery?.discard();
  reportRecovery = undefined;
  continueButton.hidden = true;
}

function clearSearchResults(current) {
  clearReportRecovery();
  showResearchPrices();
  search = undefined;
  subjectComparison.show(null, current);
  retryButton.hidden = true;
  searchTrail.length = 0;
  paintSearchPath();
  compareDialog.close();
  setResearchOpen(false);
  paintCompareTray();
  exploreGalleryRelease.hidden = true;
  exploreGalleryRelease.onclick = null;
  for (const dialog of document.querySelectorAll('dialog.report-export')) {
    dialog.close();
    dialog.remove();
  }
  renderReport(byId('report-overview'), null, current);
  renderReportChanges(byId('report-changes'), null, current);
  byId('quick-coverage').hidden = true;
  byId('quick-coverage-areas').replaceChildren();
  for (const node of [resultArea, resultFilters, resultsTitle, libraryButtons, libraryStatus, galleryStatus, quoteStatus, byId('gallery-visual-brief'),
    byId('gallery-native'), byId('gallery-model-choices'), byId('result-note'), byId('picks'), byId('research-options')]) node.replaceChildren();
  showResults(false);
}

function setSearchBusy(busy, restore = searchButton) {
  subjectComparison.setSearchBusy(busy);
  form.toggleAttribute('data-searching', busy);
  byId('open-search-areas').disabled = busy;
  byId('reset-search-area').disabled = busy;
  byId('search-suggestion').disabled = busy;
  pictureButton.disabled = busy || addingSearchPicture || !context;
  if (busy) searchButton.setAttribute('aria-disabled', 'true');
  else searchButton.removeAttribute('aria-disabled');
  for (const control of [continueButton, retryButton]) {
    if (busy) control.setAttribute('aria-disabled', 'true');
    else control.removeAttribute('aria-disabled');
  }
  if (!busy && document.activeElement === cancelButton) {
    (restore?.isConnected && restore !== document.body && !restore.closest('[hidden]') ? restore : searchButton).focus({ preventScroll: true });
  }
  cancelButton.hidden = !busy;
  paintSearchPath();
}

const filterControls = createFilterControls(form, () => context);
const updateButtonLayout = configureSearchButtons(window, selectSearchArea);
const cropEditor = createVisualCropEditor(document);
const subjectComparison = configureSubjectComparison(document, renderResearch);
const visualReferences = configureLocalReferences(document, report => {
  if (search?.result.report !== report || !report) return;
  if (visualReferences.researchSelection(report).length) {
    soundMatch.clearSelection(false);
    sceneMatch.clearSelection(false);
  }
  renderResearch();
}, ready => {
  filterControls.setPictureSearchReady(ready);
  refreshScenes();
}, () => {
  referenceRevision++;
  activeReferenceSearch?.abort(referenceChange);
  if (!search?.result.report?.localTrace) return;
  activeQuote?.abort();
  workflowRun?.clearOffer();
  clearSearchResults(context);
  visualReferences.show(null, context);
  soundMatch.show(null, {}, context);
  searchStatus.textContent = referenceChange.message;
}, cropEditor, () => {
  visualBriefRevision++;
  activeVisualBrief?.abort(visualBriefChange);
  if (!search?.result.visualComposition) return;
  activeQuote?.abort();
  workflowRun?.clearOffer();
  clearSearchResults(context);
  soundMatch.show(null, {}, context);
  searchStatus.textContent = visualBriefChange.message;
});
const soundMatch = configureSoundMatch(document, result => {
  if (search?.result !== result || !result) return;
  if (soundMatch.selected(result).picks.length) {
    visualReferences.clearResearchSelection(false);
    sceneMatch.clearSelection(false);
  }
  renderResearch();
}, refreshScenes);
const sceneMatch = configureSceneMatch(document, visualReferences, soundMatch, result => {
  if (search?.result !== result || !result) return;
  if (sceneMatch.selected(result).length) {
    visualReferences.clearResearchSelection(false);
    soundMatch.clearSelection(false);
  }
  renderResearch();
});

function refreshScenes() {
  sceneMatch.show(search?.phase === 'complete' ? search.result : null, search?.context);
}
function rerunSearch(filters, trigger = searchButton, savedSearch) {
  if (!context || activeSearch) return false;
  const branch = [reportThisSearch, exploreGalleryRelease].includes(trigger) ? resultBranch(filters.scope) : undefined;
  selectedMediaTag = isGalleryScope(filters.scope) ? tagRecord(filters.selectedMediaTag) ?? undefined : undefined;
  upgradeDraft = upgradeForSearch(filters);
  scope.value = filters.scope;
  syncLibraryScope();
  filterControls.restore(filters);
  void runSearch(trigger, { restored: filters, savedSearch, branch });
  return true;
}

reviewReleases.addEventListener('click', () => {
  if (search?.result.ownerStatus === 'ready' && search.result.candidates.length) {
    rerunSearch({ ...search.filters, scope: 'report', reportType: 'portfolio' }, reviewReleases);
  }
});

const preferences = configurePreferences(window, {
  getContext: () => context, getSearch: () => search, isSearching: () => Boolean(activeSearch), rerun: rerunSearch,
  onReady() { if (search) renderGroup(); },
  onMediaOrder(enabled, profile) {
    const current = search;
    const media = current?.mediaRanking;
    if (!media) return;
    applyMediaOrder(current, enabled, profile);
    if (['all', media.scope].includes(current.filter) && !reorderGalleryCards(resultArea, media.scope, current.groups[media.scope])) renderGroup();
    preferences.paintResults();
  },
});
const workflowHistory = configureWorkflowHistory(document, { getContext: () => context, onLookup: startExample });
const workspace = configureWorkspace(window, {
  getContext: () => context,
  getSearch: () => search,
  openSearch: rerunSearch,
  openShortlist: openWorkspaceShortlist,
  applyProfile(profile) {
    if (!context || activeSearch || !profile.baseModel) return;
    const prior = Object.fromEntries(new FormData(form));
    filterControls.restore({ ...prior, scope: 'report', reportType: 'workflow', baseModel: profile.baseModel });
    syncLibraryScope();
    query.focus();
    searchStatus.textContent = 'Model family applied. Build a free report when ready.';
  },
});
const publishedWorkflow = configurePublishedWorkflow({ getContext: () => context, openAudit: workspace.openPublishedAudit });
let previousScope = scope.value;

function paintWorkflowOffers() {
  const state = workflowRun?.availability();
  const focused = document.activeElement;
  for (const { runOffer } of search?.quotes ?? []) {
    if (runOffer) runOffer.hidden = state !== 'ready';
  }
  receiptRetry.hidden = !publishedApp || state !== 'unavailable';
  receiptStatus.textContent = !publishedApp ? '' : state === 'checking' ? 'Checking access to your Deep Search receipts…'
    : state === 'unavailable' ? 'Civitai couldn’t open your Deep Search receipts.' : '';
  if (researchArea.open && focused?.hidden && (focused === receiptRetry || focused.classList.contains('workflow-offer'))) {
    quoteButton.focus({ preventScroll: true });
  }
}

receiptRetry.addEventListener('click', () => { void workflowRun?.restore(); });

watchHost(window, update => {
  const reconnected = context?.connectionLost && update.signedIn;
  const identityChanged = context && context.viewerUserId !== update.viewerUserId;
  const visibilityReduced = context && (context.browsingLevel & update.browsingLevel) !== context.browsingLevel;
  const collectionAccessLost = context && hasCollectionAccess(context, libraryPrivate) && !hasCollectionAccess(update, libraryPrivate);
  const quoteAccessLost = context?.scopes.includes(QUOTE_SCOPE) && !update.scopes.includes(QUOTE_SCOPE);
  if (context && (identityChanged || visibilityReduced || collectionAccessLost ||
      context.origin !== update.origin || update.connectionLost && !context.connectionLost)) subjectComparison.release();
  context = update;
  if (search?.context !== update) retryButton.hidden = true;
  if (searchTrail.length && searchTrail.at(-1).state.context !== update) {
    searchTrail.length = 0;
    paintSearchPath();
  }
  if (reportRecovery && !reportRecovery.matches(update)) clearReportRecovery();
  if (!mockPreview) {
    const owner = publishedApp &&
      update.hosted && update.signedIn && update.token && update.storageMode !== 'local-preview' &&
      update.scopes.includes(QUOTE_SCOPE) && update.scopes.includes('apps:storage')
      ? [update.origin, update.viewerUserId, update.browsingLevel].join('#') : null;
    if (owner !== workflowOwner) {
      workflowRun?.dispose();
      workflowRun = owner ? installWorkflowRun(byId('workflow-session'), {
        context: update, client: appRunTransport(update, () => context), journal: appWorkflowJournal(update, () => context),
        onLookup: startExample, onOpenHistory: workflowHistory.open, onAvailability: paintWorkflowOffers,
      }) : undefined;
      workflowOwner = owner;
      paintWorkflowOffers();
    }
  }
  updateButtonLayout(update);
  if (quoteAccessLost) {
    activeQuote?.abort();
    if (search) search.recordedQuote = null;
    showResearchPrices();
    quoteStatus.textContent = 'Quote access changed on Civitai. Get a new quote when ready.';
  }
  if (identityChanged || visibilityReduced || collectionAccessLost) {
    libraryRequest?.abort();
    if (identityChanged || visibilityReduced) {
      probeRequest?.abort(accessChange);
      byId('probe-rows').replaceChildren();
      byId('probe-results').hidden = true;
    }
    if (identityChanged || visibilityReduced || libraryScopes.includes(scope.value)) activeSearch?.abort(accessChange);
    activeQuote?.abort();
    if (identityChanged || visibilityReduced || search?.result.library) {
      clearSearchResults(update);
      searchStatus.textContent = update.connectionLost ? connectionNotice : reconnected
        ? 'Civitai reconnected. Search again for signed-in results.' : accessChange.message;
    }
    if (identityChanged || visibilityReduced) {
      cropEditor.close();
      publishedWorkflow.reset();
      visualReferences.reset();
      visualReferences.show(null, update);
      soundMatch.reset();
      refreshScenes();
      selectedMediaTag = undefined;
      upgradeDraft = undefined;
    }
    libraryMode = undefined;
    libraryPrivate = false;
    if (identityChanged) filterControls.restore({ scope: scope.value });
    else if (scope.value === 'saved') query.value = '';
  }
  workspace.bind(update);
  workflowHistory.bind(update);
  preferences.bind(update);
  const domain = new URL(update.origin).hostname;
  host.textContent = update.hosted ? domain + (update.connectionLost ? ' · Public search' : '') : 'Local preview';
  host.title = update.hosted && !update.token ? 'Public catalog only until Civitai connects the app' : '';
  if (update.connectionLost && !identityChanged && !searchStatus.textContent) searchStatus.textContent = connectionNotice;
  searchButton.disabled = false;
  pictureButton.disabled = Boolean(activeSearch || addingSearchPicture);
  visualReferences.setScope(scope.value, update);
  visualReferences.enableLookup(!activeSearch);
  probeButton.disabled = Boolean(probeRequest);
  filterControls.onHostReady();
  if (search?.recordedQuote && update.scopes.includes(QUOTE_SCOPE)) quoteButton.textContent = 'Get a new live quote';
  completeStartup();
});

byId('diagnostics').hidden = window.parent !== window && !developerPreview;

function rankMediaPage(current, rows) {
  const media = current.mediaRanking;
  const ranked = personalMediaOrder(rows, media.profile, current.context.browsingLevel);
  media.changes += ranked.filter((item, index) => item.id !== rows[index].id).length;
  return ranked;
}

function applyMediaOrder(current, enabled, profile) {
  const media = current.mediaRanking;
  media.enabled = enabled;
  media.profile = enabled ? { mediaEnabled: true, mediaFeedback: profile?.mediaFeedback } : undefined;
  media.changes = 0;
  const rows = current.result.related[media.scope];
  let offset = 0;
  current.groups[media.scope] = media.sizes.flatMap(size => {
    const page = rows.slice(offset, offset + size);
    offset += size;
    return rankMediaPage(current, page);
  });
}

function ratedMedia(current) {
  return current.phase === 'complete' && current.result.gallery?.rateable && !current.result.library
    ? preferences.mediaFeedback(current.context) : null;
}

function renderGroup() {
  const gallery = search.result.gallery;
  const subjectResult = search.phase === 'complete' && (search.filter === 'all' || search.filter === gallery?.scope) ? search.result : null;
  subjectComparison.show(subjectResult, search.context, visualReferences.subjectReferences(subjectResult?.visualComposition));
  if (gallery && isVisualGalleryScope(gallery.scope)) filterControls.showGalleryTagNames(search.groups[gallery.scope] ?? []);
  renderResults(resultArea, search.result, search.groups, search.filter, {
    context: search.context,
    catalogFailure: search.catalogFailure,
    chosen: search.picksEdited ? search.chosen : new Set(),
    loadingDetails: search.phase === 'loading',
    feedback: search.phase === 'complete' && !search.result.library ? preferences.feedback(search.context) : null,
    mediaFeedback: ratedMedia(search),
    toggle: togglePick,
    onTag(tag) { followResult('tag: ' + tag, 'models'); },
    onMediaTag: startMediaTag,
    onLookup: followResult,
    onVisualCrop: focusVisualSearch,
    onHandoff: search.phase === 'complete' && !search.result.library
      ? (model, file) => showModelHandoff(window, search.context, model, file) : undefined,
    onWorkflow: search.phase === 'complete' && search.context.hosted ? publishedWorkflow.open : undefined,
    onShowResultType: search.result.quickCatalog && search.filter === 'all' ? id => {
      selectResultType(id);
      resultArea.querySelector('[data-group="' + id + '"] h3')?.focus();
    } : undefined,
    onVisualReference: search.phase === 'complete' && !search.result.library && (isVisualGalleryScope(search.result.gallery?.scope) || search.result.quickCatalog)
      ? addGalleryReference : undefined,
  });
  preferences.paintResults();
}

async function addGalleryReference(item, trigger) {
  const current = search;
  if (activeSearch || !current?.context || current.phase !== 'complete') return;
  if (!isVisualGalleryScope(scope.value)) {
    scope.value = current.result.gallery?.scope ?? (item.video ? 'videos' : 'gallery');
    syncLibraryScope();
    filterControls.sync();
  }
  const added = await visualReferences.addPublic(item.id, current.context, trigger);
  if (added && current.result.target.kind === 'similarMedia' && query.value === current.filters.query) query.value = '';
}

function paintVisualBrief(brief, current) {
  const area = byId('gallery-visual-brief');
  area.replaceChildren();
  area.hidden = !brief?.cues.length;
  if (area.hidden) return;
  const list = element('ul');
  for (const cue of brief.cues) {
    const row = element('li');
    const label = (cue.polarity === 'avoid' ? 'Avoid ' : 'Match ') + visualRoles[cue.role].toLowerCase();
    const detail = cue.region ? label + ' · ' + visualRegionLabel(cue.region) : label;
    if (cue.public) {
      const link = sourceLink(cue.public.link, cue.label + ' ↗', current);
      const preview = element('img');
      preview.src = cue.public.preview;
      preview.alt = '';
      preview.referrerPolicy = 'no-referrer';
      link.prepend(preview);
      row.append(link);
    } else row.append(element('span', cue.label));
    row.append(element('small', detail));
    list.append(row);
  }
  area.append(list);
}

async function focusVisualSearch(reference, trigger) {
  const previous = search;
  if (activeSearch || previous?.phase !== 'complete' || !previous.result.visualSearch || previous.result.reference !== reference) return;
  const region = previous.result.visualSearch.region;
  trigger.disabled = true;
  let prepared;
  try {
    prepared = await cropEditor.choose(signal => loadPublicPreview(document, reference.preview, signal), region);
  } catch (error) {
    if (search === previous) searchStatus.textContent = error.message;
  } finally {
    trigger.disabled = false;
  }
  if (search !== previous || activeSearch) return;
  if (!prepared || (region?.join(',') ?? '') === (prepared.region?.join(',') ?? '')) {
    trigger.focus({ preventScroll: true });
    return;
  }
  activeSearch = new AbortController();
  const { signal } = activeSearch;
  setSearchBusy(true, trigger);
  resultArea.setAttribute('aria-busy', 'true');
  try {
    const refined = await refineVisualNeighbors(previous.result, prepared, {
      signal, onPhase: message => { searchStatus.textContent = message; },
    });
    signal.throwIfAborted();
    renderSearch(refined, previous.filters, previous.context);
    resultsTitle.focus({ preventScroll: true });
  } catch (error) {
    if (search === previous) {
      searchStatus.textContent = signal.aborted ? 'Area comparison cancelled.' : error.message;
      trigger.focus({ preventScroll: true });
    }
  } finally {
    activeSearch = undefined;
    setSearchBusy(false, trigger);
    resultArea.setAttribute('aria-busy', 'false');
    preferences.paintResults();
  }
}

function selectResultType(id) {
  search.filter = id;
  for (const input of resultFilters.querySelectorAll('input')) input.checked = input.value === id;
  renderGroup();
  renderResearch();
}

function addResultFilter(id, label, count) {
  const option = element('label', null, 'type-filter');
  const input = element('input', null, 'sr-only');
  input.type = 'radio';
  input.name = 'result-type';
  input.value = id;
  input.checked = id === search.filter;
  input.addEventListener('change', () => selectResultType(id));
  option.append(input, document.createTextNode(label));
  if (count) option.append(element('span', String(count)));
  resultFilters.append(option);
}

function renderResultFilters() {
  const { groups, result } = search;
  resultFilters.replaceChildren();
  const populated = resultGroupOrder(result).filter(([id]) => groups[id]?.length);
  if (populated.length > 1 || (result.reference && populated.length)) {
    addResultFilter('all', 'Overview');
    for (const [id, title] of populated) addResultFilter(id, title, groups[id].length);
  }
  resultFilters.hidden = !resultFilters.childElementCount;
  return populated;
}

function renderSearch(result, filters, current, phase = 'complete') {
  const groups = resultGroups(result);
  const resultScope = result.gallery?.scope ?? result.scope ?? (result.target.kind === 'text' ? filters.scope : 'all');
  const catalogFailure = phase === 'complete' ? catalogSearchFailure(result) : null;
  if (result.bountyFacets) filterControls.applyBountyFacets(result.bountyFacets);
  if (result.directoryFacets) filterControls.applyDirectoryFacets(result.directoryFacets, { append: result.directoryFacetsPartial });
  const services = result.serviceCatalog;
  const retiredServiceFilter = services?.facets && filterControls.applyServiceFacets(services.facets, { partial: services.partial });
  const previous = search?.filters === filters ? search : null;
  const preferred = previous?.filter ?? (['audio', 'challenges', 'crucibles', 'services', ...socialScopes, ...libraryScopes].includes(resultScope) ||
    result.exactPost || result.target.kind === 'comic' ? 'all' : resultScope);
  const filter = groups[preferred]?.length ? preferred : 'all';
  const focusedPick = previous && document.activeElement?.dataset?.pick;
  const keepPicks = previous && (previous.phase !== 'loading' || previous.result.candidates.length);
  const chosen = keepPicks ? previous.chosen : new Set(result.shortlisted.map(({ id }) => id));
  const catalogSelections = previous?.catalogSelections ?? new Map();
  search = { result, filters, groups, filter, context: current, chosen, picksEdited: Boolean(previous?.picksEdited || filters.workspaceShortlist),
    catalogSelections, compareVisual: previous?.compareVisual, quotes: [], phase, catalogFailure };
  retryButton.hidden = true;
  if (!previous) resultTools.open = false;
  paintSearchPath();
  paintCompareTray();
  if (phase === 'complete' && result.gallery?.preferenceEligible) {
    const profile = preferences.forSearch(current);
    search.mediaRanking = { scope: resultScope, sizes: [groups[resultScope].length] };
    applyMediaOrder(search, profile?.mediaEnabled === true, profile);
  }
  const searchName = {
    collection: 'Collection', version: 'Model version', model: 'Model', image: 'Image lookup', hash: 'File lookup', asset3d: '3D asset',
    similarMedia: result.target.scene ? 'Clips with matching scenes' : result.target.motion ? 'Clips with similar movement'
      : resultScope === 'videos' ? 'Clips with a similar look' : 'Pictures with a similar look',
    post: 'Post', storyline: 'Storyline',
    bounty: 'Bounty', challenge: 'Challenge', challengeEvent: 'Challenge event', crucible: 'Crucible', leaderboard: 'Leaderboard',
    service: 'Creator service', serviceShop: 'Creator Shop', buzzMarketplace: 'Buzz Marketplace',
    auction: 'Auctions', prize: 'Prizes', user: 'User profile', article: 'Article', tool: 'Tool', app: 'App listing', comic: 'Comic', comicChapter: 'Comic chapter',
    hub: 'Hub', topic: result.target.value, modelReviews: 'Model reviews', comment: 'Comment link', articleComments: 'Article discussion',
  }[result.target.kind];
  const brief = (result.target.value ?? filters.query ?? '').slice(0, 100);
  const libraryTitle = { vault: 'Your Vault', saved: 'Saved & followed', downloads: 'Your downloads', creations: 'Your creation history',
    notifications: 'Your notifications', messages: 'Your messages' }[resultScope];
  const example = result.report?.exampleSetup && result.reference;
  const exampleTitle = example ? (example.video ? 'Clip' : 'Picture') + ' #' + example.id + (example.creator ? ' by ' + example.creator : '') : null;
  const referenceTitle = result.report?.upgrade?.next?.title ?? result.report?.upgrade?.previous?.title ?? result.report?.collectionTrace?.title ?? exampleTitle;
  const compositionTitle = result.visualComposition && (resultScope === 'videos' ? 'Clips by visual reference' : 'Pictures by visual reference');
  resultsTitle.textContent = result.report ? [result.report.title, referenceTitle ?? brief].filter(Boolean).join(' · ')
    : compositionTitle || result.directoryTitle || libraryTitle || searchName || (brief ? 'Results for “' + brief + '”'
    : ({
      challenges: 'Challenges', crucibles: 'Crucibles', leaderboards: 'Leaderboards', services: 'Creator Services', marketplace: 'Buzz Marketplace',
      auctions: 'Auctions', prizes: 'Prizes', hubs: 'Hubs', topics: 'Topics', communities: 'Communities', reviews: 'Reviews', comments: 'Comments',
    }[resultScope] ?? GROUPS[resultScope] ?? 'Browse models'));
  const pause = catalogFailure && catalogPause(current.origin);
  const parts = [];
  if (result.alternateQueries?.length) {
    parts.push('Also searched for ' + result.alternateQueries.map(value => '“' + value + '”').join(' and ') + '.');
  }
  if (resultScope === 'pictures') parts.push('Pictures linked to models found for this search.');
  if (resultScope === 'ownedModels' && result.ownerStatus === 'ready') {
    parts.push('Public releases on your Civitai account.' + (brief && result.target.kind === 'text' ? ' Search for “' + brief + '”.' : ''));
  }
  const hashNote = !result.report && hashLookupNote(result.hashStatus);
  if (hashNote) parts.push(hashNote);
  if (!result.report && result.target.download) parts.push(downloadReferenceNote(result.target, result.candidates));
  reviewReleases.hidden = !(resultScope === 'ownedModels' && result.ownerStatus === 'ready' && result.candidates.length);
  if (services?.missing) parts.push('This service ID is absent from Civitai’s registry.');
  if (services && !services.exact && services.total !== null) {
    parts.push('Checked ' + services.count + (services.partial ? ' of ' + services.total : '') + ' listed services.');
  }
  if (services && !services.missing && !services.partial) parts.push('Median prices and times summarize past requests.');
  if (retiredServiceFilter) parts.push('Civitai removed one of the selected filter choices. Search again to use the current choices.');
  if (resultScope === 'apps' && result.directory?.nextCursor) parts.push('More approved listings are available to search.');
  if (resultScope === 'articles' && catalogOrder('articles', result.directory?.plan.order)?.site) {
    parts.push('This sort searches Civitai article titles. Choose Recommended to also search article text.');
  }
  if (resultScope === 'audio') parts.push('Play public audio and video examples from Civitai’s audio models.');
  if (resultScope === 'assets3d' && result.target.kind !== 'asset3d') parts.push('Search public 3D collections here. Open individual assets and their interactive previews on Civitai.');
  if (resultScope === 'storylines' && result.target.kind !== 'storyline') {
    parts.push('These story links come from public Civitai articles. Browse the native feed for more stories.');
  }
  if (resultScope === 'posts' && !result.exactPost) {
    parts.push(result.gallery.modelMatches ? 'Posts linked to matching model examples.' : 'Posts found through their published pictures and clips.');
  }
  if (resultScope === 'challenges' && result.nativeActions) {
    parts.push('Find challenges linked in public articles. Open Civitai to browse by status or see winners.');
  }
  if (resultScope === 'crucibles' && result.nativeActions) {
    parts.push('Crucibles are head-to-head contests. Find contests linked in public articles, or browse the full feed on Civitai.');
  }
  if (resultScope === 'leaderboards' && result.target.kind !== 'leaderboard') {
    parts.push('Find a board by name or topic. Choose Season or Legacy to see the current rankings on Civitai.');
  }
  if (resultScope === 'services' && !['service', 'serviceShop'].includes(result.target.kind)) {
    parts.push('Find commission articles and links to creator shops. Check live listings, prices, and availability on Civitai.');
  }
  if (resultScope === 'marketplace') {
    parts.push('Civitai’s Buzz Marketplace is under development. Search official articles to learn how Buzz credits work.');
  }
  if (resultScope === 'auctions') parts.push('Find auction information here. Civitai shows live bids and featured spots.');
  if (resultScope === 'prizes') parts.push('Search public prize announcements. My Prizes opens the list for your Civitai account.');
  if (resultScope === 'hubs' && !result.target.key) parts.push('Find hub guides and image feeds that creators have shared in public articles.');
  if (resultScope === 'topics') parts.push('Explore Civitai tags, example pictures, and public collections for this topic.');
  if (resultScope === 'communities') parts.push('Find public collections and articles. Shared image feeds open in Civitai Hubs.');
  if (resultScope === 'reviews') parts.push('Choose a model version to read its reviews on Civitai. Pictures here are model examples.');
  if (resultScope === 'comments' && result.target.kind !== 'comment') {
    parts.push('Find discussions by the model or article they’re on. Open Civitai to read the conversation.');
  }
  if (resultScope === 'vault') parts.push('Search and filter the model versions in your membership Vault on Civitai.');
  if (resultScope === 'downloads') parts.push('Civitai shows your model downloads, with search and date filters.');
  if (resultScope === 'creations') parts.push('Open your full history on Civitai, or choose pictures to preview in this tab.');
  if (resultScope === 'notifications') parts.push('View your notifications in your signed-in Civitai account.');
  if (resultScope === 'messages') parts.push('Choose Chat in Civitai’s header to view your conversations.');
  if (resultScope === 'saved') {
    parts.push(result.library.status === 'followed' ? 'Find followed collections among public catalog matches. Open Collections for your full list.'
      : 'Search your collections by name. Civitai can share private collections with your permission.');
  }
  if (result.visualSearch && result.reference) {
    const { checked, compared, sampled, motion, scene, copiesChecked, possibleCopies } = result.visualSearch;
    if (checked.length) parts.push('Searched ' + checked.join(' · ') + '.');
    if (scene) {
      const names = { appearance: 'picture', motion: 'motion', sound: 'sound' };
      const signals = new Intl.ListFormat('en').format(scene.signals.map(signal => names[signal]));
      const detail = 'Compared using ' + signals + '. Sampled ' + scene.sampled + ' of ' + scene.eligible + ' eligible clips.';
      const soundNote = scene.signals.includes('sound') ? ' Read aligned sound in ' + scene.soundChecked + (scene.soundChecked === 1 ? ' clip.' : ' clips.') : '';
      const matches = scene.matched === 1 ? ' 1 scene match.' : ' ' + (scene.matched || 'No') + ' scene matches.';
      const ready = scene.matched ? (scene.matched === 1 ? '1 scene match is ready.' : scene.matched + ' scene matches are ready.')
        : 'Related clips are ready.';
      parts.push(phase === 'interrupted' ? 'Scene comparison stopped. ' + ready : ({
        checking: ready + ' Comparing more scenes…',
        complete: detail + soundNote + matches,
        'picture-only': 'Picture samples are available. Choose Match appearance to compare them.',
        'no-candidates': 'No related clips with playable previews matched these filters.',
        separate: 'Sound and movement fell in different sampled moments of the reference. Choose Match motion or Match appearance.',
        unavailable: 'Scene comparison was unavailable. Related clips are still shown.',
      }[scene.status]));
    } else if (motion) {
      const comparison = 'Checked movement in ' + motion.checked + ' of ' + motion.eligible + ' eligible clips.';
      const matches = motion.matched === 1 ? ' 1 close match.' : ' ' + (motion.matched || 'No') + ' close matches.';
      parts.push(phase === 'interrupted' ? 'Movement comparison stopped. Showing related clips.' : ({
        checking: 'Related clips are ready. Checking their movement…',
        complete: comparison + matches,
        'no-candidates': 'No related clips with playable previews matched these filters.',
        'unsteady-reference': 'No consistent movement was detected in the sampled moments of the reference clip.',
        unavailable: 'Movement comparison was unavailable. Related clips are still shown.',
      }[motion.status]));
    } else if (compared) {
      parts.push('Compared ' + compared + (compared === 1 ? ' preview' : ' previews') +
        (result.visualSearch.region ? ' using the selected area’s color, lighting, layout, and texture.' : ' for color, lighting, layout, and texture.') +
        (sampled ? ' Also checked frames in ' + sampled + (sampled === 1 ? ' clip.' : ' clips.') : ''));
      if (copiesChecked) parts.push((possibleCopies || 'No') + (possibleCopies === 1 ? ' possible copy in ' : ' possible copies in ') +
        copiesChecked + (copiesChecked === 1 ? ' checked preview.' : ' checked previews.'));
    }
    else if (result.primaryCount) parts.push('Showing related catalog results. Pixel comparison was unavailable.');
    else parts.push('These catalog sources returned no related results.');
  } else if (result.gallery?.modelSource) {
    const { title, version } = result.gallery.modelSource;
    parts.push('Civitai gallery for ' + [title, version].filter(Boolean).join(' · ') + '.');
    if (result.gallery.plan.exclusions?.length) parts.push('Exclusions apply to published tags and descriptions.');
  } else if (result.gallery?.plan?.ranking) {
    parts.push(result.visualComposition ? 'Found through Civitai tags and published descriptions.' : 'Ranked by Civitai tags and published descriptions.');
    if (result.gallery.plan.ranking.excluded.length) parts.push('Exclusions apply to those tags and descriptions.');
  } else if (result.gallery?.tags.length && !result.visualComposition?.referenceTextChecked) {
    if (result.gallery.correctedTag) parts.push('Showing results for the Civitai tag “' + result.gallery.correctedTag + '”.');
    else parts.push('Matching ' + result.gallery.tags.map(tag => '“' + tag.name + '”').join(' and ') + '.');
    if (result.gallery.plan.exclusions?.length) parts.push('Exclusions apply to published tags and descriptions.');
    if (result.gallery.partial && result.gallery.nativeLink && resultScope !== 'posts') parts.push('Use Civitai search for the full description.');
  }
  if (result.visualComposition) {
    const { checked, compared, sampled, unavailableReferences, candidates, referenceMatchesAdded, referenceTextChecked,
      recordedVersionsUnavailable } = result.visualComposition;
    if (compared) parts.push('Compared ' + compared + ' of ' + candidates + ' eligible previews in this browser.');
    else if (candidates) parts.push('Showing catalog results. Visual comparison was unavailable.');
    else if (!referenceTextChecked) parts.push('No previews matched these catalog filters.');
    if (sampled) parts.push('Checked frames in ' + sampled + (sampled === 1 ? ' clip.' : ' clips.'));
    if (referenceMatchesAdded) parts.push('Added ' + referenceMatchesAdded + (referenceMatchesAdded === 1 ? ' match' : ' matches') + ' from related Civitai listings.');
    else if (referenceTextChecked) parts.push('No related listing matched all your search terms.');
    else if (checked.length) parts.push('Searched Civitai listings linked to the selected references.');
    if (referenceTextChecked && referenceMatchesAdded) parts.push('Each added match covers your search terms in its tags or published description.');
    if (unavailableReferences) parts.push(unavailableReferences + (unavailableReferences === 1 ? ' reference was unavailable.' : ' references were unavailable.'));
    if (recordedVersionsUnavailable) parts.push(recordedVersionsUnavailable + (recordedVersionsUnavailable === 1
      ? ' recorded model version could not be verified.' : ' recorded model versions could not be verified.'));
  }
  const selectedFilters = [filters.category, filters.modelAuthor && 'By @' + filters.modelAuthor, modelFilterValues(filters.baseModel).join(' or '),
    modelFilterValues(filters.resourceType).map(modelTypeLabel).join(' or '), filters.fileFormat,
    modelDownloadFilter(filters.downloadAccess)?.label, filters.supportsGeneration === 'true' && 'Supports Civitai generation'].filter(Boolean);
  if (selectedFilters.length) parts.push('Model filters · ' + selectedFilters.join(' · '));
  if (result.nativeModelExclusions) parts.push('Word exclusions apply in RasterRaid.');
  if (catalogFailure && !pause) parts.push('Some Civitai sources could not be checked.');
  byId('result-note').textContent = parts.join(' ');
  const coverage = byId('quick-coverage');
  const quick = result.quickCatalog;
  coverage.hidden = !quick;
  if (!previous) coverage.open = false;
  if (quick) {
    const areas = [...new Set(['Models', 'Collections', 'Articles', 'Creators', 'Tags', ...quick.areas.map(area => GROUPS[area.group])])];
    byId('quick-coverage-areas').textContent = areas.join(' · ') + (quick.status !== 'ready' ? '. Some additional areas were unavailable.' : '');
  } else byId('quick-coverage-areas').textContent = '';
  paintVisualBrief(result.visualComposition, current);
  renderReport(byId('report-overview'), result.report, current, startExample, {
    onCompareSetup: phase === 'complete' ? setup => workspace.openExampleCheck(current, setup) : undefined,
    graphicsMemory: result.report?.upgrade ? workspace.graphicsMemory() : null,
  });
  renderReportChanges(byId('report-changes'), result.searchComparison, current, checkpoint =>
    workspace.refreshSearch(result.savedSearch, checkpoint, current), startExample);
  visualReferences.show(phase === 'loading' ? null : result.report, current);
  soundMatch.show(phase === 'complete' ? result : null, groups, current);

  const populated = renderResultFilters();
  renderGroup();
  renderResearch();
  renderLibraryActions();
  const gallery = result.gallery;
  const releaseReference = ['gallery', 'videos'].includes(gallery?.scope) && (gallery.modelSource?.link ??
    (result.target.kind === 'version' ? filters.query : null));
  exploreGalleryRelease.hidden = !releaseReference;
  exploreGalleryRelease.onclick = releaseReference ? () => {
    const galleryFilters = Object.fromEntries(Object.entries(filters).filter(([key]) => key.startsWith('media')));
    rerunSearch({ ...galleryFilters, scope: 'report', reportType: 'release', query: releaseReference }, exploreGalleryRelease);
  } : null;
  const modelChoices = byId('gallery-model-choices');
  modelChoices.replaceChildren(...(gallery?.modelChoices ?? []).map(({ title, version, link }) => {
    const button = element('button', [title, version].filter(Boolean).join(' · '), 'chip');
    button.type = 'button';
    button.addEventListener('click', () => followResult(link, gallery.scope));
    return button;
  }));
  modelChoices.hidden = !modelChoices.childElementCount;
  const pager = gallery ?? result.directory ?? result.library?.pager ?? result.modelPager;
  const nativeLink = gallery?.nativeLink ?? result.nativeLink;
  const nativeLabel = result.library ? result.library.nativeLabel + ' ↗' : gallery?.modelSource ? 'Browse this release’s gallery on Civitai ↗'
    : result.visualComposition ? 'Open catalog search on Civitai ↗' : ({
    gallery: result.visualSearch?.region ? 'Search from the whole picture on Civitai ↗'
      : gallery?.query || result.visualSearch ? 'Search visually on Civitai ↗' : 'Browse images on Civitai ↗',
    videos: result.target.scene || result.target.motion ? 'Browse related videos on Civitai ↗'
      : gallery?.query ? 'Search videos on Civitai ↗' : 'Browse videos on Civitai ↗',
    assets3d: result.target.kind === 'asset3d' ? 'Open 3D asset on Civitai ↗' : 'Browse 3D models on Civitai ↗',
    storylines: result.target.kind === 'storyline' ? 'Read on Civitai ↗' : 'Browse Storylines on Civitai ↗',
    posts: result.exactPost || result.target.kind === 'post' ? 'Open full post on Civitai ↗' : 'Browse Posts on Civitai ↗',
    bounties: result.target.kind === 'bounty' ? 'Open bounty on Civitai ↗' : 'Browse Bounties on Civitai ↗',
    challenges: result.nativeActions ? 'Browse Challenges on Civitai ↗' : 'Open challenge on Civitai ↗',
    crucibles: result.target.kind === 'crucible' ? 'Open contest on Civitai ↗' : 'Browse Crucibles on Civitai ↗',
    leaderboards: result.target.kind === 'leaderboard' ? 'Open leaderboard on Civitai ↗' : 'Browse all leaderboards on Civitai ↗',
    services: result.target.kind === 'service' ? 'Open service on Civitai ↗' : result.target.kind === 'serviceShop'
      ? 'Open Creator Shop on Civitai ↗' : 'Browse Creator Services on Civitai ↗',
    marketplace: 'Open Buzz Marketplace on Civitai ↗',
    auctions: result.target.slug ? 'Open auction on Civitai ↗' : 'Browse Auctions on Civitai ↗',
    prizes: result.target.id ? 'Open prize on Civitai ↗' : 'My Prizes on Civitai ↗',
    users: result.target.kind === 'user' ? 'Open profile on Civitai ↗' : 'Search Users on Civitai ↗',
    articles: result.target.kind === 'article' ? 'Read article on Civitai ↗' : 'Search Articles on Civitai ↗',
    collections: 'Search Collections on Civitai ↗',
    tools: result.target.kind === 'tool' ? 'Open tool on Civitai ↗' : 'Search Tools on Civitai ↗',
    apps: result.target.kind === 'app' ? 'Open listing on Civitai ↗' : 'Open App Store on Civitai ↗',
    comics: ['comic', 'comicChapter'].includes(result.target.kind) ? 'Open comic on Civitai ↗' : 'Browse Comics on Civitai ↗',
    hubs: result.target.key ? 'Open hub on Civitai ↗' : 'Browse Hubs on Civitai ↗',
    topics: 'Open tag page on Civitai ↗',
    communities: result.target.kind === 'collection' ? 'Open collection on Civitai ↗' : 'Search articles on Civitai ↗',
    reviews: result.target.kind === 'text' || result.target.kind === 'tag' ? 'Search models on Civitai ↗' : 'Read reviews on Civitai ↗',
    comments: result.target.kind === 'comment' ? 'Open comment on Civitai ↗' : 'Open discussion on Civitai ↗',
    ownedModels: current.signedIn ? 'Open my models on Civitai ↗' : 'Open Civitai to sign in ↗',
  }[resultScope] ?? (['all', 'models', 'pictures'].includes(resultScope) ? 'Continue model search on Civitai ↗' : 'Search on Civitai ↗'));
  const actionsFirst = catalogHandoffs.includes(resultScope);
  if (actionsFirst && galleryActions.nextElementSibling !== resultArea) resultArea.before(galleryActions);
  if (!actionsFirst && resultArea.nextElementSibling !== galleryActions) resultArea.after(galleryActions);
  galleryActions.classList.toggle('gallery-actions-top', actionsFirst);
  galleryActions.hidden = !(pager?.nextCursor || nativeLink);
  galleryMore.hidden = !pager?.nextCursor;
  galleryMore.textContent = 'Load more ' + ({
    videos: 'videos', audio: 'audio', posts: 'posts', bounties: 'bounties', users: 'users', articles: 'articles', tools: 'tools', comics: 'comics',
    collections: 'collections', apps: 'apps', aiServices: 'services', libraryCollections: 'collections', libraryMedia: 'previews', models: 'models',
  }[pager?.scope] ?? 'images');
  galleryStatus.textContent = '';
  const nativeLinks = nativeLink ? [sourceLink(nativeLink, nativeLabel, current)] : [];
  for (const action of result.nativeActions ?? []) {
    const link = sourceLink(action.link, action.label + ' ↗', current);
    if (actionsFirst) link.className = 'chip';
    nativeLinks.push(link);
  }
  byId('gallery-native').replaceChildren(...nativeLinks);
  showResults(true);
  if (focusedPick) resultArea.querySelector('[data-pick="' + focusedPick + '"]')?.focus({ preventScroll: true });
  const count = populated.filter(([id]) => (id !== 'pictures' || resultScope === 'pictures') && id !== 'postMedia')
    .reduce((total, [id]) => total + groups[id].length, result.reference ? 1 : 0);
  const matchLabel = result.target.scene || result.target.motion ? result.primaryCount + (result.primaryCount === 1 ? ' related clip' : ' related clips')
    : services?.matches > count ? count + ' of ' + services.matches + ' matches shown'
    : count + (count === 1 ? ' match' : ' matches');
  searchStatus.textContent = phase === 'loading' ? result.report ? 'Some report sources are ready. Searching the rest…'
    : result.target.scene ? 'Related clips ready. Checking short scenes…'
    : result.target.motion ? 'Related clips ready. Checking movement…'
    : result.visualSearch || result.visualComposition ? 'Preview matches ready. Checking video frames…' : 'Ranked results ready. Loading pictures and related matches…' : pause
      ? (count ? count + (count === 1 ? ' match · ' : ' matches · ') : '') + pause.message : count
    ? matchLabel + (catalogFailure ? ' · Search incomplete' : ' · Free search')
    : result.library ? 'Choose an option below.'
    : catalogFailure ? 'Search incomplete. Some Civitai sources could not be checked.'
    : ['asset3d', 'storyline', 'challenge', 'challengeEvent', 'crucible', 'leaderboard', 'service', 'serviceShop', 'buzzMarketplace',
      'auction', 'prize', 'user', 'article', 'tool', 'comic', 'comicChapter', 'app', 'hub', 'topic', 'modelReviews', 'comment', 'articleComments'].includes(result.target.kind)
      ? 'Ready to open on Civitai.' : 'No matches this time.';
}

function renderLibraryActions() {
  libraryButtons.replaceChildren();
  libraryStatus.textContent = '';
  const result = search.result;
  const library = result.library;
  libraryActions.hidden = !library || !['saved', 'creations'].includes(library.scope);
  if (libraryActions.hidden) return;

  if (context?.connectionLost) {
    libraryStatus.textContent = connectionNotice;
    return;
  }

  function action(label, run) {
    const button = element('button', label, 'chip');
    button.type = 'button';
    button.addEventListener('click', run);
    libraryButtons.append(button);
  }

  if (library.scope === 'saved') {
    if (!hasCollectionAccess(context)) {
      libraryStatus.textContent = context?.signedIn ? 'This preview has no collection access. Open Collections on Civitai.'
        : 'Sign in on Civitai to see your collections.';
      return;
    }
    const hasPrivate = hasCollectionAccess(context, true);
    action(hasPrivate ? 'Search my collections, including private' : 'Search my public collections', () => searchCollections('mine', hasPrivate));
    if (!hasPrivate) action('Include private collections', grantCollections);
    action('Find followed collections', () => searchCollections('followed', false));
    if (library.status === 'followed-needs-query') libraryStatus.textContent = 'Enter part of a collection name to find it.';
    if (library.includesPrivate) libraryStatus.textContent = 'Private results are visible in this tab.';
    if (library.pager) action('Clear collection results', () => {
      libraryMode = undefined;
      libraryPrivate = false;
      startExample('', 'saved');
    });
    return;
  }

  if (!context?.signedIn) {
    libraryStatus.textContent = 'Sign in on Civitai to select your pictures.';
    return;
  }
  action('Pick generated pictures', () => openCreationPicker('generated'));
  action('Pick posted pictures', () => openCreationPicker('posted'));
  if (result.related.pickedCreations?.length) action('Clear previews', () => {
    renderSearch({ ...result, related: {} }, search.filters, context);
  });
}

function searchCollections(mode, includePrivate) {
  if (activeSearch || libraryRequest || search?.result.scope !== 'saved') return;
  libraryMode = mode;
  libraryPrivate = includePrivate;
  startExample(query.value, 'saved');
  if (mode === 'followed' && !query.value.trim()) query.focus();
}

async function grantCollections() {
  if (activeSearch || libraryRequest) return;
  const initial = search;
  const controller = new AbortController();
  libraryRequest = controller;
  libraryStatus.textContent = 'Waiting for your permission on Civitai…';
  const allowed = await context.requestPrivateCollections(AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]));
  if (libraryRequest === controller) libraryRequest = undefined;
  if (controller.signal.aborted || search !== initial) return;
  if (allowed && hasCollectionAccess(allowed, true)) searchCollections('mine', true);
  else libraryStatus.textContent = 'Private collections stay hidden until you grant access on Civitai.';
}

async function openCreationPicker(source) {
  if (activeSearch || libraryRequest || !context?.pickCreations) return;
  const initial = search;
  const controller = new AbortController();
  libraryRequest = controller;
  libraryStatus.textContent = 'Choose the pictures you want to share from Civitai.';
  const data = await context.pickCreations(source, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
  if (libraryRequest === controller) libraryRequest = undefined;
  if (controller.signal.aborted || search !== initial) return;
  const items = creationPicks(context.origin, data, source, context.browsingLevel);
  if (items.length) renderSearch({ ...initial.result, related: { pickedCreations: items } }, initial.filters, context);
  else libraryStatus.textContent = data?.length ? 'No selected pictures are available at the current browsing level.'
    : data ? 'No pictures selected.' : 'The picker is unavailable here. Open your history on Civitai.';
}

function paintCompareTray() {
  const count = search?.picksEdited ? search.chosen.size : 0;
  compareTray.hidden = !count;
  byId('compare-count').textContent = count + (count === 1 ? ' model selected' : ' models selected');
  compareFeedback.textContent = '';
}

function togglePick(id, fromSuggestions = false) {
  if (!search.picksEdited && !fromSuggestions) search.chosen.clear();
  search.picksEdited = true;
  if (search.chosen.has(id)) search.chosen.delete(id);
  else if (search.chosen.size < 3) search.chosen.add(id);
  else {
    compareFeedback.textContent = 'Up to 3 models. Remove a pick to add another.';
    return;
  }
  for (const button of resultArea.querySelectorAll('[data-pick]')) paintCompare(button, search.chosen.has(Number(button.dataset.pick)));
  paintCompareTray();
  renderResearch();
}

function renderResearch() {
  activeQuote?.abort();
  activeQuote = undefined;
  workflowRun?.clearOffer();
  quoteButton.removeAttribute('aria-disabled');
  quoteButton.disabled = search.phase === 'loading' || search.phase === 'interrupted';
  quoteButton.textContent = context.hosted && !context.signedIn && !context.connectionLost ? 'Sign in for live quotes' : 'Get live quotes';
  quoteStatus.textContent = '';
  showResearchPrices();
  serviceCheck?.controller.abort();
  serviceCheck = undefined;
  search.recordedQuote = null;
  search.quotes = [];
  const selectedReport = search.result.report;
  const visual = visualResearch(selectedReport, search.context.origin, visualReferences.researchSelection(selectedReport));
  const soundSelection = soundMatch.selected(search.result);
  const sound = soundResearch(soundSelection.available, soundSelection.picks, search.context.origin);
  const scenes = sceneResearch(selectedReport, search.context.origin, sceneMatch.selected(search.result));
  const local = scenes ?? visual ?? sound;
  const report = search.filter === 'all' || local ? selectedReport : null;
  const reportPlans = report && !local ? reportResearchPlans(report) : null;
  const subjectOrder = subjectComparison.orderFor(search.result);
  const neighbors = report || local ? null : galleryCompositionResearch(search.result, search.context.origin, subjectOrder) ??
    gallerySimilarityResearch(search.result, search.context.origin, subjectOrder) ?? galleryCandidateResearch(search.result, search.context.origin, subjectOrder);
  const visualMode = Boolean(neighbors && search.compareVisual !== false);
  const legacyMock = report || local || neighbors ? null : configureMock;
  const modelMode = Boolean(legacyMock || !report && !local && search.result.candidates.length && ['all', 'models'].includes(search.filter));
  const catalog = modelMode || report || local || visualMode ? null : catalogResearch(search.result, search.groups, search.filter, search.context.origin,
    search.catalogSelections.get(search.filter));
  if (catalog?.picks.length && !search.catalogSelections.has(search.filter)) {
    search.catalogSelections.set(search.filter, new Set(catalog.picks.map(item => item.key)));
  }
  const reportOffer = report?.evidence.length && (quoteButton.disabled || reportPlans?.length || local);
  researchArea.hidden = !(modelMode || reportOffer || local || visualMode || catalog?.available.length);
  for (const button of workbench.querySelectorAll('button[data-open-research]')) button.disabled = researchArea.hidden;
  researchToggle.hidden = researchArea.hidden;
  if (researchArea.hidden) {
    setResearchOpen(false);
    return;
  }

  const picked = search.result.candidates.filter(candidate => search.chosen.has(candidate.id));
  const picks = byId('picks');
  const options = byId('research-options');
  const pickerOpen = byId('catalog-picks')?.open === true;
  const focusedKey = document.activeElement?.dataset?.catalogPick;
  picks.replaceChildren();
  options.replaceChildren();
  byId('quote-actions').hidden = mockPreview || (!visualMode && !(modelMode ? picked : local?.picks ?? report?.evidence ?? catalog.picks).length);
  byId('research-intro').textContent = legacyMock ? 'Local simulation · Compare the base model recorded for each pick. 0 Buzz used.' : modelMode
    ? 'See prices for different ways to compare your picks. Civitai charges in Buzz credits.'
    : scenes ? 'Price a closer look at the selected public scenes. Your reference files stay in your browser.'
      : visual ? 'Price a closer look at your selected public media and video times. Local reference files stay in your browser.'
      : sound ? 'Price a closer look at the selected public recordings. Local sound references stay in your browser.'
      : report ? mockPreview ? 'Try the combined workflow in the local simulation.' : 'Price a closer analysis of the evidence in this report.'
      : visualMode ? neighbors.publicMatches
        ? 'Price a closer look at the listed public previews. Your local references stay in your browser.'
        : neighbors.references ? 'Price an AI review of your Civitai reference traits and a sample of these results.'
          : 'Price a comparison of the whole Civitai reference and a sample of the related previews.'
      : 'Choose up to three public results and check what a closer look would cost in Buzz.';
  if (configureMock) {
    byId('mock-heading').parentElement.hidden = !legacyMock;
    if (legacyMock) legacyMock(picked, search.filters, search.context.origin);
  }
  if (local) {
    const label = scenes ? scenePickLimit + ' public scenes' : sound ? soundPickLimit + ' public recordings' : visualPickLimit + ' visual matches';
    picks.append(element('p', local.picks.length + ' of ' + label + ' selected'));
    const list = element('ul', null, 'pick-list catalog-pick-summary visual-pick-summary');
    for (const [index, item] of local.picks.entries()) {
      const itemRow = element('li');
      itemRow.append(sourceLink(item.link, item.title, search.context));
      const description = scenes ? 'Frame near ' + sceneTime(item.seconds) + ' · Sound ' + sceneTime(item.start) + '–' + sceneTime(item.end)
        : sound ? 'Audio near ' + item.seconds + ' s' :
        [item.kind === 'clip' ? 'Frame near ' + item.seconds + ' s' : item.kind === 'poster' ? 'Video poster' : 'Public picture',
          index === 0 && local.picks.length > 1 && 'Similarity reference'].filter(Boolean).join(' · ');
      itemRow.append(element('span', description));
      list.append(itemRow);
    }
    const clear = element('button', report ? 'Use full report' : 'Use regular comparison', 'chip');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      if (scenes) sceneMatch.clearSelection();
      else if (sound) soundMatch.clearSelection();
      else visualReferences.clearResearchSelection();
      (byId('quote-actions').hidden ? researchTitle : quoteButton).focus({ preventScroll: true });
    });
    picks.append(list, clear);
  } else if (report) {
    const sources = report.rails.filter(rail => rail.count).map(rail => rail.label);
    if (sources.length) picks.append(element('p', sources.join(' · ')));
  } else if (visualMode && neighbors.publicMatches) {
    if (neighbors.writtenSearch) picks.append(element('p', 'Search words used · ' + neighbors.writtenSearch));
  } else if (visualMode) {
    const sources = neighbors.references ?? [neighbors.reference];
    for (const source of sources) {
      const reference = element('p', (source.cue ?? 'Reference') + ' · ');
      reference.append(sourceLink(source.link, source.title, search.context));
      picks.append(reference);
    }
  } else if (!modelMode) {
    renderCatalogPicks(picks, catalog, pickerOpen, focusedKey);
  } else if (!picked.length) {
    picks.append(element('p', 'Use Compare on any model to choose up to three.'));
    if (search.result.shortlisted.length) {
      const restore = element('button', 'Use suggested models', 'chip');
      restore.type = 'button';
      restore.addEventListener('click', () => {
        search.chosen = new Set(search.result.shortlisted.map(({ id }) => id));
        search.picksEdited = false;
        paintCompareTray();
        renderResearch();
        researchTitle.focus({ preventScroll: true });
      });
      picks.append(restore);
    }
    return;
  } else {
    picks.append(element('p', search.picksEdited ? picked.length + ' of 3 selected' : 'Suggested models'));
    const list = element('ul', null, 'pick-list model-pick-list');
    for (const entry of picked) {
      const row = element('li');
      const title = [entry.model, entry.version].filter(Boolean).join(' · ');
      const name = element('span', title, 'pick-name');
      const cover = entry.examples.find(item => item.preview)?.preview;
      if (cover) {
        const preview = element('img');
        preview.alt = '';
        preview.loading = 'lazy';
        preview.referrerPolicy = 'no-referrer';
        preview.src = cover;
        preview.addEventListener('error', () => preview.remove(), { once: true });
        row.append(preview);
      }
      const remove = element('button', null, 'remove-pick');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + title + ' from Deep Search');
      const cross = element('span', '×');
      cross.setAttribute('aria-hidden', 'true');
      remove.append(cross);
      remove.addEventListener('click', () => {
        togglePick(entry.id, true);
        (picks.querySelector('button') ?? researchTitle).focus();
      });
      row.append(name, remove);
      list.append(row);
    }
    picks.append(list);
  }
  if (neighbors) {
    const mode = element('button', visualMode ? 'Compare selected results' : neighbors.publicMatches ? 'Compare public previews' : 'Compare visual matches', 'chip');
    mode.type = 'button';
    mode.id = 'change-visual-research-mode';
    mode.addEventListener('click', () => {
      search.compareVisual = !visualMode;
      renderResearch();
      byId(mode.id)?.focus({ preventScroll: true });
    });
    picks.append(mode);
  }

  if (legacyMock) return;
  if (quoteButton.disabled) {
    search.quotes = [];
    quoteStatus.textContent = search.phase === 'interrupted'
      ? reportRecovery ? 'Finish the report to get a quote.' : 'Start a new search to prepare a quote.'
      : 'Preparing the picture details for quotes…';
    return;
  }
  const plans = (visualMode ? neighbors.plans : null) ?? local?.plans ?? reportPlans ?? catalog?.plans ??
    researchPlans({ ...search.result, shortlisted: picked }, search.filters, { model: RESEARCH_MODEL });
  search.quotes = plans.map(plan => ({ plan, ...quoteCard(plan, search.context) }));
  const sources = visualMode ? neighbors.plans.at(-1).sources : local?.sources ?? report?.evidence ?? (modelMode ? picked.map(candidate => ({
    title: [candidate.model, candidate.version].filter(Boolean).join(' · '), link: candidate.link,
  })) : catalog.picks);
  if (publishedApp || mockPreview && (report || local || neighbors)) for (const view of search.quotes) {
    const button = element('button', mockPreview ? 'Try simulation' : 'Review run', 'chip workflow-offer');
    button.type = 'button';
    button.addEventListener('click', () => {
      setResearchOpen(false);
      workflowRun?.offer(view.plan, view.plan.sources ?? sources, view.advisory.textContent);
    });
    view.card.append(button);
    view.runOffer = button;
  }
  options.append(...search.quotes.map(view => view.card));
  paintWorkflowOffers();
  checkResearchServices();
  if (developerPreview && search.quotes.length) showVerifiedPreviewEstimate(search, search.quotes);
}

function renderCatalogPicks(container, { available, picks }, open, focusedKey) {
  container.replaceChildren();
  const selected = new Set(picks.map(item => item.key));
  const list = element('ul', null, 'pick-list catalog-pick-summary');
  for (const item of picks) {
    const row = element('li');
    const link = evidenceSource(item, search.context, startExample);
    link.title = item.title;
    row.append(link);
    list.append(row);
  }
  if (picks.length) container.append(list);
  const details = element('details', null, 'catalog-picks');
  details.id = 'catalog-picks';
  details.open = open || !picks.length;
  details.append(element('summary', 'Choose results · ' + picks.length + ' of 3 picked'));
  const choices = element('div', null, 'catalog-pick-choices');
  let focused;
  for (const item of available) {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    input.dataset.catalogPick = item.key;
    input.checked = selected.has(item.key);
    input.disabled = selected.size >= 3 && !input.checked;
    input.addEventListener('change', () => {
      if (input.checked) selected.add(item.key);
      else selected.delete(item.key);
      search.catalogSelections.set(search.filter, selected);
      renderResearch();
    });
    if (item.key === focusedKey) focused = input;
    label.append(input, element('span', item.title));
    choices.append(label);
  }
  details.append(choices);
  container.append(details);
  focused?.focus({ preventScroll: true });
}

function previewReceipt(origin) {
  let pending = previewReceipts.get(origin);
  if (!pending) {
    const url = new URL('../preview-quotes.json', import.meta.url);
    url.searchParams.set('domain', new URL(origin).hostname.split('.').at(-1));
    const signedEntry = new URL(location.href).searchParams.get('dev');
    if (developerPreview && signedEntry && url.origin === location.origin) url.searchParams.set('dev', signedEntry);
    pending = fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7_000) })
      .then(response => response.ok && response.headers.get('content-type')?.includes('application/json') ? response.json() : null)
      .catch(() => null);
    previewReceipts.set(origin, pending);
  }
  return pending;
}

async function showVerifiedPreviewEstimate(current, quotes) {
  try {
    const origin = current.context.origin;
    const receipt = await previewReceipt(origin);
    const plans = quotes.map(view => view.plan);
    const matches = await Promise.all((Array.isArray(receipt) ? receipt : [receipt]).map(batch => matchPreviewQuotes(batch, origin, plans)));
    const match = matches.find(Boolean);
    if (!match || search !== current || search.quotes !== quotes || activeQuote) return;
    search.recordedQuote = match;
    paintPreviewEstimate(match);
  } catch {
    // Live quotes still use the Civitai host if the preview receipt cannot be read.
  }
}

function paintPreviewEstimate(match) {
  showResearchPrices(match.prices, match.capturedAt + PREVIEW_QUOTE_MAX_AGE_MS);
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(match.capturedAt);
  quoteStatus.textContent = 'Civitai estimate for these picks · developer quote captured at ' + time + ' · 0 Buzz used.';
  quoteButton.textContent = context.scopes.includes(QUOTE_SCOPE) ? 'Get a new live quote' : 'Show preview quotes';
}

function followResult(example, targetScope = 'all', tag, reportType, visualCrop) {
  startExample(example, targetScope, tag, reportType, visualCrop, resultBranch(targetScope));
}

function startExample(example, targetScope = 'all', tag, reportType, visualCrop, branch) {
  if (!context || activeSearch) return;
  selectedMediaTag = tag;
  upgradeDraft = undefined;
  scope.value = targetScope;
  syncLibraryScope();
  query.value = libraryHandoffs.includes(targetScope) ? '' : example;
  if (targetScope === 'report' && reportType && (reportType !== 'creator' || form.elements.reportType.value !== 'creator')) {
    filterControls.selectReportType(reportType);
  }
  filterControls.sync();
  void runSearch(searchButton, { visualCrop, followInput: targetScope === 'all', branch });
}

function selectSearchArea(next) {
  if (activeSearch) return;
  if (context && libraryScopes.includes(next)) {
    startExample(next === 'saved' && previousScope === 'saved' ? query.value : '', next);
    return;
  }
  searchPreparation++;
  filterPanel.open = false;
  scope.value = next;
  syncLibraryScope();
  filterControls.sync();
  form.removeAttribute('data-showing-results');
  query.focus();
}

byId('reset-search-area').addEventListener('click', () => selectSearchArea('all'));

function syncLibraryScope() {
  const next = scope.value;
  visualReferences.setScope(next, context);
  if (previousScope === next) return;
  libraryRequest?.abort();
  if (previousScope === 'saved') {
    query.value = '';
    libraryMode = undefined;
    libraryPrivate = false;
  }
  if (search?.result.library && previousScope === search.result.scope) {
    search = undefined;
    resultArea.replaceChildren();
    libraryButtons.replaceChildren();
    byId('gallery-native').replaceChildren();
    showResults(false);
  }
  previousScope = next;
}

function startMediaTag(tag, group) {
  if (search?.result.report?.publicWork) {
    rerunSearch({ scope: 'report', reportType: 'publicWork', query: tag.name });
    return;
  }
  const target = isGalleryScope(group) ? group : search.result.gallery?.scope ?? 'gallery';
  followResult(tag.name, target, tag);
}

async function openWorkspaceShortlist(entry) {
  if (!context || activeSearch) return;
  clearReportRecovery();
  searchTrail.length = 0;
  const current = context;
  activeSearch = new AbortController();
  activeQuote?.abort();
  workflowRun?.clearOffer();
  const { signal } = activeSearch;
  setSearchBusy(true);
  searchStatus.textContent = 'Checking saved model versions on Civitai…';
  try {
    const { candidates, unavailable, unavailableFiles, flows } = await reopenShortlist(current, entry.versions, { signal });
    signal.throwIfAborted();
    const filters = { scope: 'models', query: '', workspaceShortlist: true };
    filterControls.restore(filters);
    syncLibraryScope();
    const result = { scope: 'models', target: { kind: 'text', value: '' }, directoryTitle: entry.name, related: {}, reference: null,
      candidates, shortlisted: candidates.slice(0, 3), guides: [], flows, alternateQueries: [], baseline: [], combined: [] };
    renderSearch(result, filters, current);
    searchStatus.textContent = [candidates.length + (candidates.length === 1 ? ' verified model version' : ' verified model versions'),
      unavailable.length && unavailable.length + (unavailable.length === 1 ? ' version unavailable' : ' versions unavailable'),
      unavailableFiles.length && unavailableFiles.length + (unavailableFiles.length === 1 ? ' saved file unavailable' : ' saved files unavailable'),
    ].filter(Boolean).join(' · ');
  } catch (error) {
    searchStatus.textContent = signal.reason === accessChange ? context.connectionLost ? connectionNotice : accessChange.message
      : signal.aborted ? 'Stopped checking the shortlist.'
      : error.message || 'Could not reopen the shortlist.';
  } finally {
    activeSearch = undefined;
    setSearchBusy(false);
  }
}

function canAddSearchPicture() {
  return !pictureButton.disabled && !pictureButton.hidden;
}

async function addSearchPictures(supplied) {
  if (!canAddSearchPicture() || !supplied.length) return;
  const pictures = supplied.filter(isReferencePictureFile);
  if (!pictures.length) {
    searchStatus.textContent = 'Choose a JPEG, PNG, WebP, GIF, AVIF, or BMP picture.';
    return;
  }
  const startingScope = scope.value;
  const { origin, viewerUserId, browsingLevel } = context;
  searchPreparation++;
  addingSearchPicture = true;
  pictureButton.disabled = true;
  searchStatus.textContent = 'Reading pictures on this device…';
  let added;
  try {
    added = await visualReferences.addFiles(pictures, { pictureSearch: true });
  } finally {
    addingSearchPicture = false;
    pictureButton.disabled = Boolean(activeSearch);
  }
  if (scope.value !== startingScope || context.origin !== origin || context.viewerUserId !== viewerUserId ||
      context.browsingLevel !== browsingLevel) return;
  if (added && startingScope === 'all') {
    scope.value = 'gallery';
    syncLibraryScope();
    filterControls.sync();
  }
  const importStatus = byId('visual-reference-status').textContent;
  searchStatus.textContent = added ? 'Pictures stay on this device. ' + importStatus : importStatus || 'This picture could not be added.';
  if (added && [pictureButton, query, document.body].includes(document.activeElement)) query.focus();
}

pictureButton.addEventListener('click', () => searchPictureFiles.click());
searchPictureFiles.addEventListener('change', () => {
  const files = [...searchPictureFiles.files];
  searchPictureFiles.value = '';
  void addSearchPictures(files);
});
query.addEventListener('paste', event => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  const pasted = clipboard.getData('text/plain');
  if (pasted.trim()) {
    try {
      const download = civitaiDownloadReference(pasted);
      if (download) {
        event.preventDefault();
        query.value = download.download.link;
        query.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (error) {
      event.preventDefault();
      searchStatus.textContent = error.message;
    }
    return;
  }
  if (!canAddSearchPicture()) return;
  const pictures = [...clipboard.files];
  if (!pictures.length) for (const item of clipboard.items) {
    const file = item.kind === 'file' && item.getAsFile();
    if (file) pictures.push(file);
  }
  if (!pictures.length) return;
  event.preventDefault();
  void addSearchPictures(pictures);
});
const searchField = query.closest('.query-field');
searchField.addEventListener('dragover', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  const accepted = canAddSearchPicture();
  event.dataTransfer.dropEffect = accepted ? 'copy' : 'none';
  searchField.toggleAttribute('data-file-over', accepted);
});
searchField.addEventListener('dragenter', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
searchField.addEventListener('dragleave', event => {
  if (!searchField.contains(event.relatedTarget)) searchField.removeAttribute('data-file-over');
});
searchField.addEventListener('drop', event => {
  searchField.removeAttribute('data-file-over');
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  void addSearchPictures([...event.dataTransfer.files]);
});
alternateSearch.addEventListener('click', () => void runSearch(alternateSearch));
byId('search-suggestion').addEventListener('click', () => {
  const suggestion = scope.value === 'all' && !filterControls.searchAction() && suggestedCatalogSearch(query.value);
  if (!suggestion || !context || activeSearch) return;
  searchButton.focus({ preventScroll: true });
  startExample(suggestion.query, suggestion.scope);
});

form.addEventListener('click', event => {
  const submitter = event.target.closest('button[type="submit"]');
  if (submitter?.form === form) {
    event.preventDefault();
    void runSearch(submitter);
    return;
  }
  const example = event.target.closest('[data-example]');
  if (example) startExample(example.dataset.example, example.dataset.scope, undefined, example.dataset.reportType);
});
form.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.defaultPrevented && filterPanel.open && filterPanel.contains(event.target)) {
    event.preventDefault();
    filterPanel.open = false;
    filterPanel.querySelector('summary').focus();
    return;
  }
  if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || !(event.target instanceof HTMLInputElement) ||
      !['text', 'search', 'number'].includes(event.target.type)) return;
  event.preventDefault();
  void runSearch(filterPanel.contains(event.target) ? byId('apply-search-filters') : searchButton);
});
scope.addEventListener('change', syncLibraryScope);
document.addEventListener('pointerdown', event => {
  if (filterPanel.open && !filterPanel.contains(event.target) && !byId('active-filters').contains(event.target)) filterPanel.open = false;
});
query.addEventListener('input', () => { selectedMediaTag = undefined; upgradeDraft = undefined; });

form.addEventListener('submit', event => {
  event.preventDefault();
  void runSearch(event.submitter ?? searchButton);
});

async function runSearch(submitter = searchButton, { restored, visualCrop, savedSearch, followInput = true, branch } = {}) {
  if (activeSearch || addingSearchPicture || !context || submitter.disabled) return;
  const applyFilters = submitter.id === 'apply-search-filters';
  try {
    const download = civitaiDownloadReference(query.value);
    if (download) query.value = download.download.link;
  } catch (error) {
    searchStatus.textContent = error.message;
    return;
  }
  const address = query.value.trim();
  const link = !restored && scope.value !== 'report' ? URL.parse(address) : null;
  if (link && clipMatchTarget(link) && scope.value !== 'videos') {
    scope.value = 'videos';
    syncLibraryScope();
    query.value = address;
    filterControls.sync();
  }
  const originalScope = scope.value;
  const action = followInput && !restored && !visualCrop && (submitter === searchButton || applyFilters) ? filterControls.searchAction() : null;
  if (action?.picture) {
    if (pictureSearch.disabled) return;
    submitter = pictureSearch;
  }
  const imported = !restored && !visualCrop && !submitter.id.startsWith('visual-') &&
    (readNativeModelSearch(address) ?? readNativeGallerySearch(address));
  if (imported) {
    if (!imported.filters || imported.origin !== context.origin) {
      searchStatus.textContent = imported.reason
        ? 'This Civitai search uses ' + imported.reason + '. Open the original link on Civitai to keep its filters.'
        : 'Open this search in the RasterRaid preview on ' + new URL(imported.origin).hostname + '.';
      return;
    }
    restored = imported.filters;
    selectedMediaTag = undefined;
    scope.value = restored.scope;
    syncLibraryScope();
    filterControls.restore(restored);
    filterPanel.open = !link?.searchParams.has('similarTo');
  }
  if (!form.reportValidity()) return;
  const preparation = ++searchPreparation;
  const trigger = applyFilters ? filterPanel.querySelector('summary')
    : restored && submitter !== searchButton ? submitter : document.activeElement;
  const traceEdits = submitter.id === 'visual-compare-edits';
  const tracePictures = submitter.id === 'visual-compare-pictures';
  const traceSidecars = submitter.id === 'visual-compare-sidecars';
  const traceRecorded = traceEdits || tracePictures || traceSidecars || submitter.id === 'visual-trace-report';
  const compose = submitter.id === 'visual-compose-search';
  const requested = context;
  const referenceVersion = referenceRevision;
  const briefVersion = visualBriefRevision;
  const visualBrief = compose ? visualReferences.brief() : undefined;
  const recordedReferences = submitter.id === 'visual-trace-report' ? visualReferences.recorded() : undefined;
  const editPairs = tracePictures ? visualReferences.pairedPictures()
    : traceSidecars ? visualReferences.pairedSidecars() : traceEdits ? visualReferences.pairedEdits() : undefined;
  syncLibraryScope();
  libraryRequest?.abort();
  const filters = await filterControls.readFilters();
  if (!filters || preparation !== searchPreparation || activeSearch || context.origin !== requested.origin || context.viewerUserId !== requested.viewerUserId ||
      (context.browsingLevel & requested.browsingLevel) !== requested.browsingLevel ||
      action && (originalScope !== scope.value || address !== query.value.trim()) ||
      traceRecorded && (filters.scope !== 'report' || referenceVersion !== referenceRevision) ||
      compose && (!isVisualGalleryScope(filters.scope) || briefVersion !== visualBriefRevision || !visualBrief.length)) return;
  if (action?.reportType) Object.assign(filters, { scope: 'report', reportType: action.reportType, query: action.query });
  try {
    if (filters.query) filters.query = catalogSearchText(filters.query);
  } catch (error) {
    searchStatus.textContent = error.message;
    return;
  }
  const changedFilter = restored && Object.entries(restored).find(([name, value]) => {
    if (modelChoiceFields.includes(name)) {
      const label = name === 'resourceType' ? modelTypeLabel : value => value;
      const keys = input => JSON.stringify(modelFilterValues(input).map(choice => labelKey(label(choice))).sort());
      return keys(value) !== keys(filters[name]);
    }
    if (typeof value !== 'string' || !value || name === 'query') return false;
    return value !== filters[name];
  });
  if (changedFilter) {
    byId('search-filters').open = true;
    const value = changedFilter[1];
    searchStatus.textContent = (imported ? 'The Civitai filter “' : 'The saved filter “') + (Array.isArray(value) ? value.join(' or ') : value) +
      '” is unavailable. Review your filters before searching.';
    return;
  }
  upgradeDraft = traceRecorded ? undefined : upgradeForSearch({ ...filters, upgradePair: upgradeDraft });
  if (upgradeDraft) filters.upgradePair = upgradeDraft;
  if (filters.scope === 'saved') {
    filters.libraryMode = libraryMode;
    filters.libraryPrivate = libraryPrivate;
  }
  if (isGalleryScope(filters.scope) && selectedMediaTag?.name === filters.query) filters.selectedMediaTag = selectedMediaTag;
  if (applyFilters) {
    filterPanel.open = false;
    trigger.focus({ preventScroll: true });
  }
  clearReportRecovery();
  if (!traceRecorded && !compose && !visualCrop && !savedSearch?.checkpoint) {
    reportRecovery = createReportRecovery(context, filters, preferences.forSearch(context)) ?? undefined;
  }
  await executeSearch(reportRecovery?.filters ?? filters, {
    trigger, traceRecorded, compose, recordedReferences, editPairs, visualCrop, visualBrief, savedSearch, recovery: reportRecovery, branch,
  });
}

async function executeSearch(filters, { trigger, traceRecorded, compose, recordedReferences, editPairs, visualCrop, visualBrief, savedSearch,
  recovery, continuing = false, branch }) {
  const retrying = trigger === retryButton;
  const canRetry = !traceRecorded && !compose && !visualCrop && filters.scope !== 'report' &&
    filters.scope !== 'ownedModels' && !libraryScopes.includes(filters.scope);
  if (!continuing && !retrying) {
    if (branch && branch.state === search && branch.state.context === context) {
      if (searchTrail.length >= 4) searchTrail.shift();
      searchTrail.push(branch);
    } else searchTrail.length = 0;
  }
  activeSearch = new AbortController();
  compareDialog.close();
  setResearchOpen(false);
  if (traceRecorded) activeReferenceSearch = activeSearch;
  if (compose) activeVisualBrief = activeSearch;
  activeQuote?.abort();
  workflowRun?.clearOffer();
  const current = context;
  const { signal } = activeSearch;
  soundMatch.show(null, {}, current);
  preferences.paintResults();
  setSearchBusy(true);
  visualReferences.enableLookup(false);
  resultArea.setAttribute('aria-busy', 'true');
  searchStatus.textContent = continuing ? 'Continuing the previous report…' : retrying ? 'Retrying the previous search…' : 'Searching Civitai…';
  const fromResults = workbench.contains(trigger);
  const attempt = recovery?.begin({ discoverSource: discover, recordedSource: readRecordedVersions });
  let checkpoint;
  let offerContinue = false;
  let checkingSaved = false;
  function showLoading(result) {
    renderSearch(result, filters, current, 'loading');
    resultArea.setAttribute('aria-busy', 'false');
  }
  function hasEarlierEvidence(next) {
    if (!continuing || search?.filters !== filters || !search.result.report) return false;
    const keys = new Set(next.report.evidence.map(item => item.key));
    return search.result.report.evidence.some(item => !keys.has(item.key));
  }
  try {
    const find = filters.scope === 'report' ? discoverReport : discover;
    const result = await find(current, filters, {
      signal,
      preferences: recovery ? recovery.preferences : preferences.forSearch(current),
      recordedReferences, editPairs,
      visualCrop, visualBrief,
      ...(attempt && { discoverSource: attempt.discoverSource, recordedSource: attempt.recordedSource, onCheckpoint(snapshot) {
        checkpoint = snapshot;
        if (signal.aborted || continuing || search?.filters === filters) return;
        const ready = snapshot();
        if (ready.report.evidence.length) showLoading(ready);
      } }),
      onPhase: message => { searchStatus.textContent = message; },
      onRanked(ranked) {
        if (signal.aborted) return;
        checkpoint = () => ranked;
        if (retrying || hasEarlierEvidence(ranked)) return;
        showLoading(ranked);
      },
    });
    signal.throwIfAborted();
    const checkedAt = new Date().toISOString();
    if (result.report) result.reportCheckedAt = checkedAt;
    else result.catalogCheckpoint = captureCatalogCheckpoint(result, current, checkedAt);
    if (savedSearch) result.savedSearch = savedSearch;
    if (savedSearch && !savedSearch.catalogCheckpoint && result.catalogCheckpoint) {
      result.searchComparison = { kind: 'search', status: 'baseline-ready', checkpoint: result.catalogCheckpoint };
    }
    const retryFocused = retrying && document.activeElement === retryButton;
    renderSearch(result, filters, current);
    retryButton.hidden = !(canRetry && search.catalogFailure === 'retryable' && current === context);
    offerContinue = Boolean(attempt && (attempt.retryable || result.report?.rails.some(rail => rail.retryable)));
    if (attempt?.reused) searchStatus.textContent += ' · Reused ' + attempt.reused +
      (attempt.reused === 1 ? ' completed check.' : ' completed checks.');
    const baseline = result.report ? savedSearch?.checkpoint : savedSearch?.catalogCheckpoint;
    if (baseline) {
      checkingSaved = true;
      const summary = searchStatus.textContent;
      searchStatus.textContent = result.report ? 'Checking sources from the saved report…' : 'Checking earlier results from the saved search…';
      const review = result.report ? reviewReportCheckpoint : reviewCatalogCheckpoint;
      const comparison = await review(baseline, result, current, { signal, checkedAt });
      signal.throwIfAborted();
      if (comparison && search?.result === result) {
        result.searchComparison = comparison;
        renderReportChanges(byId('report-changes'), comparison, current,
          checkpoint => workspace.refreshSearch(savedSearch, checkpoint, current), startExample);
        if (document.activeElement === byId('open-workspace') || document.activeElement === document.body) {
          byId('report-change-title')?.focus();
        }
      }
      searchStatus.textContent = summary;
    }
    if (compose || trigger === reportThisSearch || retryFocused && retryButton.hidden ||
        filters.reportType === 'publicWork' && trigger === byId('open-workspace') ||
        fromResults && (!trigger.isConnected || trigger.hidden) && document.activeElement === document.body) resultsTitle.focus();
    workspace.remember(current, result, filters);
  } catch (error) {
    const retained = recovery && recovery === reportRecovery && recovery.matches(context);
    const stopped = Boolean(retained && signal.aborted && signal.reason?.name === 'AbortError');
    offerContinue = Boolean(retained && (stopped || attempt.retryable));
    const snapshot = offerContinue && checkpoint?.();
    if (snapshot && !hasEarlierEvidence(snapshot)) {
      renderSearch(snapshot, filters, current, 'interrupted');
    } else if (search?.filters === filters && (search.phase === 'loading' || stopped)) {
      renderSearch(search.result, filters, current, 'interrupted');
    } else if (search?.phase === 'complete' && search.context === context) {
      soundMatch.show(search.result, search.groups, search.context);
    }
    searchStatus.textContent = signal.reason === accessChange && context.connectionLost ? connectionNotice
      : signal.reason === accessChange || signal.reason === referenceChange || signal.reason === visualBriefChange
      ? signal.reason.message : stopped ? 'Report paused.' : signal.aborted ? checkingSaved ? 'Stopped checking saved sources. The refreshed results are ready.' : 'Search cancelled.'
      : error.message || 'Search was interrupted. Try again.';
  } finally {
    if (searchTrail.at(-1) === branch && branch?.state === search) searchTrail.pop();
    if (activeReferenceSearch === activeSearch) activeReferenceSearch = undefined;
    if (activeVisualBrief === activeSearch) activeVisualBrief = undefined;
    activeSearch = undefined;
    const continueFocused = document.activeElement === continueButton;
    if (recovery && recovery === reportRecovery) {
      if (offerContinue && recovery.matches(context)) continueButton.hidden = false;
      else clearReportRecovery();
    }
    const destination = trigger === continueButton && continueButton.hidden ? workbench.hidden ? searchButton : resultsTitle : trigger;
    if (continuing && continueButton.hidden && continueFocused) destination.focus({ preventScroll: true });
    setSearchBusy(false, signal.aborted && !continueButton.hidden ? continueButton : destination);
    visualReferences.enableLookup(Boolean(context));
    resultArea.setAttribute('aria-busy', 'false');
    preferences.paintResults();
  }
}
cancelButton.addEventListener('click', () => activeSearch?.abort());

async function checkReplayFilters(control, filters, isCurrent) {
  const preparation = ++searchPreparation;
  control.setAttribute('aria-disabled', 'true');
  try {
    const retired = await filterControls.retiredSearchFilter(filters);
    if (preparation === searchPreparation && !activeSearch && !addingSearchPicture && isCurrent()) return { retired };
  } catch {
    if (preparation === searchPreparation && isCurrent()) {
      searchStatus.textContent = 'Civitai could not check your filters. Try again.';
    }
  } finally {
    if (!activeSearch) control.removeAttribute('aria-disabled');
  }
  return null;
}

retryButton.addEventListener('click', async () => {
  const prior = search;
  if (retryButton.hidden || retryButton.hasAttribute('aria-disabled') || activeSearch || addingSearchPicture || prior?.context !== context) return;
  const pause = catalogPause(context.origin);
  if (pause) {
    searchStatus.textContent = pause.message;
    return;
  }
  const checked = await checkReplayFilters(retryButton, prior.filters, () => search === prior && context === prior.context);
  if (!checked) return;
  if (checked.retired) {
    searchStatus.textContent = 'Civitai removed the filter “' + checked.retired + '”. Update your filters before searching again.';
    retryButton.hidden = true;
    (filterPanel.hidden ? searchButton : filterPanel.querySelector('summary')).focus();
    return;
  }
  await executeSearch(prior.filters, { trigger: retryButton, savedSearch: prior.result.savedSearch });
});

continueButton.addEventListener('click', async () => {
  const recovery = reportRecovery;
  if (!recovery?.matches(context) || activeSearch || addingSearchPicture || continueButton.hasAttribute('aria-disabled')) return;
  const pause = catalogPause(context.origin);
  if (pause) {
    searchStatus.textContent = pause.message;
    return;
  }
  const checked = await checkReplayFilters(continueButton, recovery.filters, () => recovery === reportRecovery && recovery.matches(context));
  if (!checked) return;
  if (checked.retired) {
    searchStatus.textContent = 'Civitai removed the filter “' + checked.retired + '”. Update your filters to run a new report.';
    (filterPanel.hidden ? searchButton : filterPanel.querySelector('summary')).focus();
    clearReportRecovery();
    return;
  }
  await executeSearch(recovery.filters, { trigger: continueButton, continuing: true, recovery });
});

galleryMore.addEventListener('click', async () => {
  const current = search;
  const directory = current?.result.directory;
  const library = current?.result.library?.pager;
  const models = current?.result.modelPager;
  const pager = directory ?? current?.result.gallery ?? library ?? models;
  if (activeSearch || !pager?.nextCursor) return;
  const pause = catalogPause(current.context.origin);
  if (pause && pager.scope !== 'aiServices') {
    galleryStatus.textContent = pause.message;
    return;
  }
  const controller = new AbortController();
  activeSearch = controller;
  galleryMore.setAttribute('aria-disabled', 'true');
  setSearchBusy(true);
  preferences.paintResults();
  galleryStatus.textContent = 'Loading more…';
  try {
    const items = current.groups[pager.scope];
    const known = new Set(items.map(item => item.id));
    const options = { cursor: pager.nextCursor, signal: controller.signal };
    const page = models ? await readModelPage(context, pager.nextCursor, options)
      : library ? await readLibraryPage(context, pager.plan, options)
      : directory ? await readDirectoryPage(current.context, pager.scope, pager.plan, { ...options, excluded: known })
      : pager.scope === 'posts' ? await readPostPage(current.context, pager, { ...options, excluded: known })
        : pager.scope === 'bounties' ? await readBountyPage(current.context, pager.plan, options)
          : await readGalleryPage(current.context, pager.plan, options);
    controller.signal.throwIfAborted();
    const unique = page.items.filter(item => !known.has(item.id) && known.add(item.id));
    const firstModels = models && !items.length;
    let displayed = unique;
    if (unique.length && current.mediaRanking?.scope === pager.scope) {
      current.result.related[pager.scope].push(...unique);
      current.mediaRanking.sizes.push(unique.length);
      displayed = rankMediaPage(current, unique);
    }
    items.push(...displayed);
    pager.nextCursor = page.nextCursor;
    if (pager.scope === 'apps' && !pager.plan.kind && !pager.plan.category && page.facets) {
      filterControls.applyDirectoryFacets(page.facets, { append: true });
    }
    if (models && unique.length) {
      current.groups = resultGroups(current.result);
      if (firstModels) current.chosen = new Set(unique.slice(0, 3).map(item => item.id));
      renderResultFilters();
      renderGroup();
      if (firstModels || current.filter === 'pictures' && !byId('catalog-picks')) renderResearch();
      searchStatus.textContent = items.length + (items.length === 1 ? ' model' : ' models') + ' loaded · Free search';
    } else if (unique.length && !appendResultCards(resultArea, displayed, pager.scope, {
      context: current.context, onMediaTag: startMediaTag, onLookup: followResult, directory: directory || pager.scope === 'libraryCollections',
      mediaFeedback: ratedMedia(current),
      onVisualReference: !current.result.library ? addGalleryReference : undefined,
    })) renderGroup();
    if (unique.length) soundMatch.show(current.result, current.groups, current.context);
    if (unique.length && !current.result.library && (['all', pager.scope].includes(current.filter) || models && current.filter === 'pictures')) {
      const picker = byId('catalog-picks');
      if (picker) {
        const catalog = catalogResearch(current.result, current.groups, current.filter, current.context.origin,
          current.catalogSelections.get(current.filter));
        renderCatalogPicks(byId('picks'), catalog, picker.open);
      } else if (researchArea.hidden) renderResearch();
    }
    const pendingPause = page.partial && catalogPause(current.context.origin);
    galleryStatus.textContent = items.length + ' loaded' + (page.partial ? ' · ' + (pendingPause?.message ?? 'Some Civitai sources were unavailable.')
      : unique.length ? '' : ' · No new matches in this batch.');
    if (!page.nextCursor && document.activeElement === galleryMore) {
      (byId('gallery-native').querySelector('a') ?? resultsTitle).focus({ preventScroll: true });
    }
    galleryMore.hidden = !page.nextCursor;
  } catch (error) {
    galleryStatus.textContent = controller.signal.aborted ? 'Stopped loading.' : error.message || 'More results are unavailable.';
  } finally {
    activeSearch = undefined;
    galleryMore.removeAttribute('aria-disabled');
    setSearchBusy(false, galleryMore.hidden ? resultsTitle : galleryMore);
    preferences.paintResults();
  }
});

quoteButton.addEventListener('click', async () => {
  if (mockPreview || activeQuote || activeSearch || !search?.quotes.length) return;
  checkResearchServices();
  if (!context.scopes.includes(QUOTE_SCOPE) && search.recordedQuote) {
    if (Date.now() - search.recordedQuote.capturedAt < PREVIEW_QUOTE_MAX_AGE_MS) {
      paintPreviewEstimate(search.recordedQuote);
      return;
    }
    search.recordedQuote = null;
  }
  const controller = new AbortController();
  activeQuote = controller;
  const { signal } = controller;
  const quotes = search.quotes;
  const current = context;
  quoteButton.setAttribute('aria-disabled', 'true');

  try {
    if (current.connectionLost) {
      quoteStatus.textContent = 'Refresh this Civitai page to reconnect for live quotes.';
      return;
    }
    if (!current.hosted || !current.token) {
      quoteStatus.textContent = 'Open RasterRaid inside Civitai and sign in for live quotes.';
      return;
    }
    if (!current.signedIn) {
      quoteStatus.textContent = 'Sign in on Civitai to see live prices.';
      current.requestSignIn();
      return;
    }
    let authorized = current;
    if (!current.scopes.includes(QUOTE_SCOPE)) {
      quoteStatus.textContent = 'Waiting for Civitai’s quote permission. Getting a quote uses 0 Buzz.';
      authorized = await current.requestQuoteAccess(AbortSignal.any([signal, AbortSignal.timeout(35_000)]));
      signal.throwIfAborted();
    }
    if (!authorized?.token) {
      quoteStatus.textContent = 'Civitai hasn’t enabled live prices in this session.';
      return;
    }

    quoteStatus.textContent = 'Getting prices from Civitai…';
    showResearchPrices();
    const bodies = quotes.map(view => appEstimateBody(view.plan));
    const startedAt = Date.now();
    const batch = bodies.length > 1 ? await authorized.requestQuoteBatch(bodies, signal) : null;
    signal.throwIfAborted();
    const prices = batch ?? [];
    if (!batch) for (const body of bodies) {
      signal.throwIfAborted();
      try {
        const snapshot = await estimateAppWorkflow(context.origin, context.token, body, fetch, signal);
        signal.throwIfAborted();
        prices.push(quotePrice(snapshot));
      } catch (error) {
        signal.throwIfAborted();
        prices.push(null);
        if ([401, 403, 429].includes(error.status)) break;
      }
    }
    const priced = prices.filter(Boolean).length;
    const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date());
    showResearchPrices(prices, startedAt + LIVE_QUOTE_MAX_AGE_MS);
    if (priced) quoteButton.textContent = 'Refresh live quotes';
    quoteStatus.textContent = priced
      ? priced + ' of ' + quotes.length + ' priced ' + (batch ? 'together ' : '') + 'by Civitai at ' + time + '. 0 Buzz used.'
      : 'Civitai couldn’t return prices right now. 0 Buzz used.';
  } catch (error) {
    if (!signal.aborted) {
      showResearchPrices(quotes.map(() => null));
      quoteStatus.textContent = 'Civitai couldn’t return prices right now. Try again shortly. 0 Buzz used.';
    }
  } finally {
    if (activeQuote === controller) {
      activeQuote = undefined;
      quoteButton.removeAttribute('aria-disabled');
    }
  }
});

probeButton.addEventListener('click', async () => {
  if (!context || probeRequest) return;
  const controller = new AbortController();
  probeRequest = controller;
  probeButton.disabled = true;
  const rows = byId('probe-rows');
  const progress = byId('progress');
  rows.replaceChildren();
  byId('probe-results').hidden = false;
  progress.textContent = 'Checking ' + new URL(context.origin).hostname + '…';
  try {
    const results = await runHostProbe(context.origin, {
      token: context.token,
      signal: controller.signal,
      onResult(result) {
        const row = rows.insertRow();
        const header = element('th', result.name);
        header.scope = 'row';
        row.append(header);
        row.insertCell().textContent = result.status ? 'HTTP ' + result.status : result.outcome;
        const evidence = [
          result.firstId && 'ID ' + result.firstId,
          result.count && result.count + (result.count === 1 ? ' result' : ' results'),
          result.metadataPresent && 'Metadata present',
          result.browsingLevel && 'Browsing level ' + result.browsingLevel,
          result.tools?.join(', '),
        ].filter(Boolean);
        row.insertCell().textContent = evidence.join(' · ') || (result.status === 200 ? 'Response parsed' : '—');
        progress.textContent = 'Checked ' + rows.rows.length + ' of ' + HOST_PROBES.length + ' routes';
      },
    });
    const reachable = results.filter(result => result.status === 200).length;
    progress.textContent = 'Probe complete · ' + reachable + ' of ' + results.length + ' routes responded successfully';
  } catch {
    if (!controller.signal.aborted) progress.textContent = 'The catalog check ended before completion.';
  } finally {
    probeRequest = undefined;
    probeButton.disabled = false;
  }
});

if (mockPreview) {
  const [{ installMockPanel }, { linocutSample }, { createWorkflowSimulationClient }] = await Promise.all([
    import('../mock/panel.mjs'),
    import('../mock/sample.mjs'),
    import('../mock/client.mjs'),
  ]);
  const client = createWorkflowSimulationClient(location.origin);
  workflowRun = installWorkflowRun(byId('workflow-session'), {
    context, simulated: true, client, journal: localWorkflowJournal(window, context.origin),
    onLookup: startExample, onOpenHistory: workflowHistory.open, onAvailability: paintWorkflowOffers,
  });
  workflowHistory.setSimulation(context, { list: client.list, poll: client.inspect }, localWorkflowJournal(window, context.origin));
  configureMock = installMockPanel(researchArea);
  byId('buzz-help').hidden = true;
  host.textContent = 'Mock preview';
  query.value = 'linocut';
  renderSearch(linocutSample(context.origin), { query: 'linocut', scope: 'all' }, context);
  searchStatus.textContent = 'Linocut sample · 3 model versions';
}

mounted = true;
completeStartup();
