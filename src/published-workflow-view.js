import { numericId } from './catalog.mjs';
import { isWorkflowModel, workflowFiles } from './published-workflow.mjs';
import { element, sourceLink } from './view.js';
import { inspectWorkflowGraph, workflowAssetLabel, workflowInspectionLabel } from './workflow-profile.mjs';

const formatLabel = { ui: 'ComfyUI editor graph', api: 'ComfyUI API graph' };
const readStatus = {
  'not-found': 'Civitai could not provide this file for your account. Choose another file or open the release on Civitai.',
  forbidden: 'Civitai declined this read for the current preview or browsing settings.',
  unauthorized: 'Sign in on Civitai to read this workflow.',
  'too-large': 'This file is larger than Civitai can open here.',
  'parse-failed': 'Civitai could not read the workflow file. Try again or open the release.',
  busy: 'Civitai is busy. Try again in a moment.',
  'rate-limited': 'Civitai has paused workflow reads. Try again in about a minute.',
  timeout: 'Civitai did not answer in time. Open the release or try again.',
  invalid: 'Civitai returned a file that could not be confirmed for this selection.',
  unavailable: 'This Civitai page could not read the file.',
  cancelled: 'Stopped waiting for Civitai.',
};

function chip(label) {
  const button = element('button', label, 'chip');
  button.type = 'button';
  return button;
}

