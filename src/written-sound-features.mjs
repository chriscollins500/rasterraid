import { fftOrder, fftSize, transformSpectrum } from './audio-fft.mjs';
import { hasAudibleSound, writtenSoundMinimum, writtenSoundRate, writtenSoundWindow } from './written-sound.mjs';

// The CLAP2 audio graph expects 256 flattened log-mel patches from one five-second window.
export const soundPatchCount = 256;
export const soundPatchWidth = 256;
export const soundTextTokens = 64;
export const soundVectorSize = 224;
export const soundWindowSamples = writtenSoundRate * writtenSoundWindow;

const hop = 320;
const melBins = 128;
const patchSide = 16;
const frameCount = Math.floor(soundWindowSamples / hop) + 1;
const paddedFrames = Math.ceil(frameCount / patchSide) * patchSide;
const hann = Float64Array.from({ length: fftSize }, (_, index) => .5 - .5 * Math.cos(2 * Math.PI * index / fftSize));
const toMel = hz => 2595 * Math.log10(1 + hz / 700);
const toHz = mel => 700 * (10 ** (mel / 2595) - 1);
const minimumMel = toMel(50);
const melStep = (toMel(writtenSoundRate / 2) - minimumMel) / (melBins + 1);
const edges = Float64Array.from({ length: melBins + 2 }, (_, band) => toHz(minimumMel + band * melStep));
const hertzPerBin = writtenSoundRate / fftSize;
const filters = Array.from({ length: melBins }, (_, band) => {
  const [low, center, high] = edges.subarray(band, band + 3);
  const first = Math.ceil(low / hertzPerBin);
  const last = Math.floor(high / hertzPerBin);
  const gains = Float64Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
    const hz = (first + index) * hertzPerBin;
    return Math.max(0, Math.min((hz - low) / (center - low), (high - hz) / (high - center)));
  });
  return { first, gains };
});

function powerSpectrum(input, center, real, imaginary, powers) {
  const first = center - fftSize / 2;
  imaginary.fill(0);
  for (let index = 0; index < fftSize; index++) {
    const sample = first + index;
    const reflected = sample < 0 ? -sample : sample >= soundWindowSamples ? 2 * soundWindowSamples - sample - 2 : sample;
    real[fftOrder[index]] = (input[reflected] ?? 0) * hann[index];
  }
  transformSpectrum(real, imaginary);
  for (let index = 0; index < powers.length; index++) powers[index] = real[index] ** 2 + imaginary[index] ** 2;
}

export function createAudioPatches(input) {
  if (!(input instanceof Float32Array) || input.length > soundWindowSamples ||
      input.length < writtenSoundRate * writtenSoundMinimum || !input.every(Number.isFinite)) {
    throw new RangeError('Unexpected audio samples.');
  }
  if (!hasAudibleSound(input)) return null;
  const timeMel = new Float32Array(paddedFrames * melBins);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const powers = new Float64Array(fftSize / 2 + 1);
  let floor = Infinity;
  for (let frame = 0; frame < frameCount; frame++) {
    powerSpectrum(input, frame * hop, real, imaginary, powers);
    for (let band = 0; band < melBins; band++) {
      const { first, gains } = filters[band];
      let energy = 0;
      for (let index = 0; index < gains.length; index++) energy += powers[first + index] * gains[index];
      const decibels = 10 * Math.log10(Math.max(1e-10, energy));
      timeMel[frame * melBins + band] = decibels;
      floor = Math.min(floor, decibels);
    }
  }
  timeMel.fill(floor, frameCount * melBins);
  const patches = new Float32Array(soundPatchCount * soundPatchWidth);
  let offset = 0;
  for (let frequency = 0; frequency < melBins; frequency += patchSide) {
    for (let time = 0; time < paddedFrames; time += patchSide) {
      for (let band = frequency; band < frequency + patchSide; band++) {
        for (let frame = time; frame < time + patchSide; frame++) patches[offset++] = timeMel[frame * melBins + band];
      }
    }
  }
  return patches;
}

export function createAudioTextTokens(tokenizer, descriptions) {
  const ids = new BigInt64Array(descriptions.length * soundTextTokens).fill(50258n);
  descriptions.forEach((description, index) => {
    const clean = description.trim().replace(/\s+/gu, ' ');
    const values = tokenizer.encode(clean, { add_special_tokens: false }).ids;
    if (!values.length || values.length > soundTextTokens - 2 ||
        !values.every(value => Number.isInteger(value) && value >= 0 && value < 50256)) {
      throw new RangeError('Use shorter sound descriptions.');
    }
    const start = index * soundTextTokens;
    ids[start] = 50259n;
    for (let position = 0; position < values.length; position++) ids[start + 1 + position] = BigInt(values[position]);
    ids[start + 1 + values.length] = 50257n;
  });
  return ids;
}

export function soundSimilarity(left, right) {
  let product = 0;
  for (let index = 0; index < soundVectorSize; index++) product += left[index] * right[index];
  return product;
}
