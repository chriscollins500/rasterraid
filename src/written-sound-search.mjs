import { createSoundDecoder, decodePublicSoundSource } from './sound-analysis.mjs';
import { requestSoundWorker, startSoundWorker } from './sound-worker-client.mjs';
import { subjectWasmAvailable } from './subject-artifacts.mjs';
import { audioDownloadBytes } from './written-sound-artifacts.mjs';
import { hasAudibleSound, validWrittenSoundWindows, writtenSoundBudget, writtenSoundRate, writtenSoundSamples } from './written-sound.mjs';

export function supportsWrittenSound(window) {
  return typeof window.Worker === 'function' &&
    typeof (window.OfflineAudioContext ?? window.webkitOfflineAudioContext) === 'function' &&
    typeof window.DecompressionStream === 'function' && Boolean(window.crypto?.subtle) && subjectWasmAvailable();
}

export async function readWrittenSounds(window, clips, brief, { signal, onProgress, maximumDuration = Infinity }) {
  const recordings = [];
  let decoded = 0;
  let checked = 0;
  let silent = 0;
  let worker;
  let failure;
  try {
    const decode = createSoundDecoder(window, writtenSoundRate);
    const budget = { remaining: writtenSoundBudget };
    for (const [index, item] of clips.entries()) {
      signal.throwIfAborted();
      onProgress('Reading clip ' + (index + 1) + ' of ' + clips.length + '…');
      let preview;
      try { preview = await decodePublicSoundSource(item.stream, decode, signal, budget); }
      catch { signal.throwIfAborted(); continue; }
      decoded++;
      const { duration } = preview.audio;
      if (duration > maximumDuration) continue;
      const samples = writtenSoundSamples(preview.audio);
      if (!samples || !hasAudibleSound(samples)) { silent++; continue; }
      const sampleLength = samples.length;
      if (!worker) {
        onProgress('Getting the sound model…');
        worker = startSoundWorker(window, new URL('./written-sound-worker.mjs', import.meta.url));
        const opened = await requestSoundWorker(worker, { type: 'load', brief }, signal, 90_000, {
          progress(data) {
            if (Number.isFinite(data.loaded) && data.loaded >= 0 && data.loaded <= audioDownloadBytes) {
              onProgress('Getting the sound model · ' + Math.floor(100 * data.loaded / audioDownloadBytes) + '%');
            }
          },
        });
        if (opened.type === 'length') throw new RangeError('Shorten each description and try again.');
        if (opened.type !== 'ready') throw new Error('The sound model is unavailable. Try again.');
      }
      onProgress('Checking the sound in clip ' + (index + 1) + ' of ' + clips.length + '…');
      const reply = await requestSoundWorker(worker, { type: 'read', samples }, signal, 30_000, { transfer: [samples.buffer] });
      signal.throwIfAborted();
      if (reply.type !== 'checked' || !validWrittenSoundWindows(reply.windows, brief, sampleLength)) {
        throw new Error('Sound matching stopped while reading a clip.');
      }
      if (!reply.windows.length) silent++;
      checked += reply.windows.length;
      recordings.push({ item, rendition: preview.stream, duration, checked: reply.windows });
    }
  } catch (error) {
    if (!signal.aborted) {
      failure = error instanceof RangeError ? error.message :
        (worker && checked ? 'Sound matching stopped early.' : 'Sound matching is unavailable. Try again.');
    }
  } finally { worker?.terminate(); }
  return { recordings, decoded, checked, silent, failure };
}
