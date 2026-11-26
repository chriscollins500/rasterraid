import { appPrivateRecord, tabPrivateRecord } from './workflow-journal.mjs';
import { checkWorkflowFiles, checkWorkspaceAsset, checkWorkspaceSetup, recentSearchLabel, recentWorkspaceSearches,
  saveWorkspaceEntry, updateSearchCheckpoint, versionReferences, workspaceDocument, workspaceFilters, writeWorkspaceChange } from './workspace.mjs';
import { captureReportCheckpoint } from './report-checkpoint.mjs';
import { element, sourceLink } from './view.js';
import { environmentProfile, inspectWorkflowGraph, maximumWorkflowBytes, workflowAssetLabel, workflowInspectionLabel } from './workflow-profile.mjs';
import { showReportExport } from './report-view.js';
import { renderWorkflowFile, workflowAuditMarkdown, workflowFileStatus } from './workspace-file-view.js';
import { upgradePair, upgradeSources, upgradeVersionLink } from './upgrade-evidence.mjs';
import { configureWorkspaceBackup } from './workspace-backup-view.js';
import { configureWorkspaceStorage } from './workspace-storage-view.js';
import { configureLocalModelFiles } from './local-model-files-view.js';
import { compareWorkspaceExample, workspaceExampleMarkdown, workspaceExampleNotes } from './workspace-example.mjs';
import { canReadPublicWork } from './creator-trail.mjs';

function fitRows(card) {
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const files = card.files.map(file => [file.name, '#' + file.id, file.format, file.precision,
    file.sizeKB ? number.format(file.sizeKB / 1024) + ' MiB on disk' : ''].filter(Boolean).join(' · ')).join('\n');
  const generation = card.generationListed === true ? 'Civitai lists on-site generation support.'
    : card.generationListed === false ? 'Civitai lists on-site generation as unsupported.' : 'Generation support is unknown.';
  return [
    ['Model family · ' + card.familyKind, card.family],
    ['Published files', files || 'File details are unavailable.'],
    ['Catalog availability', [card.availability, generation].filter(Boolean).join(' · ')],
    ['Creator’s listed usage options', card.usage.length ? card.usage.join('\n') : 'Usage details are unavailable.'],
  ];
}

