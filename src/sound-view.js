import { createSoundDecoder, decodePublicSound, decodePublicSoundSource, describeSound, rankSoundMatches, soundCandidateLimit, soundFileBytes, soundRoles,
  soundTypes, soundWindows } from './sound-analysis.mjs';
import { soundCandidates, soundPickLimit } from './sound-research.mjs';
import { showReportExport } from './report-view.js';
import { element, sourceLink } from './view.js';

const referenceLimit = 3;
const clipTime = seconds => Math.floor(seconds / 60) + ':' + (seconds % 60).toFixed(1).padStart(4, '0');
const cueName = ({ role, avoid }) => (avoid ? 'Avoid ' : 'Match ') + soundRoles[role].toLowerCase();
const points = score => Math.round(score * 100);
const markdownText = value => value.replace(/[\\[\]()`*_<>]/gu, '\\$&');

function waveform(features, name) {
  const canvas = element('canvas', null, 'sound-waveform');
  canvas.width = 288;
  canvas.height = 52;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Energy across ' + name);
  const draw = canvas.getContext('2d');
  if (!draw) return canvas;
  draw.fillStyle = '#d7f477';
  const stride = canvas.width / features.waveform.length;
  features.waveform.forEach((level, index) => {
    const height = 1 + level * 44;
    draw.fillRect(index * stride, (canvas.height - height) / 2, stride - 2, height);
  });
  return canvas;
}

function matchExport(matches) {
  return ['## Local sound matches', '', 'Compared sampled excerpts from the public Civitai results.', '',
    ...matches.flatMap(({ item, features, score, cues }) => [
      `- [${markdownText(item.title)}](${item.link}) · ${clipTime(features.start)} · ${points(score)}/100`,
      ...cues.map(cue => `  - ${cueName(cue)} · ${points(cue.score)}/100`),
    ]), ''].join('\n');
}

export function configureSoundMatch(document, onSelection, onAnalysisChange = () => {}) {
  const window = document.defaultView;
  const byId = id => document.getElementById(id);
  const section = byId('sound-comparison');
  const refs = byId('sound-references');
  const files = byId('sound-files');
  const publicSelect = byId('sound-public-reference');
  const addPublic = byId('sound-use-public');
  const action = byId('sound-compare');
  const stop = byId('sound-stop');
  const status = byId('sound-status');
  const results = byId('sound-results');
  const selection = byId('sound-research-selection');
  const selectionStatus = byId('sound-research-status');
  const copy = byId('sound-copy');
  const canDecode = typeof (window.OfflineAudioContext ?? window.webkitOfflineAudioContext) === 'function';
  const picks = new Map();
  const buttons = new Map();
  let references = [];
  let available = [];
  let profiles = new Map();
  let current;
  let context;
  let operation;
  let matches = [];
  let sampled = false;

  function paintSelection() {
    selection.hidden = !picks.size;
    selectionStatus.textContent = picks.size ? picks.size + ' of ' + soundPickLimit + ' public recordings selected' : '';
    for (const [link, control] of buttons) {
      const chosen = picks.has(link);
      control.setAttribute('aria-pressed', String(chosen));
      control.textContent = chosen ? 'Selected for Deep Search' : 'Add to Deep Search';
      control.disabled = !chosen && picks.size >= soundPickLimit;
    }
  }

  function clearSelection(notify = true) {
    if (!picks.size) return;
    picks.clear();
    paintSelection();
    if (notify) onSelection(current);
  }

  function clearMatches(notify = true) {
    results.replaceChildren();
    matches = [];
    sampled = false;
    buttons.clear();
    copy.hidden = true;
    clearSelection(notify);
    onAnalysisChange();
  }

  function referencesChanged() {
    clearMatches();
    status.textContent = references.length ? 'Compare sounds to use the updated references.' : '';
  }

  function paintControls() {
    const noRoom = Boolean(operation) || references.length >= referenceLimit || !canDecode;
    files.disabled = noRoom;
    publicSelect.disabled = noRoom || !available.length;
    addPublic.disabled = publicSelect.disabled || !publicSelect.value;
    action.disabled = Boolean(operation) || !references.length || !comparisonCandidates().length;
    stop.hidden = operation?.kind !== 'compare';
    refs.disabled = Boolean(operation);
    onAnalysisChange();
  }

  function comparisonCandidates() {
    const anchored = new Set(references.map(ref => ref.link));
    return available.filter(item => !anchored.has(item.link)).slice(0, soundCandidateLimit);
  }

  function paintReferences() {
    refs.replaceChildren(element('legend', 'Sound references', 'sr-only'));
    for (const reference of references) {
      const row = element('div', null, 'sound-reference-row');
      const name = element('strong', reference.name);
      name.title = reference.name;
      const role = element('select');
      role.setAttribute('aria-label', 'Trait for ' + reference.name);
      for (const [value, label] of Object.entries(soundRoles)) {
        const option = element('option', label);
        option.value = value;
        role.append(option);
      }
      role.value = reference.role;
      const avoidLabel = element('label', 'Avoid this trait');
      const avoid = element('input');
      avoid.type = 'checkbox';
      avoid.checked = reference.avoid;
      avoid.setAttribute('aria-label', 'Avoid trait for ' + reference.name);
      avoidLabel.prepend(avoid);
      const startLabel = element('label', 'Start (seconds)');
      const start = element('input');
      start.type = 'number';
      start.min = '0';
      start.max = String(Math.floor(Math.max(0, reference.audio.duration - 1.5) * 10) / 10);
      start.step = '.1';
      start.value = reference.start;
      start.setAttribute('aria-label', 'Start in seconds for ' + reference.name);
      startLabel.append(start);
      const remove = element('button', 'Remove', 'chip');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + reference.name);
      role.addEventListener('change', () => { reference.role = role.value; referencesChanged(); });
      avoid.addEventListener('change', () => { reference.avoid = avoid.checked; referencesChanged(); });
      start.addEventListener('change', () => {
        reference.start = Math.max(0, Math.min(Number(start.max), start.valueAsNumber || 0));
        start.value = reference.start;
        reference.features = null;
        row.querySelector('canvas')?.remove();
        referencesChanged();
      });
      remove.addEventListener('click', () => {
        references = references.filter(item => item !== reference);
        referencesChanged();
        paintReferences();
        paintPublic();
        (refs.querySelector('select') ?? files).focus();
      });
      row.append(name, role, startLabel, avoidLabel, remove);
      if (reference.features) row.append(waveform(reference.features, 'the reference excerpt'));
      refs.append(row);
    }
    paintControls();
  }

  function paintPublic() {
    const prior = publicSelect.value;
    publicSelect.replaceChildren(element('option', 'Choose a public result'));
    publicSelect.firstElementChild.value = '';
    const used = new Set(references.map(ref => ref.link));
    for (const item of available) {
      if (used.has(item.link)) continue;
      const option = element('option', item.title);
      option.value = item.link;
      publicSelect.append(option);
    }
    if ([...publicSelect.options].some(item => item.value === prior)) publicSelect.value = prior;
    paintControls();
  }

  function begin(kind) {
    operation = { kind, controller: new AbortController() };
    paintControls();
    return operation;
  }

  function finish(run) {
    if (operation !== run) return false;
    operation = undefined;
    paintControls();
    return true;
  }

  async function addReferences(entries) {
    if (operation || !entries.length) return;
    const run = begin('import');
    const { signal } = run.controller;
    status.textContent = 'Reading sound references…';
    clearMatches();
    let failed = 0;
    try {
      const decode = createSoundDecoder(window);
      const budget = { remaining: soundFileBytes };
      for (const entry of entries.slice(0, referenceLimit - references.length)) {
        try {
          signal.throwIfAborted();
          const audio = entry.file ? await decode(await entry.file.arrayBuffer(), signal) :
            await decodePublicSound(entry.stream, decode, signal, budget);
          const features = await describeSound(audio, 0, { signal });
          signal.throwIfAborted();
          references.push({ name: entry.name, link: entry.link, role: Object.keys(soundRoles)[references.length],
            avoid: false, start: 0, audio, features });
        } catch {
          if (signal.aborted) return;
          failed++;
        }
      }
    } catch { failed = entries.length; }
    if (!finish(run)) return;
    paintReferences();
    paintPublic();
    status.textContent = [references.length ? references.length + ' sound references ready.' : '', failed ?
      'Some references could not be read. Try a supported audio or video file from 1.5 seconds to 4 minutes, up to 16 MiB.' : ''].join(' ').trim();
  }

  files.addEventListener('change', () => {
    const supplied = [...files.files];
    files.value = '';
    const matching = supplied.filter(file => file.size <= soundFileBytes && soundTypes.test(file.name));
    if (!matching.length && supplied.length) status.textContent = 'Choose a supported audio or video file up to 16 MiB.';
    void addReferences(matching.map(file => ({ name: file.name, file })));
  });
  publicSelect.addEventListener('change', paintControls);
  addPublic.addEventListener('click', () => {
    const item = available.find(row => row.link === publicSelect.value);
    if (item) void addReferences([{ ...item, name: item.title }]);
  });
  const stopComparison = () => operation?.controller.abort();
  stop.addEventListener('click', stopComparison);
  copy.addEventListener('click', () => showReportExport(matchExport(matches), { title: 'Copy sound matches', label: 'Public sound matches in Markdown' }));

  function paintMatches() {
    for (const { item, features, score, cues } of matches) {
      const card = element('article', null, 'sound-match');
      const header = element('div', null, 'sound-match-head');
      if (item.cover) {
        const cover = element('img');
        cover.alt = '';
        cover.loading = 'lazy';
        cover.referrerPolicy = 'no-referrer';
        cover.src = item.cover;
        header.append(cover);
      }
      header.append(sourceLink(item.link, item.title + ' ↗', context));
      card.append(header, waveform(features, 'the matching excerpt'), element('p',
        points(score) + '/100 sound fit · Sample near ' + clipTime(features.start), 'sound-match-score'));
      const player = element('audio');
      player.controls = true;
      player.preload = 'none';
      player.src = item.stream;
      player.setAttribute('aria-label', 'Listen to ' + item.title + ' near ' + clipTime(features.start));
      player.addEventListener('loadedmetadata', () => { if (features.start < player.duration) player.currentTime = features.start; }, { once: true });
      player.addEventListener('play', () => {
        for (const other of results.querySelectorAll('audio')) if (other !== player) other.pause();
      });
      const why = element('details', null, 'visual-match-details');
      why.append(element('summary', 'Why this matched'));
      for (const cue of cues) {
        const label = element('label', cueName(cue) + ' · ' + points(cue.score) + '/100');
        const meter = element('meter');
        meter.max = 100;
        meter.value = points(cue.score);
        label.append(meter);
        why.append(label);
      }
      const choose = element('button', 'Add to Deep Search', 'chip');
      choose.type = 'button';
      const title = header.querySelector('a');
      title.id = 'sound-source-' + item.link.split('/').at(-1);
      choose.setAttribute('aria-describedby', title.id);
      choose.addEventListener('click', () => {
        if (picks.has(item.link)) picks.delete(item.link);
        else if (picks.size < soundPickLimit) picks.set(item.link, { link: item.link, seconds: features.start });
        paintSelection();
        onSelection(current);
      });
      buttons.set(item.link, choose);
      card.append(player, why, choose);
      results.append(card);
    }
    copy.hidden = !matches.length;
    paintSelection();
  }

  async function compare() {
    if (operation || action.disabled) return;
    const run = begin('compare');
    const { signal } = run.controller;
    clearMatches();
    status.textContent = 'Reading your selected excerpts…';
    const anchors = [];
    const candidates = comparisonCandidates();
    const completed = [];
    const budget = { remaining: 32 * 1024 * 1024 };
    let checked = 0;
    try {
      for (const reference of references) {
        reference.features ??= await describeSound(reference.audio, reference.start, { signal });
        if (reference.features) anchors.push(reference);
      }
      if (anchors.length !== references.length) throw new Error('A reference excerpt is quiet or too short. Choose another start time.');
      const decode = createSoundDecoder(window);
      const compare = async item => {
        try {
          let recording = profiles.get(item.stream);
          if (!recording) {
            const { audio, stream } = await decodePublicSoundSource(item.stream, decode, signal, budget);
            recording = { windows: await soundWindows(audio, { signal }), stream };
            profiles.set(item.stream, recording);
          }
          completed.push({ item, ...recording });
        } catch { /* Other eligible results can still be compared. */ }
        checked++;
        if (operation === run) status.textContent = 'Checked ' + checked + ' of ' + candidates.length + ' public recordings…';
      };
      for (let index = 0; index < candidates.length && !signal.aborted; index += 2) {
        await Promise.all(candidates.slice(index, index + 2).map(compare));
      }
    } catch (error) {
      if (finish(run)) {
        status.textContent = signal.aborted ? 'Sound comparison stopped.' : error.message;
        if (signal.aborted && document.activeElement === stop) action.focus();
      }
      return;
    }
    if (!finish(run)) return;
    paintReferences();
    const order = new Map(candidates.map((item, index) => [item.link, index]));
    completed.sort((a, b) => order.get(a.item.link) - order.get(b.item.link));
    matches = rankSoundMatches(anchors, completed);
    sampled = true;
    status.textContent = (signal.aborted ? 'Sound comparison stopped. ' : '') + matches.length + ' of ' + candidates.length +
      ' public recordings matched from sampled excerpts.' + (matches.length < candidates.length ? ' Some audio was quiet or unavailable.' : '');
    paintMatches();
    onAnalysisChange();
    if (signal.aborted && document.activeElement === stop) action.focus();
  }
  action.addEventListener('click', compare);

  return {
    clearSelection,
    sceneState(result) {
      return result && result === current ? { clips: comparisonCandidates().filter(item => item.video),
        ready: canDecode && references.length > 0, busy: Boolean(operation), recordings: sampled ? matches : null } : { clips: [] };
    },
    compare,
    stop: stopComparison,
    selected(result) { return result === current ? { available, picks: [...picks.values()] } : {}; },
    show(result, groups, nextContext) {
      const next = result ? soundCandidates(result, groups, nextContext.origin) : [];
      if (result !== current) {
        operation?.controller.abort();
        operation = undefined;
        profiles = new Map();
        clearMatches(false);
        status.textContent = '';
      }
      current = result;
      context = nextContext;
      available = next;
      section.hidden = !available.length;
      paintReferences();
      paintPublic();
      if (!canDecode && available.length) status.textContent = 'Sound matching needs this browser’s audio decoder. You can still play and browse the catalog results.';
    },
    reset() {
      references = [];
      this.show(null, {}, null);
      section.open = false;
    },
  };
}
