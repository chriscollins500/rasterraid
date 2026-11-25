import { soundCandidates, spokenClipResearch } from './sound-research.mjs';
import { rankWrittenSoundMatches, writtenSoundBrief, writtenSoundClipLimit } from './written-sound.mjs';
import { readWrittenSounds, supportsWrittenSound } from './written-sound-search.mjs';
import { element, sourceLink } from './view.js';

const clipTime = seconds => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
const changeVersion = (context, next) => ['origin', 'viewerUserId', 'browsingLevel', 'signedIn', 'connectionLost']
  .some(key => context?.[key] !== next?.[key]);

export function configureWrittenSoundSearch(document, onReview) {
  const window = document.defaultView;
  const byId = id => document.getElementById(id);
  const panel = byId('written-sound-search');
  const controls = byId('written-sound-controls');
  const extra = byId('written-sound-extra');
  const description = byId('written-sound-query');
  const together = byId('written-sound-together');
  const avoid = byId('written-sound-avoid');
  const start = byId('written-sound-start');
  const stop = byId('written-sound-stop');
  const status = byId('written-sound-status');
  const matches = byId('written-sound-results');
  const media = byId('written-sound-player');
  const supported = supportsWrittenSound(window);
  byId('written-sound-unavailable').hidden = supported;
  controls.hidden = !supported;
  const fields = [description, together, avoid];
  let context;
  let current;
  let available = [];
  let active;
  let selected;
  let lastMatches = [];

  const brief = () => writtenSoundBrief(description.value, together.value, avoid.value);

  function clearReview(notify = true) {
    if (!selected) return;
    selected = undefined;
    if (notify) onReview(current, false);
  }

  function clearPlayer() {
    const player = media.firstElementChild;
    if (!player) return;
    player.pause();
    player.removeAttribute('src');
    player.load();
    media.replaceChildren();
  }

  function updateControls() {
    start.disabled = Boolean(active) || !supported || !available.length || !brief();
    stop.hidden = !active;
  }

  function clearMatches() {
    lastMatches = [];
    matches.replaceChildren();
    clearPlayer();
  }

  function listenTo(match) {
    if (!lastMatches.includes(match) || context.connectionLost) return;
    clearPlayer();
    const { item, rendition, start: seconds } = match;
    const player = element(item.video ? 'video' : 'audio');
    const uri = new URL(rendition);
    uri.hash = 't=' + seconds.toFixed(2);
    player.src = uri.href;
    player.controls = true;
    player.playsInline = true;
    player.preload = 'metadata';
    player.tabIndex = 0;
    player.setAttribute('aria-label', item.title + ' near ' + clipTime(seconds));
    media.replaceChildren(player);
    void player.play().catch(() => {});
    player.focus();
  }

  function researchMatch(match) {
    if (!lastMatches.includes(match) || context.connectionLost) return;
    const { item, start: seconds } = match;
    const selection = { link: item.link, stream: item.stream, seconds };
    if (!spokenClipResearch(available, selection, context.origin)) return;
    selected = selection;
    onReview(current, true);
  }

  function paintMatches(hits) {
    lastMatches = hits;
    if (!hits.length) return;
    const list = element('ol', null, 'history-rows');
    list.setAttribute('aria-label', 'Closest sounds in the checked recordings');
    for (const match of hits) {
      const { item, start: from, end } = match;
      const row = element('li', null, 'history-row');
      const evidence = element('div');
      evidence.append(sourceLink(item.link, item.title + ' ↗', context),
        element('p', 'Sampled ' + clipTime(from) + '–' + clipTime(end)));
      const play = element('button', 'Play near ' + clipTime(from), 'chip');
      play.type = 'button';
      play.setAttribute('aria-label', play.textContent + ' · ' + item.title);
      play.addEventListener('click', () => listenTo(match));
      const review = element('button', 'Research this clip', 'chip');
      review.type = 'button';
      review.setAttribute('aria-label', 'Research this clip · ' + item.title);
      review.setAttribute('aria-haspopup', 'dialog');
      review.setAttribute('aria-controls', 'deep-search');
      review.addEventListener('click', () => researchMatch(match));
      const actions = element('div', null, 'spoken-actions');
      actions.append(play, review);
      row.append(evidence, actions);
      list.append(row);
    }
    matches.replaceChildren(list);
  }

  function cancelAndClear() {
    const run = active;
    active = undefined;
    run?.controller.abort();
    clearMatches();
    status.textContent = '';
  }

  async function find() {
    const search = brief();
    if (start.disabled || !search) return;
    const run = { controller: new AbortController(), clips: available };
    active = run;
    const { signal } = run.controller;
    clearMatches();
    clearReview();
    updateControls();
    const { recordings, decoded, checked, silent, failure } = await readWrittenSounds(window, run.clips, search, { signal,
      onProgress(message) { if (active === run) status.textContent = message; },
    });
    if (active !== run) return;
    const restoreFocus = document.activeElement === stop;
    active = undefined;
    const hits = rankWrittenSoundMatches(recordings, search);
    paintMatches(hits);
    const coverage = checked
      ? 'Compared ' + checked + (checked === 1 ? ' excerpt' : ' excerpts') + ' from ' + hits.length + ' of ' + run.clips.length + ' clips.'
      : signal.aborted || failure ? '' : decoded ? 'No audible excerpts in the clips read.' : 'These sound previews could not be read.';
    const unavailable = decoded < run.clips.length && !signal.aborted && !failure && checked ?
      ' Some previews could not be read.' : '';
    const quiet = silent && checked && !failure && !signal.aborted ?
      ' ' + silent + (silent === 1 ? ' clip had no audible excerpt.' : ' clips had no audible excerpts.') : '';
    status.textContent = [signal.aborted ? 'Stopped.' : failure, coverage].filter(Boolean).join(' ') + unavailable + quiet;
    updateControls();
    if (restoreFocus && !start.disabled) start.focus({ preventScroll: true });
  }

  function edit() {
    cancelAndClear();
    clearReview();
    updateControls();
  }

  for (const input of fields) {
    input.addEventListener('input', event => { if (!event.isComposing) edit(); });
    input.addEventListener('compositionend', edit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void find(); }
    });
  }
  start.addEventListener('click', () => { void find(); });
  stop.addEventListener('click', () => active?.controller.abort());

  return {
    clearReview,
    reviewFor(result) {
      return selected && result === current && !context.connectionLost ? spokenClipResearch(available, selected, context.origin) : null;
    },
    show(result, groups, nextContext) {
      const next = result && !nextContext?.connectionLost && ['audio', 'videos'].includes(result.gallery?.scope)
        ? soundCandidates(result, groups, nextContext.origin).slice(0, writtenSoundClipLimit) : [];
      const changed = next.length !== available.length || next.some((item, index) =>
        item.link !== available[index].link || item.stream !== available[index].stream);
      if (result !== current || changeVersion(context, nextContext) || changed) {
        cancelAndClear();
        clearReview(false);
        fields.forEach(input => { input.value = ''; });
        extra.open = false;
        panel.open = false;
      }
      context = nextContext;
      current = result;
      available = next;
      panel.hidden = !next.length;
      updateControls();
    },
  };
}
