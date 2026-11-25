import { unpackModel, verifiedModelBytes } from './model-bytes.mjs';
import { audioDownloadBytes, audioPackMagic, audioPackParts, audioPackUrl } from './written-sound-artifacts.mjs';
import { subjectCpuWasm } from './subject-artifacts.mjs';
import { Tokenizer } from './vendor/tokenizers/tokenizers.min.mjs';
import { createAudioPatches, createAudioTextTokens, soundPatchCount, soundPatchWidth, soundSimilarity, soundTextTokens,
  soundVectorSize } from './written-sound-features.mjs';
import { validWrittenSoundBrief, writtenSoundMinimum, writtenSoundRate, writtenSoundSampleLimit,
  writtenSoundWindows } from './written-sound.mjs';

let model;
let busy = false;

async function readAssets() {
  const received = [0, 0];
  let last = 0;
  const progress = (index, count) => {
    received[index] = count;
    const loaded = received[0] + received[1];
    const now = performance.now();
    if (now - last > 200 || loaded === audioDownloadBytes) {
      last = now;
      self.postMessage({ type: 'progress', loaded });
    }
  };
  const read = async url => {
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      cache: 'force-cache', signal: AbortSignal.timeout(75_000) });
    if (!response.ok || !response.body || response.url !== url) throw new Error('The sound model file is unavailable.');
    return response.body;
  };
  return Promise.all([
    read(audioPackUrl).then(body => unpackModel(body, audioPackMagic, audioPackParts, count => progress(0, count))),
    read(subjectCpuWasm.url).then(body => verifiedModelBytes(body, subjectCpuWasm, count => progress(1, count))),
  ]);
}

async function createSession(ort, graph, input) {
  const session = await ort.InferenceSession.create(graph, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  if (session.inputNames[0] !== input || session.outputNames[0] !== 'features') {
    await session.release();
    throw new Error('Unexpected sound model inputs or outputs.');
  }
  return session;
}

async function embed(ort, session, key, kind, data, shape) {
  const input = new ort.Tensor(kind, data, shape);
  try {
    const response = await session.run({ [key]: input }, ['features']);
    try {
      const values = await response.features.getData();
      if (values.length !== shape[0] * soundVectorSize || !values.every(Number.isFinite)) {
        throw new Error('Unexpected sound model values.');
      }
      return Array.from({ length: shape[0] }, (_, index) =>
        values.slice(index * soundVectorSize, (index + 1) * soundVectorSize));
    } finally { response.features.dispose(); }
  } finally { input.dispose(); }
}

async function openModel(brief) {
  const [{ audio, text, tokenizer, tokenizerConfig }, wasm] = await readAssets();
  const decoder = new TextDecoder();
  const tokens = new Tokenizer(JSON.parse(decoder.decode(tokenizer)), JSON.parse(decoder.decode(tokenizerConfig)));
  const captions = [...brief.required, ...brief.avoid];
  const ids = createAudioTextTokens(tokens, captions);
  const ort = await import('./vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
  ort.env.wasm.wasmBinary = wasm.buffer;
  const textSession = await createSession(ort, text, 'tokens');
  let features;
  try {
    features = await embed(ort, textSession, 'tokens', 'int64', ids, [captions.length, soundTextTokens]);
  } finally { await textSession.release(); }
  const audioSession = await createSession(ort, audio, 'patches');
  return { ort, features, audioSession };
}

async function checkAudio({ ort, audioSession, features }, samples) {
  const checked = [];
  for (const { start, end, wave } of writtenSoundWindows(samples)) {
    const patches = createAudioPatches(wave);
    if (!patches) continue;
    const [vector] = await embed(ort, audioSession, 'patches', 'float32', patches, [1, soundPatchCount, soundPatchWidth]);
    checked.push({ start, end, scores: features.map(cue => soundSimilarity(cue, vector)) });
  }
  return checked;
}

self.addEventListener('message', async event => {
  if (!event.isTrusted || event.origin !== '' || event.source !== null || event.ports.length !== 0 || busy) return;
  const { data } = event;
  busy = true;
  try {
    if (!model && data?.type === 'load' && validWrittenSoundBrief(data.brief)) {
      model = await openModel(data.brief);
      self.postMessage({ type: 'ready' });
    } else if (model && data?.type === 'read' && data.samples instanceof Float32Array &&
      data.samples.length >= writtenSoundMinimum * writtenSoundRate && data.samples.length <= writtenSoundSampleLimit) {
      self.postMessage({ type: 'checked', windows: await checkAudio(model, data.samples) });
    } else {
      self.postMessage({ type: 'error' });
    }
  } catch (error) {
    self.postMessage({ type: error instanceof RangeError && error.message === 'Use shorter sound descriptions.' ? 'length' : 'error' });
  } finally { busy = false; }
});
