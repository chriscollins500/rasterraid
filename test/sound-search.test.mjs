import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePublicSound, describeSound, rankSoundMatches, scoreSound, soundWindows } from '../src/sound-analysis.mjs';
import { soundCandidates, soundResearch } from '../src/sound-research.mjs';
import { researchOutput } from '../src/workflow-session.mjs';

const origin = 'https://civitai.red';
const cdn = 'https://image.civitai.com/example/';
const tracks = [11, 12].map((id, i) => ({ title: 'Public recording ' + id, link: origin + '/images/' + id,
  stream: cdn + id + (i ? '.mp3' : '.mp4'), group: i ? 'audio' : 'audioExamples', music: true, video: i === 0 }));
const signal = new AbortController().signal;
const immediate = { yieldTask: async () => {} };

function tone({ tempo = 92, frequency = 380, sustain = .32, gain = .6, seconds = 8 } = {}) {
  const sampleRate = 16000;
  const length = sampleRate * seconds;
  const samples = Float32Array.from({ length }, (_, index) => {
    const t = index / sampleRate;
    const position = (t * tempo / 60) % 1;
    const shape = Math.min(1, position * 50) * Math.max(0, 1 - position / sustain);
    return gain * shape * Math.sin(2 * Math.PI * frequency * t);
  });
  const opposite = samples.map(value => -value);
  return { sampleRate, length, duration: seconds, numberOfChannels: 2, getChannelData: channel => channel ? opposite : samples };
}

test('three independent sound cues beat the input order and gain or antiphase stereo preserves the match', async () => {
  const [pulse, noise, energy, right, fast, bright, sustained] = await Promise.all([
    tone({ frequency: 780 }), tone({ frequency: 3250 }), tone({ frequency: 500 }), tone({ gain: .3 }),
    tone({ tempo: 155 }), tone({ frequency: 3250 }), tone({ sustain: .95 }),
  ].map(audio => describeSound(audio, 0, immediate)));
  assert.ok(right.waveform.some(x => x > .9));
  assert.ok(scoreSound([{ role: 'texture', features: right }], await describeSound(tone(), 0, immediate)).score > .99);
  const references = [{ role: 'rhythm', features: pulse }, { role: 'texture', features: noise, avoid: true }, { role: 'dynamics', features: energy }];
  const rows = [fast, bright, sustained, right].map((features, index) => ({ item: index, windows: [features] }));
  assert.equal(rankSoundMatches(references, rows)[0].item, 3);
  assert.ok(scoreSound(references, right).cues.every(cue => cue.score > .75));
  assert.ok(scoreSound(references, fast).cues[0].score < .75);
  assert.ok(scoreSound(references, bright).cues[1].score < .1);
  assert.ok(scoreSound(references, sustained).cues[2].score < .75);
});

test('quiet audio is omitted and a selected excerpt stays bounded to the recording', async () => {
  assert.equal(await describeSound(tone({ gain: 0 }), 0, immediate), null);
  const windows = await soundWindows(tone({ seconds: 24 }), immediate);
  assert.deepEqual(windows.map(row => [row.start, row.duration]), [[0, 8], [4, 8], [8, 8], [12, 8], [16, 8]]);
  const controller = new AbortController();
  await assert.rejects(describeSound(tone(), 0, { signal: controller.signal, yieldTask: async () => controller.abort() }), { name: 'AbortError' });
});

test('sound reads use anonymous CDN media and reject signed, off-host and over-budget responses', async () => {
  const make = (url, body, headers) => Object.defineProperty(new Response(body, { headers }), 'url', { value: url });
  const decode = async data => [...new Uint8Array(data)];
  const media = tracks[1].stream;
  const result = await decodePublicSound(media, decode, signal, { remaining: 8 }, async (url, init) => {
    assert.equal(url, media);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    return make('https://blobs-b2.civitai.com/' + '12.mp3', Uint8Array.of(1, 2), { 'content-type': 'audio/mpeg' });
  });
  assert.deepEqual(result, [1, 2]);
  for (const url of [media + '?private=fixture', 'https://example.org/a.mp3']) {
    await assert.rejects(decodePublicSound(url, decode, signal, { remaining: 8 }, () => assert.fail('No fetch expected')), /outside the Civitai/u);
  }
  await assert.rejects(decodePublicSound(media, decode, signal, { remaining: 1 }, async url =>
    make(url, Uint8Array.of(1, 2), { 'content-type': 'audio/mpeg' })), /limit reached/u);
  await assert.rejects(decodePublicSound(media, decode, signal, { remaining: 8 }, async () =>
    make('https://example.org/a.mp3', Uint8Array.of(1, 2), { 'content-type': 'audio/mpeg' })), /unavailable/u);
});

test('paid sound plans use chosen public URLs, timestamped source evidence, and the accepted frame reference', () => {
  const mixed = [...tracks,
    { ...tracks[0], link: 'https://civitai.com/images/31' },
    { ...tracks[0], link: origin + '/images/32', stream: cdn + '32.mp3?private=fixture' },
    { ...tracks[0], link: origin + '/images/33', group: 'libraryMedia' },
  ];
  const report = { report: { evidence: mixed } };
  const available = soundCandidates(report, {}, origin);
  assert.equal(available.length, 2);
  assert.deepEqual(soundCandidates({ ...report, library: {} }, {}, origin), []);
  const picks = available.map(({ link }, index) => ({ link, seconds: 62.27 + index, name: 'private-reference-canary.wav' }));
  const research = soundResearch(available, [...picks, { link: mixed.at(-1).link, seconds: 0 }], origin);
  assert.deepEqual(research.plans.map(plan => [plan.id, plan.body.steps.length]), [['soundwords', 1], ['soundnotes', 4], ['soundscene', 6]]);
  const scene = research.plans.at(-1);
  assert.equal(scene.body.steps[0].input.startTime, 62.3);
  assert.deepEqual(scene.body.steps[1].input.mediaUrl, { $ref: 'sound_frame', path: 'output.frames[0].url' });
  assert.equal(scene.stepEvidence.sound_scene.sourceLink, tracks[0].link);
  assert.equal(scene.stepEvidence.sound_scene.seconds, 62.3);
  assert.equal(scene.stepEvidence.sound_description_2.sourceLink, tracks[1].link);
  assert.equal(scene.dependentInputs, true);
  assert.doesNotMatch(JSON.stringify(research), /private|canary/u);
});

test('recovered sound captions preserve documented string tempo and related musical estimates', () => {
  const step = { name: 'sound_description_1', $type: 'audioCaptioning', sourceLink: tracks[0].link };
  const run = { steps: [step], status: 'succeeded' };
  const output = { hasAudio: true, results: { sample: { text: 'Light percussion and keys.', bpm: '104', keyScale: 'D minor',
    timeSignature: '4/4', language: 'English', lyrics: 'The lights came on.' } } };
  const observed = (result) => researchOutput({ steps: [{ ...step, status: 'succeeded', output: result }] }, run).steps[0];
  assert.equal(observed(output).sourceLink, tracks[0].link);
  assert.deepEqual(observed(output).lines, ['Light percussion and keys.',
    'Estimated 104 BPM · Key D minor · Time signature 4/4 · Language English', 'Possible lyric excerpt · The lights came on.']);
  assert.deepEqual(observed({ hasAudio: false }).lines, ['Civitai reported that the clip has no audio track.']);
});
