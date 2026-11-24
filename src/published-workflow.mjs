import { numericId, text } from './catalog.mjs';

const resourceErrors = new Set(['not-found', 'forbidden', 'unauthorized', 'too-large', 'parse-failed', 'busy', 'rate-limited']);
const graphFormats = new Set(['ui', 'api']);

export const isWorkflowModel = type => /^(?:comfy)?workflows?$/iu.test(type ?? '');

export function workflowFiles(candidate) {
  return (candidate.files ?? []).filter(file => numericId(file.id) && typeof file.name === 'string' && /\.(?:json|zip)$/iu.test(file.name));
}

export function workflowReadResult(payload, { modelId, versionId, fileId }) {
  if (!payload || typeof payload !== 'object') return { status: 'invalid' };
  if (Object.hasOwn(payload, 'error')) {
    return { status: !payload.file && resourceErrors.has(payload.error) ? payload.error : 'invalid' };
  }
  const { meta, entries, truncated } = payload.file ?? {};
  const fileName = text(meta?.fileName, 260);
  if (meta?.modelId !== modelId || meta.modelVersionId !== versionId || !numericId(meta.fileId) ||
      fileId !== undefined && meta.fileId !== fileId || !fileName || !/\.(?:json|zip)$/iu.test(fileName) ||
      !Array.isArray(entries) || entries.length > 20 || typeof truncated !== 'boolean') return { status: 'invalid' };
  const graphs = entries.flatMap(entry => {
    const path = text(entry?.path, 350);
    const { graph, format } = entry ?? {};
    if (!path || !graphFormats.has(format) || !graph || typeof graph !== 'object' || Array.isArray(graph)) return [];
    if (format === 'ui' && !Array.isArray(graph.nodes)) return [];
    if (format === 'api') {
      const nodes = Object.values(graph);
      if (!nodes.length || !nodes.every(node => typeof node?.class_type === 'string' &&
        node.inputs && typeof node.inputs === 'object' && !Array.isArray(node.inputs))) return [];
    }
    return [{ path, format, graph }];
  });
  return { status: 'ready', file: {
    fileId: meta.fileId, fileName, graphs, truncated, skipped: entries.length - graphs.length,
  } };
}
