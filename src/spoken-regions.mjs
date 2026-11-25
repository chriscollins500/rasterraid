export const speechRate = 16_000;

export function spokenRegions(samples) {
  const block = speechRate / 50;
  const minimumGap = speechRate * 1.2;
  const regions = [];
  let start = -1;
  let lastVoice = 0;
  const flush = () => {
    if (start >= 0 && lastVoice - start >= speechRate * 0.16) {
      regions.push({ start, from: Math.max(0, start - speechRate * 0.10),
        through: Math.min(samples.length, lastVoice + speechRate * 0.17) });
    }
    start = -1;
  };
  for (let first = 0; first + block <= samples.length; first += block) {
    let squared = 0;
    for (let i = first; i < first + block; i++) squared += samples[i] * samples[i];
    if (squared / block >= 0.000081) {
      if (start < 0) start = first;
      lastVoice = first + block;
    } else if (start >= 0 && first - lastVoice >= minimumGap) flush();
  }
  flush();
  return regions;
}
