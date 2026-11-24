import { civitaiAir, numericId, text } from './catalog.mjs';
import { selectorAir, traceComfyWorkflow } from './comfy-workflow.mjs';
import { generationFields } from './image-metadata.mjs';

export const recordedReferenceLimit = 8;
export const localReferenceLimit = 4;
export const localReferenceBytes = 24_000_000;
const perImageLimit = 16;
export const civiScribeSidecar = 'CiviScribe sidecar';
const studioIdentityExport = 'Metadata Studio identity export';
export const studioIdentitySchema = 'civitai-metadata-studio.identity-cache';
export const studioAuditReport = 'Metadata Studio audit report';
export const studioEditSession = 'Metadata Studio edit session';
const studioEditSchema = 'civitai-metadata-studio.edit-session';
const documentSources = new Set([civiScribeSidecar, studioIdentityExport, studioAuditReport, studioEditSession]);
const originalFormats = new Set(['png', 'jpeg', 'webp']);
const sidecarRoles = new Map([
  ['base_model', 'Base model'], ['lora', 'LoRA'], ['vae', 'VAE'], ['text_encoder', 'Text encoder'],
  ['embedding', 'Embedding'], ['hypernetwork', 'Hypernetwork'], ['controlnet', 'ControlNet'],
  ['ipadapter', 'IP-Adapter'], ['style_model', 'Style model'], ['vision_encoder', 'Vision encoder'],
  ['model_patch', 'Model patch'], ['auxiliary_model', 'Auxiliary model'], ['motion_module', 'Motion module'],
  ['gligen', 'GLIGEN'], ['upscaler', 'Upscaler'],
]);
const sidecarStrengths = [['model', 'Model strength'], ['clip', 'CLIP strength'], ['weight', 'Weight']];
const knownField = /^(?:PNG (?:parameters(?:_utf8)?|prompt|workflow|comment|civitai(?:[_ -]?(?:resources|metadata))?|extraMetadata)|EXIF UserComment|EXIF generation field)$/iu;
const sha = value => typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value) ? value.toLowerCase() : null;
const id = value => numericId(value) ?? (typeof value === 'string' && /^[1-9]\d{0,14}$/u.test(value) ? Number(value) : null);
const bag = value => value && typeof value === 'object' && !Array.isArray(value);
const isStudioManifest = value => value?.schemaName === 'civitai-metadata-studio' && value.schemaVersion === 1;
const fileFormat = value => typeof value === 'string' && /^[a-z\d_-]{1,32}$/iu.test(value)
  ? value.toLowerCase().replace(/^safetensors?$/u, 'safetensors') : null;

function readJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function airReference(value) {
  const parsed = civitaiAir(typeof value === 'string' ? value.trim() : value);
  return parsed?.kind === 'version' ? { versionId: parsed.id, modelId: parsed.modelId, fileId: parsed.fileId, format: fileFormat(parsed.format) } : null;
}

function resource(row) {
  if (typeof row === 'string') return airReference(row);
  if (!bag(row)) return null;
  const rawAir = row.air ?? row.canonicalAir ?? row.urn ?? row.rawAir;
  const air = airReference(rawAir);
  const alternate = airReference(row.rawAir);
  const modelId = id(row.modelId);
  const versionId = id(row.modelVersionId ?? row.versionId);
  const fileId = id(row.modelFileId ?? row.fileId);
  const airFileId = air?.fileId ?? fileId;
  const format = fileFormat(row.format);
  const digest = sha(row.sha256 ?? row.SHA256 ?? row.hashes?.SHA256 ?? row.hashes?.sha256);
  if (row.modelId != null && !modelId || (row.modelVersionId ?? row.versionId) != null && !versionId ||
      (row.modelFileId ?? row.fileId) != null && !fileId || rawAir != null && !air) return null;
  if (air && ((modelId && modelId !== air.modelId) || (versionId && versionId !== air.versionId) ||
      (fileId && air.fileId && fileId !== air.fileId))) return null;
  if (air && alternate && (air.modelId !== alternate.modelId || air.versionId !== alternate.versionId ||
      (airFileId && alternate.fileId && airFileId !== alternate.fileId))) return null;
  if (!air && !versionId && !digest) return null;
  // An AIR assigns a file suffix. An exporter can also label its format independently.
  return { versionId: air?.versionId ?? versionId, modelId: air?.modelId ?? modelId, fileId: air?.fileId ?? alternate?.fileId ?? fileId,
    format: air?.format ?? alternate?.format ?? format, sha256: digest };
}

