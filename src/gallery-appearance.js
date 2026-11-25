import { visualTextMatchAvailable } from './subject-matching.mjs';
import { renderSubjectMatches } from './subject-view.js';
import { sceneTime } from './scene-research.mjs';
import { element, sourceLink } from './view.js';
import { galleryDescriptionSample } from './visual-research.mjs';
import { validVisualDescription, visualPackBytes, visualPackUrl } from './visual-text-pack.mjs';
import { rankWrittenScenes, writtenSceneReview, writtenSceneSample } from './written-scenes.mjs';

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
  const moreScenes = byId('written-scene-more');
  const moreScenesLabel = byId('written-scene-more-label');
  const extraScenes = byId('written-scene-extra');
  packLink.value = visualPackUrl;
  let current;
  let context;
  let chosenPack;
  let active;
  let playing;
  let review;
  let searchBusy = false;

  function controls() {
    start.disabled = searchBusy || !current || current.clipFrames && !validVisualDescription(sceneQuery.value);
    sceneQuery.disabled = searchBusy;
    stop.hidden = !active;
    packPicker.disabled = searchBusy || Boolean(active);
    if (active) start.setAttribute('aria-disabled', 'true');
    else start.removeAttribute('aria-disabled');
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
    if (!video || !sameSearch) sceneQuery.value = video ? next.description : '';
    results.classList.toggle('written-scene-matches', video);
    results.setAttribute('aria-label', video ? 'Closest sampled scenes' : 'Appearance match order');
    setup.open = false;
    packLink.hidden = true;
    if (next) help.textContent = (video
      ? 'Check frames in ' + next.sample.length + (next.sample.length === 1 ? ' loaded clip' : ' loaded clips') + '. Clips up to one minute. Your description stays in this tab.'
      : 'Compare ' + next.sample.length + ' loaded pictures against your search words on this device.') +
      ' First use can download about 231 MB. 0 Buzz.';
    clear();
  }

  function showWrittenScenes(frameMatches, selected) {
    const scenes = rankWrittenScenes(frameMatches);
    for (const [index, eventFrame] of scenes.entries()) {
      const { clip, preview, timestamp, stream } = eventFrame;
      const item = element('li');
      const card = element('article', null, 'visual-match scene-match');
      const view = element('div', null, 'scene-preview');
      preview.setAttribute('aria-hidden', 'true');
      view.append(preview);
      const time = sceneTime(timestamp);
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
        url.hash = 't=' + timestamp.toFixed(3);
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
      const price = element('button', 'See frame review price', 'chip');
      price.type = 'button';
      price.setAttribute('aria-label', 'See frame review price for ' + clip.title);
      price.addEventListener('click', () => {
        if (current !== selected) return;
        const offer = writtenSceneReview(eventFrame, context.origin);
        if (!offer) return;
        review = { result: selected.result, offer };
        onReview(selected.result, true);
      });
      card.append(view, sourceLink(clip.link, clip.title, context), play, price);
      item.append(card);
      (index === 0 ? results : extraScenes).append(item);
    }
    moreScenes.hidden = scenes.length < 2;
    moreScenesLabel.textContent = scenes.length - 1 + (scenes.length === 2 ? ' more clip' : ' more clips');
    status.textContent = 'Compared ' + frameMatches.matches.length + ' sampled frames across ' + scenes.length + ' of ' + selected.sample.length + ' clips · 0 Buzz';
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

  sceneQuery.addEventListener('input', () => { clear(); });
  sceneQuery.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    start.click();
  });

  start.addEventListener('click', async () => {
    if (!current || searchBusy || active) return;
    const selected = current;
    const { clipFrames } = selected;
    const description = clipFrames ? sceneQuery.value.trim() : selected.description;
    if (!validVisualDescription(description)) return;
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
      const matches = await matcher.rank({ description, sample: selected.sample, modelPack: chosenPack, clipFrames }, {
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
      } else if (clipFrames) showWrittenScenes(matches, selected);
      else {
        renderSubjectMatches(results, selected.sample, matches, context);
        status.textContent = 'Compared ' + matches.length + ' of ' + selected.sample.length + ' loaded pictures · 0 Buzz';
      }
      if (document.activeElement === stop) start.focus({ preventScroll: true });
    } catch (error) {
      if (active !== attempt) return;
      if (error.name === 'NotReadableError') {
        setup.open = true;
        status.textContent = chosenPack ? 'This pack couldn’t be verified. Choose a verified RasterRaid model pack.'
          : 'The download couldn’t open. You can choose a saved model pack.';
      } else status.textContent = clipFrames ? 'Scene search could not read these clips. Your video results are below.'
        : 'Picture comparison is unavailable right now. Your gallery results are below.';
      if (document.activeElement === stop) start.focus({ preventScroll: true });
    } finally {
      if (active === attempt) {
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
