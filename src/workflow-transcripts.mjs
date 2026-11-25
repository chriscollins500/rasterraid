import { text } from './catalog.mjs';
import { workflowIdBelongsToViewer } from './workflow-client.mjs';
import { writtenSoundSeconds, writtenSoundWindow } from './written-sound.mjs';

export const transcriptBatchSize = 6;
export const transcriptSessionLimit = 24;
const phraseLimit = 12;
const resultLimit = 12;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const normalizeWord = word => word.normalize('NFKC').toLowerCase();
const sceneWordsPrefix = 'scene_words_';

function sceneWordRange(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start &&
    end <= writtenSoundSeconds && end - start <= writtenSoundWindow
    ? { start, end } : null;
}

export function sceneTranscriptStepName(start, end) {
  // The stable step name carries the interval even when Civitai history is
  // available without RasterRaid's local receipt.
  if (!sceneWordRange(start, end)) return null;
  const first = Math.ceil(start * 1000);
  const last = Math.floor(end * 1000);
  return first < last ? sceneWordsPrefix + first + '_' + last : null;
}

export const isSceneTranscript = step => step?.$type === 'transcription' && typeof step.name === 'string' &&
  step.name.startsWith(sceneWordsPrefix);

function sceneTranscriptRange(name) {
  const match = /^scene_words_(0|[1-9]\d{0,4})_([1-9]\d{0,4})$/u.exec(name);
  return match && sceneWordRange(Number(match[1]) / 1000, Number(match[2]) / 1000);
}

function sceneWordClock(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const second = String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0');
  const fraction = String(milliseconds % 1000).padStart(3, '0').replace(/0+$/u, '');
  return Math.floor(milliseconds / 60_000) + ':' + second + (fraction ? '.' + fraction : '');
}

export function sceneTranscriptLabel(name) {
  const range = sceneTranscriptRange(name);
  return range ? 'Speech at ' + sceneWordClock(range.start) + '–' + sceneWordClock(range.end) : 'Speech in the match';
}

export function sceneTranscriptEvidence(output, name) {
  const range = sceneTranscriptRange(name);
  const unavailable = { scope: 'untimed-window', lines: [] };
  if (!range) return unavailable;
  if (output?.hasAudio === false) return { scope: 'silent', lines: [] };
  const rows = output?.timeStamps;
  if (!Array.isArray(rows) || rows.length > 2048) return unavailable;
  const timed = rows.flatMap(row => {
    const { startTime, endTime } = row ?? {};
    const value = text(row?.text, 120).replace(/\s+/gu, ' ');
    return value && Number.isFinite(startTime) && startTime >= 0 && Number.isFinite(endTime) &&
      endTime >= startTime ? [{ startTime, endTime, value }] : [];
  });
  if (!timed.length && (rows.length || typeof output.text !== 'string' || text(output.text, 1))) return unavailable;
  const words = timed.filter(({ startTime, endTime }) => startTime >= range.start && startTime < range.end &&
    endTime <= range.end).sort((a, b) => a.startTime - b.startTime);
  if (!words.length) return { scope: 'empty-window', lines: [] };
  return { scope: 'timed', lines: [sceneWordClock(words[0].startTime) + ' · ' + words.map(row => row.value).join(' ').slice(0, 8000)] };
}

function tokens(value) {
  return Array.from(segmenter.segment(value)).flatMap(part => part.isWordLike ?
    [{ word: normalizeWord(part.segment), start: part.index, end: part.index + part.segment.length }] : []);
}

export { tokens as transcriptTokens };

function cues(step) {
  if (step.status !== 'succeeded' || step.$type !== 'transcription') return [];
  if (step.transcriptScope === 'clip') return step.lines.slice(0, 1).map(line => ({ value: text(line, 8_000), time: null }));
  if (step.transcriptScope !== 'timed') return [];
  return step.lines.slice(0, 32).flatMap(line => {
    const match = /^(\d{1,4}):([0-5]\d(?:\.\d{1,3})?) · (.+)$/su.exec(line);
    return match ? [{ value: text(match[3], 8_000), time: Number(match[1]) * 60 + Number(match[2]), clock: match[1] + ':' + match[2] }] : [];
  });
}

export function preparedTranscripts(run, snapshot) {
  if (!run?.workflowId || !snapshot || snapshot.restricted || snapshot.withheld) return null;
  const tracks = [];
  for (const step of snapshot.steps.slice(0, 8)) {
    const lines = cues(step);
    if (!lines.length) continue;
    const postings = new Map();
    const words = [];
    for (const [cue, { value }] of lines.entries()) {
      for (const part of tokens(value)) {
        if (!postings.has(part.word)) postings.set(part.word, []);
        postings.get(part.word).push(words.length);
        words.push({ ...part, cue });
      }
    }
    if (words.length) tracks.push({ lines, words, postings, source: run.sources.find(item => item.link === step.sourceLink) });
  }
  return tracks.length ? { run, snapshot, tracks } : null;
}

function excerpt(track, first, last) {
  const line = track.lines[first.cue];
  let value = line.value;
  let end = last.end;
  if (last.cue !== first.cue) {
    const next = track.lines[last.cue];
    const gap = next.time - line.time;
    // Allow a phrase to cross one nearby cue. Separate sentences and gaps do not establish continuity.
    if (last.cue !== first.cue + 1 || line.time === null || next.time === null || gap < 0 || gap > 6 ||
        /[.!?。！？]$/u.test(value)) return null;
    end += value.length + 1;
    value += ' ' + next.value;
  }
  const left = Math.max(0, first.start - 72);
  const right = Math.min(value.length, end + 72);
  return { before: (left ? '…' : '') + value.slice(left, first.start), phrase: value.slice(first.start, end),
    after: value.slice(end, right) + (right < value.length ? '…' : ''), clock: line.clock };
}

export function findTranscriptMatches(records, query) {
  const phrase = tokens(text(query, 180)).map(token => token.word);
  if (!phrase.length || phrase.length > phraseLimit) return { matches: [], count: 0, valid: false };
  const matches = [];
  const distinct = new Set();
  const ordered = [...records].filter(Boolean).sort((a, b) => (b.run.createdAt ?? 0) - (a.run.createdAt ?? 0));
  for (const record of ordered) for (const track of record.tracks) {
    const matchedCues = new Set();
    for (const offset of track.postings.get(phrase[0]) ?? []) {
      const first = track.words[offset];
      if (matchedCues.has(first.cue) || !phrase.every((word, index) => track.words[offset + index]?.word === word)) continue;
      const piece = excerpt(track, first, track.words[offset + phrase.length - 1]);
      if (!piece) continue;
      matchedCues.add(first.cue);
      const key = JSON.stringify([track.source?.link ?? record.run.workflowId, piece.clock, piece.before, piece.phrase, piece.after]);
      if (distinct.has(key)) continue;
      distinct.add(key);
      if (matches.length < resultLimit) matches.push({ ...piece, record, source: track.source });
    }
  }
  return { matches, count: distinct.size, valid: true };
}

export function canLoadTranscript(saved, run, context, simulated) {
  return Boolean(saved?.status === 'succeeded' && saved.receipt?.status === 'succeeded' && run.status === 'succeeded' &&
    (simulated || workflowIdBelongsToViewer(run.workflowId, context.viewerUserId)) &&
    run.steps.some(step => step.$type === 'transcription'));
}
