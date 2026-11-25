import { clipAnalysisUrl } from './catalog.mjs';
import { publicMedia } from './catalog-research.mjs';
import { fftOrder as reversed, fftSize as size, transformSpectrum } from './audio-fft.mjs';

export const soundRoles = { rhythm: 'Rhythm', texture: 'Sound texture', dynamics: 'Energy changes' };
export const soundTypes = /\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|mp4|webm)$/iu;
export const soundWindowSeconds = 8;
export const soundFileBytes = 16 * 1024 * 1024;
export const soundCandidateLimit = 8;
export const soundMaximumSeconds = 240;
const rate = 16000;
const hop = 512;
const bands = 26;
const waveformPoints = 48;
const pulseRates = Array.from({ length: 25 }, (_, index) => Math.round(52 * 2 ** (index / 12)));
const hann = Float64Array.from({ length: size }, (_, index) => .5 - .5 * Math.cos(2 * Math.PI * index / (size - 1)));
const spectrumBand = Int8Array.from({ length: size / 2 }, (_, index) => {
  const hz = index * rate / size;
  return hz < 38 ? -1 : Math.min(bands - 1, Math.floor(4 * Math.log2(hz / 38)));
});

const unit = x => Math.min(1, Math.max(0, x));
const clampStart = (audio, seconds) => Math.min(Math.max(0, audio.duration - 1.5), Math.max(0, seconds || 0));
const distance = (a, b) => a.reduce((sum, n, index) => sum + Math.abs(n - b[index]), 0) / a.length;
const nextTask = () => globalThis.scheduler?.yield?.() ?? new Promise(resolve => setTimeout(resolve, 0));

function spectrum(samples, offset, real, imaginary, powers) {
  let energy = 0;
  for (let index = 0; index < size; index++) {
    const value = samples[offset + index];
    energy += value * value;
    real[reversed[index]] = value * hann[index];
  }
  imaginary.fill(0);
  transformSpectrum(real, imaginary);
  for (let i = 3; i < spectrumBand.length; i++) powers[spectrumBand[i]] += real[i] ** 2 + imaginary[i] ** 2;
  return energy / size;
}

function pulseShape(onsets) {
  const average = onsets.reduce((sum, x) => sum + x, 0) / onsets.length;
  const centered = onsets.map(x => Math.max(0, x - average));
  const measure = lag => {
    let dot = 0;
    let before = 0;
    let after = 0;
    for (let i = lag; i < centered.length; i++) {
      const a = centered[i];
      const b = centered[i - lag];
      dot += a * b;
      before += a * a;
      after += b * b;
    }
    return dot / Math.max(.000001, Math.sqrt(before * after));
  };
  return pulseRates.map(bpm => {
    const lag = 60 * rate / (hop * bpm);
    const lower = Math.floor(lag);
    const upperWeight = lag - lower;
    return measure(lower) * (1 - upperWeight) + measure(lower + 1) * upperWeight;
  });
}

export async function describeSound(audio, seconds = 0, { signal, yieldTask = nextTask, windowSeconds = soundWindowSeconds } = {}) {
  if (audio?.sampleRate !== rate || audio.duration < 1.5 || !audio.numberOfChannels) return null;
  const start = clampStart(audio, seconds);
  const from = Math.floor(start * rate);
  const end = Math.min(audio.length, from + Math.floor(Math.min(soundWindowSeconds, Math.max(1.5, windowSeconds)) * rate));
  const channels = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, index) => audio.getChannelData(index));
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  const powers = new Float64Array(bands);
  const previous = new Float64Array(bands);
  const texture = new Float64Array(bands);
  const waveform = new Float64Array(waveformPoints);
  const energy = [];
  const onsets = [];
  for (let offset = from; offset + size <= end; offset += hop) {
    powers.fill(0);
    let power = 0;
    for (const samples of channels) power += spectrum(samples, offset, real, imaginary, powers);
    const rms = Math.sqrt(power / channels.length);
    const peak = Math.min(waveformPoints - 1, Math.floor((offset - from) / (end - from) * waveformPoints));
    waveform[peak] = Math.max(waveform[peak], rms);
    const magnitude = powers.reduce((sum, n) => sum + Math.sqrt(n), 0);
    let flux = 0;
    for (let i = 0; i < bands; i++) {
      const current = magnitude > .01 ? Math.sqrt(powers[i]) / magnitude : 0;
      // Weight spectral shape by audibility so silence cannot dominate texture ranking.
      texture[i] += current * rms;
      flux += Math.max(0, current - previous[i]);
      previous[i] = current;
    }
    const amplitudeChange = Math.max(0, Math.log((rms + .001) / ((energy.at(-1) ?? rms) + .001)));
    if (energy.length) onsets.push(Math.min(1.5, amplitudeChange) * .65 + flux * .35);
    energy.push(rms);
    if (energy.length % 48 === 0) {
      signal?.throwIfAborted();
      await yieldTask();
    }
  }
  signal?.throwIfAborted();
  if (!energy.length) return null;
  const sorted = energy.toSorted((a, b) => a - b);
  const quantile = p => sorted[Math.floor(p * (sorted.length - 1))];
  const loud = quantile(.95);
  const total = texture.reduce((sum, n) => sum + n, 0);
  if (loud < .0002 || total <= 0) return null;
  const profile = pulseShape(onsets);
  return { start: Math.round(start * 10) / 10, exactStart: from / rate, duration: (end - from) / rate,
    waveform: Array.from(waveform, level => unit(level / loud)),
    texture: Array.from(texture, level => Math.sqrt(level / total)),
    rhythm: { profile, activity: onsets.filter(value => value > .26).length / onsets.length },
    dynamics: [.12, .28, .5, .72].map(p => unit(1 + Math.log10(Math.max(.001, quantile(p) / loud)) / 2.5)),
  };
}

