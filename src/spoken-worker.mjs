import { verifiedModelBytes } from './model-bytes.mjs';
import { speechArtifacts, speechDownloadBytes, speechSecondsLimit } from './spoken-artifacts.mjs';
import { subjectAssetOrigins } from './subject-artifacts.mjs';
import { ortSpeech } from './ort-speech.mjs';
import { speechRate } from './spoken-regions.mjs';

let model;
let busy = false;

async function openModel() {
  const received = new Map();
  let announcedAt = 0;
  const inputs = await Promise.all(Object.entries(speechArtifacts).map(async ([name, file]) => {
    const reply = await fetch(file.url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(60_000) });
    if (!reply.ok || !reply.body || !subjectAssetOrigins.includes(new URL(reply.url).origin)) {
      throw new Error('The speech model download is unavailable.');
    }
    const bytes = await verifiedModelBytes(reply.body, file, count => {
      received.set(name, count);
      const now = performance.now();
      if (now - announcedAt >= 200) {
        announcedAt = now;
        const loaded = [...received.values()].reduce((total, value) => total + value, 0);
        self.postMessage({ type: 'progress', loaded, total: speechDownloadBytes });
      }
    });
    return [name, bytes];
  }));
  const { wasm, ...parts } = Object.fromEntries(inputs);
  const ort = await import('./vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.wasmBinary = wasm.buffer;
  return ortSpeech(ort, parts);
}

self.addEventListener('message', async event => {
  // Dedicated worker messages arrive on the browser's implicit port.
  if (!event.isTrusted || event.origin !== '' || event.source !== null || event.ports.length !== 0) return;
  const { data } = event;
  if (busy) return;
  busy = true;
  try {
    if (data?.type === 'load' && !model) {
      model = await openModel();
      self.postMessage({ type: 'ready' });
    } else if (data?.type === 'read' && model && data.samples instanceof Float32Array && data.samples.length &&
      data.samples.length <= speechRate * speechSecondsLimit) {
      const cues = await model.analyze(data.samples);
      self.postMessage({ type: 'cues', cues });
    }
  } catch {
    self.postMessage({ type: 'error' });
  } finally { busy = false; }
});