function atJson(value, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < Math.min(value.length, start + 128_000); i++) {
    const char = value[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === '[' || char === '{') depth++;
    if ((char === ']' || char === '}') && --depth === 0) return readJson(value.slice(start, i + 1));
  }
  return null;
}

function* writerResources(data) {
  const civiScribe = data.schemaName === 'ccollins-civiscribe.civitai-manifest' && data.schemaVersion === '1.0.0';
  const metadataStudio = isStudioManifest(data);
  if ((!civiScribe && !metadataStudio) || !Array.isArray(data.resources)) return;
  for (const row of data.resources.slice(0, perImageLimit)) {
    if (!usableResource(row)) continue;
    const reference = projectedResource(row, civiScribe);
    if (reference) yield reference;
  }
}

function usableResource(row) {
  return bag(row) && row.active !== false && row.removed !== true && !conflictingResource(row);
}

function conflictingResource(row) {
  return row.status === 'conflict' || row.verification === 'conflict' || row.lookupStatus === 'conflict';
}

function projectedResource(row, civiScribe) {
  const details = civiScribe ? row.identity : row;
  if (row.parserFacing === true && bag(details)) return resource({ ...details, hashes: row.hashes });
  if (!row.identity && row.modelVersionId == null && row.canonicalAir == null && row.rawAir == null) {
    const digest = sha(row.hashes?.SHA256 ?? row.hashes?.sha256);
    if (digest) return { sha256: digest };
  }
  return null;
}

function* explicitResources(data) {
  if (!bag(data)) return;
  for (const root of [data, data.meta, readJson(data.extraMetadata), data.extra]) {
    if (!bag(root)) continue;
    const resources = readJson(root.civitaiResources ?? root.civitai_resources);
    if (Array.isArray(resources)) yield* resources.slice(0, perImageLimit).map(resource).filter(Boolean);
    yield* writerResources(root);
  }
  for (const key of ['ckpt_airs', 'lora_airs', 'embedding_airs']) {
    const values = data.extra?.[key];
    if (!Array.isArray(values)) continue;
    for (const value of values.slice(0, perImageLimit)) {
      if (typeof value !== 'string') continue;
      const pair = /^([1-9]\d{0,14})@([1-9]\d{0,14})$/u.exec(value);
      if (pair) yield { modelId: Number(pair[1]), versionId: Number(pair[2]) };
      else {
        const exact = airReference(value);
        if (exact) yield exact;
      }
    }
  }
}

function* selectorReferences(data) {
  if (!bag(data)) return;
  let trace;
  try { trace = traceComfyWorkflow(data); } catch { return; }
  if (trace.mode !== 'inventory') {
    let count = 0;
    for (const entry of trace.active) if (entry.node.type === 'CivitaiModelSelector') {
      for (const slot of entry.slots) {
        const claim = airReference(entry.air(slot));
        if (claim) { yield claim; if (++count >= perImageLimit) return; }
      }
    }
    return;
  }
  const graph = bag(data.prompt) ? data.prompt : data;
  const nodes = Object.values(graph).slice(0, 4000);
  const selected = new Map();
  for (const node of nodes) {
    if (!bag(node?.inputs)) continue;
    for (const edge of Object.values(node.inputs).slice(0, 200)) {
      if (!Array.isArray(edge) || edge.length !== 2 || !['string', 'number'].includes(typeof edge[0]) ||
          !Number.isSafeInteger(edge[1]) || edge[1] < 0) continue;
      const key = String(edge[0]);
      if (!Object.hasOwn(graph, key) || graph[key]?.class_type !== 'CivitaiModelSelector') continue;
      const inputs = graph[key].inputs;
      const version = airReference(selectorAir(inputs?.air, inputs?.resources_json, edge[1]));
      if (version) selected.set([version.versionId, version.modelId, version.fileId].join('/'), version);
      if (selected.size === perImageLimit) break;
    }
    if (selected.size === perImageLimit) break;
  }
  yield* selected.values();
}

