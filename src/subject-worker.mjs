import { subjectAssetOrigins, subjectCandidateLimit, subjectCpuWasm, subjectReferenceLimit, subjectSide, subjectVisionModel, subjectWasm,
  subjectWasmAvailable } from './subject-artifacts.mjs';
import { poolSubjectRegions, sceneSubjectSimilarity, subjectScore, subjectVectorSize } from './subject-score.mjs';
import { sha256Hex, verifiedModelBytes } from './model-bytes.mjs';
import { validVisualDescription, visualPackBytes, visualTextCandidateLimit, visualTextFrameLimit } from './visual-text-pack.mjs';

const pixels = subjectSide * subjectSide;
const previewCacheLimit = 24;
const previewVectors = new Map();

async function checkedBytes(artifact, received) {
  const reply = await fetch(artifact.url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60_000) });
  if (!reply.ok || !reply.body || !subjectAssetOrigins.includes(new URL(reply.url).origin)) {
    throw new Error('The pinned inference file is unavailable.');
  }
  return verifiedModelBytes(reply.body, artifact, received);
}

async function pictureVector({ ort, session, input, output }, rgba, withRegions) {
  const normalized = new Float32Array(3 * pixels);
  for (let index = 0; index < pixels; index++) {
    for (let channel = 0; channel < 3; channel++) {
      normalized[pixels * channel + index] = rgba[index * 4 + channel] / 127.5 - 1;
    }
  }
  const tensor = new ort.Tensor('float32', normalized, [1, 3, subjectSide, subjectSide]);
  try {
    const result = await session.run({ [input]: tensor }, withRegions ? [output, 'last_hidden_state'] : [output]);
    try {
      const values = await result[output].getData();
      if (values.length !== subjectVectorSize) throw new Error('Unexpected picture vector size.');
      let squares = 0;
      for (const value of values) squares += value * value;
      if (!Number.isFinite(squares) || squares <= 0) throw new Error('Invalid picture vector.');
      const norm = Math.sqrt(squares);
      const vector = Float32Array.from(values, value => value / norm);
      return { values: vector, ...(withRegions && { regions: poolSubjectRegions(await result.last_hidden_state.getData()) }) };
    } finally {
      for (const value of Object.values(result)) value.dispose();
    }
  } finally {
    tensor.dispose();
    normalized.fill(0);
  }
}

function clearVector(vector) {
  vector?.values.fill(0);
  vector?.regions?.fill(0);
}

async function previewVector(runtime, id, rgba, withRegions) {
  // An eligible catalog preview still has to be read and decoded to reuse its vector.
  const digest = await sha256Hex(rgba);
  const previous = previewVectors.get(id);
  const reused = previous?.digest === digest && (!withRegions || Boolean(previous.regions));
  const vector = reused ? previous : { digest, ...await pictureVector(runtime, rgba, withRegions) };
  if (!reused) clearVector(previous);
  previewVectors.delete(id);
  previewVectors.set(id, vector);
  if (previewVectors.size > previewCacheLimit) {
    const [oldestId, oldest] = previewVectors.entries().next().value;
    clearVector(oldest);
    previewVectors.delete(oldestId);
  }
  return { ...vector, reused };
}

async function gpuAdapter() {
  if (!navigator.gpu || typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter?.info?.isFallbackAdapter ? null : adapter;
  } catch {
    return null;
  }
}

