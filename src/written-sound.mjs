export const writtenSoundRate = 32_000;
export const writtenSoundClipLimit = 4;
export const writtenSoundSeconds = 30;
export const writtenSoundWindow = 5;
export const writtenSoundMinimum = 1.5;
export const writtenSoundSampleLimit = writtenSoundRate * writtenSoundSeconds;
export const writtenSoundBudget = 24 * 1024 * 1024;
export const writtenSoundQueryLimit = 160;
const audiblePeak = .0002;

function cleanCue(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
}

function distinctCues(cues) {
  const unique = new Map();
  for (const cue of cues.map(cleanCue).filter(Boolean)) {
    const key = cue.toLowerCase();
    if (!unique.has(key)) unique.set(key, cue);
  }
  return [...unique.values()];
}

export function writtenSoundBrief(value, together = '', avoid = '') {
  const main = cleanCue(value);
  if (!main || /^without(?:\s|$)/iu.test(main) || [main, together, avoid].some(cue => cue?.length > writtenSoundQueryLimit)) return null;
  const [first, ...excluded] = main.split(/\s+without(?:\s+|$)/iu);
  if (excluded.some(cue => !cleanCue(cue))) return null;
  const brief = { required: distinctCues([first, together]), avoid: distinctCues([...excluded, avoid]) };
  return validWrittenSoundBrief(brief) ? brief : null;
}

export function validWrittenSoundBrief(brief) {
  const required = brief?.required;
  const avoid = brief?.avoid;
  return Array.isArray(required) && required.length >= 1 && required.length <= 2 &&
    Array.isArray(avoid) && avoid.length <= 2 && [...required, ...avoid].every(cue =>
      typeof cue === 'string' && cue.length <= writtenSoundQueryLimit && Boolean(cue.trim())) &&
    required.every(cue => !avoid.some(excluded => cue.toLowerCase() === excluded.toLowerCase()));
}

export function hasAudibleSound(samples) {
  return samples.some(sample => Math.abs(sample) > audiblePeak);
}

export function writtenSoundSamples(audio) {
  if (audio?.sampleRate !== writtenSoundRate || !audio.numberOfChannels) return null;
  const length = Math.min(audio.length, writtenSoundSampleLimit);
  const samples = audio.getChannelData(0).slice(0, length);
  if (audio.numberOfChannels > 1) {
    const right = audio.getChannelData(1);
    for (let index = 0; index < length; index++) samples[index] = (samples[index] + right[index]) * .5;
  }
  return samples;
}

export function writtenSoundWindows(samples) {
  const windows = [];
  const step = writtenSoundWindow * writtenSoundRate;
  for (let first = 0; first + writtenSoundMinimum * writtenSoundRate <= samples.length; first += step) {
    const last = Math.min(first + step, samples.length);
    const wave = samples.subarray(first, last);
    if (hasAudibleSound(wave)) windows.push({ start: first / writtenSoundRate, end: last / writtenSoundRate, wave });
  }
  return windows;
}

export function validWrittenSoundWindows(windows, brief, samples) {
  if (!Array.isArray(windows) || windows.length > writtenSoundSeconds / writtenSoundWindow) return false;
  const cueCount = brief.required.length + brief.avoid.length;
  const maxSeconds = samples / writtenSoundRate;
  return windows.every((row, index) => Number.isInteger(row?.start) && row.start >= 0 && row.start % writtenSoundWindow === 0 &&
    (index === 0 || row.start > windows[index - 1].start) && Number.isFinite(row.end) &&
    row.end === Math.min(row.start + writtenSoundWindow, maxSeconds) && row.end - row.start >= writtenSoundMinimum &&
    Array.isArray(row.scores) && row.scores.length === cueCount &&
    row.scores.every(score => Number.isFinite(score) && Math.abs(score) <= 1.001));
}

function combinedScores(windows, required) {
  const values = windows.map(window => window.scores);
  const means = values[0].map((_, index) => values.reduce((total, row) => total + row[index], 0) / values.length);
  const spread = means.map((mean, index) => Math.max(.000001, Math.sqrt(
    values.reduce((total, row) => total + (row[index] - mean) ** 2, 0) / values.length)));
  return values.map(row => {
    const centered = row.map((score, index) => (score - means[index]) / spread[index]);
    const needed = centered.slice(0, required);
    return Math.min(...needed) + .25 * (needed.reduce((total, value) => total + value, 0) / needed.length) -
      .5 * Math.max(0, ...centered.slice(required));
  });
}

export function rankWrittenSoundMatches(recordings, brief) {
  const windows = recordings.flatMap(({ item, rendition, checked }) => checked.map(window => ({ ...window, item, rendition })));
  if (!windows.length || !validWrittenSoundBrief(brief)) return [];
  const scores = brief.required.length === 1 && !brief.avoid.length
    ? windows.map(({ scores: values }) => values[0]) : combinedScores(windows, brief.required.length);
  const order = windows.map((window, index) => ({ ...window, score: scores[index] })).sort((a, b) => b.score - a.score);
  const unique = new Map();
  for (const match of order) if (!unique.has(match.item.link)) unique.set(match.item.link, match);
  return [...unique.values()];
}