export function configureWorkspace(window, { getContext, getSearch, openSearch, openShortlist, applyProfile }) {
  const id = name => window.document.getElementById(name);
  const button = id('open-workspace');
  const dialog = id('saved-workspace');
  const publicWork = id('workspace-public-work');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const name = id('workspace-name');
  const message = id('workspace-status');
  const checkChange = id('workspace-check-change');
  const saveSearch = id('workspace-save-search');
  const saveList = id('workspace-save-shortlist');
  const runtime = id('workspace-runtime');
  const family = id('workspace-family');
  const vram = id('workspace-vram');
  const graph = id('workspace-workflow');
  const graphSummary = id('workspace-workflow-summary');
  const graphSource = id('workspace-workflow-source');
  const profileSave = id('workspace-save-profile');
  const profileApply = id('workspace-apply-profile');
  const clearAssets = id('workspace-clear-assets');
  const assetSection = id('workspace-check-assets');
  const assetChoice = id('workspace-check-file');
  const assetReference = id('workspace-file-reference');
  const assetCheck = id('workspace-check-model');
  const assetStatus = id('workspace-check-file-status');
  const assetResults = id('workspace-check-results');
  const auditCheck = id('workspace-audit-files');
  const auditCancel = id('workspace-cancel-audit');
  const auditCopy = id('workspace-copy-audit');
  const auditSave = id('workspace-save-upgrades');
  const auditStatus = id('workspace-audit-status');
  const auditResults = id('workspace-audit-results');
  const setupCheck = id('workspace-check-setup');
  const setupStatus = id('workspace-setup-status');
  const setupResults = id('workspace-setup-results');
  const exampleCheck = id('workspace-example-check');
  const exampleHeading = id('workspace-example-heading');
  const exampleSource = id('workspace-example-source');
  const exampleStatus = id('workspace-example-status');
  const exampleRows = id('workspace-example-rows');
  const exampleNotes = id('workspace-example-notes');
  const clearRecent = id('workspace-clear-recent');
  const tabRecords = new Map();
  let store;
  let historyStore;
  let key;
  let state = workspaceDocument(null);
  let snapshot;
  let pendingChange;
  let writingWorkspace;
  let recent = [];
  let ready = false;
  let busy = false;
  let assets = [];
  let graphRevision = 0;
  let graphTrace = null;
  let checking;
  let auditing;
  let auditRows = [];
  let auditOffset = 0;
  let auditCheckedAt = null;
  let auditRetryAt = 0;
  let auditRetryTimer;
  let fitting;
  let ceiling;
  let openingWorkspace;
  let activeExample;
  let exampleExport;
  const backup = configureWorkspaceBackup(window, { getContext, change });
  const storage = configureWorkspaceStorage(window, getContext);
  const modelFiles = configureLocalModelFiles(window, {
    getContext,
    onReport(query) {
      const started = openSearch({ scope: 'report', query, reportType: 'workflow',
        reportSources: ['models', 'gallery', 'articles', 'collections'] });
      if (started !== false) dialog.close();
      else id('local-model-status').textContent = 'Finish or stop the current search before opening a report.';
    },
  });

  const localStore = owner => tabPrivateRecord(window, 'rasterraid:workspace:v1:' + owner, tabRecords);

  function choices() {
    const current = getSearch();
    const viewer = getContext();
    const sameView = current && !current.result.library &&
      current.context?.origin === viewer?.origin && current.context?.viewerUserId === viewer?.viewerUserId;
    const publicResults = sameView && current.phase === 'complete';
    const report = current?.result.report;
    const checkpoint = sameView && current.context.browsingLevel === viewer.browsingLevel &&
      (publicResults || current.result.reportPaused)
      ? report ? captureReportCheckpoint(current.result, current.context, current.result.reportCheckedAt)
        : current.result.catalogCheckpoint : null;
    const canSaveSearch = (publicResults || checkpoint?.partial) && !report?.localTrace && !current.result.visualComposition;
    return {
      searches: canSaveSearch ? workspaceFilters(current.filters) : null,
      shortlists: publicResults ? versionReferences(current.result.candidates.filter(candidate => current.chosen.has(candidate.id))) : [],
      checkpoint,
    };
  }

  function draw() {
    const selected = choices();
    const canSave = ready && !busy && !pendingChange;
    saveSearch.closest('.workspace-save').hidden = !selected.searches && !selected.shortlists.length;
    saveSearch.disabled = !canSave || !selected.searches;
    saveSearch.textContent = selected.checkpoint && selected.searches?.scope === 'report'
      ? selected.checkpoint.partial ? 'Save report progress' : 'Save report for comparison' : 'Save current search';
    saveList.disabled = !canSave || !selected.shortlists.length;
    profileSave.disabled = !canSave;
    checkChange.hidden = !pendingChange?.uncertain;
    checkChange.disabled = busy || !ready;
    profileApply.disabled = !family.value.trim();
    clearAssets.disabled = !assets.length || busy;
    drawFileChecks();
    drawExampleCheck();
    setupCheck.disabled = !selected.shortlists.length || Boolean(fitting) || busy;
    setupCheck.textContent = selected.shortlists.length ? 'Check ' + selected.shortlists.length + ' picked ' +
      (selected.shortlists.length === 1 ? 'version' : 'versions') : 'Check picked versions';
    backup.setWorkspace(state, canSave);
    const recentArea = id('workspace-recent');
    clearRecent.hidden = !recent.length;
    const recentList = element('ul');
    for (const filters of recent) {
      const row = element('li', null, 'workspace-row');
      const open = element('button', filters.query ? recentSearchLabel(filters) + ' · ' + filters.query : 'Browse ' + recentSearchLabel(filters), 'chip');
      open.type = 'button';
      open.addEventListener('click', () => { dialog.close(); openSearch(filters); });
      row.append(open);
      recentList.append(row);
    }
    recentArea.replaceChildren(recent.length ? recentList : element('p', 'No recent searches in this tab.'));
    for (const type of ['searches', 'shortlists']) {
      const area = id('workspace-' + type);
      area.replaceChildren();
      if (!state[type].length) {
        area.append(element('p', type === 'searches' ? 'No saved searches yet.' : 'No model shortlists yet.'));
        continue;
      }
      const list = element('ul');
      for (const entry of state[type]) {
        const row = element('li', null, 'workspace-row');
        const open = element('button', entry.name, 'chip');
        open.type = 'button';
        open.disabled = busy;
        open.setAttribute('aria-label', 'Open ' + entry.name);
        open.addEventListener('click', () => {
          dialog.close();
          if (type === 'searches') openSearch(entry.filters, undefined, entry);
          else openShortlist(entry);
        });
        const remove = element('button', 'Remove', 'chip');
        remove.type = 'button';
        remove.disabled = !canSave;
        remove.setAttribute('aria-label', 'Remove ' + entry.name);
        remove.addEventListener('click', () => { void change(value => ({ ...value, [type]: value[type].filter(item => item.id !== entry.id) })); });
        row.append(open, remove);
        if (entry.checkpoint) row.append(element('small', entry.checkpoint.references.length + ' saved sources' +
          (entry.checkpoint.partial ? ' · Partial report' : ''), 'workspace-report-summary'));
        if (entry.catalogCheckpoint) row.append(element('small', entry.catalogCheckpoint.references.length + ' saved results', 'workspace-report-summary'));
        list.append(row);
      }
      area.append(list);
    }
  }

  const profile = () => environmentProfile({ runtime: runtime.value, baseModel: family.value, vram: vram.value, assets });
  const auditVersions = () => versionReferences(auditRows.flatMap(({ check }) => check?.newer ?
    [{ ...check.newer, selectedFile: check.newerFile }] : []));

  function drawExampleCheck() {
    exampleCheck.hidden = !activeExample;
    if (!activeExample) {
      exampleSource.replaceChildren();
      exampleStatus.textContent = '';
      exampleRows.replaceChildren();
      exampleNotes.textContent = '';
      return;
    }
    const viewer = getContext();
    const comparison = compareWorkspaceExample(activeExample, profile());
    if (exampleSource.firstElementChild?.href !== comparison.source) {
      exampleSource.replaceChildren(sourceLink(comparison.source, 'Open source ' + comparison.kind + ' ↗', viewer));
    }
    if (exampleStatus.textContent !== comparison.summary) exampleStatus.textContent = comparison.summary;
    exampleRows.replaceChildren(...comparison.rows.map(row => {
      const item = element('li', null, 'report-connection');
      item.append(row.link ? sourceLink(row.link, row.title, viewer) : element('strong', row.title),
        element('p', row.facts[0], 'example-identity'), element('p', [row.fit, ...row.facts.slice(1)].join(' · ')));
      return item;
    }));
    exampleNotes.textContent = workspaceExampleNotes(comparison).join(' ');
  }

  function clearExampleCheck() {
    activeExample = undefined;
    exampleExport?.close();
    exampleExport = undefined;
    drawExampleCheck();
  }

  function drawFileChecks() {
    const active = Boolean(auditing || checking);
    assetCheck.disabled = active || busy;
    auditCancel.hidden = !auditing;
    auditCopy.hidden = !auditRows.length;
    auditCopy.disabled = Boolean(auditing);
    const versions = auditVersions();
    auditSave.hidden = !versions.length;
    auditSave.disabled = active || busy || !ready || Boolean(pendingChange);
    const complete = auditOffset >= assets.length;
    auditCheck.disabled = active || busy || !assets.length || auditRetryAt > Date.now();
    auditCheck.textContent = complete ? 'Recheck workflow files' : auditOffset ? 'Continue checking files' : 'Check workflow files';
  }

  function clearAssetCheck() {
    checking?.abort();
    checking = undefined;
    assetStatus.textContent = '';
    assetResults.replaceChildren();
    drawFileChecks();
  }

  function clearAudit() {
    auditing?.abort();
    auditing = undefined;
    auditRows = [];
    auditOffset = 0;
    auditCheckedAt = null;
    auditRetryAt = 0;
    clearTimeout(auditRetryTimer);
    auditResults.replaceChildren();
    auditStatus.textContent = '';
    drawFileChecks();
  }

  function clearSetupCheck() {
    fitting?.abort();
    fitting = undefined;
    setupStatus.textContent = '';
    setupResults.replaceChildren();
    setupCheck.disabled = !choices().shortlists.length || busy;
  }

  function reviewUpgrade(check) {
    const current = getContext();
    const prior = check.matching[0];
    const pair = upgradePair({
      from: { modelId: prior?.model.modelId, versionId: prior?.model.id, fileId: prior?.file.id },
      to: { modelId: check.newer?.modelId, versionId: check.newer?.id, fileId: check.newerFile?.id },
    });
    if (!current || !pair) return;
    const started = openSearch({ scope: 'report', query: upgradeVersionLink(current.origin, pair.to),
      reportType: 'workflow', reportSources: upgradeSources, upgradePair: pair, baseModel: family.value });
    if (started !== false) dialog.close();
    else message.textContent = 'Finish or cancel the current search before starting the upgrade report.';
  }

  function setAssets(value, trace = null) {
    graphRevision++;
    clearAssetCheck();
    clearAudit();
    assets = [...value];
    graphTrace = trace;
    graphSummary.hidden = !trace;
    graphSummary.textContent = trace ? [workflowInspectionLabel(trace),
      assets.length + (assets.length === 1 ? ' model file or reference' : ' model files and references')].join(' · ') : '';
    const source = trace?.source;
    graphSource.hidden = !source;
    graphSource.replaceChildren(...(source ? [sourceLink(source.link, source.modelName || 'Published workflow', getContext()),
      ' · Version #' + source.versionId + ' · File #' + source.fileId + ' · ' + source.graph] : []));
    assetReference.value = '';
    assetSection.hidden = !assets.length;
    assetChoice.replaceChildren(...assets.map((asset, index) => {
      const option = element('option', asset.kind + ' · ' + workflowAssetLabel(asset));
      option.value = String(index);
      return option;
    }));
    drawFileChecks();
  }

  function loadProfile(value) {
    runtime.value = value.runtime;
    family.value = value.baseModel;
    vram.value = value.vram ?? '';
    setAssets(value.assets);
    graph.value = '';
    clearSetupCheck();
  }

  graph.addEventListener('change', async () => {
    const file = graph.files?.[0];
    if (!file) return;
    graph.value = '';
    const original = store;
    const selection = ++graphRevision;
    try {
      if (file.size > maximumWorkflowBytes) throw new Error('Choose a workflow JSON file up to 10 MB.');
      const inspected = inspectWorkflowGraph(JSON.parse(await file.text()));
      if (original !== store || selection !== graphRevision || !dialog.open) return;
      const { assets: found, ...trace } = inspected;
      setAssets(found, trace);
      message.textContent = '';
      draw();
    } catch (error) {
      if (original === store && selection === graphRevision && dialog.open) {
        message.textContent = error instanceof SyntaxError ? 'The selected file is not valid JSON.' : error.message;
      }
    }
  });
  clearAssets.addEventListener('click', () => { setAssets([]); draw(); });
  assetChoice.addEventListener('change', () => { assetReference.value = ''; clearAssetCheck(); });
  assetReference.addEventListener('input', clearAssetCheck);
  dialog.addEventListener('close', clearAssetCheck);
  dialog.addEventListener('close', clearAudit);
  dialog.addEventListener('close', clearSetupCheck);
  dialog.addEventListener('close', backup.reset);
  dialog.addEventListener('close', modelFiles.reset);
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    openingWorkspace?.abort();
    openingWorkspace = undefined;
    clearExampleCheck();
    if (graphTrace?.source) setAssets(state.profile.assets);
  });
  assetCheck.addEventListener('click', async () => {
    const asset = assets[Number(assetChoice.value)];
    const current = getContext();
    if (checking || auditing || !asset || !current) return;
    const controller = new AbortController();
    checking = controller;
    assetResults.replaceChildren();
    assetStatus.textContent = 'Checking Civitai model listings…';
    drawFileChecks();
    try {
      const checked = await checkWorkspaceAsset(current, asset, family.value,
        { signal: controller.signal, reference: assetReference.value });
      if (controller.signal.aborted || !dialog.open) return;
      assetStatus.textContent = workflowFileStatus(checked);
      assetResults.replaceChildren(renderWorkflowFile({ asset, check: checked }, current, { expanded: true, onUpgrade: reviewUpgrade }));
    } catch (error) {
      if (!controller.signal.aborted && dialog.open) assetStatus.textContent = error.message || 'The file check is unavailable.';
    } finally {
      if (checking === controller) { checking = undefined; drawFileChecks(); }
    }
  });

  auditCheck.addEventListener('click', async () => {
    const current = getContext();
    if (checking || auditing || !current || !assets.length || auditRetryAt > Date.now()) return;
    if (auditOffset >= assets.length) clearAudit();
    const controller = new AbortController();
    auditing = controller;
    const settings = profile();
    const status = () => auditRows.length + ' of ' + settings.assets.length + ' checked · ' +
      auditRows.filter(row => row.check?.newer).length + ' with a newer matching release';
    auditStatus.textContent = 'Checking workflow files…';
    drawFileChecks();
    try {
      const result = await checkWorkflowFiles(current, settings, {
        offset: auditOffset, signal: controller.signal,
        onFile(row) {
          if (auditing !== controller || !dialog.open) return;
          auditRows.push(row);
          auditOffset++;
          auditCheckedAt = new Date().toISOString();
          auditResults.append(renderWorkflowFile(row, current, { onUpgrade: reviewUpgrade }));
          auditStatus.textContent = status();
        },
      });
      if (auditing !== controller || !dialog.open) return;
      auditCheckedAt = result.checkedAt;
      if (result.throttled && result.retryAfter) {
        const seconds = /^\d+$/u.test(result.retryAfter) ? Number(result.retryAfter) : null;
        auditRetryAt = seconds === null ? Date.parse(result.retryAfter) || 0 : Date.now() + seconds * 1000;
        const remaining = auditRetryAt - Date.now();
        if (remaining > 0) auditRetryTimer = setTimeout(drawFileChecks, Math.min(remaining, 2_147_483_647));
      }
      auditStatus.textContent = status() + (result.throttled ? ' · Civitai has asked for a pause. Continue when ready.'
        : result.next !== null ? ' · Continue to check the remaining files.' : ' · Catalog check finished.');
    } catch (error) {
      if (auditing === controller && dialog.open) {
        auditStatus.textContent = status() + (controller.signal.aborted ? ' · Stopped.' : ' · ' + (error.message || 'The check was interrupted.'));
      }
    } finally {
      if (auditing === controller) { auditing = undefined; drawFileChecks(); }
    }
  });
  auditCancel.addEventListener('click', () => auditing?.abort());
  auditCopy.addEventListener('click', () => {
    if (!auditRows.length) return;
    showReportExport(workflowAuditMarkdown(auditRows, profile(), auditCheckedAt, graphTrace),
      { title: 'Copy workflow file check', label: 'Workflow file check in Markdown' });
  });
  auditSave.addEventListener('click', () => {
    const versions = auditVersions();
    if (!versions.length) return;
    const operation = crypto.randomUUID();
    void change(value => saveWorkspaceEntry(value, 'shortlists', 'Workflow upgrades', versions, operation));
  });
  setupCheck.addEventListener('click', async () => {
    const versions = choices().shortlists;
    const current = getContext();
    if (fitting || !current || !versions.length) return;
    const controller = new AbortController();
    fitting = controller;
    setupResults.replaceChildren();
    setupStatus.textContent = 'Rechecking exact versions on Civitai…';
    draw();
    try {
      const report = await checkWorkspaceSetup(current, versions, profile(), { signal: controller.signal });
      if (controller.signal.aborted || !dialog.open) return;
      const environment = [report.runtime === 'civitai' ? 'Civitai' : 'Local ComfyUI', report.baseModel,
        report.vram && report.vram + ' GB declared VRAM'].filter(Boolean).join(' · ');
      setupStatus.textContent = report.cards.length + ' verified ' + (report.cards.length === 1 ? 'version' : 'versions') +
        (report.unavailable.length ? ' · ' + report.unavailable.length + ' unavailable for this viewer' : '') +
        (report.unavailableFiles.length ? ' · ' + report.unavailableFiles.length + (report.unavailableFiles.length === 1 ? ' saved file unavailable' : ' saved files unavailable') : '');
      const remaining = report.runtime === 'civitai' ? 'Viewer generation permission and pricing remain unverified.'
        : 'Local loader support and runtime memory use remain untested.';
      setupResults.append(element('p', environment), element('p', remaining));
      const safe = value => String(value).replace(/[\\[\]<>*`]/gu, '\\$&');
      const exported = ['# Civitai setup check', '', safe(environment), 'Checked ' + report.checkedAt, remaining, setupStatus.textContent];
      for (const card of report.cards) {
        const panel = element('section', null, 'setup-evidence');
        const title = element('h4');
        title.append(sourceLink(card.link, card.title + ' · Version ' + card.id, current));
        const facts = element('dl');
        exported.push('', '## [' + safe(card.title) + '](<' + card.link + '>)');
        for (const [label, value] of fitRows(card)) {
          facts.append(element('dt', label), element('dd', value));
          exported.push('- ' + safe(label) + ' · ' + safe(value).replace(/\n/gu, ' · '));
        }
        panel.append(title, facts);
        setupResults.append(panel);
      }
      if (report.cards.length) {
        const copy = element('button', 'Copy setup check', 'chip');
        copy.type = 'button';
        copy.addEventListener('click', () => showReportExport(exported.join('\n'), { title: 'Copy setup check', label: 'Setup check in Markdown' }));
        setupResults.append(copy);
      }
    } catch (error) {
      if (!controller.signal.aborted && dialog.open) setupStatus.textContent = error.message || 'The version check is unavailable.';
    } finally {
      if (fitting === controller) { fitting = undefined; draw(); }
    }
  });
  clearRecent.addEventListener('click', () => {
    recent = [];
    historyStore?.write(recent);
    message.textContent = 'Recent searches cleared.';
    draw();
  });
  family.addEventListener('input', () => {
    profileApply.disabled = !family.value.trim();
    clearAssetCheck();
    clearAudit();
    clearSetupCheck();
    if (activeExample) drawExampleCheck();
  });
  vram.addEventListener('input', () => { clearAudit(); clearSetupCheck(); });
  runtime.addEventListener('change', () => { clearAudit(); clearSetupCheck(); });
  profileSave.addEventListener('click', () => { const saved = profile(); void change(current => ({ ...current, profile: saved })); });
  profileApply.addEventListener('click', () => { const saved = profile(); dialog.close(); applyProfile(saved); });
  id('workspace-example-copy').addEventListener('click', () => {
    if (!activeExample) return;
    const preview = showReportExport(workspaceExampleMarkdown(compareWorkspaceExample(activeExample, profile())),
      { title: 'Copy comparison', label: 'Setup comparison in Markdown' });
    exampleExport = preview;
    preview.addEventListener('close', () => { if (exampleExport === preview) exampleExport = undefined; }, { once: true });
  });

  async function savePendingChange() {
    if (!store || !ready || busy || !pendingChange) return false;
    const original = store;
    const change = pendingChange;
    const controller = writingWorkspace = new AbortController();
    const isCurrent = () => original === store && writingWorkspace === controller;
    const checkingSave = window.document.activeElement === checkChange;
    busy = true;
    message.textContent = 'Updating your workspace…';
    draw();
    try {
      if (snapshot) {
        const result = await writeWorkspaceChange(original, snapshot, change, { signal: controller.signal, onCheck() {
          if (isCurrent()) message.textContent = 'Checking whether Civitai saved the change…';
        } });
        if (!isCurrent()) return false;
        snapshot = result.snapshot;
        state = workspaceDocument(snapshot.data);
        if (result.outcome === 'check') {
          message.textContent = 'Civitai’s confirmation is still pending. Check the save to continue.';
          return false;
        }
        if (result.outcome === 'review') {
          pendingChange = undefined;
          message.textContent = 'Workspace changed elsewhere. Review the current items before saving again.';
          return false;
        }
      } else {
        const updated = change.apply(state);
        await original.write(updated);
        if (!isCurrent()) return false;
        state = updated;
      }
      pendingChange = undefined;
      name.value = '';
      message.textContent = 'Workspace updated.';
      return true;
    } catch (error) {
      if (isCurrent()) {
        if (!change.uncertain) pendingChange = undefined;
        const detail = error.message || 'The workspace could not be updated.';
        message.textContent = error.code === 'too_large' ? detail + ' Remove saved items or import a smaller selection.' : detail;
      }
    } finally {
      if (isCurrent()) {
        writingWorkspace = undefined;
        busy = false;
        draw();
        if (checkingSave && dialog.open && [window.document.body, checkChange].includes(window.document.activeElement)) {
          (checkChange.hidden ? id('workspace-tab-saved') : checkChange).focus();
        }
      }
    }
    return false;
  }

  function change(apply) {
    if (!store || !ready || busy || pendingChange) return false;
    pendingChange = { id: crypto.randomUUID(), apply };
    return savePendingChange();
  }

  checkChange.addEventListener('click', () => { void savePendingChange(); });

  function save(type) {
    if (!name.value.trim()) {
      message.textContent = 'Enter a name for the saved item.';
      name.reportValidity();
      return;
    }
    const selected = choices();
    const value = selected[type];
    const title = name.value;
    const operation = crypto.randomUUID();
    void change(current => saveWorkspaceEntry(current, type, title, value, operation, type === 'searches' ? selected.checkpoint : undefined));
  }

  saveSearch.addEventListener('click', () => save('searches'));
  saveList.addEventListener('click', () => save('shortlists'));
  id('workspace-close').addEventListener('click', () => dialog.close());
  publicWork.addEventListener('click', () => {
    if (canReadPublicWork(getContext()) && openSearch({ scope: 'report', reportType: 'publicWork', query: '' }, button)) dialog.close();
  });

  function selectTab(active, focus = false) {
    for (const tab of tabs) {
      const selected = tab === active;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      id(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) active.focus();
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      const offsets = { ArrowLeft: -1, ArrowRight: 1, Home: -index, End: tabs.length - 1 - index };
      if (!Object.hasOwn(offsets, event.key)) return;
      event.preventDefault();
      selectTab(tabs[(index + offsets[event.key] + tabs.length) % tabs.length], true);
    });
  }

  async function openWorkspace({ published, example } = {}) {
    if (!store || dialog.open) return;
    if (pendingChange) {
      const activeTab = id('workspace-tab-saved');
      selectTab(activeTab);
      dialog.showModal();
      activeTab.focus();
      return;
    }
    const original = store;
    openingWorkspace?.abort();
    const opening = openingWorkspace = new AbortController();
    clearExampleCheck();
    const stillOpening = () => original === store && openingWorkspace === opening && dialog.open && !opening.signal.aborted;
    message.textContent = 'Loading saved items…';
    ready = false;
    busy = true;
    draw();
    const activeTab = id(published || example ? 'workspace-tab-files' : 'workspace-tab-saved');
    selectTab(activeTab);
    dialog.showModal();
    activeTab.focus();
    try {
      const stored = original.readSnapshot
        ? await original.readSnapshot({ signal: opening.signal }) : { data: await original.read() };
      if (stillOpening()) {
        snapshot = original.readSnapshot ? stored : undefined;
        state = workspaceDocument(stored.data);
        loadProfile(state.profile);
        ready = true;
        message.textContent = '';
      }
    } catch (error) {
      if (stillOpening()) message.textContent = error.message || 'The workspace is unavailable.';
    } finally {
      if (stillOpening()) {
        openingWorkspace = undefined;
        busy = false;
        const viewer = getContext();
        const owner = (published ?? example)?.owner;
        const sameViewer = owner && viewer?.origin === owner.origin && viewer.viewerUserId === owner.viewerUserId &&
          (viewer.browsingLevel & owner.browsingLevel) === owner.browsingLevel;
        if (sameViewer && published) {
          const { assets: found, ...trace } = published.inspected;
          setAssets(found, { ...trace, source: published.source });
          graph.closest('details').open = true;
        }
        if (sameViewer && example) {
          activeExample = example.setup;
          graph.closest('details').open = true;
        }
        draw();
        if (sameViewer && published) auditCheck.focus();
        if (activeExample) exampleHeading.focus();
      }
    }
  }
  button.addEventListener('click', () => { void openWorkspace(); });

  function resetWorkspaceWrite() {
    openingWorkspace?.abort();
    openingWorkspace = undefined;
    writingWorkspace?.abort();
    writingWorkspace = undefined;
    pendingChange = undefined;
    snapshot = undefined;
    ready = false;
    busy = false;
  }

  function bind(context) {
    modelFiles.bind(context);
    publicWork.parentElement.hidden = !canReadPublicWork(context);
    const persistent = Boolean(context?.hosted && context.signedIn && context.token &&
      context.storageMode !== 'local-preview' && context.scopes.includes('apps:storage'));
    storage.bind(persistent ? context : null);
    const next = context ? [context.origin, context.viewerUserId ?? 'guest', persistent ? 'private' : 'tab'].join('#') : null;
    const level = context?.browsingLevel;
    if (next === key) {
      if ((level & ceiling) !== ceiling) {
        if (pendingChange || openingWorkspace) {
          resetWorkspaceWrite();
          if (dialog.open) dialog.close();
        }
        backup.reset();
        clearExampleCheck();
        if (graphTrace?.source) setAssets(state.profile.assets);
        assetReference.value = '';
        clearAssetCheck();
        clearAudit();
        clearSetupCheck();
      }
      ceiling = level;
      return;
    }
    key = next;
    ceiling = level;
    resetWorkspaceWrite();
    backup.reset();
    clearExampleCheck();
    if (dialog.open) dialog.close();
    state = workspaceDocument(null);
    loadProfile(state.profile);
    store = context ? persistent ? appPrivateRecord(context, getContext, 'search-workspace') : localStore(key) : null;
    historyStore = context ? localStore('recent:' + key) : null;
    recent = recentWorkspaceSearches(historyStore?.read());
    button.disabled = !store;
    id('workspace-storage').textContent = persistent ? 'Uses your private Civitai storage.' : 'Saved in this preview session.';
    name.value = '';
    draw();
  }

  function remember(context, result, filters) {
    const viewer = getContext();
    if (!historyStore || result.library || result.report?.localTrace || result.visualComposition || viewer?.origin !== context.origin || viewer.viewerUserId !== context.viewerUserId ||
        (viewer.browsingLevel & context.browsingLevel) !== context.browsingLevel || !workspaceFilters(filters)) return;
    recent = recentWorkspaceSearches([filters, ...recent]);
    historyStore.write(recent);
    if (dialog.open) draw();
  }

  return { bind, remember, graphicsMemory() {
    return runtime.value === 'comfyui' ? profile().vram : null;
  }, openPublishedAudit(owner, inspected, source) {
    void openWorkspace({ published: { owner, inspected, source } });
  }, openExampleCheck(owner, setup) {
    void openWorkspace({ example: { owner, setup } });
  }, refreshSearch(entry, checkpoint, owner) {
    const viewer = getContext();
    if (viewer?.origin !== owner.origin || viewer.viewerUserId !== owner.viewerUserId || viewer.browsingLevel !== owner.browsingLevel) return false;
    return change(current => updateSearchCheckpoint(current, entry, checkpoint));
  } };
}
