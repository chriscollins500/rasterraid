import { unpackModel } from './model-bytes.mjs';
import { visualPackBytes, visualPackMagic, visualPackParts, visualPackUrl } from './visual-text-pack.mjs';
import { Tokenizer } from './vendor/tokenizers/tokenizers.min.mjs';

const dimensions = 768;
const tokensPerQuery = 64;
const vocabulary = 256_000;
const preservedRows = 64;
const blocksPerRow = 12;
const blockWidth = dimensions / blocksPerRow;

async function downloadModelPack() {
  const response = await fetch(visualPackUrl, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    cache: 'force-cache', signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body || response.url !== visualPackUrl) throw new Error('The model pack is unavailable.');
  return response.body;
}

export async function readVisualTextModel(pack, onProgress) {
  if (pack) onProgress('model-check');
  else onProgress('model-download', 0);
  const source = pack ?? await downloadModelPack();
  return unpackModel(source, visualPackMagic, visualPackParts, pack ? undefined : loaded => onProgress('model-download', loaded));
}

export async function createVisualTextSession(ort, provider, assets) {
  const decoder = new TextDecoder();
  const tokenizer = new Tokenizer(JSON.parse(decoder.decode(assets.tokenizer)), {
    ...JSON.parse(decoder.decode(assets.tokenizerConfig)), do_lower_case: false,
  });
  if (tokenizer.token_to_id('<pad>') !== 0 || tokenizer.token_to_id('<eos>') !== 1) {
    throw new Error('Unexpected visual model tokens.');
  }
  const session = await ort.InferenceSession.create(assets.body, { executionProviders: [provider], graphOptimizationLevel: 'all' });
  const scales = new DataView(assets.table.buffer, assets.table.byteOffset, vocabulary * blocksPerRow * 2);
  const codes = assets.table.subarray(scales.byteLength);
  const exact = new Float32Array(assets.special.buffer, assets.special.byteOffset, preservedRows * dimensions);
  return { ort, session, tokenizer, scales, codes, exact };
}

function writeTokenVector({ scales, codes, exact }, id, target, offset) {
  if (id < preservedRows) {
    target.set(exact.subarray(id * dimensions, (id + 1) * dimensions), offset);
    return;
  }
  for (let group = 0; group < blocksPerRow; group++) {
    const scale = scales.getFloat16((id * blocksPerRow + group) * 2, true);
    const source = (id * dimensions + group * blockWidth) / 2;
    const first = offset + group * blockWidth;
    for (let pair = 0; pair < blockWidth / 2; pair++) {
      const packed = codes[source + pair];
      target[first + 2 * pair] = ((packed & 15) - 8) * scale;
      target[first + 2 * pair + 1] = ((packed >>> 4) - 8) * scale;
    }
  }
}

export async function visualTextVector(model, description) {
  const { ort, session, tokenizer } = model;
  const ids = tokenizer.encode(description.toLowerCase(), { add_special_tokens: false }).ids.slice(0, tokensPerQuery - 1).concat(1);
  if (ids.some(id => !Number.isSafeInteger(id) || id < 0 || id >= vocabulary)) throw new Error('Unexpected visual model token ID.');
  const embeddings = new Float32Array(tokensPerQuery * dimensions);
  for (let index = 0; index < tokensPerQuery; index++) writeTokenVector(model, ids[index] ?? 0, embeddings, index * dimensions);
  const input = new ort.Tensor('float32', embeddings, [1, tokensPerQuery, dimensions]);
  try {
    const output = await session.run({ [session.inputNames[0]]: input }, ['pooler_output']);
    try {
      const values = await output.pooler_output.getData();
      const squared = values.reduce((sum, value) => sum + value * value, 0);
      if (values.length !== dimensions || !Number.isFinite(squared) || squared <= 0) throw new Error('Invalid visual description vector.');
      const norm = Math.sqrt(squared);
      return Float32Array.from(values, value => value / norm);
    } finally {
      for (const value of Object.values(output)) value.dispose();
    }
  } finally {
    input.dispose();
    embeddings.fill(0);
  }
}