export function configurePublishedWorkflow({ getContext, openAudit }) {
  const dialog = element('dialog', null, 'button-layout published-workflow');
  const title = element('h2', 'Inspect published workflow');
  title.id = 'published-workflow-title';
  title.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', title.id);
  const release = element('p', null, 'published-workflow-name');
  const fields = element('div', null, 'filter-grid');
  const fileLabel = element('label', 'Workflow file');
  const fileChoice = element('select');
  fileLabel.append(fileChoice);
  const graphLabel = element('label', 'Workflow graph');
  const graphChoice = element('select');
  graphLabel.append(graphChoice);
  fields.append(fileLabel, graphLabel);
  const read = chip('Read workflow');
  const stop = chip('Stop waiting');
  const signIn = chip('Sign in to read the workflow');
  const verify = chip('Open model check in Workspace');
  const close = chip('Close');
  const status = element('p');
  status.setAttribute('role', 'status');
  const summary = element('p');
  const models = element('ul');
  const guidance = element('p', 'Civitai checks access before sharing the graph. The model check uses its file names or exact Civitai references.');
  const actions = element('div', null, 'button-layout-actions');
  const native = element('span');
  actions.append(native, close);
  const readActions = element('div', null, 'workspace-actions');
  readActions.append(read, stop, signIn);
  dialog.append(title, release, fields, readActions, status, summary, models, verify, guidance, actions);
  document.body.append(dialog);

  let target;
  let reading;
  let file;
  let inspection;

  function clearGraph() {
    file = undefined;
    inspection = undefined;
    graphChoice.replaceChildren();
    graphLabel.hidden = true;
    verify.hidden = true;
    summary.textContent = '';
    models.replaceChildren();
  }

  function paintButtons() {
    const context = getContext();
    read.hidden = !context?.signedIn;
    read.disabled = Boolean(reading);
    stop.hidden = !reading;
    signIn.hidden = !context?.hosted || context.signedIn;
    fileChoice.disabled = Boolean(reading);
  }

  function showGraph() {
    inspection = undefined;
    verify.hidden = true;
    models.replaceChildren();
    const entry = file?.graphs[Number(graphChoice.value)];
    if (!entry) return;
    try {
      inspection = inspectWorkflowGraph(entry.graph);
      summary.textContent = [formatLabel[entry.format], inspection.nodeCount + ' nodes', workflowInspectionLabel(inspection),
        inspection.assets.length + ' model files or references'].join(' · ');
      models.replaceChildren(...inspection.assets.slice(0, 8).map(asset => element('li', asset.kind + ' · ' + workflowAssetLabel(asset))));
      if (inspection.assets.length > 8) models.append(element('li', 'Open Workspace to check all ' + inspection.assets.length + ' references.'));
      verify.hidden = !inspection.assets.length;
    } catch (error) {
      summary.textContent = error.message || 'This graph could not be inspected in the browser.';
    }
  }

  read.addEventListener('click', async () => {
    const context = getContext();
    if (!target || !context?.readWorkflowFile || reading) return;
    const controller = new AbortController();
    reading = controller;
    const wasRead = document.activeElement === read;
    clearGraph();
    paintButtons();
    if (wasRead) stop.focus();
    status.textContent = 'Waiting for Civitai to read the workflow…';
    const fileId = fileChoice.value ? Number(fileChoice.value) : undefined;
    const result = await context.readWorkflowFile({ modelId: target.modelId, versionId: target.versionId, fileId }, controller.signal);
    if (!dialog.open || reading !== controller) return;
    reading = undefined;
    const stopped = document.activeElement === stop;
    paintButtons();
    if (stopped) read.focus();
    if (result.status !== 'ready') {
      status.textContent = readStatus[result.status] ?? readStatus.unavailable;
      return;
    }
    file = result.file;
    const notes = [file.fileName, 'File #' + file.fileId,
      file.truncated && 'Some archive entries were omitted by Civitai',
      file.skipped > 0 && file.skipped + ' JSON entries without a supported graph'];
    if (!file.graphs.length) notes.push('No supported ComfyUI graph found');
    status.textContent = notes.filter(Boolean).join(' · ');
    graphChoice.replaceChildren(...file.graphs.map((entry, index) => {
      const option = element('option', entry.path + ' · ' + formatLabel[entry.format]);
      option.value = String(index);
      return option;
    }));
    graphLabel.hidden = file.graphs.length < 2;
    showGraph();
  });
  stop.addEventListener('click', () => reading?.abort());
  signIn.addEventListener('click', () => getContext()?.requestSignIn?.());
  fileChoice.addEventListener('change', () => { clearGraph(); status.textContent = ''; });
  graphChoice.addEventListener('change', showGraph);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    reading?.abort();
    reading = undefined;
    target = undefined;
    status.textContent = '';
    clearGraph();
  });
  verify.addEventListener('click', () => {
    if (!target || !file || !inspection?.assets.length) return;
    const { owner, link, modelName, versionId } = target;
    const { fileName, fileId, graphs, truncated } = file;
    const graph = graphs[Number(graphChoice.value)];
    const source = { link, modelName, versionId, fileName, fileId, graph: graph.path, format: formatLabel[graph.format], truncated };
    const checked = inspection;
    dialog.close();
    openAudit(owner, checked, source);
  });

  return {
    reset() {
      reading?.abort();
      if (dialog.open) dialog.close();
    },
    open(candidate) {
      const owner = getContext();
      if (dialog.open || !owner?.hosted || !isWorkflowModel(candidate.type) || !numericId(candidate.modelId) || !numericId(candidate.id)) return;
      const url = new URL('/models/' + candidate.modelId, owner.origin);
      url.searchParams.set('modelVersionId', candidate.id);
      target = { owner, modelId: candidate.modelId, versionId: candidate.id, modelName: candidate.model, link: url.href };
      release.textContent = [candidate.model, candidate.version, 'Version #' + candidate.id].filter(Boolean).join(' · ');
      native.replaceChildren(sourceLink(url.href, 'Open workflow on Civitai ↗', owner));
      const files = new Map(workflowFiles(candidate).map(file => [file.id, file.name]));
      const pinned = candidate.selectedFile;
      if (numericId(pinned?.id)) files.set(pinned.id, pinned.name);
      const defaultFile = element('option', 'Civitai’s default file');
      defaultFile.value = '';
      fileChoice.replaceChildren(defaultFile, ...[...files].map(([id, name]) => {
        const option = element('option', [name, 'File #' + id].filter(Boolean).join(' · '));
        option.value = String(id);
        return option;
      }));
      fileChoice.value = numericId(pinned?.id) ? String(pinned.id) : '';
      fileLabel.hidden = !files.size;
      clearGraph();
      status.textContent = owner.signedIn ? '' : readStatus.unauthorized;
      paintButtons();
      dialog.showModal();
      title.focus();
    },
  };
}
