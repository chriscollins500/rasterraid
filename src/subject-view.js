import { galleryCompositionSubjectSample, gallerySimilaritySample } from './visual-research.mjs';
import { subjectDownloadBytes } from './subject-artifacts.mjs';
import { createSubjectMatcher, subjectMatchAvailable } from './subject-matching.mjs';
import { element, sourceLink } from './view.js';

export function configureSubjectComparison(document, onComplete) {
  const section = document.getElementById('subject-comparison');
  const start = document.getElementById('subject-start');
  const stop = document.getElementById('subject-stop');
  const referenceChoice = document.getElementById('subject-reference-choice');
  const picker = document.getElementById('subject-reference');
  const status = document.getElementById('subject-status');
  const progress = document.getElementById('subject-download');
  const help = document.getElementById('subject-help');
  const results = document.getElementById('subject-results');
  const deep = document.getElementById('subject-deep-search');
  const matcher = createSubjectMatcher(document);
  progress.max = subjectDownloadBytes;
  let current;
  let context;
  let anchors = [];
  let sample = [];
  let matches = [];
  let active;
  let searchBusy = false;

  function cancel() {
    active?.abort();
    active = undefined;
    start.removeAttribute('aria-disabled');
    stop.hidden = true;
    progress.hidden = true;
    picker.disabled = searchBusy;
  }

  function clearMatches() {
    cancel();
    start.hidden = false;
    help.hidden = false;
    const reference = anchors[picker.selectedIndex];
    help.textContent = reference?.file ? (reference.region ? 'Uses the selected area of your picture on this device.' : 'Your reference picture stays on this device.') +
      ' Compares up to six public previews. About 81 MB to get started. 0 Buzz.'
      : 'Compares up to six previews on your device. About 81 MB to get started. 0 Buzz.';
    status.textContent = '';
    results.replaceChildren();
    matches = [];
    deep.hidden = true;
  }

  function show(result, nextContext, localReferences = []) {
    if (result === current && nextContext === context) return;
    current = result;
    context = nextContext;
    const gallery = result?.visualSearch?.region ? null : gallerySimilaritySample(result, context?.origin);
    anchors = gallery ? [gallery.reference] : localReferences;
    sample = gallery?.sample ?? (localReferences.length ? galleryCompositionSubjectSample(result, context?.origin) : []);
    section.hidden = !sample.length || !subjectMatchAvailable();
    referenceChoice.hidden = localReferences.length < 2;
    picker.replaceChildren(...anchors.map(reference => element('option', reference.label ?? reference.title)));
    clearMatches();
  }

  picker.addEventListener('change', () => {
    const hadMatches = matches.length > 0;
    clearMatches();
    if (hadMatches) onComplete();
  });
  start.addEventListener('click', async () => {
    const reference = anchors[picker.selectedIndex];
    if (!reference || !sample.length || searchBusy || active) return;
    const attempt = active = new AbortController();
    start.setAttribute('aria-disabled', 'true');
    picker.disabled = true;
    stop.hidden = false;
    status.textContent = 'Reading the previews…';
    try {
      const ranked = await matcher.rank({ reference, sample }, { signal: attempt.signal, onProgress: ({ phase, loaded }) => {
        if (active !== attempt) return;
        progress.hidden = phase !== 'loading';
        if (phase === 'loading') progress.value = loaded;
        const message = phase === 'loading' ? 'Downloading the on-device matcher…'
          : phase === 'starting' ? 'Preparing the matching model…' : 'Comparing subjects…';
        if (status.textContent !== message) status.textContent = message;
      } });
      if (active !== attempt) return;
      matches = ranked;
      const byId = new Map(sample.map(item => [item.id, item]));
      for (const [index, match] of matches.entries()) {
        const item = byId.get(match.id);
        const row = element('li');
        const link = sourceLink(item.link, null, context);
        link.setAttribute('aria-label', 'Rank ' + (index + 1) + ', ' + item.title);
        const image = element('span', null, 'subject-thumbnail');
        const preview = element('img');
        preview.alt = '';
        preview.referrerPolicy = 'no-referrer';
        preview.addEventListener('error', () => preview.replaceWith(element('small', 'Preview unavailable')), { once: true });
        preview.src = item.cover;
        image.append(preview, element('span', String(index + 1), 'subject-rank'));
        link.append(image, element('span', item.title, 'subject-source'));
        if (item.kind === 'Video poster') link.append(element('small', item.kind, 'subject-source'));
        row.append(link);
        results.append(row);
      }
      const displayed = matches.length;
      const basis = [reference, ...sample].some(item => item.kind === 'Video poster') ? ' · Includes video posters' : '';
      const area = reference.region ? ' using your selected area' : '';
      status.textContent = 'Compared ' + displayed + ' of ' + sample.length + ' previews on this device' + area + basis + ' · 0 Buzz';
      deep.hidden = reference.file && sample.length < 2;
      onComplete();
      if (document.activeElement === start || document.activeElement === stop) (deep.hidden ? section : deep).focus({ preventScroll: true });
      start.hidden = true;
      help.hidden = true;
    } catch {
      if (active === attempt) status.textContent = 'Subject matching is unavailable right now. The regular matches are below.';
    } finally {
      if (active === attempt) cancel();
    }
  });
  function stopMatching() {
    if (!active) return;
    cancel();
    status.textContent = 'Subject matching stopped. The regular matches are below.';
  }
  stop.addEventListener('click', () => {
    stopMatching();
    start.focus({ preventScroll: true });
  });
  return {
    show,
    release() {
      stopMatching();
      matcher.release();
    },
    setSearchBusy(busy) {
      searchBusy = busy;
      if (busy) stopMatching();
      start.disabled = busy;
      picker.disabled = busy;
    },
    orderFor: result => result === current ? matches.map(({ id }) => id) : [],
  };
}
