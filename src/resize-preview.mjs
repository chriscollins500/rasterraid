function bicubic(distance) {
  const x = Math.abs(distance);
  if (x < 1) return ((1.5 * x - 2.5) * x) * x + 1;
  if (x < 2) return (((-.5 * x + 2.5) * x - 4) * x) + 2;
  return 0;
}

function samplingAxis(length, output) {
  const ratio = length / output;
  const scale = Math.max(1, ratio);
  return Array.from({ length: output }, (_, position) => {
    const center = (position + .5) * ratio - .5;
    const start = Math.max(0, Math.ceil(center - 2 * scale));
    const end = Math.min(length - 1, Math.floor(center + 2 * scale));
    const raw = Array.from({ length: end - start + 1 }, (_, index) => bicubic((start + index - center) / scale));
    const sum = raw.reduce((total, weight) => total + weight, 0);
    return { start, weights: raw.map(weight => weight / sum) };
  });
}

export function resizePreview(rgba, width, height, side) {
  if (rgba.length !== width * height * 4 || !width || !height || !side) throw Error('Inconsistent preview dimensions');
  const horizontal = samplingAxis(width, side);
  const vertical = samplingAxis(height, side);
  const rows = new Float32Array(height * side * 3);
  for (let y = 0; y < height; y++) {
    for (const [x, { start, weights }] of horizontal.entries()) {
      const target = (y * side + x) * 3;
      for (const [offset, weight] of weights.entries()) {
        const source = (y * width + start + offset) * 4;
        for (let channel = 0; channel < 3; channel++) rows[target + channel] += weight * rgba[source + channel];
      }
    }
  }
  const result = new Uint8ClampedArray(side * side * 4);
  for (const [y, { start, weights }] of vertical.entries()) {
    for (let x = 0; x < side; x++) {
      const target = (y * side + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let value = 0;
        for (const [offset, weight] of weights.entries()) value += weight * rows[((start + offset) * side + x) * 3 + channel];
        result[target + channel] = value;
      }
      result[target + 3] = 255;
    }
  }
  return result;
}
