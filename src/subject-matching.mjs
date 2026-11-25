import { mediaUrl } from './catalog.mjs';
import { loadPublicPreview, sampleWrittenClip, visualRegion } from './visual-analysis.mjs';
import { subjectCandidateLimit, subjectDownloadBytes, subjectReferenceLimit, subjectSide, subjectWasmAvailable } from './subject-artifacts.mjs';
import { resizePreview } from './resize-preview.mjs';
import { validVisualDescription, visualPackBytes, visualTextCandidateLimit, visualTextClipLimit } from './visual-text-pack.mjs';

const idleLifetime = 120_000;

export function subjectMatchAvailable() {
  return Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle && typeof Worker === 'function' &&
    typeof createImageBitmap === 'function' && subjectWasmAvailable());
}

export function visualTextMatchAvailable() {
  return subjectMatchAvailable() && typeof DecompressionStream === 'function' && typeof DataView.prototype.getFloat16 === 'function';
}

async function readPreview(cover, signal) {
  if (!cover || mediaUrl(cover) !== cover) throw new Error('This preview is outside Civitai’s media catalog.');
  const response = await fetch(cover, {
    credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache', signal,
  });
  if (!response.ok) throw new Error('The public preview is unavailable.');
  return response.blob();
}

async function previewPixels(document, { id, cover, file, region }, signal, visual) {
  signal.throwIfAborted();
  if (file && !(file instanceof Blob)) throw new Error('The local reference could not be read.');
  const previewSignal = file ? signal : AbortSignal.any([signal, AbortSignal.timeout(5500)]);
  const preview = file ?? await readPreview(cover, previewSignal);
  let previewUrl;
  let image;
  try {
    if (!visual && !file) {
      try {
        previewUrl = URL.createObjectURL(preview);
        image = await loadPublicPreview(document, previewUrl, previewSignal);
      } catch {
        // Some opaque-origin frames reject local image URLs. Decode the same bytes below.
        previewSignal.throwIfAborted();
      }
    }
    image ??= await createImageBitmap(preview, visual ? { colorSpaceConversion: 'none' } : undefined);
    previewSignal.throwIfAborted();
    const canvas = document.createElement('canvas');
    if (visual) {
      const { width, height } = image;
      if (!width || !height || width * height > 4_000_000) throw new Error('The preview is too large to compare.');
      canvas.width = width;
      canvas.height = height;
      const drawing = canvas.getContext('2d', { alpha: false });
      if (!drawing) throw new Error('This browser cannot compare pictures locally.');
      drawing.drawImage(image, 0, 0);
      return { id, rgba: resizePreview(drawing.getImageData(0, 0, width, height).data, width, height, subjectSide) };
    }
    canvas.width = canvas.height = subjectSide;
    const drawing = canvas.getContext('2d', { alpha: false });
    if (!drawing) throw new Error('This browser cannot compare pictures locally.');
    drawing.imageSmoothingQuality = 'high';
    const crop = visualRegion(region);
    if (crop) {
      const [left, top, right, bottom] = crop;
      drawing.drawImage(image, left * image.width, top * image.height, (right - left) * image.width, (bottom - top) * image.height,
        0, 0, subjectSide, subjectSide);
    } else drawing.drawImage(image, 0, 0, subjectSide, subjectSide);
    return { id, rgba: drawing.getImageData(0, 0, subjectSide, subjectSide).data };
  } finally {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    image?.close?.();
  }
}

function startWorker() {
  const module = new URL('./subject-worker.mjs', import.meta.url).href;
  // Civitai's scripts-only frame has an opaque origin. Its worker starts from a fixed module import.
  const entry = 'data:text/javascript;charset=utf-8,' + encodeURIComponent('import ' + JSON.stringify(module) + ';');
  return new Worker(entry, { name: 'RasterRaid subject match', type: 'module' });
}

