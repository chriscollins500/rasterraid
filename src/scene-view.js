import { reportMarkdown } from './report.mjs';
import { showReportExport } from './report-view.js';
import { publicScenePicks, rankSceneMatches, scenePickLimit, sceneSummary, sceneTime } from './scene-research.mjs';
import { soundRoles } from './sound-analysis.mjs';
import { visualRegionLabel, visualRoles } from './visual-analysis.mjs';
import { element, showVisualRegion, sourceLink } from './view.js';

export function configureSceneMatch(document, picture, sound, onSelection) {
  const byId = id => document.getElementById(id);
  const section = byId('scene-comparison');
  const compare = byId('scene-compare');
  const stop = byId('scene-stop');
  const copy = byId('scene-copy');
  const status = byId('scene-status');
  const results = byId('scene-results');
  const selections = byId('scene-selection');
  const pickedStatus = byId('scene-selected');
  const picks = new Map();
  const pickButtons = new Map();
  let current;
  let context;
  let frames;
  let recordings;
  let matches = [];
  let playing;
  let combined;

  function paintPicks() {
    selections.hidden = !picks.size;
    pickedStatus.textContent = picks.size ? picks.size + ' of ' + scenePickLimit + ' scenes selected for Deep Search' : '';
    for (const [link, button] of pickButtons) {
      const added = picks.has(link);
      button.setAttribute('aria-pressed', String(added));
      button.textContent = added ? 'Selected for Deep Search' : 'Add to Deep Search';
      button.disabled = !added && picks.size >= scenePickLimit;
    }
  }

  function clearSelection(notify = true) {
    if (!picks.size) return;
    picks.clear();
    paintPicks();
    if (notify) onSelection(current);
  }

  function releasePlayer() {
    if (!playing) return;
    playing.video.pause();
    playing.video.removeAttribute('src');
    playing.video.load();
    playing.video.remove();
    playing.poster.hidden = false;
    playing = undefined;
  }

  function paintMatches() {
    releasePlayer();
    pickButtons.clear();
    results.replaceChildren();
    copy.hidden = !matches.length;
    const report = current?.report;
    if (!report) return;
    delete report.localScenes;
    if (!matches.length) return;
    report.localScenes = matches.map(row => ({ title: row.source.title, link: row.source.link, detail: sceneSummary(row) }));
    for (const row of matches) {
      const { source, start, duration } = row;
      const card = element('article', null, 'visual-match scene-match');
      const link = sourceLink(source.link, source.title, context);
      const preview = element('div', null, 'scene-preview');
      const poster = element('canvas');
      poster.setAttribute('aria-hidden', 'true');
      poster.width = row.preview.width;
      poster.height = row.preview.height;
      poster.getContext('2d')?.drawImage(row.preview, 0, 0);
      const region = row.pictureCues.find(cue => cue.region && cue.polarity !== 'avoid')?.region ??
        row.pictureCues.find(cue => cue.region)?.region;
      const frame = showVisualRegion(poster, region);
      preview.append(frame);
      const watch = element('button', 'Play excerpt near ' + sceneTime(start), 'chip');
      watch.type = 'button';
      watch.addEventListener('click', () => {
        releasePlayer();
        const video = element('video');
        const url = new URL(row.stream);
        url.hash = 't=' + start.toFixed(3) + ',' + (start + duration).toFixed(3);
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.setAttribute('aria-label', 'Matched excerpt from ' + source.title);
        playing = { video, poster: frame };
        frame.hidden = true;
        preview.append(video);
        video.src = url.href;
        video.play().catch(() => {});
      });
      const cues = element('details', null, 'visual-match-details');
      cues.append(element('summary', 'Match details'));
      for (const [kind, values, roles] of [['Picture', row.pictureCues, visualRoles], ['Sound', row.soundCues, soundRoles]]) {
        for (const cue of values) {
          const name = (cue.avoid || cue.polarity === 'avoid' ? 'Avoid ' : 'Match ') + roles[cue.role].toLowerCase();
          const label = element('label', kind + ' · ' + name + (cue.region ? ' · ' + visualRegionLabel(cue.region) : '') +
            ' · ' + Math.round(cue.score * 100) + '/100');
          const meter = element('meter');
          meter.max = 100;
          meter.value = Math.round(cue.score * 100);
          label.append(meter);
          cues.append(label);
        }
      }
      const pick = element('button', '', 'chip');
      pick.type = 'button';
      pick.setAttribute('aria-label', 'Use ' + source.title + ' in Deep Search');
      pick.addEventListener('click', () => {
        if (current?.report !== report) return;
        if (picks.has(source.link)) picks.delete(source.link);
        else if (picks.size < scenePickLimit) picks.set(source.link, { link: source.link, stream: row.stream, timestamp: row.timestamp, start, duration });
        paintPicks();
        onSelection(current);
      });
      pickButtons.set(source.link, pick);
      const timing = element('p', 'Frame near ' + sceneTime(row.timestamp) + ' · Sound ' + sceneTime(start) + '–' + sceneTime(start + duration));
      const grades = element('p', null, 'scene-grades');
      grades.append(element('strong', Math.round(row.score * 100) + '/100 combined'),
        element('span', 'Picture ' + Math.round(row.pictureScore * 100) + '/100 · Sound ' + Math.round(row.soundScore * 100) + '/100'));
      card.append(link, preview, timing, grades, watch, cues, pick);
      results.append(card);
    }
    paintPicks();
  }

  function show(result, currentContext) {
    const sourceChanged = result !== current;
    if (sourceChanged) {
      if (current?.report) delete current.report.localScenes;
      combined = undefined;
    }
    current = result;
    context = currentContext;
    const visual = picture.sceneState(result?.report);
    const audio = sound.sceneState(result);
    const authorized = new Map(audio.clips.map(item => [item.link, item.stream]));
    const clips = visual.clips.filter(item => authorized.get(item.link) === item.stream).length;
    const wasHidden = section.hidden;
    section.hidden = !result?.report || !visual.ready || !clips;
    const busy = visual.busy || audio.busy;
    const changed = sourceChanged || wasHidden !== section.hidden || frames !== visual.frames || recordings !== audio.recordings;
    if (changed) {
      const selected = picks.size;
      clearSelection(false);
      frames = visual.frames;
      recordings = audio.recordings;
      matches = !section.hidden && frames && recordings ? rankSceneMatches(frames, recordings).flatMap(row => {
        const [source] = publicScenePicks(result.report, context.origin, [{ link: row.item.link, timestamp: row.timestamp }]);
        return source?.stream === row.item.stream && row.preview ? [{ ...row, source }] : [];
      }) : [];
      paintMatches();
      if (selected && !sourceChanged) onSelection(current);
    }
    if (busy) compare.setAttribute('aria-disabled', 'true');
    else compare.removeAttribute('aria-disabled');
    compare.textContent = audio.ready ? 'Compare both' : 'Choose a sound reference';
    stop.hidden = !combined || !busy;
    status.textContent = section.hidden ? '' : busy ? 'Comparing picture and sound in your browser…' : matches.length
      ? matches.length + ' of ' + clips + ' clips with overlapping picture and sound samples.'
      : frames && recordings ? 'No matching samples overlapped in the same public clip. You can still browse the separate matches.'
        : 'Find where the picture and sound traits occur in the same excerpt.';
  }

  compare.addEventListener('click', async () => {
    if (section.hidden || combined || compare.hasAttribute('aria-disabled')) return;
    const currentResult = current;
    const audio = sound.sceneState(currentResult);
    if (!audio.ready) {
      byId('sound-comparison').open = true;
      (byId('sound-files').disabled ? byId('sound-comparison').querySelector('summary') : byId('sound-files')).focus();
      return;
    }
    const run = { stopped: false };
    combined = run;
    const needPictures = !frames?.length || !picture.sceneState(currentResult?.report).aligned;
    const needSound = !recordings?.length;
    const repeat = !needPictures && !needSound;
    const tasks = [needPictures || repeat ? picture.compare({ alignSound: true }) : null, needSound || repeat ? sound.compare() : null];
    await Promise.allSettled(tasks);
    if (combined !== run) return;
    combined = undefined;
    show(current, context);
    if (run.stopped && current === currentResult && !section.hidden) compare.focus({ preventScroll: true });
  });
  stop.addEventListener('click', () => {
    if (combined) combined.stopped = document.activeElement === stop;
    picture.stop();
    sound.stop();
  });
  copy.addEventListener('click', () => {
    if (!current?.report || !matches.length) return;
    showReportExport(reportMarkdown(current.report), { title: 'Copy report with matched scenes', label: 'Report in Markdown' });
  });

  return { show, clearSelection, selected(result) { return result === current ? [...picks.values()] : []; } };
}
