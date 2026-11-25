export const fftSize = 1024;

export const fftOrder = Uint16Array.from({ length: fftSize }, (_, index) => {
  let reversed = 0;
  for (let bit = 1; bit < fftSize; bit <<= 1) reversed = (reversed << 1) | ((index & bit) ? 1 : 0);
  return reversed;
});

const [cosine, sine] = [Math.cos, Math.sin].map(project => Float64Array.from({ length: fftSize / 2 }, (_, index) =>
  project(-2 * Math.PI * index / fftSize)));

// The caller fills the real inputs in bit-reversed order and clears the imaginary inputs.
export function transformSpectrum(real, imaginary) {
  for (let span = 2; span <= fftSize; span *= 2) {
    const half = span / 2;
    const stride = fftSize / span;
    for (let first = 0; first < fftSize; first += span) {
      for (let index = 0; index < half; index++) {
        const low = first + index;
        const high = low + half;
        const angle = index * stride;
        const re = real[high] * cosine[angle] - imaginary[high] * sine[angle];
        const im = real[high] * sine[angle] + imaginary[high] * cosine[angle];
        real[high] = real[low] - re;
        imaginary[high] = imaginary[low] - im;
        real[low] += re;
        imaginary[low] += im;
      }
    }
  }
}
