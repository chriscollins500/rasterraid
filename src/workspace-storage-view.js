import { sourceLink } from './view.js';
import { readPrivateStorageUsage } from './workflow-journal.mjs';

const count = new Intl.NumberFormat();
const size = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const formatBytes = bytes => bytes >= 2 ** 20 ? size.format(bytes / 2 ** 20) + ' MiB' :
  bytes >= 1024 ? size.format(bytes / 1024) + ' KiB' : count.format(bytes) + ' B';

export function configureWorkspaceStorage(window, getContext) {
  const id = name => window.document.getElementById(name);
  const dialog = id('saved-workspace');
  const section = id('workspace-private-storage');
  const check = id('workspace-check-storage');
  const status = id('workspace-storage-status');
  const usage = id('workspace-storage-usage');
  const manage = id('workspace-manage-storage');
  const itemLimit = id('workspace-storage-item-limit');
  const measures = ['bytes', 'docs'].map(unit => ({
    unit, label: id('workspace-storage-' + unit), meter: id('workspace-storage-meter-' + unit),
    format: unit === 'bytes' ? formatBytes : value => count.format(value),
  }));
  let owner;
  let pending;

  function reset() {
    pending?.abort();
    pending = undefined;
    check.removeAttribute('aria-disabled');
    status.textContent = '';
    usage.hidden = true;
    itemLimit.textContent = '';
    for (const { label, meter } of measures) {
      label.textContent = '';
      meter.max = 1;
      meter.value = 0;
    }
  }

  check.addEventListener('click', async () => {
    if (!owner || pending || !dialog.open) return;
    const controller = pending = new AbortController();
    const current = () => pending === controller && dialog.open && !controller.signal.aborted;
    check.setAttribute('aria-disabled', 'true');
    usage.hidden = true;
    status.textContent = 'Checking Civitai storage…';
    try {
      const { bytes, docs, maxBytes, maxDocs, maxDocBytes } =
        await readPrivateStorageUsage(owner, getContext, { signal: controller.signal });
      if (!current()) return;
      const values = { bytes: [bytes, maxBytes], docs: [docs, maxDocs] };
      for (const { unit, label, meter, format } of measures) {
        const [value, limit] = values[unit];
        label.textContent = format(value) + ' of ' + format(limit);
        meter.max = limit;
        meter.value = Math.min(value, limit);
      }
      itemLimit.textContent = 'Each saved record can use up to ' + formatBytes(maxDocBytes) + '.';
      usage.hidden = false;
      status.textContent = 'Storage usage updated.';
    } catch (error) {
      if (current()) status.textContent = error.message || 'Civitai storage is unavailable.';
    } finally {
      if (pending === controller) {
        pending = undefined;
        check.removeAttribute('aria-disabled');
      }
    }
  });

  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });

  return {
    bind(context) {
      if (context?.origin === owner?.origin && context?.viewerUserId === owner?.viewerUserId) return;
      reset();
      owner = context ? { origin: context.origin, viewerUserId: context.viewerUserId } : undefined;
      section.hidden = !context;
      section.open = false;
      manage.replaceChildren();
      if (context) {
        manage.append(sourceLink(context.origin + '/user/account/security', 'Manage storage on Civitai ↗', { open: context.open }));
      }
    },
  };
}
