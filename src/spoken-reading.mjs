import { requestSoundWorker, startSoundWorker } from './sound-worker-client.mjs';
import { speechDownloadBytes } from './spoken-artifacts.mjs';
import { speechRate } from './spoken-regions.mjs';
import { writtenSoundRate } from './written-sound.mjs';

export async function openSpokenReader(window, signal, onProgress) {
  const worker = startSoundWorker(window, new URL('./spoken-worker.mjs', import.meta.url));
  try {
    const response = await requestSoundWorker(worker, { type: 'load' }, signal, 75_000, {
      progress({ loaded }) {
        if (Number.isFinite(loaded) && loaded >= 0 && loaded <= speechDownloadBytes) {
          onProgress(Math.floor(100 * loaded / speechDownloadBytes));
        }
      },
    });
    if (response.type !== 'ready') throw new Error('The English speech model could not open.');
    return {
      async read(samples) {
        const { type, cues } = await requestSoundWorker(worker, { type: 'read', samples }, signal, 20_000,
          { transfer: [samples.buffer] });
        if (type !== 'cues' || !Array.isArray(cues)) throw new Error('The speech model could not read this audio.');
        return cues;
      },
      close() { worker.terminate(); },
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

export async function resampleSceneSpeech(window, samples, signal) {
  signal.throwIfAborted();
  const Audio = window.OfflineAudioContext ?? window.webkitOfflineAudioContext;
  const audio = new Audio(1, Math.floor(samples.length * speechRate / writtenSoundRate), speechRate);
  const source = audio.createBufferSource();
  source.buffer = audio.createBuffer(1, samples.length, writtenSoundRate);
  source.buffer.copyToChannel(samples, 0);
  source.connect(audio.destination);
  source.start();
  const rendered = await audio.startRendering();
  signal.throwIfAborted();
  return rendered.getChannelData(0).slice();
}
