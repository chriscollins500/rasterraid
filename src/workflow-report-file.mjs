import { SITE_ORIGINS, visibleRating } from './catalog.mjs';
import { isWorkflowId, workflowIdBelongsToViewer } from './workflow-client.mjs';

export const workflowReportMaximumBytes = 1024 * 1024;
const format = 'rasterraid.deep-search-report';
const encoder = new TextEncoder();

function reportPayload(value) {
  const { origin, workflowId, browsingLevel, simulated, capturedAt, markdown } = value ?? {};
  const heading = simulated ? '# Simulated Deep Search\n' : '# Deep Search\n';
  if (value?.format !== format || value.version !== 1 || !SITE_ORIGINS.includes(origin) || !isWorkflowId(workflowId) ||
      !visibleRating(browsingLevel, 63) || typeof simulated !== 'boolean' || !Number.isSafeInteger(capturedAt) || capturedAt <= 0 ||
      !Number.isFinite(new Date(capturedAt).getTime()) || typeof markdown !== 'string' || !markdown.startsWith(heading)) {
    throw new TypeError('Choose a saved RasterRaid Deep Search report.');
  }
  return { format, version: 1, origin, workflowId, browsingLevel, simulated, capturedAt, markdown };
}

function checkAccess(report, context, simulated) {
  if (report.simulated !== simulated) throw new Error(report.simulated ? 'Open this report in a RasterRaid simulation.' : 'Open this report in RasterRaid on Civitai.');
  if (report.origin !== context?.origin) throw new Error('Open this report in RasterRaid on ' + new URL(report.origin).hostname + '.');
  if (!simulated) {
    if (!context.hosted || !context.signedIn || !context.token || !workflowIdBelongsToViewer(report.workflowId, context.viewerUserId)) {
      throw new Error('Open the report in its original Civitai account.');
    }
    if (!visibleRating(report.browsingLevel, context.browsingLevel)) {
      throw new Error('Open the report with its original Civitai browsing access.');
    }
  }
}

async function fingerprint(report) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(report))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function workflowReportFile(context, workflowId, markdown, { simulated = false, capturedAt = Date.now() } = {}) {
  const report = reportPayload({ format, version: 1, origin: context?.origin, workflowId,
    browsingLevel: simulated ? 1 : context?.browsingLevel, simulated, capturedAt, markdown });
  checkAccess(report, context, simulated);
  if (markdown.length > workflowReportMaximumBytes) throw new RangeError('Save a report up to 1 MiB.');
  const json = JSON.stringify({ ...report, sha256: await fingerprint(report) }, null, 2);
  if (encoder.encode(json).length > workflowReportMaximumBytes) throw new RangeError('Save a report up to 1 MiB.');
  return json;
}

export async function readWorkflowReportFile(bytes, context, simulated = false) {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > workflowReportMaximumBytes) {
    throw new RangeError('Choose a saved report up to 1 MiB.');
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new TypeError('Choose an intact RasterRaid report JSON file.'); }
  const report = reportPayload(value);
  checkAccess(report, context, simulated);
  if (!/^[a-f\d]{64}$/u.test(value.sha256 ?? '') || value.sha256 !== await fingerprint(report)) {
    throw new Error('The report file does not match its saved checksum.');
  }
  return report;
}
