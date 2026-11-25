import { spokenRegions, speechRate } from './spoken-regions.mjs';

const binary = new TextDecoder('utf-8', { fatal: true });
const words = new TextDecoder('utf-8');
const encoderStride = 384;
const voiceFrame = 512;
const voiceContext = 64;

function tokenTable(bytes) {
  const table = [];
  for (const line of binary.decode(bytes).trimEnd().split(/\r?\n/u)) {
    const match = /^([A-Za-z0-9+/]*=*) (\d+)$/u.exec(line);
    if (!match || Number(match[2]) !== table.length) throw new Error('Unexpected speech tokenizer format.');
    table.push(Uint8Array.from(atob(match[1]), char => char.charCodeAt(0)));
  }
  if (table.length !== 32_768) throw new Error('Unexpected speech vocabulary.');
  return table;
}

const ones = length => new BigInt64Array(length).fill(1n);
const asText = (tokens, table) => tokens.map(token => words.decode(table[token], { stream: true })).join('') + words.decode();

function hasVoice(scores, from, through) {
  let active = 0;
  const first = Math.floor(from / voiceFrame);
  const last = Math.min(scores.length, Math.ceil(through / voiceFrame));
  for (let index = first; index < last; index++) {
    active = scores[index] >= .5 ? active + 1 : 0;
    if (active * voiceFrame >= .25 * speechRate) return true;
  }
  return false;
}

async function voiceScores(ort, session, samples) {
  const count = Math.ceil(samples.length / voiceFrame);
  const width = voiceContext + voiceFrame;
  const frames = new Float32Array(count * width);
  for (let index = 0; index < count; index++) {
    const start = index * voiceFrame - voiceContext;
    frames.set(samples.subarray(Math.max(0, start), start + width), index * width + Math.max(0, -start));
  }
  const input = new ort.Tensor('float32', frames, [count, width]);
  const state = new ort.Tensor('float32', new Float32Array(128), [1, 1, 128]);
  try {
    const { speech_probs: probabilities } = await session.run({ input, h: state, c: state }, ['speech_probs']);
    try {
      const values = await probabilities.getData();
      if (values.length !== count || !values.every(score => Number.isFinite(score) && score >= 0 && score <= 1)) {
        throw new Error('Unexpected speech detector output.');
      }
      return values.slice();
    } finally { probabilities.dispose(); }
  } finally { input.dispose(); state.dispose(); }
}

export async function ortSpeech(ort, { encoder, decoder, tokens, vad }) {
  const vocabulary = tokenTable(tokens);
  const config = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const input = await ort.InferenceSession.create(encoder, config);
  let output;
  let detector;
  try {
    output = await ort.InferenceSession.create(decoder, config);
    if (vad) detector = await ort.InferenceSession.create(vad, config);
  } catch (error) {
    await Promise.allSettled([input, output].filter(Boolean).map(session => session.release()));
    throw error;
  }
  const tensor = (type, data, shape) => new ort.Tensor(type, data, shape);
  const stateKeys = output.inputNames.filter(name => /^past_key_values\.\d+\.(?:encoder|decoder)\.(?:key|value)$/u.test(name));
  const decoderOutputs = ['logits', ...output.outputNames.filter(name => name.includes('.decoder.'))];
  const initial = tensor('float32', new Float32Array(0), [1, 8, 0, 36]);
  if (stateKeys.length !== 24 || decoderOutputs.length !== 13 || !input.outputNames.includes('last_hidden_state')) {
    initial.dispose();
    await Promise.allSettled([input, output, detector].filter(Boolean).map(session => session.release()));
    throw new Error('Unexpected speech model inputs or outputs.');
  }

  async function decode(samples) {
    const waveform = tensor('float32', samples, [1, samples.length]);
    const mask = tensor('int64', ones(samples.length), [1, samples.length]);
    let features;
    try { ({ last_hidden_state: features } = await input.run({ input_values: waveform, attention_mask: mask })); }
    finally { waveform.dispose(); mask.dispose(); }
    const frameCount = features.dims[1];
    const paddedLength = frameCount * encoderStride;
    const feeds = { encoder_attention_mask: tensor('int64', ones(paddedLength), [1, paddedLength]), encoder_hidden_states: features };
    for (const key of stateKeys) feeds[key] = initial;
    const tokenLimit = Math.floor(paddedLength / speechRate * 15);
    const ids = [];
    let selected = 1;
    try {
      for (let step = 0; step < tokenLimit; step++) {
        const cached = step !== 0;
        feeds.input_ids = tensor('int64', [BigInt(selected)], [1, 1]);
        feeds.use_cache_branch = tensor('bool', [cached ? 1 : 0], [1]);
        let result;
        try { result = await output.run(feeds, cached ? decoderOutputs : output.outputNames); }
        finally { feeds.input_ids.dispose(); feeds.use_cache_branch.dispose(); }
        const logits = result.logits.data;
        selected = 0;
        for (let position = 1; position < logits.length; position++) if (logits[position] > logits[selected]) selected = position;
        result.logits.dispose();
        for (const key of stateKeys) {
          const next = result[key.replace('past_key_values.', 'present.')];
          if (!next) continue;
          if (feeds[key] !== initial) feeds[key].dispose();
          feeds[key] = next;
        }
        if (selected === 2) break;
        ids.push(selected);
      }
    } finally {
      feeds.encoder_attention_mask.dispose();
      features.dispose();
      for (const key of stateKeys) if (feeds[key] !== initial) feeds[key].dispose();
    }
    return asText(ids, vocabulary).replaceAll('\u2581', ' ').trim();
  }

  return {
    async analyze(samples) {
      const result = [];
      const regions = spokenRegions(samples);
      const scores = detector && regions.length ? await voiceScores(ort, detector, samples) : null;
      for (const { start, from, through } of regions) {
        if (scores && !hasVoice(scores, from, through)) continue;
        const text = await decode(samples.subarray(from, through));
        if (text) result.push({ start: start / speechRate, end: through / speechRate, text });
      }
      return result;
    },
    async close() { initial.dispose(); await Promise.all([input, output, detector].filter(Boolean).map(session => session.release())); },
  };
}
