import { subjectAssetOrigins, subjectCandidateLimit, subjectCpuWasm, subjectReferenceLimit, subjectSide, subjectVisionModel, subjectWasm,
  subjectWasmAvailable } from './subject-artifacts.mjs';
import { subjectScore } from './subject-score.mjs';

const pixels = subjectSide * subjectSide;
const dimensions = 768;
const previewCacheLimit = 24;
const previewVectors = new Map();

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function checkedBytes({ url, bytes, sha256 }, received) {
  const reply = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60_000) });
  if (!reply.ok || !reply.body || !subjectAssetOrigins.includes(new URL(reply.url).origin)) {
    throw new Error('The pinned inference file is unavailable.');
  }
  const output = new Uint8Array(bytes);
  const reader = reply.body.getReader();
  let position = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (position + value.byteLength > bytes) throw new Error('Unexpected inference file size.');
      output.set(value, position);
      position += value.byteLength;
      received(position);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (position !== bytes || await sha256Hex(output) !== sha256) throw new Error('Inference file verification failed.');
  return output;
}

async function pictureVector({ ort, session, input, output }, rgba) {
  const normalized = new Float32Array(3 * pixels);
  for (let index = 0; index < pixels; index++) {
    for (let channel = 0; channel < 3; channel++) {
      normalized[pixels * channel + index] = rgba[index * 4 + channel] / 127.5 - 1;
    }
  }
  const tensor = new ort.Tensor('float32', normalized, [1, 3, subjectSide, subjectSide]);
  try {
    const result = await session.run({ [input]: tensor }, [output]);
    try {
      const values = await result[output].getData();
      if (values.length !== dimensions) throw new Error('Unexpected picture vector size.');
      let squares = 0;
      for (const value of values) squares += value * value;
      if (!Number.isFinite(squares) || squares <= 0) throw new Error('Invalid picture vector.');
      const norm = Math.sqrt(squares);
      return Float32Array.from(values, value => value / norm);
    } finally {
      for (const value of Object.values(result)) value.dispose();
    }
  } finally {
    tensor.dispose();
    normalized.fill(0);
  }
}

async function previewVector(runtime, id, rgba) {
  // An eligible catalog preview still has to be read and decoded to reuse its vector.
  const digest = await sha256Hex(rgba);
  const previous = previewVectors.get(id);
  const reused = previous?.digest === digest;
  const values = reused ? previous.values : await pictureVector(runtime, rgba);
  if (!reused) previous?.values.fill(0);
  previewVectors.delete(id);
  previewVectors.set(id, { digest, values });
  if (previewVectors.size > previewCacheLimit) {
    const [oldestId, oldest] = previewVectors.entries().next().value;
    oldest.values.fill(0);
    previewVectors.delete(oldestId);
  }
  return { values, reused };
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

async function compare(data, runtime) {
  const { references, sample } = data ?? {};
  if (!Array.isArray(references) || references.length < 1 || references.length > subjectReferenceLimit ||
      !references.every(row => validPixels(row) && ['prefer', 'avoid'].includes(row.polarity)) ||
      !references.some(row => row.polarity === 'prefer') ||
      !Array.isArray(sample) || sample.length < 1 || sample.length > subjectCandidateLimit ||
      !sample.every(row => validPixels(row) && Number.isSafeInteger(row.id) && row.id > 0) ||
      new Set(sample.map(row => row.id)).size !== sample.length) throw new Error('Invalid picture inputs.');
  const { provider } = runtime;
  const reportCount = done => self.postMessage({ phase: 'matching', provider, done, total: references.length + sample.length });
  reportCount(0);
  const preferred = [];
  const avoided = [];
  try {
    for (const { rgba, polarity } of references) {
      const vector = await pictureVector(runtime, rgba);
      (polarity === 'avoid' ? avoided : preferred).push(vector);
      if (provider === 'wasm') reportCount(preferred.length + avoided.length);
    }
    const matches = [];
    let reusedPreviews = 0;
    for (const { id, rgba } of sample) {
      const { values, reused } = await previewVector(runtime, id, rgba);
      const score = subjectScore(preferred.map(vector => cosine(vector, values)), avoided.map(vector => cosine(vector, values)));
      if (reused) reusedPreviews++;
      matches.push({ id, score });
      if (provider === 'wasm') reportCount(references.length + matches.length);
    }
    return { phase: 'complete', reusedPreviews, matches: matches.sort((first, next) => next.score - first.score || first.id - next.id) };
  } finally {
    for (const vector of [...preferred, ...avoided]) vector.fill(0);
  }
}

// The app creates this worker on the first explicit comparison. Initialization overlaps preview decoding.
const runtime = loadRuntime().catch(() => {
  self.postMessage({ phase: 'failed' });
  return null;
});
let matching = false;
self.addEventListener('message', async event => {
  // The browser's dedicated-worker port sends trusted messages without a window origin or source.
  if (!event.isTrusted || event.origin !== '' || event.source !== null || event.ports.length !== 0) return;
  const { data } = event;
  if (matching) {
    self.postMessage({ phase: 'failed' });
    return;
  }
  matching = true;
  let reply;
  try {
    const loaded = await runtime;
    if (loaded) reply = await compare(data, loaded);
  } catch {
    reply = { phase: 'failed' };
  } finally {
    for (const rows of [data?.references, data?.sample]) if (Array.isArray(rows)) {
      for (const row of rows) if (row?.rgba instanceof Uint8ClampedArray) row.rgba.fill(0);
    }
    matching = false;
  }
  if (reply) self.postMessage(reply);
});
