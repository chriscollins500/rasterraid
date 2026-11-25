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
  const cues = document.getElementById('subject-cues');
  const cueItems = document.getElementById('subject-cue-items');
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
  let settings = [];
  let active;
  let searchBusy = false;

  function cancel() {
    active?.abort();
    active = undefined;
    start.removeAttribute('aria-disabled');
    stop.hidden = true;
    progress.hidden = true;
    picker.disabled = searchBusy;
    cues.disabled = searchBusy;
  }

  function selectedReferences() {
    if (picker.value === 'combine') return settings.flatMap(({ reference, choice }) =>
      choice.value === 'ignore' ? [] : [{ ...reference, polarity: choice.value }]);
    const reference = anchors[picker.selectedIndex];
    return reference ? [{ ...reference, polarity: 'prefer' }] : [];
  }

  function updateControls() {
    const combined = picker.value === 'combine';
    const selected = selectedReferences();
    const ready = selected.some(reference => reference.polarity === 'prefer');
    cues.hidden = !combined;
    start.disabled = searchBusy || !ready;
    const location = selected.some(reference => reference.file) ? 'Your reference files stay on this device. ' : '';
    const areas = selected.some(reference => reference.region) ? 'Uses any selected picture areas. ' : '';
    const guidance = !ready ? 'Choose at least one subject to match. '
      : combined ? 'Match weighs the selected subjects together. Avoid moves similar subjects lower. ' : '';
    help.textContent = guidance + location + areas + 'Compares up to six public previews. About 81 MB to get started. 0 Buzz.';
  }

  function clearMatches() {
    cancel();
    start.hidden = false;
    help.hidden = false;
    updateControls();
    status.textContent = '';
    results.replaceChildren();
    matches = [];
    deep.hidden = true;
  }

  function show(result, nextContext, briefReferences = []) {
    if (result === current && nextContext === context) return;
    current = result;
    context = nextContext;
    const gallery = result?.visualSearch?.region ? null : gallerySimilaritySample(result, context?.origin);
    anchors = gallery ? [gallery.reference] : briefReferences;
    sample = gallery?.sample ?? (briefReferences.length ? galleryCompositionSubjectSample(result, context?.origin) : []);
    section.hidden = !sample.length || !subjectMatchAvailable();
    referenceChoice.hidden = anchors.length < 2;
    const options = anchors.map((reference, index) => {
      const option = element('option', reference.label ?? reference.title);
      option.value = String(index);
      return option;
    });
    if (anchors.length > 1) {
      const combine = element('option', 'Combine references');
      combine.value = 'combine';
      options.push(combine);
    }
    picker.replaceChildren(...options);
    picker.selectedIndex = Math.max(0, anchors.findIndex(reference => !reference.avoidInBrief));
    const defaults = anchors.filter(reference => !reference.avoidInBrief).slice(0, 2);
    if (!defaults.length && anchors.length) defaults.push(anchors[0]);
    settings = anchors.map(reference => {
      const label = element('label', null, 'subject-cue');
      const name = reference.label ?? reference.title;
      const choice = element('select');
      choice.setAttribute('aria-label', 'Subject cue for ' + name);
      for (const [value, text] of [['ignore', 'Ignore'], ['prefer', 'Match subject'], ['avoid', 'Avoid similar subjects']]) {
        const option = element('option', text);
        option.value = value;
        choice.append(option);
      }
      choice.value = defaults.includes(reference) ? 'prefer' : 'ignore';
      choice.addEventListener('change', referenceChanged);
      label.append(element('span', name), choice);
      return { reference, label, choice };
    });
    cueItems.replaceChildren(...settings.map(row => row.label));
    clearMatches();
  }

  function referenceChanged() {
    const hadMatches = matches.length > 0;
    clearMatches();
    if (hadMatches) onComplete();
  }
  picker.addEventListener('change', referenceChanged);
  start.addEventListener('click', async () => {
    const references = selectedReferences();
    if (!references.some(reference => reference.polarity === 'prefer') || !sample.length || searchBusy || active) return;
    const attempt = active = new AbortController();
    start.setAttribute('aria-disabled', 'true');
    picker.disabled = true;
    cues.disabled = true;
    stop.hidden = false;
    status.textContent = 'Reading the previews…';
    try {
      const ranked = await matcher.rank({ references, sample }, { signal: attempt.signal, onProgress: ({ phase, loaded, total, provider, done }) => {
        if (active !== attempt) return;
        progress.hidden = phase !== 'loading';
        if (phase === 'loading') {
          progress.max = total;
          progress.value = loaded;
        }
        const message = phase === 'loading' ? 'Downloading the on-device matcher…'
          : phase === 'starting' ? 'Preparing the matching model…'
            : provider === 'wasm' ? 'Comparing subjects · ' + done + ' of ' + total + ' pictures' : 'Comparing subjects…';
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
      const basis = [...references, ...sample].some(item => item.kind === 'Video poster') ? ' · Includes video posters' : '';
      const cropped = references.filter(reference => reference.region).length;
      const area = cropped === 1 ? ' using your selected area' : cropped ? ' using selected picture areas' : '';
      const avoidCount = references.filter(reference => reference.polarity === 'avoid').length;
      const selected = references.length > 1 ? ' · ' + (references.length - avoidCount) + ' to match, ' + avoidCount + ' to avoid' : '';
      status.textContent = 'Compared ' + displayed + ' of ' + sample.length + ' previews on this device' + area + selected + basis + ' · 0 Buzz';
      deep.hidden = Boolean(current?.visualComposition && matches.length < 2);
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
      picker.disabled = busy;
      cues.disabled = busy;
      updateControls();
    },
    orderFor: result => result === current ? matches.map(({ id }) => id) : [],
  };
}
