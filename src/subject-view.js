import { galleryCompositionSubjectSample, gallerySimilaritySample, galleryVisualDescription } from './visual-research.mjs';
import { subjectDownloadBytes } from './subject-artifacts.mjs';
import { createSubjectMatcher, subjectMatchAvailable, visualTextMatchAvailable } from './subject-matching.mjs';
import { visualPackBytes, visualPackUrl } from './visual-text-pack.mjs';
import { element, sourceLink } from './view.js';

export function pairedSubjectOrder(matches, sort) {
  const wordsFirst = [...matches].sort((a, b) => b.textScore - a.textScore || a.id - b.id);
  const words = new Map(wordsFirst.map(({ id }, index) => [id, index + 1]));
  const references = new Map(matches.map(({ id }, index) => [id, index + 1]));
  return (sort === 'references' ? matches : wordsFirst).map(match =>
    ({ ...match, ranks: { words: words.get(match.id), references: references.get(match.id) } }));
}

export function renderSubjectMatches(results, sample, matches, context) {
  const byId = new Map(sample.map(item => [item.id, item]));
  const cards = matches.map((match, index) => {
    const item = byId.get(match.id);
    const row = element('li');
    const link = sourceLink(item.link, null, context);
    const image = element('span', null, 'subject-thumbnail');
    const preview = element('img');
    preview.alt = '';
    preview.referrerPolicy = 'no-referrer';
    preview.addEventListener('error', () => preview.replaceWith(element('small', 'Preview unavailable')), { once: true });
    preview.src = item.cover;
    image.append(preview);
    if (!match.ranks) {
      const rank = element('span', String(index + 1), 'subject-rank');
      rank.setAttribute('aria-hidden', 'true');
      image.append(rank);
    }
    link.append(image, element('span', item.title, 'subject-source'));
    const detail = item.kind === 'Video poster' ? item.kind : '';
    const ranks = match.ranks ? 'Words ' + match.ranks.words + ' · References ' + match.ranks.references : '';
    if (detail || ranks) link.append(element('small', [ranks, detail].filter(Boolean).join(' · '), 'subject-source'));
    row.append(link);
    return row;
  });
  results.replaceChildren(...cards);
}

