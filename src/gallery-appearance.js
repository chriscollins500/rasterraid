import { visualTextMatchAvailable } from './subject-matching.mjs';
import { renderSubjectMatches } from './subject-view.js';
import { sceneTime } from './scene-research.mjs';
import { speechDownloadBytes } from './spoken-artifacts.mjs';
import { openSpokenReader, resampleSceneSpeech } from './spoken-reading.mjs';
import { element, sourceLink } from './view.js';
import { galleryDescriptionSample } from './visual-research.mjs';
import { validVisualDescription, visualPackBytes, visualPackUrl } from './visual-text-pack.mjs';
import { rankWrittenScenes, rankWrittenSceneSounds, writtenSceneReview, writtenSceneSample, writtenSceneSoundEvidence,
  writtenSceneSpeechSamples } from './written-scenes.mjs';
import { readWrittenSounds, supportsWrittenSound } from './written-sound-search.mjs';
import { writtenSoundBrief, writtenSoundClipLimit, writtenSoundSeconds } from './written-sound.mjs';

export function configureGalleryAppearance(document, matcher, onReview) {
  const byId = id => document.getElementById(id);
  const section = byId('gallery-appearance');
  const start = byId('gallery-appearance-start');
  const stop = byId('gallery-appearance-stop');
  const help = byId('gallery-appearance-help');
  const status = byId('gallery-appearance-status');
  const progress = byId('gallery-appearance-progress');
  const results = byId('gallery-appearance-matches');
  const setup = byId('gallery-appearance-pack');
  const packPicker = byId('gallery-appearance-file');
  const copyLink = byId('gallery-appearance-copy');
  const packLink = byId('gallery-appearance-link');
  const title = byId('gallery-appearance-title');
  const sceneLabel = byId('written-scene-query-label');
  const sceneQuery = byId('written-scene-query');
  const soundLabel = byId('written-scene-sound-label');
  const soundQuery = byId('written-scene-sound');
  const soundSupported = supportsWrittenSound(document.defaultView);
  const moreScenes = byId('written-scene-more');
  const moreScenesLabel = byId('written-scene-more-label');
  const extraScenes = byId('written-scene-extra');
  packLink.value = visualPackUrl;
  let current;
  let context;
  let chosenPack;
  let active;
  let speechRead;
  let playing;
  let review;
  let searchBusy = false;

  const soundWords = () => soundLabel.hidden ? '' : soundQuery.value.trim();

  function controls() {
    const sound = soundWords();
    start.disabled = searchBusy || !current || current.clipFrames &&
      (!validVisualDescription(sceneQuery.value) || Boolean(sound && !writtenSoundBrief(sound)));
    sceneQuery.disabled = searchBusy;
    soundQuery.disabled = searchBusy;
    stop.hidden = !active;
    packPicker.disabled = searchBusy || Boolean(active);
    if (active) start.setAttribute('aria-disabled', 'true');
    else start.removeAttribute('aria-disabled');
    if (current) help.textContent = sound
      ? 'Compare picture and sound in the same sample. Checks the first ' + writtenSoundSeconds +
        ' seconds of up to four clips lasting a minute or less. First use can download about 273 MB of models. Both descriptions stay in this tab. 0 Buzz.'
      : (current.clipFrames
        ? 'Check frames in ' + current.sample.length + (current.sample.length === 1 ? ' loaded clip' : ' loaded clips') +
          '. Clips up to one minute. Your description stays in this tab.'
        : 'Compare ' + current.sample.length + ' loaded pictures against your search words on this device.') +
        ' First use can download about 231 MB. 0 Buzz.';
  }

  function stopPlayer() {
    if (!playing) return;
    const { video, preview } = playing;
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    preview.hidden = false;
    playing = undefined;
  }

  function clearReview(notify = true) {
    if (!review) return;
    const { result } = review;
    review = undefined;
    if (notify) onReview(result, false);
  }

  function clear(message = '') {
    active?.abort();
    active = undefined;
    speechRead?.abort();
    speechRead = undefined;
    stopPlayer();
    results.replaceChildren();
    moreScenes.hidden = true;
    moreScenes.open = false;
    extraScenes.replaceChildren();
    status.textContent = message;
    progress.hidden = true;
    controls();
    clearReview();
  }

  function show(result, displayed, nextContext) {
    const next = writtenSceneSample(result, displayed, nextContext) ?? galleryDescriptionSample(result, displayed, nextContext);
    const sameSearch = current?.result === result && context === nextContext;
    if (next && sameSearch && current.description === next.description && current.sample.length === next.sample.length &&
        current.sample.every((row, index) => row.id === next.sample[index].id && row.cover === next.sample[index].cover && row.stream === next.sample[index].stream)) return;
    current = next && { ...next, result };
    context = nextContext;
    section.hidden = !next || !visualTextMatchAvailable();
    const video = next?.clipFrames === true;
    title.textContent = video ? 'Find a scene' : 'Match by appearance';
    start.textContent = video ? 'Find scenes' : 'Compare pictures';
    stop.textContent = video ? 'Stop finding scenes' : 'Stop picture comparison';
    sceneLabel.hidden = !video;
    soundLabel.hidden = !video || !soundSupported;
    if (!video || !sameSearch) {
      sceneQuery.value = video ? next.description : '';
      soundQuery.value = '';
    }
    results.classList.toggle('written-scene-matches', video);
    results.setAttribute('aria-label', video ? 'Closest sampled scenes' : 'Appearance match order');
    setup.open = false;
    packLink.hidden = true;
    clear();
  }

  function speechDetails(samples, selected) {
    const window = document.defaultView;
    const details = element('details');
    const label = element('summary', 'Read English speech · 0 Buzz');
    const message = element('p');
    message.setAttribute('role', 'status');
    details.append(label, message);
    let completed = false;
    let pending;
    details.addEventListener('toggle', async () => {
      if (!details.open) { pending?.abort(); return; }
      if (completed || pending || current !== selected || !details.isConnected) return;
      speechRead?.abort();
      const request = pending = speechRead = new AbortController();
      const { signal } = request;
      const present = () => current === selected && details.isConnected && details.open;
      let reader;
      try {
        const pcm = await resampleSceneSpeech(window, samples, signal);
        const size = Math.ceil(speechDownloadBytes / 1_000_000);
        message.textContent = 'Getting the English speech model · Up to ' + size + ' MB on first use';
        reader = await openSpokenReader(window, signal, percent => {
          if (!signal.aborted && present()) message.textContent = 'Getting the speech model · ' + percent + '%';
        });
        message.textContent = 'Reading speech in this sample…';
        const cues = await reader.read(pcm);
        signal.throwIfAborted();
        if (!present()) return;
        const words = cues.map(row => row.text).join(' ').trim();
        const transcript = words ? 'On-device transcript · ' + words : 'No clear English speech recognized in this sample.';
        message.textContent = transcript;
        completed = true;
      } catch {
        if (present()) message.textContent = signal.aborted ? 'Speech check stopped. Reopen to try again.'
          : 'Speech could not be read here. Reopen to try again.';
      } finally {
        reader?.close();
        pending = undefined;
        if (speechRead === request) speechRead = undefined;
      }
    });
    return details;
  }

  function showWrittenScenes(scenes, selected, soundRecordings) {
    for (const [index, eventFrame] of scenes.entries()) {
      const { clip, preview, timestamp, stream, soundStart, soundEnd } = eventFrame;
      const item = element('li');
      const card = element('article', null, 'visual-match scene-match');
      const view = element('div', null, 'scene-preview');
      preview.setAttribute('aria-hidden', 'true');
      view.append(preview);
      const playAt = soundStart ?? timestamp;
      const time = sceneTime(playAt);
      const play = element('button', 'Play near ' + time, 'chip');
      play.type = 'button';
      play.addEventListener('click', () => {
        if (current !== selected) return;
        stopPlayer();
        const video = element('video');
        video.crossOrigin = 'anonymous';
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.setAttribute('aria-label', 'Matched moment from ' + clip.title);
        const url = new URL(stream);
        url.hash = 't=' + playAt.toFixed(3);
        playing = { video, preview };
        preview.hidden = true;
        view.append(video);
        video.addEventListener('error', () => {
          if (playing?.video !== video) return;
          stopPlayer();
          status.textContent = 'This clip couldn’t play here. Open the original on Civitai.';
        }, { once: true });
        video.src = url.href;
        video.play().catch(() => {});
      });
      const priceLabel = soundStart === undefined ? 'See frame review price' : 'See review prices';
      const price = element('button', priceLabel, 'chip');
      price.type = 'button';
      price.setAttribute('aria-label', priceLabel + ' for ' + clip.title);
      price.addEventListener('click', () => {
        if (current !== selected) return;
        const offer = writtenSceneReview(eventFrame, context.origin);
        if (!offer) return;
        review = { result: selected.result, offer };
        onReview(selected.result, true);
      });
      card.append(view, sourceLink(clip.link, clip.title, context));
      if (soundStart !== undefined) card.append(element('p', 'Sound sample ' + sceneTime(soundStart) + '–' + sceneTime(soundEnd) +
        ' · Frame near ' + sceneTime(timestamp)));
      card.append(play, price);
      const samples = writtenSceneSpeechSamples(eventFrame, soundRecordings?.get(clip.id));
      if (samples) card.append(speechDetails(samples, selected));
      item.append(card);
      (index === 0 ? results : extraScenes).append(item);
    }
    moreScenes.hidden = scenes.length < 2;
    moreScenesLabel.textContent = scenes.length - 1 + (scenes.length === 2 ? ' more clip' : ' more clips');
  }

  copyLink.addEventListener('click', async () => {
    const selected = current;
    try {
      await document.defaultView.navigator.clipboard.writeText(visualPackUrl);
      if (current === selected) status.textContent = 'Model pack link copied.';
    } catch {
      if (current !== selected) return;
      packLink.hidden = false;
      packLink.focus();
      packLink.select();
    }
  });

  packPicker.addEventListener('change', () => {
    if (!current || active) return;
    const file = packPicker.files[0];
    if (file && file.size !== visualPackBytes) {
      packPicker.value = '';
      if (chosenPack) matcher.release();
      chosenPack = undefined;
      clear('Choose the RasterRaid visual model pack, about 150 MB.');
      return;
    }
    matcher.release();
    chosenPack = file;
    clear(file ? 'Model pack selected.' : '');
  });

  for (const field of [sceneQuery, soundQuery]) {
    field.addEventListener('input', () => { clear(); });
    field.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      start.click();
    });
  }

  start.addEventListener('click', async () => {
    if (!current || searchBusy || active) return;
    const selected = current;
    const { clipFrames } = selected;
    const description = clipFrames ? sceneQuery.value.trim() : selected.description;
    const soundText = soundWords();
    const sound = soundText && writtenSoundBrief(soundText);
    if (!validVisualDescription(description) || soundText && !sound) return;
    clear();
    if (clipFrames) {
      results.classList.add('written-scene-matches');
      results.setAttribute('aria-label', 'Closest sampled scenes');
    }
    const attempt = active = new AbortController();
    const downloads = new Map();
    controls();
    results.replaceChildren();
    status.textContent = clipFrames ? 'Sampling the loaded clips…' : 'Reading the loaded pictures…';
    try {
      let sample = selected.sample;
      let audio;
      let soundRecordings;
      const clipCount = sound ? Math.min(sample.length, writtenSoundClipLimit) : sample.length;
      if (sound) {
        sample = sample.slice(0, clipCount);
        audio = await readWrittenSounds(document.defaultView, sample, sound, { signal: attempt.signal, maximumDuration: 60, retainSamples: true,
          onProgress(message) { if (active === attempt) status.textContent = message; },
        });
        attempt.signal.throwIfAborted();
        const audible = audio.recordings.filter(row => row.checked.length);
        if (!audible.length) {
          status.textContent = audio.failure ?? 'No sound excerpts could be read. Clear the sound description to compare frames.';
          return;
        }
        sample = audible.map(recording => recording.item);
        soundRecordings = new Map(audible.map(recording => [recording.item.id, recording]));
      }
      const matches = await matcher.rank({ description, sample, modelPack: chosenPack, clipFrames, soundRecordings }, {
        signal: attempt.signal,
        onProgress({ phase, loaded, total, provider, done }) {
          if (active !== attempt) return;
          const downloading = phase === 'loading' || phase === 'model-download';
          if (downloading) {
            downloads.set(phase, { loaded, total });
            progress.max = [...downloads.values()].reduce((sum, part) => sum + part.total, 0);
            progress.value = [...downloads.values()].reduce((sum, part) => sum + part.loaded, 0);
          }
          progress.hidden = !downloading && !(phase === 'sampling' && [...downloads.values()].some(part => part.loaded < part.total));
          const message = downloading ? 'Downloading the on-device model…' : phase === 'sampling'
            ? 'Sampling clips · ' + done + ' of ' + total : phase === 'model-check' ? 'Checking the model pack…'
            : phase === 'starting' ? 'Preparing the on-device model…' : provider === 'wasm' && phase === 'matching'
              ? 'Comparing on this device · ' + done + ' of ' + total + ' steps' : 'Comparing what’s visible…';
          if (status.textContent !== message) status.textContent = message;
        },
      });
      if (active !== attempt || selected !== current) return;
      if (clipFrames && matches.posterClips) {
        results.classList.remove('written-scene-matches');
        results.setAttribute('aria-label', 'Closest video posters');
        renderSubjectMatches(results, matches.posterClips, matches.matches, context);
        status.textContent = 'Compared ' + matches.matches.length + ' video posters. This browser couldn’t read frames from these clips.';
      } else if (clipFrames) {
        const evidence = audio && writtenSceneSoundEvidence(matches, audio.recordings, sound);
        const scenes = evidence ? rankWrittenSceneSounds(evidence) : rankWrittenScenes(matches);
        showWrittenScenes(scenes, selected, soundRecordings);
        status.textContent = evidence?.length
          ? 'Compared picture and sound in ' + evidence.length + ' samples from ' + scenes.length + ' of ' + clipCount + ' clips · 0 Buzz'
          : evidence ? 'No clips supplied matching picture and sound times. Clear the sound description to compare frames.'
            : 'Compared ' + matches.matches.length + ' sampled frames across ' + scenes.length + ' of ' + clipCount + ' clips · 0 Buzz';
        if (audio?.failure) status.textContent += ' ' + audio.failure;
      } else {
        renderSubjectMatches(results, selected.sample, matches, context);
        status.textContent = 'Compared ' + matches.length + ' of ' + selected.sample.length + ' loaded pictures · 0 Buzz';
      }
    } catch (error) {
      if (active !== attempt) return;
      if (error.name === 'NotReadableError') {
        setup.open = true;
        status.textContent = chosenPack ? 'This pack couldn’t be verified. Choose a verified RasterRaid model pack.'
          : 'The download couldn’t open. You can choose a saved model pack.';
      } else status.textContent = sound ? 'Picture and sound could not be compared in these clips. Clear the sound description to compare frames.'
        : clipFrames ? 'Scene search could not read these clips. Your video results are below.'
        : 'Picture comparison is unavailable right now. Your gallery results are below.';
    } finally {
      if (active === attempt) {
        if (document.activeElement === stop) start.focus({ preventScroll: true });
        active = undefined;
        progress.hidden = true;
        controls();
      }
    }
  });

  stop.addEventListener('click', () => {
    clear(current?.clipFrames ? 'Scene search stopped.' : 'Comparison stopped.');
    start.focus({ preventScroll: true });
  });

  return {
    show,
    clear() { show(null, [], null); },
    clearReview,
    reviewFor(result) { return review && review.result === result ? review.offer : null; },
    setSearchBusy(busy) {
      searchBusy = busy;
      if (busy && (active || current?.clipFrames)) clear();
      else controls();
    },
  };
}
