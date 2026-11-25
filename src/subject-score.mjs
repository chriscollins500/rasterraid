export const subjectVectorSize = 768;
const grid = 7;
const regions = grid * grid;
const patchesPerSide = grid * 2;
const supportCount = 12;

export function subjectScore(matches, exclusions) {
  const positive = matches.length === 1 ? matches[0] :
    .75 * matches.reduce((sum, value) => sum + value, 0) / matches.length + .25 * Math.min(...matches);
  return positive - .55 * Math.max(0, ...exclusions);
}

export function poolSubjectRegions(patches) {
  if (!(patches instanceof Float32Array) || patches.length !== patchesPerSide ** 2 * subjectVectorSize) {
    throw new Error('Unexpected region descriptor size.');
  }
  const pooled = new Float32Array(regions * subjectVectorSize);
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const start = (y * grid + x) * subjectVectorSize;
      const top = (2 * y * patchesPerSide + 2 * x) * subjectVectorSize;
      const bottom = top + patchesPerSide * subjectVectorSize;
      let squared = 0;
      for (let channel = 0; channel < subjectVectorSize; channel++) {
        const value = patches[top + channel] + patches[top + subjectVectorSize + channel] +
          patches[bottom + channel] + patches[bottom + subjectVectorSize + channel];
        pooled[start + channel] = value;
        squared += value * value;
      }
      if (!Number.isFinite(squared)) throw new Error('Invalid region descriptor.');
      const norm = Math.sqrt(squared) || 1;
      for (let channel = 0; channel < subjectVectorSize; channel++) pooled[start + channel] /= norm;
    }
  }
  return pooled;
}

export function sceneSubjectSimilarity(whole, reference, candidate) {
  // Keep a near-duplicate view ahead of a different view with similar regions.
  if (whole >= .90) return 2 + whole;
  const left = new Float32Array(regions).fill(-1);
  const right = new Float32Array(regions).fill(-1);
  for (let i = 0; i < regions; i++) {
    const first = i * subjectVectorSize;
    for (let j = 0; j < regions; j++) {
      const next = j * subjectVectorSize;
      let dot = 0;
      for (let channel = 0; channel < subjectVectorSize; channel++) dot += reference[first + channel] * candidate[next + channel];
      left[i] = Math.max(left[i], dot);
      right[j] = Math.max(right[j], dot);
    }
  }
  left.sort();
  right.sort();
  let support = 0;
  for (let region = regions - supportCount; region < regions; region++) support += left[region] + right[region];
  return support / (2 * supportCount);
}
