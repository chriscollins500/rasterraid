import { readVisualReferences } from '../src/visual-discovery.mjs';

export const publicVisualCues = [
  { id: 135405057, role: 'palette', polarity: 'prefer' },
  { id: 145616716, role: 'composition', polarity: 'prefer' },
  { id: 80205619, role: 'texture', polarity: 'avoid' },
];

export const visualBriefExample = { scope: 'gallery', query: 'dark lighthouse on a rocky coast' };
export const visualBriefCues = publicVisualCues.slice(1);

export async function publicVisualBrief(context, { galleryRead = readVisualReferences, cues = publicVisualCues, signal, fetcher } = {}) {
  const media = await galleryRead(context, cues.map(cue => cue.id), { signal, fetcher });
  const rows = new Map(media.map(item => [item.id, item]));
  return cues.map(({ id, role, polarity }) => {
    const item = rows.get(id);
    if (!item?.preview) throw new Error('The reference fixture is unavailable on ' + context.origin + '.');
    // This fixture reproduces the source pool and exact quote body without decoding pixels.
    return { label: (item.video ? 'Clip #' : 'Picture #') + id, mediaId: id,
      role, polarity, publicPreview: item.preview, features: { [role]: {} } };
  });
}
