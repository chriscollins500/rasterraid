import { mergeWorkspaceBackup, readWorkspaceBackup, recentSearchLabel, workspaceBackup, workspaceBackupMaximumBytes,
  workspaceBackupPlan } from './workspace.mjs';
import { showReportExport } from './report-view.js';
import { element } from './view.js';
import { downloadJson, workspaceBackupFilename } from './download-json.js';

const groups = ['searches', 'shortlists'];
const itemKey = (group, item) => group + '/' + item.id;
const countLabel = (count, one, many = one + 's') => count + ' ' + (count === 1 ? one : many);

function itemSummary(group, item) {
  if (group === 'searches') return [recentSearchLabel(item.filters), item.filters.query,
    item.filters.baseModel, item.filters.selectedMediaTag && 'Tag #' + item.filters.selectedMediaTag.id,
    item.checkpoint && countLabel(item.checkpoint.references.length, 'saved source'),
    item.catalogCheckpoint && countLabel(item.catalogCheckpoint.references.length, 'saved result')].filter(Boolean).join(' · ');
  const pins = item.versions.reduce((count, entry) => count + (entry.filePins?.length ?? 0), 0);
  return [countLabel(item.versions.length, 'saved version'), pins && countLabel(pins, 'exact file')].filter(Boolean).join(' · ');
}

export function configureWorkspaceBackup(window, { getContext, change }) {
  const id = name => window.document.getElementById('workspace-backup-' + name);
  const download = id('download');
  const copy = id('copy');
  const hostedNote = id('hosted-note');
  const input = id('file');
  const paste = id('paste');
  const inspect = id('inspect');
  const review = id('review');
  const choices = id('choices');
  const apply = id('apply');
  const cancel = id('cancel');
  const summary = id('summary');
  const status = id('status');
  let busyDownload;
  let exported;
  let pending;
  let state;
  let ready = false;
  let readRevision = 0;
  const selected = new Set();

  function chosen() {
    return Object.fromEntries(groups.map(group => [group, (pending?.[group] ?? []).filter(row => selected.has(itemKey(group, row)))]));
  }

  function buttons() {
    const hasSavedItems = groups.some(group => state?.[group].length);
    download.disabled = !ready || !hasSavedItems || Boolean(busyDownload);
    copy.disabled = !ready || !hasSavedItems;
    input.disabled = paste.disabled = !ready;
    hostedNote.hidden = !getContext()?.hosted;
    inspect.disabled = !ready || !paste.value.trim();
    const count = selected.size;
    apply.disabled = !ready || !count;
    apply.textContent = count ? 'Import ' + countLabel(count, 'item') : 'Import selected';
    cancel.disabled = !ready;
    for (const box of choices.querySelectorAll('input')) box.disabled = !ready;
  }

  function paintReview() {
    review.hidden = !pending;
    choices.replaceChildren();
    if (!pending) { buttons(); return; }
    const { additions, duplicates } = workspaceBackupPlan(state, pending);
    const rows = [];
    const remaining = new Set();
    for (const group of groups) for (const item of additions[group]) {
      const key = itemKey(group, item);
      remaining.add(key);
      const label = element('label', null, 'workspace-backup-choice');
      const box = element('input');
      box.type = 'checkbox';
      box.checked = selected.has(key);
      const caption = element('span');
      caption.append(element('strong', item.name), element('small', itemSummary(group, item)));
      box.addEventListener('change', () => {
        if (box.checked) selected.add(key);
        else selected.delete(key);
        buttons();
      });
      label.append(box, caption);
      rows.push(label);
    }
    for (const key of selected) if (!remaining.has(key)) selected.delete(key);
    choices.append(...rows);
    const duplicateCount = groups.reduce((count, group) => count + duplicates[group], 0);
    summary.textContent = [rows.length ? countLabel(rows.length, 'item') + ' available to import.' : 'No new items to import.',
      duplicateCount && countLabel(duplicateCount, 'item') + ' already included.'].filter(Boolean).join(' ');
    buttons();
  }

  function clearReview() {
    readRevision++;
    pending = undefined;
    selected.clear();
    paintReview();
  }

  function read(value) {
    clearReview();
    try {
      pending = readWorkspaceBackup(value);
      const { additions } = workspaceBackupPlan(state, pending);
      for (const group of groups) for (const item of additions[group]) selected.add(itemKey(group, item));
      paste.value = '';
      status.textContent = 'Backup ready for review.';
      paintReview();
      summary.focus();
    } catch (error) { status.textContent = error.message; }
  }

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file || !ready) return;
    clearReview();
    input.value = '';
    const current = readRevision;
    try {
      if (file.size > workspaceBackupMaximumBytes) throw new Error('Choose a RasterRaid backup up to 2 MiB.');
      const bytes = await file.arrayBuffer();
      if (current !== readRevision || !ready) return;
      read(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      if (current === readRevision && ready) status.textContent = error instanceof TypeError ? 'The backup must use UTF-8 text.' : error.message;
    }
  });
  paste.addEventListener('input', buttons);
  inspect.addEventListener('click', () => { if (ready) read(paste.value); });
  cancel.addEventListener('click', () => { clearReview(); status.textContent = ''; input.focus(); });
  apply.addEventListener('click', async () => {
    if (!ready || !pending || !selected.size) return;
    const before = pending;
    const selection = chosen();
    if (await change(current => mergeWorkspaceBackup(current, selection)) && pending === before) {
      clearReview();
      status.textContent = 'Backup imported.';
      input.focus();
    }
  });
  copy.addEventListener('click', () => {
    if (!ready) return;
    exported = showReportExport(workspaceBackup(state), { title: 'Copy workspace backup', label: 'Workspace backup JSON' });
  });
  download.addEventListener('click', async () => {
    if (!ready || busyDownload) return;
    const context = getContext();
    const json = workspaceBackup(state);
    const controller = new AbortController();
    busyDownload = controller;
    buttons();
    status.textContent = 'Preparing the backup download…';
    try {
      await downloadJson(window, context, workspaceBackupFilename, json, controller.signal);
      if (!controller.signal.aborted) status.textContent = 'Download started.';
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message || 'The backup download is unavailable.';
    } finally {
      if (busyDownload === controller) { busyDownload = undefined; buttons(); }
    }
  });

  return {
    setWorkspace(value, enabled) {
      const updated = state !== value;
      state = value;
      ready = enabled;
      if (updated && pending) paintReview();
      else buttons();
    },
    reset() {
      busyDownload?.abort();
      busyDownload = undefined;
      exported?.remove();
      exported = undefined;
      input.value = paste.value = '';
      status.textContent = '';
      clearReview();
    },
  };
}
