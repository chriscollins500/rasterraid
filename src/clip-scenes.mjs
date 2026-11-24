import { clipAnalysisUrl } from './catalog.mjs';
import { sampleMediaByPost } from './gallery.mjs';
import { createSoundDecoder, decodeExactPublicSound, describeSound, scoreSound } from './sound-analysis.mjs';
import { samplePublicScene, visualRoles, visualScorer } from './visual-analysis.mjs';
import { minimumMotionScore, motionSimilarity } from './video-motion.mjs';

const soundSeconds = 2;
const candidateLimit = 6;
const minimumAppearance = .58;
const minimumSound = .65;

function alignedSound({ sound, seconds, span, stream }) {
  return sound && sound.stream === stream && sound.exactStart <= seconds && sound.exactStart + sound.duration >= seconds + span;
}

export function planClipScene(windows) {
  const motion = windows.some(window => window.motion);
  const sound = windows.some(alignedSound);
  const signals = ['appearance', ...(motion ? ['motion'] : []), ...(sound ? ['sound'] : [])];
  const anchors = windows.filter(window => window.appearance && (!motion || window.motion) && (!sound || alignedSound(window))).map(window => ({
    ...window, scoreAppearance: visualScorer(Object.keys(visualRoles).map(role => ({ role, features: window.appearance }))),
  }));
  return { signals, anchors };
}

export function bestClipScene(plan, windows, { includeSound = true } = {}) {
  const motion = plan.signals.includes('motion');
  const sound = includeSound && plan.signals.includes('sound');
  let best;
  for (const anchor of plan.anchors) for (const window of windows) {
    if (!window.appearance || motion && !window.motion || sound && !alignedSound(window)) continue;
    const appearance = anchor.scoreAppearance(window.appearance).score;
    const movement = motion ? motionSimilarity(anchor.motion, window.motion) : null;
    if (appearance < minimumAppearance || motion && movement < minimumMotionScore) continue;
    const audio = sound ? scoreSound(['texture', 'dynamics'].map(role => ({ role, features: anchor.sound })), window.sound).score : null;
    if (sound && audio < minimumSound) continue;
    const scores = { appearance, ...(motion && { motion: movement }), ...(sound && { sound: audio }) };
    const values = Object.values(scores);
    const score = values.reduce((product, value) => product * value, 1) ** (1 / values.length);
    if (best && score <= best.score) continue;
    const start = sound ? window.sound.exactStart : Math.max(0, window.seconds - .35);
    const end = sound ? start + window.sound.duration : Math.min(window.videoDuration, start + 1.6);
    best = { score, scores, start, end, seconds: window.seconds, referenceSeconds: anchor.seconds, stream: window.stream };
  }
  return best;
}

async function readAlignedSound(windows, decode, budget, signal, fetcher) {
  const first = windows[0];
  if (!first || !decode || budget.remaining <= 0) return windows;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
  try {
    const audio = await decodeExactPublicSound(first.stream, decode, deadline, budget, fetcher);
    if (Math.abs(audio.duration - first.videoDuration) > Math.max(.2, first.videoDuration * .01)) return windows;
    const measured = [];
    for (const window of windows) {
      if (window.stream !== first.stream) continue;
      const centered = window.seconds + (window.span - soundSeconds) / 2;
      const start = Math.min(centered, audio.duration - soundSeconds);
      const features = await describeSound(audio, start, { signal: deadline, windowSeconds: soundSeconds });
      measured.push({ ...window, ...(features && { sound: { ...features, stream: first.stream } }) });
    }
    return measured;
  } catch {
    signal.throwIfAborted();
    return windows;
  }
}

export async function compareClipScenes(reference, items, { document = globalThis.document, signal, fetcher,
  onPhase = () => {}, onCandidates } = {}) {
  signal?.throwIfAborted();
  const eligible = items.filter(item => item.video && !item.audio && clipAnalysisUrl(item.stream));
  const state = { eligible: eligible.length, sampled: 0, soundChecked: 0, matched: 0, signals: [] };
  const result = (status, rows = items) => ({ items: rows, compared: 0, sampled: 0, scene: { ...state, status } });
  if (!document || !clipAnalysisUrl(reference.stream)) return result('unavailable');
  if (!eligible.length) return result('no-candidates');
  onCandidates?.(result('checking'));
  const deadline = AbortSignal.timeout(20_000);
  const end = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const budget = { remaining: 24 * 1024 * 1024 };
  let decode;
  try { decode = createSoundDecoder(document.defaultView); } catch { /* Appearance and motion can still be compared. */ }
  onPhase('Reading short scenes in the reference clip…');
  const frames = await samplePublicScene(document, reference.stream, end).catch(() => []);
  signal?.throwIfAborted();
  if (!frames.length) return result('unavailable');
  const source = await readAlignedSound(frames, decode, budget, end, fetcher).catch(() => frames);
  signal?.throwIfAborted();
  const plan = planClipScene(source);
  state.signals = plan.signals;
  if (plan.signals.length < 2) return result('picture-only');
  if (!plan.anchors.length) return result('separate');
  state.referenceStream = plan.anchors[0].stream;
  const withSound = plan.signals.includes('sound');
  const matches = new Map();
  const ranked = () => items.map(item => matches.has(item.id) ? { ...item, sceneMatch: matches.get(item.id) } : item)
    .sort((a, b) => (b.sceneMatch?.score ?? 0) - (a.sceneMatch?.score ?? 0));
  const sample = sampleMediaByPost(eligible, candidateLimit);
  for (let start = 0; start < sample.length && !end.aborted; start += 2) {
    onPhase('Comparing short scenes in ' + sample.length + (sample.length === 1 ? ' clip…' : ' clips…'));
    await Promise.allSettled(sample.slice(start, start + 2).map(async item => {
      const windows = await samplePublicScene(document, item.stream, end);
      if (!windows.length) return;
      state.sampled++;
      const visual = bestClipScene(plan, windows, { includeSound: false });
      if (!visual) return;
      if (!withSound) {
        matches.set(item.id, visual);
        return;
      }
      const combined = await readAlignedSound(windows, decode, budget, end, fetcher);
      if (combined.some(alignedSound)) state.soundChecked++;
      const match = bestClipScene(plan, combined);
      if (match) matches.set(item.id, match);
    }));
    signal?.throwIfAborted();
    if (matches.size > state.matched && start + 2 < sample.length && !end.aborted) {
      state.matched = matches.size;
      onCandidates?.(result('checking', ranked()));
    }
  }
  state.matched = matches.size;
  return result(state.sampled ? 'complete' : 'unavailable', ranked());
}
