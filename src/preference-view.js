import { preferenceDocument, saveFeedback, saveMediaFeedback, visibleFeedback, visibleMediaFeedback } from './preferences.mjs';
import { showReportExport } from './report-view.js';
import { appPrivateRecord, tabPrivateRecord } from './workflow-journal.mjs';

export function configurePreferences(window, { getContext, getSearch, isSearching, rerun, onReady, onMediaOrder }) {
  const byId = id => window.document.getElementById(id);
  const setting = byId('personalize-models');
  const mediaSetting = byId('personalize-media');
  const count = byId('preference-count');
  const message = byId('preference-status');
  const inspect = byId('export-model-feedback');
  const clear = byId('clear-model-feedback');
  const toolbar = byId('result-ranking');
  const ranking = byId('result-ranking-label');
  const switchOrder = byId('switch-result-ranking');
  const resultStatus = byId('result-ranking-status');
  const memory = new Map();
  let owner;
  let store;
  let state = preferenceDocument(null);
  let ready = false;
  let busy = false;

  function allowed(view) {
    const current = getContext();
    return Boolean(ready && view && view.origin === current?.origin && view.viewerUserId === current?.viewerUserId &&
      (current.browsingLevel & view.browsingLevel) === view.browsingLevel);
  }

  function paintResults() {
    const search = getSearch();
    const result = search?.result;
    const media = search?.mediaRanking;
    const modelOrder = result?.candidates.length && typeof result.preferenceMode === 'boolean';
    const mediaOrder = media && ['all', media.scope].includes(search.filter) && search.groups[media.scope]?.length > 1;
    toolbar.hidden = !allowed(search?.context) || !modelOrder && !mediaOrder;
    if (toolbar.hidden) return;
    const enabled = mediaOrder ? media.enabled : result.preferenceMode;
    const changes = mediaOrder ? media.changes : result.preferenceChanges;
    ranking.textContent = enabled ? changes ? 'Ranked with your preferences' : 'Your preferences left the order as is'
      : 'Standard ' + (mediaOrder ? media.scope === 'videos' ? 'clip' : 'picture' : 'model') + ' ranking';
    switchOrder.textContent = enabled ? 'Use standard ranking' : 'Use my preferences';
    switchOrder.disabled = busy || isSearching() || search.phase !== 'complete';
  }

  function paint() {
    if (!busy) {
      setting.checked = state.enabled;
      mediaSetting.checked = state.mediaEnabled === true;
    }
    setting.disabled = !ready || busy;
    mediaSetting.disabled = !ready || busy;
    const level = getContext()?.browsingLevel;
    const models = visibleFeedback(state, level).length;
    const media = visibleMediaFeedback(state, level).length;
    count.textContent = ready ? models + ' rated model ' + (models === 1 ? 'version' : 'versions') +
      ' · ' + media + ' rated ' + (media === 1 ? 'picture or clip' : 'pictures and clips') : '';
    inspect.disabled = !ready || busy || !(models + media);
    clear.disabled = !ready || busy || !state.feedback.length && !state.mediaFeedback?.length;
    paintResults();
  }

  async function update(apply) {
    if (!store || !ready || busy) return false;
    const original = store;
    busy = true;
    paint();
    try {
      let next = apply(state);
      try { await original.write(next); }
      catch (error) {
        if (error.status !== 409) throw error;
        next = apply(preferenceDocument(await original.read()));
        await original.write(next);
      }
      if (original !== store) return false;
      state = preferenceDocument(next);
      message.textContent = 'Saved.';
      return true;
    } catch {
      if (original === store) message.textContent = 'Civitai could not save the preferences.';
      return false;
    } finally {
      if (original === store) { busy = false; paint(); }
    }
  }

  setting.addEventListener('change', () => {
    const enabled = setting.checked;
    void update(current => ({ ...current, enabled }));
  });
  mediaSetting.addEventListener('change', async () => {
    const mediaEnabled = mediaSetting.checked;
    if (await update(current => ({ ...current, mediaEnabled }))) onMediaOrder?.(mediaEnabled, state);
  });
  clear.addEventListener('click', async () => {
    if (await update(current => ({ ...current, feedback: [], mediaFeedback: [] }))) {
      onMediaOrder?.(getSearch()?.mediaRanking?.enabled ?? state.mediaEnabled === true, state);
      onReady();
    }
  });
  inspect.addEventListener('click', () => {
    if (!ready) return;
    const level = getContext()?.browsingLevel;
    const data = { enabled: state.enabled, feedback: visibleFeedback(state, level),
      mediaEnabled: state.mediaEnabled === true, mediaFeedback: visibleMediaFeedback(state, level) };
    showReportExport(JSON.stringify(data, null, 2), { title: 'Copy ranking preferences', label: 'Visible ranking preferences in JSON' });
  });
  switchOrder.addEventListener('click', async () => {
    const search = getSearch();
    if (busy || isSearching() || search?.phase !== 'complete' || !allowed(search.context)) return;
    resultStatus.textContent = '';
    if (search.mediaRanking) {
      onMediaOrder?.(!search.mediaRanking.enabled, state);
      return;
    }
    const enabled = !search.result.preferenceMode;
    if (await update(current => ({ ...current, enabled }))) {
      if (search === getSearch() && !isSearching()) rerun(search.filters);
    } else if (search === getSearch()) resultStatus.textContent = message.textContent;
  });

  function bind(context) {
    const persistent = Boolean(context?.hosted && context.signedIn && context.token && context.storageMode !== 'local-preview' &&
      context.scopes.includes('apps:storage'));
    const next = context ? [context.origin, context.viewerUserId ?? 'guest', persistent ? 'private' : 'tab'].join('#') : null;
    if (next === owner) { paint(); return; }
    owner = next;
    state = preferenceDocument(null);
    resultStatus.textContent = '';
    ready = false;
    busy = false;
    store = context ? persistent ? appPrivateRecord(context, getContext, 'model-preferences') :
      tabPrivateRecord(window, 'rasterraid:model-preferences:v1:' + owner, memory) : null;
    message.textContent = store ? 'Loading your preferences…' : '';
    paint();
    const original = store;
    if (!original) return;
    void Promise.resolve().then(() => original.read()).then(data => {
      if (original !== store) return;
      state = preferenceDocument(data);
      ready = true;
      message.textContent = persistent ? 'Saved privately in your Civitai workspace.' : 'Stored in this tab.';
      paint();
      onMediaOrder?.(state.mediaEnabled === true, state);
      onReady();
    }).catch(() => {
      if (original === store) message.textContent = 'Ranking preferences are unavailable.';
    });
  }

  function feedback(view) {
    if (!allowed(view)) return null;
    return {
      vote: model => visibleFeedback(state, view.browsingLevel).find(row => row.id === model.id && row.modelId === model.modelId)?.vote ?? 0,
      save: (model, vote) => allowed(view) && update(current => saveFeedback(current, model, vote, view.browsingLevel)),
    };
  }

  function mediaFeedback(view) {
    if (!allowed(view)) return null;
    return {
      vote: item => visibleMediaFeedback(state, view.browsingLevel).find(row => row.id === item.id)?.vote ?? 0,
      save: (item, vote) => allowed(view) && update(current => saveMediaFeedback(current, item, vote, view.browsingLevel)),
    };
  }

  return { bind, feedback, mediaFeedback, paintResults, forSearch: view => allowed(view) ? state : undefined };
}
