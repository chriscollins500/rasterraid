import { visualTextMatchAvailable } from './subject-matching.mjs';
import { renderSubjectMatches } from './subject-view.js';
import { galleryDescriptionSample } from './visual-research.mjs';
import { visualPackBytes, visualPackUrl } from './visual-text-pack.mjs';

export function configureGalleryAppearance(document, matcher) {
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
  packLink.value = visualPackUrl;
  let current;
  let context;
  let chosenPack;
  let active;
  let searchBusy = false;

  function controls() {
    start.disabled = searchBusy || !current;
    stop.hidden = !active;
    packPicker.disabled = searchBusy || Boolean(active);
    if (active) start.setAttribute('aria-disabled', 'true');
    else start.removeAttribute('aria-disabled');
  }

  function clear(message = '') {
    active?.abort();
    active = undefined;
    results.replaceChildren();
    status.textContent = message;
    progress.hidden = true;
    controls();
  }

  function show(result, displayed, nextContext) {
    const next = galleryDescriptionSample(result, displayed, nextContext);
    if (next && current?.description === next.description && context === nextContext && current.sample.length === next.sample.length &&
        current.sample.every((picture, index) => picture.id === next.sample[index].id && picture.cover === next.sample[index].cover) && current.result === result) return;
    current = next && { ...next, result };
    context = nextContext;
    section.hidden = !next || !visualTextMatchAvailable();
    setup.open = false;
    packLink.hidden = true;
    if (next) help.textContent = 'Compare ' + next.sample.length + ' loaded pictures against your search words on this device. ' +
      'First use can download about 231 MB. 0 Buzz.';
    clear();
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
    clear(file ? 'Model pack selected. Compare pictures when ready.' : '');
  });

  start.addEventListener('click', async () => {
    if (!current || searchBusy || active) return;
    const selected = current;
    const attempt = active = new AbortController();
    const downloads = new Map();
    controls();
    results.replaceChildren();
    status.textContent = 'Reading the loaded pictures…';
    try {
      const matches = await matcher.rank({ description: selected.description, sample: selected.sample, modelPack: chosenPack }, {
        signal: attempt.signal,
        onProgress({ phase, loaded, total, provider, done }) {
          if (active !== attempt) return;
          const downloading = phase === 'loading' || phase === 'model-download';
          progress.hidden = !downloading;
          if (downloading) {
            downloads.set(phase, { loaded, total });
            progress.max = [...downloads.values()].reduce((sum, part) => sum + part.total, 0);
            progress.value = [...downloads.values()].reduce((sum, part) => sum + part.loaded, 0);
          }
          const message = downloading ? 'Downloading the on-device model…' : phase === 'model-check' ? 'Checking the model pack…'
            : phase === 'starting' ? 'Preparing the on-device model…' : provider === 'wasm' && phase === 'matching'
              ? 'Comparing on this device · ' + done + ' of ' + total + ' steps' : 'Comparing what’s visible…';
          if (status.textContent !== message) status.textContent = message;
        },
      });
      if (active !== attempt || selected !== current) return;
      renderSubjectMatches(results, selected.sample, matches, context);
      status.textContent = 'Compared ' + matches.length + ' of ' + selected.sample.length + ' loaded pictures · 0 Buzz';
      if (document.activeElement === stop) start.focus({ preventScroll: true });
    } catch (error) {
      if (active !== attempt) return;
      if (error.name === 'NotReadableError') {
        setup.open = true;
        status.textContent = chosenPack ? 'This pack couldn’t be verified. Choose a verified RasterRaid model pack.'
          : 'The download couldn’t open. You can choose a saved model pack.';
      } else status.textContent = 'Picture comparison is unavailable right now. Your gallery results are below.';
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
    clear('Comparison stopped.');
    start.focus({ preventScroll: true });
  });

  return {
    show,
    clear() { show(null, [], null); },
    setSearchBusy(busy) {
      searchBusy = busy;
      if (busy && active) clear();
      else controls();
    },
  };
}
