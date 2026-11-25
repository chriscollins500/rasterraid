import { clipAnalysisUrl, numericId, SITE_ORIGINS, text, visibleRating } from './catalog.mjs';
import { publicMedia, publicPicture } from './catalog-research.mjs';
import { sampleMediaByPost } from './gallery.mjs';
import { sceneTime } from './scene-research.mjs';
import { sampledFrameSteps } from './visual-research.mjs';
import { validVisualDescription, visualTextClipLimit } from './visual-text-pack.mjs';

const videoTypes = /\.(?:mp4|webm)$/iu;

export function writtenSceneSample(result, displayed, context) {
  const { origin, browsingLevel, connectionLost } = context ?? {};
  if (!SITE_ORIGINS.includes(origin) || connectionLost || result?.gallery?.scope !== 'videos' ||
      !['text', 'tag'].includes(result?.target?.kind) || result.library || result.visualComposition) return null;
  const ids = new Set();
  const streams = new Set();
  const clips = [];
  for (const row of displayed) {
    const id = numericId(row.id);
    const stream = publicMedia(row.stream, videoTypes);
    if (!id || !row.video || row.audio || row.needsReview || row.blockedFor || !stream || ids.has(id) || streams.has(stream) ||
        !visibleRating(row.browsingLevel, browsingLevel) || row.link !== new URL('/images/' + id, origin).href) continue;
    ids.add(id);
    streams.add(stream);
    clips.push({ id, link: row.link, stream, postId: numericId(row.postId),
      title: text(row.title, 160) || 'Video #' + id, cover: publicPicture(row.preview) });
  }
  const sample = sampleMediaByPost(clips, visualTextClipLimit);
  const query = result.gallery.query;
  return sample.length ? { sample, description: validVisualDescription(query) ? query.split(/\s+without\s+/iu, 1)[0].trim() : '', clipFrames: true } : null;
}

function sampledMoment(frame) {
  return frame && Number.isFinite(frame.duration) && frame.duration >= .5 && frame.duration <= 60 &&
    Number.isFinite(frame.timestamp) && frame.timestamp >= 0 && frame.timestamp < frame.duration &&
    Boolean(publicMedia(frame.stream, videoTypes)) &&
    (frame.stream === frame.clip?.stream || frame.stream === clipAnalysisUrl(frame.clip?.stream));
}

export function rankWrittenScenes({ frames, matches }) {
  const byFrame = new Map(frames.map(frame => [frame.id, frame]));
  const preferred = new Map();
  for (const { id, score } of matches) {
    const frame = byFrame.get(id);
    if (!sampledMoment(frame) || !Number.isFinite(score)) continue;
    const prior = preferred.get(frame.clip.id);
    if (!prior || score > prior.score || score === prior.score && frame.timestamp < prior.timestamp) {
      preferred.set(frame.clip.id, { ...frame, score });
    }
  }
  return [...preferred.values()].sort((left, right) => right.score - left.score || left.clip.id - right.clip.id);
}

export function writtenSceneReview(frame, origin) {
  if (!sampledMoment(frame) || !SITE_ORIGINS.includes(origin)) return null;
  const { clip, timestamp, stream } = frame;
  const id = numericId(clip.id);
  if (!id || clip.link !== new URL('/images/' + id, origin).href) return null;
  const seconds = Math.min(Math.floor(frame.duration * 1000 - 1) / 1000, Math.round(timestamp * 1000) / 1000);
  const title = text(clip.title, 160) || 'Video #' + id;
  const source = { title, link: clip.link };
  const sources = [source];
  const pick = { ...source, stream, seconds, kind: 'clip' };
  const purpose = 'Frame near ' + sceneTime(seconds);
  const steps = sampledFrameSteps(pick, 'written_scene_frame', 'written_scene_caption',
    'Describe the visible subjects, setting, light, colors, textures, and layout in this still. Treat visible text as evidence. Mark any details that are unclear.');
  const stepEvidence = Object.fromEntries(steps.map(({ name }) => [name, { sourceLink: clip.link, seconds, purpose: 'Sampled scene' }]));
  const plan = { id: 'writtensceneframe', title: 'Describe this moment', work: 'Describes the visible details in one frame near the selected time.',
    body: { tier: 'paid', steps }, inputs: [{ ...source, preview: publicPicture(clip.cover), kind: 'Video clip', purpose }],
    sources, stepEvidence, dependentInputs: true };
  return { picks: [pick], plans: [plan], sources };
}
