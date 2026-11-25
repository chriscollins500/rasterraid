import { createSoundDecoder, decodeExactPublicSound } from './sound-analysis.mjs';
import { soundCandidates } from './sound-research.mjs';
import { speechClipLimit, speechDownloadBytes, speechSecondsLimit } from './spoken-artifacts.mjs';
import { speechRate } from './spoken-regions.mjs';
import { subjectWasmAvailable } from './subject-artifacts.mjs';
import { transcriptTokens } from './workflow-transcripts.mjs';
import { element, sourceLink } from './view.js';

const clipTime = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const words = text => transcriptTokens(text).map(token => token.word);
const validLength = length => length >= 1 && length <= 12;

export function spokenWordHits(rows, query) {
  const phrase = words(query);
  if (!validLength(phrase.length)) return [];
  return rows.flatMap(({ item, cues }) => cues.flatMap(cue => {
    const terms = transcriptTokens(cue.text);
    const index = terms.findIndex((term, offset) => term.word === phrase[0] &&
      phrase.every((word, step) => terms[offset + step]?.word === word));
    return index < 0 ? [] : [{ item, ...cue, from: terms[index].start, through: terms[index + phrase.length - 1].end }];
  })).slice(0, 12);
}

function request(worker, message, timeout, signal, progress, transfer = []) {
  const guard = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  guard.throwIfAborted();
  return new Promise((resolve, reject) => {
    const settle = result => {
      guard.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = null;
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const abort = () => settle(guard.reason);
    guard.addEventListener('abort', abort, { once: true });
    worker.onerror = () => settle(new Error('This browser could not start the speech model.'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress(data);
      else settle(data.type === 'error' ? new Error('The speech model could not read this audio.') : data);
    };
    try { worker.postMessage(message, transfer); }
    catch (error) { settle(error); }
  });
}

function samplesFrom(audio) {
  const length = Math.min(audio.length, speechRate * speechSecondsLimit);
  const mono = audio.getChannelData(0).slice(0, length);
  if (audio.numberOfChannels > 1) {
    const right = audio.getChannelData(1);
    for (let index = 0; index < length; index++) mono[index] = (mono[index] + right[index]) * 0.5;
  }
  return mono;
}

export function configureSpokenSearch(document) {
  const window = document.defaultView;
  const byId = id => document.getElementById(id);
  const panel = byId('spoken-search');
  const field = byId('spoken-query');
  const start = byId('spoken-start');
  const stop = byId('spoken-stop');
  const status = byId('spoken-status');
  const results = byId('spoken-results');
  const media = byId('spoken-player');
  let context;
  let current;
  let available = [];
  let rows = [];
  let active;
  let checked = 0;
  const supported = typeof window.Worker === 'function' && typeof (window.OfflineAudioContext ?? window.webkitOfflineAudioContext) === 'function' &&
    Boolean(window.crypto?.subtle) && subjectWasmAvailable();

  function paint() {
    const query = field.value.trim();
    const length = words(query).length;
    start.disabled = Boolean(active) || !available.length || !validLength(length);
    stop.hidden = !active;
    results.replaceChildren();
    if (length > 12) {
      results.append(element('p', 'Enter up to 12 words.'));
      return;
    }
    if (!rows.length || !query) return;
    const hits = spokenWordHits(rows, query);
    if (!hits.length) {
      results.append(element('p', 'No matching words in the audio read so far.'));
      return;
    }
    const list = element('ul', null, 'history-rows');
    for (const hit of hits) {
      const row = element('li', null, 'history-row');
      const content = element('div');
      content.append(sourceLink(hit.item.link, hit.item.title + ' ↗', context));
      const excerpt = element('p');
      const left = Math.max(0, hit.from - 72);
      const right = Math.min(hit.text.length, hit.through + 72);
      excerpt.append((left ? '…' : '') + hit.text.slice(left, hit.from), element('mark', hit.text.slice(hit.from, hit.through)),
        hit.text.slice(hit.through, right) + (right < hit.text.length ? '…' : ''));
      const label = 'Play near ' + clipTime(hit.start);
      const play = element('button', label, 'chip');
      play.type = 'button';
      play.setAttribute('aria-label', label + ' · ' + hit.item.title);
      play.addEventListener('click', () => {
        clearPlayer();
        const player = element(hit.item.video ? 'video' : 'audio');
        const rendition = new URL(hit.item.stream);
        rendition.hash = 't=' + hit.start.toFixed(2);
        player.src = rendition.href;
        player.controls = true;
        player.preload = 'metadata';
        player.playsInline = true;
        player.tabIndex = 0;
        player.setAttribute('aria-label', hit.item.title);
        media.replaceChildren(player);
        void player.play().catch(() => {});
        player.focus();
      });
      content.append(excerpt);
      row.append(content, play);
      list.append(row);
    }
    results.append(list);
  }

  function clearPlayer() {
    const player = media.firstElementChild;
    if (!player) return;
    player.pause();
    player.removeAttribute('src');
    player.load();
    media.replaceChildren();
  }

  function clear() {
    active?.abort();
    active = null;
    rows = [];
    checked = 0;
    clearPlayer();
    status.textContent = '';
    field.value = '';
    panel.open = false;
  }

  async function find() {
    if (start.disabled) return;
    const run = new AbortController();
    active = run;
    const samples = available;
    const { signal } = run;
    rows = [];
    checked = 0;
    clearPlayer();
    paint();
    let worker;
    try {
      const decode = createSoundDecoder(window);
      const budget = { remaining: 24 * 1024 * 1024 };
      for (const item of samples) {
        signal.throwIfAborted();
        status.textContent = 'Reading recording ' + (checked + 1) + ' of ' + samples.length + '…';
        let audio;
        try { audio = await decodeExactPublicSound(item.stream, decode, signal, budget); }
        catch { signal.throwIfAborted(); }
        if (audio) {
          if (!worker) {
            status.textContent = 'Getting the English speech model…';
            const script = 'import ' + JSON.stringify(new URL('./spoken-worker.mjs', import.meta.url).href) + ';';
            worker = new window.Worker('data:text/javascript;charset=UTF-8,' + encodeURIComponent(script), { type: 'module' });
            await request(worker, { type: 'load' }, 75_000, signal, update => {
              if (active === run) status.textContent = 'Getting the speech model · ' + Math.floor(100 * update.loaded / speechDownloadBytes) + '%';
            });
            status.textContent = 'Checking the recording for speech…';
          }
          const pcm = samplesFrom(audio);
          const { cues } = await request(worker, { type: 'read', samples: pcm }, 20_000, signal, () => {}, [pcm.buffer]);
          signal.throwIfAborted();
          rows.push({ item, cues });
        }
        checked++;
        paint();
      }
    } catch (error) {
      if (active === run && !signal.aborted) status.textContent = error.message;
      if (!signal.aborted) return;
    } finally {
      worker?.terminate();
      if (active === run) {
        const focused = document.activeElement === stop;
        active = null;
        paint();
        if (checked === samples.length || signal.aborted || rows.length) status.textContent = (signal.aborted ? 'Stopped. ' : '') +
          rows.length + ' of ' + samples.length + ' recording' + (samples.length === 1 ? '' : 's') + ' read.';
        if (focused) start.focus();
      }
    }
  }

  start.addEventListener('click', () => { void find(); });
  stop.addEventListener('click', () => active?.abort());
  field.addEventListener('input', event => { if (!event.isComposing) paint(); });
  field.addEventListener('compositionend', paint);
  field.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (!rows.length) void find();
  });

  return {
    show(result, groups, nextContext) {
      const next = supported && result && ['audio', 'videos'].includes(result.gallery?.scope)
        ? soundCandidates(result, groups, nextContext.origin).slice(0, speechClipLimit) : [];
      if (result !== current || nextContext?.browsingLevel !== context?.browsingLevel || nextContext?.viewerUserId !== context?.viewerUserId ||
        nextContext?.origin !== context?.origin || available.some((item, index) => item.stream !== next[index]?.stream)) clear();
      current = result;
      context = nextContext;
      available = next;
      panel.hidden = !available.length;
      paint();
    },
  };
}
