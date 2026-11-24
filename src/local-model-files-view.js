import { modelFileLimit, localFileChecksum } from './local-file-checksum.mjs';
import { readPublishedFiles } from './search.mjs';
import { element, sourceLink } from './view.js';
import { showModelHandoff } from './model-handoff.js';

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const title = file => file.name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 160) || 'Selected model file';
const fileSize = bytes => {
  const unit = bytes >= 2 ** 30 ? ['GiB', 2 ** 30] : bytes >= 2 ** 20 ? ['MiB', 2 ** 20] :
    bytes >= 2 ** 10 ? ['KiB', 2 ** 10] : ['bytes', 1];
  return sizeFormat.format(bytes / unit[1]) + ' ' + unit[0];
};
const labels = {
  unique: 'Exact file found',
  shared: 'Checksum shared by several listings or files',
  incomplete: 'Catalog check incomplete',
  missing: 'No published match found',
};

function matchCard(window, model, file, context, onReport) {
  const card = element('article', null, 'local-model-match');
  const example = model.examples.find(row => row.preview);
  if (example) {
    const picture = element('img');
    picture.src = example.preview;
    picture.alt = '';
    picture.loading = 'lazy';
    card.append(picture);
  }
  const body = element('div');
  const name = [model.model, model.version].filter(Boolean).join(' · ');
  body.append(sourceLink(model.link, name || 'Version #' + model.id, context),
    element('p', [model.base, model.type, file.format, 'File #' + file.id].filter(Boolean).join(' · ')));
  const report = element('button', 'Research this file', 'chip');
  report.type = 'button';
  report.setAttribute('aria-label', 'Research this file · ' + (name || model.id) + ' · file ' + file.id);
  report.addEventListener('click', () => {
    const reference = new URL(model.link);
    reference.searchParams.set('modelFileId', String(file.id));
    onReport(reference.href);
  });
  const handoff = element('button', 'Use in other tools', 'chip');
  handoff.type = 'button';
  handoff.setAttribute('aria-label', 'Use in other tools · ' + (name || model.id) + ' · file ' + file.id);
  handoff.addEventListener('click', () => showModelHandoff(window, context, model, file));
  const actions = element('div', null, 'model-handoff-actions');
  actions.append(report, handoff);
  body.append(actions);
  card.append(body);
  return card;
}

export function configureLocalModelFiles(window, { getContext, onReport }) {
  const id = name => window.document.getElementById(name);
  const picker = id('local-model-files');
  const lookup = id('local-model-lookup');
  const cancel = id('local-model-cancel');
  const clear = id('local-model-clear');
  const status = id('local-model-status');
  const progress = id('local-model-progress');
  const results = id('local-model-results');
  let queue = [];
  let controller;
  let choices = new Map();
  let lookupDone = false;
  let owner;
  let ceiling = 0;

  function draw() {
    const context = getContext();
    const running = Boolean(controller);
    lookup.disabled = running || !context || Boolean(context.hosted && !context.token) ||
      !queue.some(row => !row.failed);
    lookup.textContent = lookupDone ? 'Check Civitai again' : 'Find Civitai matches';
    picker.disabled = running;
    cancel.hidden = !running;
    clear.hidden = running || !queue.length;
    if (!running) progress.hidden = true;
    results.replaceChildren(...queue.map(row => {
      const found = choices.get(row.digest);
      const item = element('li', null, 'local-model-file');
      const header = element('div', null, 'local-model-file-heading');
      header.append(element('strong', row.name),
        element('span', fileSize(row.size) + ' · ' + (row.failed ? 'Could not read file' :
          found ? labels[found.status] : row.digest ? 'Checksum ready' : 'Ready to check')));
      item.append(header);
      if (row.digest) {
        const detail = element('details');
        detail.append(element('summary', 'SHA-256 checksum'), element('code', row.digest));
        item.append(detail);
      }
      if (found?.status === 'shared') item.append(element('p', found.candidates.length
        ? 'Each result below matches these bytes. Open the listing you intend to use.'
        : 'Civitai listed multiple matches. No matching file details were available in this view.'));
      if (found?.status === 'incomplete') item.append(element('p', 'Civitai did not confirm all the file details. You can check again without rereading this file.'));
      for (const model of found?.candidates ?? []) {
        for (const file of [model.selectedFile, ...(model.matchingFiles ?? [])].filter(Boolean)) {
          item.append(matchCard(window, model, file, context, onReport));
        }
      }
      return item;
    }));
  }

  function reset() {
    controller?.abort();
    controller = undefined;
    queue = [];
    choices = new Map();
    lookupDone = false;
    picker.value = '';
    status.textContent = '';
    draw();
  }

  picker.addEventListener('change', () => {
    const selected = Array.from(picker.files ?? []);
    if (!selected.length) return;
    reset();
    queue = selected.slice(0, modelFileLimit).map(file => ({ file, name: title(file), size: file.size }));
    status.textContent = selected.length > modelFileLimit ? 'The first eight selected files are ready to check.' :
      queue.length + (queue.length === 1 ? ' file selected.' : ' files selected.');
    draw();
  });
  cancel.addEventListener('click', () => controller?.abort());
  clear.addEventListener('click', () => { reset(); picker.focus(); });
  lookup.addEventListener('click', async () => {
    const context = getContext();
    if (lookup.disabled || controller || !context) return;
    const job = new AbortController();
    const { signal } = job;
    controller = job;
    choices = new Map();
    draw();
    try {
      for (const [index, row] of queue.entries()) {
        if (!row.file || row.failed) continue;
        const fileStatus = 'Reading file ' + (index + 1) + ' of ' + queue.length + '…';
        status.textContent = fileStatus;
        progress.hidden = false;
        progress.value = 0;
        try {
          row.digest = await localFileChecksum(row.file, {
            signal,
            onProgress(bytes) {
              if (job === controller) progress.value = row.size ? bytes / row.size : 1;
            },
          });
          signal.throwIfAborted();
        } catch {
          signal.throwIfAborted();
          row.failed = true;
        }
        row.file = null;
      }
      const hashes = queue.map(row => row.digest).filter(Boolean);
      progress.hidden = true;
      if (!hashes.length) {
        status.textContent = 'Choose another file to try again.';
        return;
      }
      status.textContent = 'Checking published Civitai files…';
      const receipt = await readPublishedFiles(context, hashes, { signal });
      if (job !== controller || signal.aborted) return;
      choices = receipt.files;
      lookupDone = true;
      const ready = queue.filter(row => choices.get(row.digest)?.candidates.length).length;
      status.textContent = receipt.flows.some(flow => flow.status === 429)
        ? 'Civitai is limiting catalog requests. Try again after the pause.'
        : ready + ' of ' + queue.length + ' selected files have a verified match.';
    } catch {
      if (job === controller) status.textContent = signal.aborted ? 'File check stopped.' : 'The file check is unavailable. Try again.';
    } finally {
      if (job === controller) {
        controller = undefined;
        draw();
      }
    }
  });

  function bind(context) {
    const key = context && [context.origin, context.viewerUserId, context.hosted, Boolean(context.token)].join('#');
    const level = context?.browsingLevel ?? 0;
    const changed = key !== owner || (level & ceiling) !== ceiling;
    owner = key;
    ceiling = level;
    if (changed) reset();
  }
  return { bind, reset };
}
