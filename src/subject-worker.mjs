import { subjectAssetOrigins, subjectCandidateLimit, subjectDownloadBytes, subjectSide, subjectVisionModel, subjectWasm } from './subject-artifacts.mjs';

const pixels = subjectSide * subjectSide;
const dimensions = 768;

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
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', output)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
  if (position !== bytes || digest !== sha256) throw new Error('Inference file verification failed.');
  return output;
}

async function pictureVector(ort, session, input, output, rgba) {
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

async function loadRuntime() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter || adapter.info?.isFallbackAdapter || typeof WebAssembly.Suspending !== 'function' ||
      typeof WebAssembly.promising !== 'function' || !crypto.subtle) {
    self.postMessage({ phase: 'unavailable' });
    return null;
  }
  const received = [0, 0];
  let lastUpdate = -Infinity;
  function progress(index, bytes) {
    received[index] = bytes;
    const now = performance.now();
    const loaded = received[0] + received[1];
    if (now - lastUpdate < 150 && loaded !== subjectDownloadBytes) return;
    lastUpdate = now;
    self.postMessage({ phase: 'loading', loaded });
  }
  progress(0, 0);
  const [model, wasm] = await Promise.all([subjectVisionModel, subjectWasm].map((artifact, index) =>
    checkedBytes(artifact, bytes => progress(index, bytes))));
  self.postMessage({ phase: 'starting' });
  const ort = await import('./vendor/ort/ort.jspi.min.mjs');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.wasmBinary = wasm.buffer;
  ort.env.webgpu.adapter = adapter;
  const session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
  const input = session.inputNames.find(name => name === 'pixel_values');
  const output = ['image_embeds', 'pooler_output', 'image_features'].find(name => session.outputNames.includes(name));
  if (!input || !output) {
    await session.release();
    throw new Error('Unexpected vision model inputs or outputs.');
  }
  return { ort, session, input, output };
}

async function compare(rows, { ort, session, input, output }) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 1 + subjectCandidateLimit ||
      !rows.every((row, index) => Number.isSafeInteger(row?.id) && row.id >= (index === 0 ? 0 : 1) &&
        row.rgba instanceof Uint8ClampedArray && row.rgba.length === 4 * pixels) ||
      new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid picture inputs.');
  self.postMessage({ phase: 'matching' });
  const reference = await pictureVector(ort, session, input, output, rows[0].rgba);
  try {
    const matches = [];
    for (const { id, rgba } of rows.slice(1)) {
      const values = await pictureVector(ort, session, input, output, rgba);
      const score = reference.reduce((sum, value, index) => sum + value * values[index], 0);
      values.fill(0);
      matches.push({ id, score });
    }
    return { phase: 'complete', matches: matches.sort((first, next) => next.score - first.score || first.id - next.id) };
  } finally {
    reference.fill(0);
  }
}

// The app creates this worker on the first explicit comparison. Initialization overlaps preview decoding.
const runtime = loadRuntime().catch(() => {
  self.postMessage({ phase: 'failed' });
  return null;
});
let matching = false;
self.addEventListener('message', async ({ data }) => {
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
    if (Array.isArray(data)) {
      for (const row of data) if (row?.rgba instanceof Uint8ClampedArray) row.rgba.fill(0);
    }
    matching = false;
  }
  if (reply) self.postMessage(reply);
});