function matchInWorker(worker, prepared, signal, onProgress, textPreparation) {
  return new Promise((resolve, reject) => {
    let ids;
    let paired = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', canceled);
      worker.removeEventListener('error', failed);
      worker.removeEventListener('messageerror', failed);
      worker.removeEventListener('message', received);
      callback(value);
    };
    const canceled = () => finish(reject, signal.reason);
    const failed = () => finish(reject, new Error('Subject matching is unavailable right now.'));
    const received = ({ data }) => {
      if (['loading', 'model-download'].includes(data?.phase) && Number.isSafeInteger(data.total) && data.total > 0 &&
          data.total <= (data.phase === 'model-download' ? visualPackBytes : subjectDownloadBytes) &&
          Number.isSafeInteger(data.loaded) && data.loaded >= 0 && data.loaded <= data.total) {
        onProgress(data);
        return;
      }
      if (['starting', 'matching', 'model-check'].includes(data?.phase)) {
        onProgress(data);
        return;
      }
      if (data?.phase === 'unavailable') {
        finish(reject, new Error('This browser cannot run the on-device model.'));
      } else if (data?.phase === 'model-pack-unavailable') {
        finish(reject, new DOMException('The visual model pack could not be verified or loaded.', 'NotReadableError'));
      } else if (data?.phase === 'complete' && ids && Array.isArray(data.matches) && data.matches.length === ids.size &&
          data.matches.every(row => Number.isFinite(row?.score) && (!paired || Number.isFinite(row.textScore)) && ids.delete(row.id))) {
        finish(resolve, data.matches);
      } else failed();
    };
    signal.addEventListener('abort', canceled, { once: true });
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    worker.addEventListener('message', received);
    if (signal.aborted) canceled();
    if (textPreparation && !settled) {
      let source;
      try {
        // Open the file in the frame that owns it. WebKit cannot read a Blob cloned into this worker.
        source = textPreparation.modelPack?.stream();
        worker.postMessage({ type: 'prepare-text', ...(source && { modelPack: source }) }, source ? [source] : []);
      } catch {
        if (source && !source.locked) void source.cancel().catch(() => {});
        failed();
      }
    }
    prepared.then(pictures => {
      const rows = [...pictures.references, ...pictures.sample];
      if (settled) {
        for (const row of rows) row.rgba.fill(0);
        return;
      }
      try {
        ids = new Set(pictures.sample.map(row => row.id));
        paired = pictures.description !== undefined && pictures.references.length > 0;
        worker.postMessage(pictures, rows.map(row => row.rgba.buffer));
      } catch {
        for (const row of rows) if (row.rgba.byteLength) row.rgba.fill(0);
        failed();
      }
    }, error => {
      finish(reject, error);
    });
  });
}

async function preparePictures(document, references, sample, signal, description) {
  const visual = description !== undefined;
  const pictures = await Promise.allSettled([
    ...references.map(item => previewPixels(document, item, signal, false)),
    ...sample.map(item => previewPixels(document, item, signal, visual)),
  ]);
  const anchors = pictures.slice(0, references.length);
  const candidates = pictures.slice(references.length).flatMap(row => row.status === 'fulfilled' ? [row.value] : []);
  try {
    signal.throwIfAborted();
    if (anchors.some(row => row.status === 'rejected')) throw new Error('A selected reference preview could not be read.');
    if (candidates.length < (visual ? 2 : 1)) throw new Error('The related previews could not be read.');
    return { references: anchors.map(({ value }, index) => ({ rgba: value.rgba, polarity: references[index].polarity })),
      sample: candidates, ...(visual && { description }) };
  } catch (error) {
    for (const row of pictures) row.value?.rgba.fill(0);
    throw error;
  }
}