function* fieldReferences({ keyword, value }) {
  const key = keyword.toLowerCase().replace(/[_ -]/gu, '').replace(/^parametersutf8$/u, 'parameters');
  if (key === 'civitairesources') {
    const rows = readJson(value);
    if (Array.isArray(rows)) yield* rows.slice(0, perImageLimit).map(resource).filter(Boolean);
    return;
  }
  const prefix = /^(prompt|workflow|extraMetadata|parameters|civitai[_ -]?resources):\s*/iu.exec(value);
  if (prefix && prefix[1].toLowerCase().replace(/[_ -]/gu, '') === 'civitairesources') {
    yield* fieldReferences({ keyword: prefix[1], value: value.slice(prefix[0].length) });
    return;
  }
  const data = readJson(prefix ? value.slice(prefix[0].length) : value);
  if (bag(data)) {
    yield* explicitResources(data);
    if (['prompt', 'workflow', 'parameters', 'comment'].includes(prefix?.[1]?.toLowerCase() ?? key)) yield* selectorReferences(data);
    return;
  }
  if (key !== 'parameters' && key !== 'comment') return;
  // Only process details-line fields emitted by generation tools. Free-form
  // prompts, tags and arbitrary embedded links carry no catalog identity.
  const detailLine = value.slice(value.lastIndexOf('\n') + 1).slice(0, 128_000);
  if (!/^(?:(?:Steps|Seed|CFG scale):\s*\d|Size:\s*\d+x\d+|Sampler:\s*[^,]+,)/iu.test(detailLine)) return;
  const details = detailLine;
  const citations = /,\s*Civitai resources:\s*(?=\[)/iu.exec(details);
  const rows = citations ? atJson(details, citations.index + citations[0].length) : null;
  if (Array.isArray(rows)) yield* rows.slice(0, perImageLimit).map(resource).filter(Boolean);
  const extra = /,\s*Civitai metadata:\s*(?=\{)/iu.exec(details);
  if (extra) yield* explicitResources(atJson(details, extra.index + extra[0].length));
  const modelHash = /,\s*Model hash:\s*([a-f\d]{64})(?=,|\s*$)/iu.exec(details)?.[1];
  if (modelHash) yield { sha256: sha(modelHash) };
}

const identity = reference => [reference.versionId, reference.modelId, reference.fileId, reference.sha256, reference.format].map(value => value ?? '').join('/');
const catalogReferenceKey = record => record.versionId && record.fileId ? record.versionId + '/' + record.fileId : identity(record);
const moreSpecific = (row, other) => row !== other && row.versionId && row.versionId === other.versionId &&
  ['modelId', 'fileId', 'sha256', 'format'].every(key => !row[key] || row[key] === other[key]);

export async function inspectReferenceImage(file, options) {
  const { format, fields, imageDigest, pictureDigest } = await generationFields(file, options);
  const references = new Map();
  for (const field of fields) for (const reference of fieldReferences(field)) {
    const key = identity(reference);
    if (!references.has(key) && references.size < 4 * perImageLimit) {
      references.set(key, { ...reference, field: field.field, fields: new Set() });
    }
    references.get(key)?.fields.add(field.field);
  }
  const rows = [...references.values()];
  const detailed = rows.filter(row => !rows.some(other => moreSpecific(row, other)));
  for (const row of rows) for (const other of detailed) {
    if (moreSpecific(row, other)) for (const field of row.fields) other.fields.add(field);
  }
  return { format, references: detailed.slice(0, perImageLimit).map(row => ({ ...row, fields: [...row.fields] })),
    ...(imageDigest && { imageDigest }), ...(pictureDigest && { pictureDigest }) };
}

function editResources(rows, imageDigests) {
  const references = new Map();
  const removed = new Map();
  let unresolved = 0;
  let omitted = 0;
  for (const row of rows) {
    if (row?.active === false && row.removed !== true) continue;
    const claim = bag(row) && !conflictingResource(row) && resource({ modelId: row.modelId, modelVersionId: row.modelVersionId,
      fileId: row.fileId, canonicalAir: row.canonicalAir || undefined, rawAir: row.rawAir || undefined,
      format: row.format, hashes: row.hashes });
    if (!claim || imageDigests.has(claim.sha256)) {
      unresolved++;
      continue;
    }
    const target = row.removed === true ? removed : references;
    const key = identity(claim);
    if (target.has(key)) continue;
    if (target.size >= perImageLimit) omitted++;
    else target.set(key, { ...claim, field: studioEditSession });
  }
  return { references: [...references.values()], removed: [...removed.values()], unresolved, omitted };
}

function inspectStudioEditSession(data, bytes) {
  if (data.schemaVersion !== 1 || bytes > 16 * 1024 * 1024 || !Array.isArray(data.images) || !data.images.length || data.images.length > 1000) {
    throw new Error('Choose a Metadata Studio v1 edit session up to 16 MiB.');
  }
  const entries = new Map();
  for (const image of data.images) {
    const imageDigest = sha(image?.sha256);
    const resources = image?.edits?.resources;
    if (!imageDigest || !originalFormats.has(image.format) || entries.has(imageDigest) || !Array.isArray(resources) || resources.length > 10_000) {
      throw new Error('The Metadata Studio edit session has invalid original-image entries.');
    }
    entries.set(imageDigest, { format: image.format, resources });
  }
  const digests = new Set(entries.keys());
  const editImages = new Map([...entries].map(([digest, image]) => [digest, { format: image.format, ...editResources(image.resources, digests) }]));
  return { source: studioEditSession, references: [], editImages };
}

function sidecarUse(row) {
  const strengths = sidecarStrengths.flatMap(([key, label]) => Number.isFinite(row.strengths?.[key]) ? [label + ' ' + row.strengths[key]] : []);
  return [sidecarRoles.get(row.role), ...strengths].filter(Boolean).join(' · ');
}

export async function inspectReferenceDocument(file) {
  if (!Number.isSafeInteger(file?.size) || file.size < 1 || file.size > localReferenceBytes) {
    throw new Error('Choose a metadata JSON file up to 24 MB.');
  }
  const data = readJson(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
  if (data?.schema === studioEditSchema) return inspectStudioEditSession(data, file.size);
  const scribe = data?.schemaName === 'ccollins-civiscribe.sidecar' && data.schemaVersion === '2.0.0';
  const studio = data?.schema === studioIdentitySchema && data.schemaVersion === 1;
  const audit = data?.schema === 'civitai-metadata-studio.audit-report' && data.schemaVersion === 1 && isStudioManifest(data.manifest);
  const rows = scribe ? data.generationRecord?.resources : studio ? data.resources : audit ? data.manifest.resources : null;
  if (!Array.isArray(rows)) {
    if (scribe && data.generationRecord === null) return { source: civiScribeSidecar, references: [], conflicts: 0 };
    throw new Error('Choose a CiviScribe sidecar, Metadata Studio identity export, audit report, or edit session.');
  }
  const source = scribe ? civiScribeSidecar : audit ? studioAuditReport : studioIdentityExport;
  const references = new Map();
  let conflicts = 0;
  for (const row of audit ? rows.slice(0, perImageLimit) : rows) {
    if (!bag(row) || row.active === false || row.removed === true || scribe && row.active !== true) continue;
    if (conflictingResource(row)) {
      conflicts++;
      continue;
    }
    const reference = scribe || audit ? projectedResource(row, scribe) : resource(row);
    if (!reference) continue;
    const key = identity(reference);
    const claim = { ...reference, field: source };
    const use = scribe && sidecarUse(row);
    if (scribe) {
      claim.uses = references.get(key)?.uses ?? new Map();
      if (use) claim.uses.set(use, (claim.uses.get(use) ?? 0) + 1);
    }
    references.set(key, claim);
  }
  return { source, references: [...references.values()], conflicts };
}

export function pairReferencePictures(original, revised) {
  if (!originalFormats.has(original?.format) || !originalFormats.has(revised?.format)) return null;
  const imageDigests = new Set([original.imageDigest, revised.imageDigest].filter(Boolean));
  const pictureClaims = file => ({ format: file.format, references: file.references.filter(claim => !imageDigests.has(claim.sha256)) });
  let integrity = 'unconfirmed';
  if (original.format !== revised.format) integrity = 'format-changed';
  else if (original.imageDigest && original.imageDigest === revised.imageDigest) integrity = 'same-file';
  else if (original.pictureDigest && revised.pictureDigest) {
    integrity = original.pictureDigest === revised.pictureDigest ? 'same-picture-data' : 'picture-data-changed';
  }
  return { kind: 'pictures', integrity, original: pictureClaims(original),
    draft: { ...pictureClaims(revised), removed: [], unresolved: 0, omitted: 0 } };
}

export function pictureIntegrityText(integrity) {
  return {
    'same-file': 'The files are byte-for-byte identical.',
    'same-picture-data': 'Encoded picture data matches.',
    'picture-data-changed': 'Encoded picture data differs.',
    'format-changed': 'These pictures use different file formats.',
    unconfirmed: 'Encoded picture data could not be checked.',
  }[integrity] ?? '';
}

export function pairReferenceSidecars(original, revised) {
  if (original?.source !== civiScribeSidecar || revised?.source !== civiScribeSidecar) return null;
  return { kind: 'sidecars', original, draft: { ...revised, removed: [], unresolved: 0, omitted: 0 } };
}

export function matchReferenceEdits(files) {
  const selected = files.slice(0, localReferenceLimit).filter(Boolean);
  const imageDigests = new Set(selected.map(file => file.imageDigest).filter(Boolean));
  const modelClaims = claim => !imageDigests.has(claim.sha256);
  const sessions = new Map(selected.filter(file => file.editImages instanceof Map).map(file => [file, { matched: 0, withModels: 0, ambiguous: 0 }]));
  const pairs = [];
  const originals = new Set();
  for (const original of selected) {
    if (!original.imageDigest || originals.has(original.imageDigest)) continue;
    originals.add(original.imageDigest);
    const matching = [...sessions].flatMap(([session, state]) => {
      const draft = session.editImages.get(original.imageDigest);
      return draft?.format === original.format ? [{ draft, state }] : [];
    });
    if (matching.length > 1) for (const { state } of matching) state.ambiguous++;
    if (matching.length !== 1) continue;
    const [{ draft, state }] = matching;
    const references = original.references.filter(modelClaims);
    const proposed = draft.references.filter(modelClaims);
    const removed = draft.removed.filter(modelClaims);
    state.matched++;
    if (references.length || proposed.length || removed.length) state.withModels++;
    const unresolved = draft.unresolved + draft.references.length - proposed.length + draft.removed.length - removed.length;
    pairs.push({ original: { format: original.format, references }, draft: { ...draft, references: proposed, removed, unresolved } });
  }
  return { pairs, sessions };
}

export function describeReferenceEdits(pairs) {
  return pairs.map(({ original, draft, kind, integrity }) => {
    const rows = new Map();
    for (const [side, claims] of [['original', original.references], ['proposed', draft.references], ['removed', draft.removed]]) {
      for (const claim of claims) {
        const { versionId, fileId, sha256 } = claim;
        const key = versionId ? [versionId, fileId ?? ''].join('/') : 'hash/' + sha256 + '/' + (fileId ?? '');
        const existing = rows.get(key) ?? { versionId, fileId, sides: new Map() };
        const recorded = existing.sides.get(side) ?? [];
        recorded.push(claim);
        existing.sides.set(side, recorded);
        rows.set(key, existing);
      }
    }
    const pictures = kind === 'pictures';
    const sidecars = kind === 'sidecars';
    const sameFileLabel = pictures ? 'Both pictures' : 'Both sidecars';
    const entries = [...rows.values()].map(({ versionId, fileId, sides }) => {
      const inOriginal = sides.has('original');
      const proposed = sides.has('proposed');
      const removed = sides.has('removed');
      const claims = [...sides.values()].flat();
      const conflicting = ['modelId', 'format', 'sha256'].some(field => new Set(claims.map(claim => claim[field]).filter(Boolean)).size > 1);
      const label = pictures || sidecars ? (inOriginal && proposed ? sameFileLabel : inOriginal ? 'Original only' : 'Revised only')
        : inOriginal && proposed ? 'Original and proposed' : inOriginal ? 'Original' : proposed ? 'Proposed' : '';
      const first = sidecars ? mergeRecordedUses(sides.get('original')) : null;
      const second = sidecars ? mergeRecordedUses(sides.get('proposed')) : null;
      const changed = first?.size && second?.size && !sameRecordedUses(first, second);
      return { versionId, fileId, labels: [label,
        removed && 'Removal marked', conflicting && 'Identity claims differ', proposed && removed && 'Edit entries disagree',
        changed && 'Recorded use changed'].filter(Boolean),
        ...(sidecars && { recordedUses: [['Original', first], ['Revised', second]].flatMap(([name, uses]) =>
          uses.size ? [name + ' · ' + summarizeRecordedUses(uses)] : []) }) };
    });
    const limit = sidecars ? perImageLimit * 2 : entries.length;
    if (entries.length > limit) {
      const priority = row => row.labels.includes('Recorded use changed') || !row.labels.includes('Both sidecars') ? 1 : 0;
      entries.sort((first, second) => priority(second) - priority(first));
    }
    return { format: original.format, ...(pictures && { revisedFormat: draft.format, integrity }), ...(sidecars && { sidecars }),
      unresolved: draft.unresolved, omitted: draft.omitted + Math.max(0, entries.length - limit), rows: entries.slice(0, limit) };
  });
}

function mergeRecordedUses(claims = []) {
  const uses = new Map();
  for (const claim of claims) {
    for (const [label, count] of claim.uses ?? []) uses.set(label, (uses.get(label) ?? 0) + count);
  }
  return uses;
}

function sameRecordedUses(first = new Map(), second = new Map()) {
  return first.size === second.size && [...first].every(([label, count]) => second.get(label) === count);
}

function summarizeRecordedUses(uses) {
  const groups = [...uses].sort(([first], [second]) => first.localeCompare(second));
  const labels = groups.slice(0, 8).map(([label, count]) => count === 1 ? label : label + ' (' + count + ' uses)');
  if (groups.length > labels.length) labels.push((groups.length - labels.length) + ' more recorded settings');
  return labels.join(' / ');
}

export function editVerificationPriorities(pairs) {
  const priority = new Map();
  const promote = (claim, level) => {
    const key = catalogReferenceKey(claim);
    priority.set(key, Math.max(priority.get(key) ?? 0, level));
  };
  for (const { original, draft, kind } of pairs) {
    const before = new Map(original.references.map(claim => [identity(claim), claim]));
    const after = new Set(draft.references.map(identity));
    for (const claim of original.references) if (!after.has(identity(claim))) promote(claim, 1);
    for (const claim of draft.removed) promote(claim, 2);
    for (const claim of draft.references) {
      const prior = before.get(identity(claim));
      if (!prior) promote(claim, 3);
      else if (kind === 'sidecars' && !sameRecordedUses(prior.uses, claim.uses)) promote(claim, 2);
    }
  }
  return priority;
}

export function recordedReferencePlan(files, { priority } = {}) {
  const references = new Map();
  let pictures = 0;
  let documents = 0;
  for (const file of (Array.isArray(files) ? files : []).slice(0, localReferenceLimit)) {
    const isDocument = documentSources.has(file?.source);
    let present = false;
    const rows = Array.isArray(file?.references) ? file.references : [];
    for (const row of isDocument ? rows : rows.slice(0, perImageLimit)) {
      if (!row) continue;
      const candidate = { versionId: id(row.versionId), modelId: id(row.modelId), fileId: id(row.fileId), sha256: sha(row.sha256),
        format: fileFormat(row.format) };
      if (!candidate.versionId && !candidate.sha256) continue;
      const key = identity(candidate);
      present = true;
      if (!references.has(key)) references.set(key, { ...candidate, fields: [] });
      const fields = references.get(key).fields;
      for (const value of [row.field, ...(Array.isArray(row.fields) ? row.fields.slice(0, 32) : [])]) {
        const field = text(value, 100);
        if ((knownField.test(field) || (isDocument && field === file.source)) && !fields.includes(field)) fields.push(field);
      }
    }
    if (present && isDocument) documents++;
    if (present && !isDocument) pictures++;
  }
  const filesByVersion = new Map();
  for (const record of references.values()) {
    const key = catalogReferenceKey(record);
    const claims = filesByVersion.get(key) ?? [];
    claims.push(record);
    filesByVersion.set(key, claims);
  }
  // The same published file takes one slot. Keep each source's qualifiers for independent verification.
  const records = [...filesByVersion.values()].flatMap(claims => {
    if (claims.length < 2 || claims.length > perImageLimit) return claims;
    const [{ versionId, fileId }] = claims;
    return [{ versionId, fileId, claims }];
  });
  if (priority && records.length > recordedReferenceLimit) {
    records.sort((first, second) => (priority.get(catalogReferenceKey(second)) ?? 0) - (priority.get(catalogReferenceKey(first)) ?? 0));
  }
  return { pictures, documents, records: records.slice(0, recordedReferenceLimit),
    unchecked: Math.max(0, records.length - recordedReferenceLimit) };
}