async function loadRuntime() {
  if (!crypto.subtle || !subjectWasmAvailable()) {
    self.postMessage({ phase: 'unavailable' });
    return null;
  }
  const adapter = await gpuAdapter();
  const provider = adapter ? 'webgpu' : 'wasm';
  const wasmArtifact = adapter ? subjectWasm : subjectCpuWasm;
  const total = subjectVisionModel.bytes + wasmArtifact.bytes;
  const received = [0, 0];
  let lastUpdate = -Infinity;
  function progress(index, bytes) {
    received[index] = bytes;
    const now = performance.now();
    const loaded = received[0] + received[1];
    if (now - lastUpdate < 150 && loaded !== total) return;
    lastUpdate = now;
    self.postMessage({ phase: 'loading', loaded, total, provider });
  }
  progress(0, 0);
  const [model, wasm] = await Promise.all([subjectVisionModel, wasmArtifact].map((artifact, index) =>
    checkedBytes(artifact, bytes => progress(index, bytes))));
  self.postMessage({ phase: 'starting', provider });
  const ort = adapter ? await import('./vendor/ort/ort.jspi.min.mjs') : await import('./vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.wasmBinary = wasm.buffer;
  if (adapter) ort.env.webgpu.adapter = adapter;
  const session = await ort.InferenceSession.create(model, { executionProviders: [provider], graphOptimizationLevel: 'all' });
  const input = session.inputNames.find(name => name === 'pixel_values');
  const output = ['image_embeds', 'pooler_output', 'image_features'].find(name => session.outputNames.includes(name));
  if (!input || !output) {
    await session.release();
    throw new Error('Unexpected vision model inputs or outputs.');
  }
  return { ort, session, input, output, provider };
}

const validPixels = row => row?.rgba instanceof Uint8ClampedArray && row.rgba.length === 4 * pixels;
const cosine = (reference, values) => reference.reduce((sum, value, index) => sum + value * values[index], 0);

function validateComparison(data) {
  const { description, references, sample, modelPack, clipFrames = false } = data ?? {};
  const visual = description !== undefined;
  const withReferences = !visual || references?.length > 0;
  if (!Array.isArray(references) || typeof clipFrames !== 'boolean' ||
      visual && (!validVisualDescription(description) || modelPack != null && !(modelPack instanceof ReadableStream)) ||
      withReferences && (references.length > subjectReferenceLimit || !references.some(row => row?.polarity === 'prefer') ||
        !references.every(row => validPixels(row) && ['prefer', 'avoid'].includes(row.polarity))) ||
      !Array.isArray(sample) || sample.length < (visual && !clipFrames ? 2 : 1) ||
      sample.length > (clipFrames ? visualTextFrameLimit : withReferences ? subjectCandidateLimit : visualTextCandidateLimit) ||
      !sample.every(row => validPixels(row) && Number.isSafeInteger(row.id) && row.id > 0) ||
      new Set(sample.map(row => row.id)).size !== sample.length) throw new Error('Invalid comparison inputs.');
}

async function compare({ description, references, sample, clipFrames }, runtime, textRuntime) {
  const { provider } = runtime;
  const withRegions = clipFrames && references.length > 0;
  const anchorCount = references.length + Number(description !== undefined);
  const reportCount = done => self.postMessage({ phase: 'matching', provider, done, total: anchorCount + sample.length });
  reportCount(0);
  const preferred = [];
  const avoided = [];
  let words;
  try {
    if (description) {
      words = await textRuntime.encode(textRuntime.model, description);
      if (provider === 'wasm') reportCount(1);
    }
    for (const { rgba, polarity } of references) {
      const vector = await pictureVector(runtime, rgba, withRegions);
      (polarity === 'avoid' ? avoided : preferred).push(vector);
      if (provider === 'wasm') reportCount(preferred.length + avoided.length + Number(Boolean(words)));
    }
    const matches = [];
    let reusedPreviews = 0;
    for (const { id, rgba } of sample) {
      const { values, regions, reused } = await previewVector(runtime, clipFrames ? 'frame-' + id : id, rgba, withRegions);
      const textScore = words && cosine(words, values);
      const pictureMatch = vector => {
        const whole = cosine(vector.values, values);
        return withRegions ? sceneSubjectSimilarity(whole, vector.regions, regions) : whole;
      };
      const score = references.length ? subjectScore(preferred.map(pictureMatch), avoided.map(pictureMatch)) : textScore;
      if (reused) reusedPreviews++;
      matches.push({ id, score, ...(words && references.length && { textScore }) });
      if (provider === 'wasm') reportCount(anchorCount + matches.length);
    }
    return { phase: 'complete', reusedPreviews, matches: matches.sort((first, next) => next.score - first.score || first.id - next.id) };
  } finally {
    words?.fill(0);
    for (const vector of [...preferred, ...avoided]) clearVector(vector);
  }
}

// The app creates this worker on the first explicit comparison. Initialization overlaps preview decoding.
const runtime = loadRuntime().catch(() => {
  self.postMessage({ phase: 'failed' });
  return null;
});
let textRuntime;
let textPreparation;

async function loadTextRuntime(pack) {
  const { readVisualTextModel, createVisualTextSession, visualTextVector } = await import('./visual-text-model.mjs');
  let assets;
  try {
    assets = await readVisualTextModel(pack, (phase, loaded) => self.postMessage({ phase, loaded, total: visualPackBytes }));
  } catch {
    self.postMessage({ phase: 'model-pack-unavailable' });
    return null;
  }
  const vision = await runtime;
  if (!vision) return null;
  self.postMessage({ phase: 'starting', provider: vision.provider });
  const model = await createVisualTextSession(vision.ort, vision.provider, assets);
  return { model, encode: visualTextVector };
}

let matching = false;
self.addEventListener('message', async event => {
  // The browser's dedicated-worker port sends trusted messages without a window origin or source.
  if (!event.isTrusted || event.origin !== '' || event.source !== null || event.ports.length !== 0) return;
  const { data } = event;
  if (data?.type === 'prepare-text') {
    const pack = data.modelPack;
    if (pack != null && !(pack instanceof ReadableStream)) {
      self.postMessage({ phase: 'failed' });
      return;
    }
    if (!matching && !textRuntime && !textPreparation) {
      textPreparation = loadTextRuntime(pack).catch(() => {
        self.postMessage({ phase: 'failed' });
        return null;
      });
    } else if (pack && !pack.locked) void pack.cancel().catch(() => {});
    return;
  }
  if (matching) {
    self.postMessage({ phase: 'failed' });
    return;
  }
  matching = true;
  let reply;
  try {
    validateComparison(data);
    if (data.description && !textRuntime) {
      textRuntime = await (textPreparation ?? loadTextRuntime(data.modelPack));
      textPreparation = undefined;
      if (!textRuntime) return;
    }
    const loaded = await runtime;
    if (loaded) reply = await compare(data, loaded, textRuntime);
  } catch {
    reply = { phase: 'failed' };
  } finally {
    if (data?.modelPack instanceof ReadableStream && !data.modelPack.locked) void data.modelPack.cancel().catch(() => {});
    for (const rows of [data?.references, data?.sample]) if (Array.isArray(rows)) {
      for (const row of rows) if (row?.rgba instanceof Uint8ClampedArray) row.rgba.fill(0);
    }
    matching = false;
  }
  if (reply) self.postMessage(reply);
});