async function prepareClipPictures(document, clips, signal, description, onProgress) {
  const frames = [];
  const sample = [];
  const parallelClips = 2;
  const total = clips.length;
  for (let index = 0; index < total; index += parallelClips) {
    const batch = clips.slice(index, index + parallelClips);
    const captured = await Promise.allSettled(batch.map(clip => sampleWrittenClip(document, clip.stream, signal)));
    signal.throwIfAborted();
    for (const [offset, reply] of captured.entries()) {
      if (reply.status !== 'fulfilled') continue;
      for (const frame of reply.value) {
        try {
          const { width, height } = frame.preview;
          const pixels = frame.preview.getContext('2d').getImageData(0, 0, width, height);
          const id = sample.length + 1;
          sample.push({ id, rgba: resizePreview(pixels.data, width, height, subjectSide) });
          frames.push({ ...frame, id, clip: batch[offset] });
        } catch { /* This browser could play the clip without giving the app its pixels. */ }
      }
    }
    onProgress({ phase: 'sampling', done: Math.min(index + parallelClips, total), total });
  }
  if (!sample.length) {
    const posterClips = clips.filter(clip => clip.cover).map(clip => ({ ...clip, kind: 'Video poster' }));
    if (posterClips.length < 2) throw new Error('The loaded clips could not be sampled.');
    const comparison = await preparePictures(document, [], posterClips, signal, description);
    return { comparison, posterClips };
  }
  return { frames, comparison: { references: [], sample, description, clipFrames: true } };
}

export function createSubjectMatcher(document) {
  let worker;
  let active;
  let idleTimer;

  function release() {
    clearTimeout(idleTimer);
    active?.abort();
    active = undefined;
    worker?.terminate();
    worker = undefined;
  }

  document.defaultView.addEventListener('pagehide', release);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !active) release();
  });

  async function rank({ reference, references = reference ? [{ ...reference, polarity: 'prefer' }] : [], sample, description, modelPack,
    clipFrames = false }, { signal, onProgress }) {
    const visual = description !== undefined;
    const withReferences = !visual || references?.length > 0;
    if (active || !(visual ? visualTextMatchAvailable() : subjectMatchAvailable())) throw new Error('Subject matching is unavailable right now.');
    if (!Array.isArray(references) || !Array.isArray(sample) || sample.length < (visual && !clipFrames ? 2 : 1) ||
        sample.length > (clipFrames ? visualTextClipLimit : withReferences ? subjectCandidateLimit : visualTextCandidateLimit) ||
        clipFrames && (!visual || withReferences) ||
        visual && !validVisualDescription(description) ||
        withReferences && (references.length > subjectReferenceLimit || !references.every(row => row && ['prefer', 'avoid'].includes(row.polarity)) ||
          !references.some(row => row.polarity === 'prefer'))) {
      throw new Error('Choose a subject and a bounded sample.');
    }
    if (visual && modelPack != null && (!(modelPack instanceof Blob) || modelPack.size !== visualPackBytes)) {
      throw new DOMException('The visual model pack could not be verified or loaded.', 'NotReadableError');
    }
    const attempt = active = new AbortController();
    const deadline = AbortSignal.any([signal, attempt.signal, AbortSignal.timeout(visual ? 120_000 : 85_000)]);
    clearTimeout(idleTimer);
    try {
      deadline.throwIfAborted();
      worker ??= startWorker();
      const prepared = clipFrames
        ? prepareClipPictures(document, sample, deadline, description, onProgress)
        : preparePictures(document, references, sample, deadline, description).then(comparison => ({ comparison }));
      const matches = await matchInWorker(worker, prepared.then(({ comparison }) => comparison), deadline, onProgress, visual && { modelPack });
      const { frames, posterClips } = await prepared;
      deadline.throwIfAborted();
      active = undefined;
      if (document.hidden) release();
      else idleTimer = setTimeout(release, idleLifetime);
      return clipFrames ? { matches, frames, posterClips } : matches;
    } catch (error) {
      if (active === attempt) release();
      throw error;
    }
  }

  return { rank, release };
}