export function configureSubjectComparison(document, onComplete, matcher = createSubjectMatcher(document)) {
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
  const wordsChoice = document.getElementById('subject-words-choice');
  const includeWords = document.getElementById('subject-include-words');
  const orderChoice = document.getElementById('subject-order-choice');
  const order = document.getElementById('subject-order');
  const modelSetup = document.getElementById('subject-model-setup');
  const modelFile = document.getElementById('subject-model-file');
  const modelLink = document.getElementById('subject-model-link');
  modelLink.value = visualPackUrl;
  modelLink.addEventListener('focus', () => modelLink.select());
  progress.max = subjectDownloadBytes;
  let current;
  let context;
  let anchors = [];
  let sample = [];
  let matches = [];
  let settings = [];
  let description = '';
  let chosenPack;
  let comparisonHasWords = false;
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
    includeWords.disabled = searchBusy;
    modelFile.disabled = searchBusy;
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
    const useWords = Boolean(description && includeWords.checked);
    cues.hidden = !combined;
    start.disabled = searchBusy || !ready;
    includeWords.disabled = searchBusy || Boolean(active);
    modelFile.disabled = searchBusy || Boolean(active);
    wordsChoice.hidden = !description;
    modelSetup.hidden = !useWords;
    const location = selected.some(reference => reference.file) ? 'Your reference files stay on this device. ' : '';
    const areas = selected.some(reference => reference.region) ? 'Uses any selected picture areas. ' : '';
    const guidance = !ready ? 'Choose at least one subject to match. '
      : combined ? 'Match weighs the selected subjects together. Avoid moves similar subjects lower. ' : '';
    help.textContent = guidance + location + areas + (useWords
      ? 'See separate rankings for your search words and reference subjects. About 231 MB to get started. 0 Buzz.'
      : 'Compares up to six public previews. About 81 MB to get started. 0 Buzz.');
  }

  function clearMatches() {
    cancel();
    start.hidden = false;
    help.hidden = false;
    updateControls();
    status.textContent = '';
    results.replaceChildren();
    matches = [];
    comparisonHasWords = false;
    orderChoice.hidden = true;
    order.value = 'words';
    results.setAttribute('aria-label', 'Subject match order');
    deep.hidden = true;
  }

  function show(result, nextContext, briefReferences = []) {
    if (result === current && nextContext === context) return;
    current = result;
    context = nextContext;
    const gallery = result?.visualSearch?.region ? null : gallerySimilaritySample(result, context?.origin);
    anchors = gallery ? [gallery.reference] : briefReferences;
    sample = gallery?.sample ?? (briefReferences.length ? galleryCompositionSubjectSample(result, context?.origin) : []);
    description = !context?.connectionLost && result?.visualComposition && sample.length >= 2 && visualTextMatchAvailable()
      ? galleryVisualDescription(result) : '';
    includeWords.checked = false;
    modelSetup.open = false;
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
      choice.value = reference.avoidInBrief ? 'avoid' : defaults.includes(reference) ? 'prefer' : 'ignore';
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
  function paintMatches() {
    const ordered = comparisonHasWords ? pairedSubjectOrder(matches, order.value) : matches;
    results.setAttribute('aria-label', comparisonHasWords ? 'Preview comparison ordered by ' +
      (order.value === 'references' ? 'reference subjects' : 'search words') : 'Subject match order');
    renderSubjectMatches(results, sample, ordered, context);
  }

  picker.addEventListener('change', referenceChanged);
  includeWords.addEventListener('change', referenceChanged);
  order.addEventListener('change', paintMatches);
  modelFile.addEventListener('change', () => {
    if (active || !includeWords.checked) return;
    referenceChanged();
    matcher.release();
    const file = modelFile.files[0];
    if (file && file.size !== visualPackBytes) {
      modelFile.value = '';
      chosenPack = undefined;
      status.textContent = 'Choose the RasterRaid visual model pack, about 150 MB.';
      return;
    }
    chosenPack = file;
    if (file) status.textContent = 'Model pack selected. Compare on this device when ready.';
  });
  start.addEventListener('click', async () => {
    const references = selectedReferences();
    if (!references.some(reference => reference.polarity === 'prefer') || !sample.length || searchBusy || active) return;
    const words = includeWords.checked ? description : '';
    const attempt = active = new AbortController();
    const downloads = new Map();
    start.setAttribute('aria-disabled', 'true');
    picker.disabled = true;
    cues.disabled = true;
    updateControls();
    stop.hidden = false;
    status.textContent = 'Reading the previews…';
    try {
      const inputs = { references, sample, ...(words && { description: words, modelPack: chosenPack }) };
      const ranked = await matcher.rank(inputs, { signal: attempt.signal, onProgress: ({ phase, loaded, total, provider, done }) => {
        if (active !== attempt) return;
        const downloading = phase === 'loading' || phase === 'model-download';
        progress.hidden = !downloading;
        if (downloading) {
          downloads.set(phase, { loaded, total });
          progress.max = [...downloads.values()].reduce((sum, part) => sum + part.total, 0);
          progress.value = [...downloads.values()].reduce((sum, part) => sum + part.loaded, 0);
        }
        const message = downloading ? 'Downloading the on-device matcher…' : phase === 'model-check' ? 'Checking the model pack…'
          : phase === 'starting' ? 'Preparing the matching model…'
            : provider === 'wasm' ? 'Comparing on this device · ' + done + ' of ' + total + ' steps' : 'Comparing previews…';
        if (status.textContent !== message) status.textContent = message;
      } });
      if (active !== attempt) return;
      matches = ranked;
      comparisonHasWords = Boolean(words);
      orderChoice.hidden = !comparisonHasWords;
      paintMatches();
      const displayed = matches.length;
      const basis = [...references, ...sample].some(item => item.kind === 'Video poster') ? ' · Includes video posters' : '';
      const cropped = references.filter(reference => reference.region).length;
      const area = cropped === 1 ? ' using your selected area' : cropped ? ' using selected picture areas' : '';
      const avoidCount = references.filter(reference => reference.polarity === 'avoid').length;
      const selected = references.length > 1 ? ' · ' + (references.length - avoidCount) + ' to match, ' + avoidCount + ' to avoid' : '';
      const signals = words ? ' · Ranked by search words and by reference subjects' : '';
      status.textContent = 'Compared ' + displayed + ' of ' + sample.length + ' previews on this device' + area + selected + signals + basis + ' · 0 Buzz';
      deep.hidden = Boolean(current?.visualComposition && matches.length < 2);
      onComplete();
      if (document.activeElement === start || document.activeElement === stop) {
        const nextControl = comparisonHasWords ? order : deep.hidden ? section : deep;
        nextControl.focus({ preventScroll: true });
      }
      start.hidden = true;
      help.hidden = true;
    } catch (error) {
      if (active !== attempt) return;
      if (words && error.name === 'NotReadableError') {
        modelSetup.open = true;
        status.textContent = 'The model pack couldn’t be loaded. Try a saved pack or compare with your pictures.';
      } else status.textContent = 'Subject matching is unavailable right now. The regular matches are below.';
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
