import { gallerySimilaritySample } from './visual-research.mjs';
import { rankPreviewSubjects, subjectMatchAvailable } from './subject-matching.mjs';
import { element, sourceLink } from './view.js';

export function configureSubjectComparison(document, onComplete) {
  const section = document.getElementById('subject-comparison');
  const start = document.getElementById('subject-start');
  const stop = document.getElementById('subject-stop');
  const status = document.getElementById('subject-status');
  const help = document.getElementById('subject-help');
  const results = document.getElementById('subject-results');
  const deep = document.getElementById('subject-deep-search');
  let current;
  let context;
  let selection;
  let matches = [];
  let active;

  function cancel() {
    active?.abort();
    active = undefined;
    start.removeAttribute('aria-disabled');
    stop.hidden = true;
  }

  function show(result, nextContext) {
    if (result === current && nextContext === context) return;
    cancel();
    current = result;
    context = nextContext;
    selection = result?.visualSearch?.region ? null : gallerySimilaritySample(result, context?.origin);
    section.hidden = !selection || !subjectMatchAvailable();
    start.hidden = false;
    help.hidden = false;
    status.textContent = '';
    results.replaceChildren();
    matches = [];
    deep.hidden = true;
  }

  start.addEventListener('click', async () => {
    if (!selection || active) return;
    const attempt = active = new AbortController();
    const { reference, sample } = selection;
    start.setAttribute('aria-disabled', 'true');
    stop.hidden = false;
    status.textContent = 'Reading the previews…';
    try {
      const ranked = await rankPreviewSubjects(document, selection, { signal: attempt.signal, onProgress: phase => {
        if (active === attempt) status.textContent = phase === 'loading' ? 'Loading the on-device matcher…' : 'Comparing subjects…';
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
      status.textContent = 'Compared ' + displayed + ' of ' + sample.length + ' previews on this device' + basis + ' · 0 Buzz';
      deep.hidden = false;
      onComplete();
      if (document.activeElement === start || document.activeElement === stop) deep.focus({ preventScroll: true });
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
    setSearchBusy(busy) {
      if (busy) stopMatching();
      start.disabled = busy;
    },
    orderFor: result => result === current ? matches.map(({ id }) => id) : [],
  };
}
