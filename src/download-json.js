export const workspaceBackupFilename = 'rasterraid-workspace.json';
export const modelIdentityFilename = 'civitai-metadata-identities.json';
export const workflowReportFilename = 'rasterraid-deep-search-report.json';

export function downloadJson(window, context, filename, json, signal) {
  signal.throwIfAborted();
  if (context.hosted) return context.downloadJson(filename, new TextEncoder().encode(json).buffer, signal);

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const target = window.document.createElement('a');
  target.href = url;
  target.download = filename;
  window.document.body.append(target);
  try { target.click(); }
  finally {
    target.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
