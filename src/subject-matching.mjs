import { visualRegion } from './visual-analysis.mjs';
import { subjectDownloadBytes, subjectSide, subjectWasmAvailable } from './subject-artifacts.mjs';

const idleLifetime = 120_000;

export function subjectMatchAvailable() {
  return Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle && typeof Worker === 'function' &&
    typeof createImageBitmap === 'function' && subjectWasmAvailable());
}

async function readPreview(cover, signal) {
  const response = await fetch(cover, {
    credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5500)]),
  });
  if (!response.ok) throw new Error('The public preview is unavailable.');
  return response.blob();
}

async function previewPixels(document, { id, cover, file, region }, signal) {
  signal.throwIfAborted();
  if (file && !(file instanceof Blob)) throw new Error('The local reference could not be read.');
  const image = await createImageBitmap(file ?? await readPreview(cover, signal));
  try {
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = subjectSide;
    const drawing = canvas.getContext('2d', { alpha: false });
    if (!drawing) throw new Error('This browser cannot compare pictures locally.');
    drawing.imageSmoothingQuality = 'high';
    const crop = file && visualRegion(region);
    if (crop) {
      const [left, top, right, bottom] = crop;
      drawing.drawImage(image, left * image.width, top * image.height, (right - left) * image.width, (bottom - top) * image.height,
        0, 0, subjectSide, subjectSide);
    } else drawing.drawImage(image, 0, 0, subjectSide, subjectSide);
    return { id, rgba: drawing.getImageData(0, 0, subjectSide, subjectSide).data };
  } finally {
    image.close();
  }
}

function startWorker() {
  const module = new URL('./subject-worker.mjs', import.meta.url).href;
  // Civitai's scripts-only frame has an opaque origin. Its worker starts from a fixed module import.
  const entry = 'data:text/javascript;charset=utf-8,' + encodeURIComponent('import ' + JSON.stringify(module) + ';');
  return new Worker(entry, { name: 'RasterRaid subject match', type: 'module' });
}

function matchInWorker(worker, prepared, signal, onProgress) {
  return new Promise((resolve, reject) => {
    let ids;
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
      if (data?.phase === 'loading' && Number.isSafeInteger(data.total) && data.total > 0 && data.total <= subjectDownloadBytes &&
          Number.isSafeInteger(data.loaded) && data.loaded >= 0 && data.loaded <= data.total) {
        onProgress(data);
        return;
      }
      if (data?.phase === 'starting' || data?.phase === 'matching') {
        onProgress(data);
        return;
      }
      if (data?.phase === 'unavailable') {
        finish(reject, new Error('This browser cannot run the on-device model.'));
      } else if (data?.phase === 'complete' && ids && Array.isArray(data.matches) && data.matches.length === ids.size &&
          data.matches.every(row => Number.isFinite(row?.score) && ids.delete(row.id))) {
        finish(resolve, data.matches);
      } else failed();
    };
    signal.addEventListener('abort', canceled, { once: true });
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    worker.addEventListener('message', received);
    prepared.then(rows => {
      if (settled) {
        for (const row of rows) row.rgba.fill(0);
        return;
      }
      try {
        ids = new Set(rows.slice(1).map(row => row.id));
        worker.postMessage(rows, rows.map(row => row.rgba.buffer));
      } catch {
        for (const row of rows) if (row.rgba.byteLength) row.rgba.fill(0);
        failed();
      }
    }, error => {
      finish(reject, error);
    });
    if (signal.aborted) canceled();
  });
}

async function preparePictures(document, { reference, sample }, signal) {
  const [anchor, ...pictures] = await Promise.allSettled([reference, ...sample].map(item => previewPixels(document, item, signal)));
  const candidates = pictures.flatMap(row => row.status === 'fulfilled' ? [row.value] : []);
  try {
    signal.throwIfAborted();
    if (anchor.status !== 'fulfilled') throw new Error('The reference preview could not be read.');
    if (!candidates.length) throw new Error('The related previews could not be read.');
    return [anchor.value, ...candidates];
  } catch (error) {
    anchor.value?.rgba.fill(0);
    for (const row of candidates) row.rgba.fill(0);
    throw error;
  }
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

  async function rank(selection, { signal, onProgress }) {
    if (active || !subjectMatchAvailable()) throw new Error('Subject matching is unavailable right now.');
    const attempt = active = new AbortController();
    const deadline = AbortSignal.any([signal, attempt.signal, AbortSignal.timeout(85_000)]);
    clearTimeout(idleTimer);
    try {
      deadline.throwIfAborted();
      worker ??= startWorker();
      const matches = await matchInWorker(worker, preparePictures(document, selection, deadline), deadline, onProgress);
      deadline.throwIfAborted();
      active = undefined;
      if (document.hidden) release();
      else idleTimer = setTimeout(release, idleLifetime);
      return matches;
    } catch (error) {
      if (active === attempt) release();
      throw error;
    }
  }

  return { rank, release };
}
