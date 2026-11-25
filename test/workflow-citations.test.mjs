import assert from 'node:assert/strict';
import test from 'node:test';
import { aiServiceLink } from '../src/ai-services.mjs';
import { reportSynthesisPlan } from '../src/report-research.mjs';
import { workflowEvidenceText, workflowNoteParts, workflowSourceLookup } from '../src/workflow-citations.mjs';
import { workflowReportMarkdown } from '../src/workflow-results-view.js';

const origin = 'https://civitai.red';
const release = { title: 'DreamShaper · v8', link: origin + '/models/4384?modelVersionId=128713&fileId=9' };
const preview = { title: 'Example picture', link: origin + '/images/91402089' };
const scene = { title: 'Selected moment', link: origin + '/images/10?t=11' };
const service = { title: 'Chat service', link: aiServiceLink('chatCompletion/test/model') };
const sources = [release, preview, scene, service];
const run = {
  origin, title: 'Review the exact releases', workflowId: '1-citations-fixture',
  status: 'succeeded', quote: { total: 6, authorFee: 0 },
  sources, steps: [{ name: 'report_brief', $type: 'chatCompletion' }],
};

test('a verified note cites the exact saved source through punctuation and equivalent catalog routes', () => {
  const alternative = 'https://civitai.com/models/4384/dreamshaper?modelVersionId=128713&fileId=9';
  const line = 'Try [release](<' + alternative + '>), view ' + preview.link + '—then check <' + scene.link + '> and ' + service.link + '.';
  assert.deepEqual(workflowNoteParts(line, workflowSourceLookup(run)), [
    'Try ', release, ', view ', preview, '—then check ', scene, ' and ', service, '.',
  ]);
  assert.deepEqual(workflowNoteParts('**' + preview.link + '**', workflowSourceLookup(run)), ['**', preview, '**']);
});

test('different files, releases, times, and destinations never receive verified source links', () => {
  const find = workflowSourceLookup(run);
  for (const url of [
    release.link.replace('fileId=9', 'fileId=10'), release.link.replace('fileId=9', 'fileId=9&tracking=1'),
    release.link.replace('128713', '128714'), origin + '/models/4384',
    scene.link.replace('t=11', 't=12'), preview.link + '#comment-1',
    'https://civitai.red.example.test/images/91402089', 'https://name@civitai.red/images/91402089',
    'http://civitai.red/images/91402089', 'www.example.test',
  ]) assert.deepEqual(workflowNoteParts(url, find), ['Unverified source link'], url);
  const alternate = { ...preview, link: origin + '/images/91402089/alternate' };
  const ambiguous = workflowSourceLookup({ origin, sources: [preview, alternate] });
  assert.equal(ambiguous(preview.link), preview);
  assert.equal(ambiguous('https://civitai.com/images/91402089'), null);
});

test('exports link verified evidence and follow-up synthesis uses those same sources', () => {
  const unverified = origin + '/models/4384?modelVersionId=999999';
  const note = 'Open ![linked release](' + release.link + '). [More context](' + unverified + ').';
  const snapshot = { steps: [
    { name: 'report_brief', $type: 'chatCompletion', status: 'succeeded', lines: [note] },
    { name: 'transcript', $type: 'transcription', status: 'succeeded', transcriptScope: 'timed', lines: ['0:00 · Spoken words.'] },
  ], text: ['[https://elsewhere.example](https://unlisted.example).'] };
  const markdown = workflowReportMarkdown([{ run, snapshot }]);
  assert.ok(markdown.includes('\\![DreamShaper · v8](<' + release.link + '>)'));
  assert.ok(markdown.includes('More context (unverified source link)'));
  assert.ok(markdown.includes('0:00 · Spoken words.'));
  for (const address of [unverified, 'https://elsewhere.example', 'https://unlisted.example']) assert.ok(!markdown.includes(address));
  assert.equal(workflowEvidenceText(note, workflowSourceLookup(run)), 'Open !' + release.link + '. More context (unverified source link).');
  const [step] = reportSynthesisPlan(run, snapshot).body.steps;
  const previous = JSON.parse(step.input.messages[1].content).previousResearch;
  assert.ok(previous[0].notes.includes(release.link));
  assert.ok(!JSON.stringify(previous).includes(unverified));
  assert.equal(previous[1].notes, '0:00 · Spoken words.');
  assert.equal(previous[2].notes, 'Unverified source link.');
  const restricted = workflowReportMarkdown([{ run, snapshot: { ...snapshot, restricted: true } }]);
  assert.ok(!restricted.includes(release.link));
  assert.ok(!restricted.includes('Unverified source link'));
});
