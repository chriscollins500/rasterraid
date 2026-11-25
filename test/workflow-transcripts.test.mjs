import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canLoadTranscript, findTranscriptMatches, preparedTranscripts } from '../src/workflow-transcripts.mjs';

const origin = 'https://civitai.com';
const source = { title: 'Archive clip', link: origin + '/images/810' };
const record = { workflowId: '21-speech', title: 'Recording review', sources: [source], createdAt: 95, status: 'succeeded' };
const step = (lines, transcriptScope = 'timed', extra = {}) => ({
  $type: 'transcription', status: 'succeeded', transcriptScope, lines, sourceLink: source.link, ...extra,
});
const snapshot = steps => ({ steps, text: [] });

const cases = [
  ['case', 'paper print', [step(['0:00 · PAPER PRINT with colored ink'])], ['0:00', 'PAPER PRINT', source]],
  ['punctuation', 'soft focus', [step(['0:09 · Try soft-focus before cropping.'])], ['0:09', 'soft-focus', source]],
  ['time boundary', 'dark river', [step(['0:11 · We saw a dark', '0:15 · river at dusk'])], ['0:11', 'dark river', source]],
  ['short factual quote', 'crop', [step(['1:02 · Crop after seeing the result'])], ['1:02', 'Crop', source]],
  ['compatibility normalization', 'SDXL 1', [step(['0:07 · Use ＳＤＸＬ １ here'])], ['0:07', 'ＳＤＸＬ １', source]],
  ['Spanish', 'IMPRESIÓN ARTESANAL', [step(['0:18 · La impresión artesanal es lenta'])], ['0:18', 'impresión artesanal', source]],
  ['Japanese', '紙の質感', [step(['0:33 · 紙の質感が大切です'])], ['0:33', '紙の質感', source]],
  ['untimed', 'edge light', [step(['Keep the edge light soft'], 'clip')], [undefined, 'edge light', source]],
  ['provider-only excerpt', 'two brushes', [step(['0:22 · She used two brushes'], 'timed', { sourceLink: undefined })],
    ['0:22', 'two brushes', undefined]],
  ['word boundary', 'ink', [step(['0:03 · Pink light reflects across the room'])], null],
  ['timing gap', 'dark river', [step(['0:11 · We saw a dark', '0:30 · river at dusk'])], null],
  ['separate sentences', 'dark river', [step(['0:11 · The sky was dark.', '0:13 · River mist arrived later.'])], null],
  ['wrong sequence', 'paper river', [step(['0:00 · River paper moves in the water'])], null],
  ['different sources', 'dark river', [step(['0:04 · We saw a dark']),
    step(['0:07 · river at dusk'], 'timed', { sourceLink: origin + '/images/811' })], null],
  ['no timed evidence', '0 44', [step(['0:44 · I used red paint'])], null],
  ['false timestamp', 'Find ink', [step(['Visual guess · Find ink'])], null],
  ['failed step', 'wrong words', [step(['0:11 · wrong words'], 'timed', { status: 'failed' })], null],
  ['repetitive output', 'create an image', [step(['create an image'], 'repetitive')], null],
  ['only audio description', 'quiet room', [step(['quiet room'], 'clip', { $type: 'audioCaptioning' })], null],
];

test('finds spoken phrases and keeps the approved excerpt, time and source', () => {
  for (const [label, phrase, steps, expected] of cases) {
    const report = preparedTranscripts(record, snapshot(steps));
    const hit = findTranscriptMatches([report], phrase);
    assert.equal(hit.valid, true, label);
    assert.equal(hit.count, expected ? 1 : 0, label);
    if (expected) {
      const match = hit.matches[0];
      assert.deepEqual([match.clock, match.phrase, match.source], expected, label);
    }
  }
});

test('withheld outputs have no index and the automatic batch requires an owned successful receipt', () => {
  const steps = [step(['0:00 · print paper'])];
  assert.equal(preparedTranscripts(record, { ...snapshot(steps), withheld: 'Civitai withheld the words' }), null);
  assert.equal(preparedTranscripts(record, { ...snapshot(steps), restricted: true }), null);
  const run = { ...record, steps };
  const saved = { ...run, receipt: { status: 'succeeded', total: 3, authorFee: 0 } };
  const viewer = { viewerUserId: 21 };
  assert.equal(canLoadTranscript(saved, run, viewer, false), true);
  assert.equal(canLoadTranscript(saved, run, { viewerUserId: 22 }, false), false);
  assert.equal(canLoadTranscript({ ...saved, receipt: { status: 'pending' } }, run, viewer, false), false);
  assert.equal(canLoadTranscript({ ...saved, status: 'processing' }, run, viewer, false), false);
  assert.equal(canLoadTranscript(saved, { ...run, status: 'expired' }, viewer, false), false);
  assert.equal(canLoadTranscript(saved, { ...run, steps: [] }, viewer, false), false);
});

test('local results retain distinct times, prefer newer receipts for repeated evidence and bound output', () => {
  const steps = [step(Array.from({ length: 16 }, (_, index) => '0:' + String(index).padStart(2, '0') + ' · Repeated paper print'))];
  const latest = { ...record, workflowId: '21-new', createdAt: 99 };
  const docs = [preparedTranscripts(record, snapshot(steps)), preparedTranscripts(latest, snapshot(steps))];
  const result = findTranscriptMatches(docs, 'paper print');
  assert.equal(result.count, 16);
  assert.equal(result.matches.length, 12);
  assert.ok(result.matches.every(row => row.record.run === latest));
  assert.equal(findTranscriptMatches(docs, 'word '.repeat(13)).valid, false);
  assert.equal(findTranscriptMatches(docs, '?!').valid, false);
});

export { cases, record, snapshot };