const similarities = {
  rhythm: (a, b) => Math.exp(-5 * distance(a.profile, b.profile) - 4 * Math.abs(a.activity - b.activity)),
  texture: (a, b) => unit(a.reduce((dot, n, index) => dot + n * b[index], 0)),
  dynamics: (a, b) => Math.exp(-5 * distance(a, b)),
};

export function scoreSound(references, features) {
  if (!references.length || !features) return null;
  const cues = references.map(({ features: anchor, role, avoid }) => {
    const similarity = similarities[role](anchor[role], features[role]);
    return { role, avoid, score: avoid ? 1 - similarity : similarity };
  });
  // Score all cues on the same window. A good mean cannot hide a poor fit to one cue.
  const total = cues.reduce((sum, cue) => sum + cue.score, 0) / cues.length;
  return { cues, score: total * .75 + Math.min(...cues.map(cue => cue.score)) * .25 };
}

export function soundWindowStarts(duration) {
  const tail = Math.max(0, duration - soundWindowSeconds);
  const count = Math.min(5, 1 + Math.ceil(tail / (soundWindowSeconds / 2)));
  return Array.from({ length: count }, (_, index) => count === 1 ? 0 : tail * index / (count - 1));
}

export async function soundWindows(audio, options) {
  const windows = [];
  for (const start of soundWindowStarts(audio.duration)) {
    const features = await describeSound(audio, start, options);
    if (features) windows.push(features);
  }
  return windows;
}

export function rankSoundMatches(references, rows) {
  if (!references.length) return [];
  return rows.flatMap(row => {
    let best;
    const excerpts = [];
    for (const features of row.windows) {
      const fit = scoreSound(references, features);
      excerpts.push({ start: features.exactStart ?? features.start, duration: features.duration, ...fit });
      if (!best || fit.score > best.score) best = { ...fit, features };
    }
    return best ? [{ item: row.item, stream: row.stream, ...best, excerpts }] : [];
  }).sort((a, b) => b.score - a.score);
}

export function createSoundDecoder(window, sampleRate = rate) {
  const Audio = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
  if (!Audio) throw new TypeError('Audio decoding is unavailable.');
  const decoder = new Audio(1, 1, sampleRate);
  return async (bytes, signal) => {
    signal?.throwIfAborted();
    if (!bytes.byteLength || bytes.byteLength > soundFileBytes) throw new RangeError('Audio file is too large.');
    const audio = await decoder.decodeAudioData(bytes);
    signal?.throwIfAborted();
    if (audio.duration < 1.5 || audio.duration > soundMaximumSeconds || audio.numberOfChannels > 8) {
      throw new RangeError('Audio must be between 1.5 seconds and 4 minutes.');
    }
    return audio;
  };
}

const deliveryOrigins = ['https://image.civitai.com', 'https://blobs-b2.civitai.com'];
const mediaType = /^(?:audio\/|video\/|application\/(?:octet-stream|ogg)(?:;|$))/iu;
const publicFileBytes = 8 * 1024 * 1024;

async function readClip(url, signal, budget, fetcher) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  const reply = await fetcher(url, { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors', signal: requestSignal });
  const limit = Math.min(publicFileBytes, budget.remaining);
  if (!reply.ok || !deliveryOrigins.includes(new URL(reply.url).origin) || !mediaType.test(reply.headers.get('content-type') ?? '') ||
      Number(reply.headers.get('content-length')) > limit || !reply.body || limit <= 0) {
    await reply.body?.cancel();
    throw new TypeError('The public sound preview is unavailable.');
  }
  const reader = reply.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      budget.remaining -= value.byteLength;
      length += value.byteLength;
      if (length > limit || budget.remaining < 0) throw new RangeError('Sound preview limit reached.');
      chunks.push(value);
    }
  } finally {
    if (length > limit || budget.remaining < 0) await reader.cancel();
    reader.releaseLock();
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}

export async function decodePublicSoundSource(source, decode, signal, budget, fetcher = fetch) {
  const stream = publicMedia(source, soundTypes);
  if (!stream) throw new TypeError('Audio source is outside the Civitai catalog.');
  for (const url of new Set([clipAnalysisUrl(stream), stream])) {
    try {
      const data = await readClip(url, signal, budget, fetcher);
      return { audio: await decode(data, signal), stream: url };
    } catch (error) {
      signal.throwIfAborted();
      if (url === stream) throw error;
    }
  }
}

export async function decodePublicSound(source, decode, signal, budget, fetcher) {
  return (await decodePublicSoundSource(source, decode, signal, budget, fetcher)).audio;
}

export async function decodeExactPublicSound(source, decode, signal, budget, fetcher = fetch) {
  const stream = publicMedia(source, soundTypes);
  if (!stream) throw new TypeError('Audio source is outside the Civitai catalog.');
  return decode(await readClip(stream, signal, budget, fetcher), signal);
}
