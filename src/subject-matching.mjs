import { loadPublicPreview } from './visual-analysis.mjs';
import { subjectSide } from './subject-artifacts.mjs';

export function subjectMatchAvailable() {
  return Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle && globalThis.navigator?.gpu &&
    typeof Worker === 'function' && typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function');
}

async function previewPixels(document, { id, cover }, signal) {
  const image = await loadPublicPreview(document, cover, signal);
  signal.throwIfAborted();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = subjectSide;
  const drawing = canvas.getContext('2d', { alpha: false });
  drawing.imageSmoothingQuality = 'high';
  drawing.drawImage(image, 0, 0, subjectSide, subjectSide);
  return { id, rgba: drawing.getImageData(0, 0, subjectSide, subjectSide).data };
}

function matchInWorker(rows, signal, onProgress) {
  const module = new URL('./subject-worker.mjs', import.meta.url).href;
  // Civitai's scripts-only frame has an opaque origin. Its worker starts from a fixed module import.
  const entry = 'data:text/javascript;charset=utf-8,' + encodeURIComponent('import ' + JSON.stringify(module) + ';');
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(entry, { name: 'RasterRaid subject match', type: 'module' });
    const ids = new Set(rows.slice(1).map(row => row.id));
    const finish = (callback, value) => {
      signal.removeEventListener('abort', canceled);
      worker.terminate();
      callback(value);
    };
    const canceled = () => finish(reject, signal.reason);
    const failed = () => finish(reject, new Error('Subject matching is unavailable right now.'));
    signal.addEventListener('abort', canceled, { once: true });
    worker.addEventListener('error', failed, { once: true });
    worker.addEventListener('messageerror', failed, { once: true });
    worker.addEventListener('message', ({ data }) => {
      if (['loading', 'matching'].includes(data?.phase)) {
        onProgress(data.phase);
        return;
      }
      if (data?.phase === 'unavailable') {
        finish(reject, new Error('This device has no compatible browser GPU for subject matching.'));
      } else if (data?.phase === 'complete' && Array.isArray(data.matches) && data.matches.length === ids.size &&
          data.matches.every(row => Number.isFinite(row?.score) && ids.delete(row.id))) {
        finish(resolve, data.matches);
      } else failed();
    });
    try {
      worker.postMessage(rows, rows.map(row => row.rgba.buffer));
    } catch {
      failed();
    }
  });
}

export async function rankPreviewSubjects(document, { reference, sample }, { signal, onProgress }) {
  if (!subjectMatchAvailable()) throw new Error('Subject matching needs a compatible browser GPU.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(85_000)]);
  const [anchor, ...pictures] = await Promise.allSettled([reference, ...sample].map(item => previewPixels(document, item, deadline)));
  deadline.throwIfAborted();
  if (anchor.status !== 'fulfilled') throw new Error('The reference preview could not be read.');
  const candidates = pictures.flatMap(row => row.status === 'fulfilled' ? [row.value] : []);
  if (!candidates.length) throw new Error('The related previews could not be read.');
  return matchInWorker([anchor.value, ...candidates], deadline, onProgress);
}
