import { text } from './catalog.mjs';
import { workflowIdBelongsToViewer } from './workflow-client.mjs';

export const transcriptBatchSize = 6;
export const transcriptSessionLimit = 24;
const phraseLimit = 12;
const resultLimit = 12;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const normalizeWord = word => word.normalize('NFKC').toLowerCase();

function tokens(value) {
  return Array.from(segmenter.segment(value)).flatMap(part => part.isWordLike ?
    [{ word: normalizeWord(part.segment), start: part.index, end: part.index + part.segment.length }] : []);
}

function cues(step) {
  if (step.status !== 'succeeded' || step.$type !== 'transcription') return [];
  if (step.transcriptScope === 'clip') return step.lines.slice(0, 1).map(line => ({ value: text(line, 8_000), time: null }));
  if (step.transcriptScope !== 'timed') return [];
  return step.lines.slice(0, 32).flatMap(line => {
    const match = /^(\d{1,4}):([0-5]\d) · (.+)$/su.exec(line);
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
