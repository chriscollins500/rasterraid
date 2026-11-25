import { mediaUrl, numericId } from './catalog.mjs';
import { civiScribeSidecar, inspectReferenceDocument, inspectReferenceImage, localReferenceBytes, localReferenceLimit, matchReferenceEdits,
  pairReferencePictures, pairReferenceSidecars, pictureIntegrityText } from './reference-provenance.mjs';
import { loadPublicPreview, rankVisualMatches, samplePublicClip, visualPreview, visualRegionLabel, visualRoles, visualScorer } from './visual-analysis.mjs';
import { readVisualReferences, visualReferenceId } from './visual-discovery.mjs';
import { visualPickLimit, visualResearchPicks } from './visual-research.mjs';
import { element, showVisualRegion, sourceLink } from './view.js';

const fileTypes = /^image\/(?:avif|bmp|gif|jpeg|png|webp)$/u;
const fileExtension = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/iu;
const candidateLimit = 24;
const clipLimit = 4;

export const isReferencePictureFile = file => fileTypes.test(file.type) || !file.type && fileExtension.test(file.name);

function clipTime(seconds) {
  const tenths = Math.max(0, Math.round(seconds * 10));
  return Math.floor(tenths / 600) + ':' + String(Math.floor(tenths % 600 / 10)).padStart(2, '0') + '.' + tenths % 10;
}

const cueLabel = cue => (cue.polarity === 'avoid' ? 'Avoid ' : 'Match ') + visualRoles[cue.role].toLowerCase() +
  (cue.region ? ' · ' + visualRegionLabel(cue.region) : cue.regionUnavailable ? ' · whole-preview fallback' : '');
const cuePoints = cue => Math.round(cue.score * 100);
const recordedVersions = reference => reference.metadata?.references.flatMap(({ versionId, modelId }) =>
  numericId(versionId) && versionId <= 2_147_483_647 ? [{ id: versionId, modelId }] : []) ?? [];

export function configureLocalReferences(document, onResearchSelection = () => {}, onAnalysisChange = () => {}, onFilesChanged = () => {}, cropEditor,
  onBriefChange = () => {}) {
  const files = document.getElementById('visual-reference-files');
  const reportFileTypes = files.accept;
  const fileLabel = files.labels[0];
  const fileHelp = document.getElementById('visual-reference-help');
  const reportFileHelp = fileHelp.textContent;
  const setup = document.getElementById('visual-reference-setup');
  const setupTitle = document.getElementById('visual-reference-summary');
  const galleryControls = document.getElementById('gallery-reference-controls');
  const publicUrl = document.getElementById('gallery-reference-url');
  const publicAdd = document.getElementById('gallery-reference-add');
  const composer = document.getElementById('gallery-compose-controls');
  const compose = document.getElementById('visual-compose-search');
  const references = document.getElementById('visual-reference-items');
  const setupStatus = document.getElementById('visual-reference-status');
  const traceControls = document.getElementById('visual-trace-controls');
  const integrityStatus = document.getElementById('visual-picture-integrity');
  const trace = document.getElementById('visual-trace-report');
  const compareEdits = document.getElementById('visual-compare-edits');
  const comparePictures = document.getElementById('visual-compare-pictures');
  const swapPictures = document.getElementById('visual-swap-pictures');
  const compareSidecars = document.getElementById('visual-compare-sidecars');
  const swapSidecars = document.getElementById('visual-swap-sidecars');
  const section = document.getElementById('visual-comparison');
  const action = document.getElementById('visual-compare');
  const stop = document.getElementById('visual-stop');
  const status = document.getElementById('visual-comparison-status');
  const results = document.getElementById('visual-comparison-results');
  const selection = document.getElementById('visual-research-selection');
  const selectionStatus = document.getElementById('visual-research-status');
  const picks = new Map();
  const pickButtons = new Map();
  let selected = [];
  let edits = matchReferenceEdits([]);
  let pictureOrder = [];
  let picturePair = null;
  let sidecarOrder = [];
  let sidecarPair = null;
  let current;
  let reportContext;
  let active;
  let playingClip;
  let importVersion = 0;
  let importing = false;
  let canTrace = false;
  let activeScope;
  let hostContext;
  let publicRequest;
  let clipSamples = null;
  let alignedClips = false;

  function paintPicks() {
    selection.hidden = !picks.size;
    selectionStatus.textContent = picks.size ? picks.size + ' of ' + visualPickLimit + ' public matches selected for Deep Search' : '';
    for (const [link, button] of pickButtons) {
      const chosen = picks.has(link);
      button.setAttribute('aria-pressed', String(chosen));
      button.textContent = chosen ? 'Selected for Deep Search' : 'Add to Deep Search';
      button.disabled = !chosen && picks.size >= visualPickLimit;
    }
  }

  function clearPicks(notify = true) {
    if (!picks.size) return;
    picks.clear();
    paintPicks();
    if (notify) onResearchSelection(current);
  }

  function releaseClip() {
    if (!playingClip) return;
    playingClip.video.pause();
    playingClip.video.removeAttribute('src');
    playingClip.video.load();
    playingClip.video.remove();
    playingClip.button.hidden = false;
    playingClip.thumbnail.hidden = false;
    playingClip = undefined;
  }

  function cancelComparison() {
    active?.abort();
    active = undefined;
    clipSamples = null;
    alignedClips = false;
    releaseClip();
    if (current) delete current.localMatches;
    results.replaceChildren();
    pickButtons.clear();
    clearPicks();
    status.textContent = '';
  }

  function available() {
    const evidence = current?.evidence ?? [];
    const pictures = new Map();
    for (const item of evidence) {
      if (!item.cover || mediaUrl(item.cover) !== item.cover) continue;
      const prior = pictures.get(item.cover);
      if (!prior || prior.video && !item.video) pictures.set(item.cover, item);
    }
    const stills = [...pictures.values()].slice(0, candidateLimit);
    const clips = [...new Map(evidence.filter(item => item.video && item.stream && mediaUrl(item.stream) === item.stream &&
      /\.(?:mp4|webm)$/iu.test(new URL(item.stream).pathname)).map(item => [item.stream, item])).values()].slice(0, clipLimit);
    return { stills, clips };
  }

  function update() {
    const { stills, clips } = available();
    const count = stills.length + clips.length;
    const previewable = selected.some(reference => reference.features);
    const inGallery = activeScope === 'gallery' || activeScope === 'videos';
    const busy = importing || Boolean(publicRequest);
    const full = selected.length >= localReferenceLimit;
    files.disabled = busy || full;
    publicUrl.disabled = busy || full;
    publicAdd.disabled = !inGallery || !canTrace || busy || full || !publicUrl.value.trim();
    compose.disabled = !inGallery || !canTrace || busy || !previewable;
    setupTitle.textContent = inGallery ? 'Visual references' + (selected.length ? ' · ' + selected.length + ' added' : '')
      : 'Pictures and model references';
    section.hidden = !current || !previewable;
    action.textContent = clips.length ? 'Compare pictures and clips' : 'Compare report pictures';
    action.disabled = Boolean(active || importing || !count || !previewable);
    stop.hidden = !active;
    const recorded = selected.some(reference => reference.metadata?.references.length);
    traceControls.hidden = activeScope !== 'report' || !recorded && !edits.sessions.size && !picturePair && !sidecarPair;
    trace.hidden = !recorded;
    trace.disabled = !recorded || importing || !canTrace;
    compareEdits.hidden = !edits.sessions.size;
    compareEdits.disabled = !edits.pairs.some(pairHasModels) || importing || !canTrace;
    comparePictures.hidden = swapPictures.hidden = !picturePair;
    integrityStatus.hidden = !picturePair;
    const integrity = pictureIntegrityText(picturePair?.integrity);
    if (integrity !== integrityStatus.textContent) integrityStatus.textContent = integrity;
    comparePictures.disabled = !picturePair || !pairHasModels(picturePair) || importing || !canTrace;
    swapPictures.disabled = importing;
    compareSidecars.hidden = swapSidecars.hidden = !sidecarPair;
    compareSidecars.disabled = !sidecarPair || !pairHasModels(sidecarPair) || importing || !canTrace;
    swapSidecars.disabled = importing;
    if (!section.hidden && !count) status.textContent = 'This report has no pictures or clips available for local comparison.';
    onAnalysisChange(previewable && !busy);
  }

  function pairHasModels({ original, draft }) {
    return original.references.length || draft.references.length || draft.removed.length;
  }

  function sessionStatus(metadata) {
    const { matched, withModels, ambiguous } = edits.sessions.get(metadata);
    const pending = metadata.editImages.size - matched - ambiguous;
    if (!globalThis.crypto?.subtle) return ['Original-file matching requires a secure browser context'];
    if (!matched && !ambiguous) return ['Add the exact original picture from Metadata Studio'];
    return [
      matched && matched + (matched === 1 ? ' exact original matched' : ' exact originals matched'),
      matched && !withModels && 'No exact model references to compare',
      pending && pending + (pending === 1 ? ' original still needed' : ' originals still needed'),
      ambiguous && 'Multiple edit sessions match an original. Remove one to compare.',
    ].filter(Boolean);
  }

  function drawReferences() {
    edits = matchReferenceEdits(selected.map(reference => reference.metadata));
    const pictures = selected.filter(reference => reference.metadata?.format && reference.metadata.format !== 'unknown');
    pictureOrder = pictures.length === 2 ? pictures : [];
    picturePair = pairReferencePictures(...pictureOrder.map(reference => reference.metadata));
    const sidecars = selected.filter(reference => reference.metadata?.source === civiScribeSidecar);
    sidecarOrder = sidecars.length === 2 ? sidecars : [];
    sidecarPair = pairReferenceSidecars(...sidecarOrder.map(reference => reference.metadata));
    references.replaceChildren();
    for (const reference of selected) {
      const row = element('div', null, 'visual-reference-row');
      const name = element('span', reference.name);
      name.title = reference.name;
      if (reference.canvas) row.append(reference.canvas);
      row.append(name);
      if (reference.features) {
        const role = element('select');
        role.setAttribute('aria-label', 'Trait for ' + reference.name);
        for (const [value, label] of Object.entries(visualRoles)) {
          const option = element('option', label);
          option.value = value;
          role.append(option);
        }
        role.value = reference.role;
        const avoid = element('input');
        avoid.type = 'checkbox';
        avoid.checked = reference.polarity === 'avoid';
        const label = element('label');
        label.append(avoid, element('span', 'Avoid this trait'));
        role.addEventListener('change', () => { reference.role = role.value; cancelComparison(); update(); onBriefChange(); });
        avoid.setAttribute('aria-label', 'Avoid trait from ' + reference.name);
        avoid.addEventListener('change', () => { reference.polarity = avoid.checked ? 'avoid' : 'prefer'; cancelComparison(); update(); onBriefChange(); });
        row.append(role, label);
        if ((activeScope === 'gallery' || activeScope === 'videos') && !reference.mediaId && recordedVersions(reference).length) {
          const examples = element('div', null, 'visual-recorded-examples');
          const consent = element('input');
          consent.type = 'checkbox';
          consent.setAttribute('aria-label', 'Include examples from recorded model versions in ' + reference.name);
          const help = element('small', 'Civitai receives only the version IDs from your file. The picture and its other metadata stay on this device.');
          help.id = 'visual-recorded-help-' + references.children.length;
          consent.setAttribute('aria-describedby', help.id);
          const choice = element('label');
          choice.append(consent, element('span', 'Include examples from recorded model versions'));
          const sync = () => {
            if (avoid.checked) reference.includeRecordedVersions = false;
            consent.disabled = avoid.checked;
            consent.checked = Boolean(reference.includeRecordedVersions);
          };
          sync();
          avoid.addEventListener('change', sync);
          consent.addEventListener('change', () => { reference.includeRecordedVersions = consent.checked; onBriefChange(); });
          examples.append(choice, help);
          row.append(examples);
        }
        if (reference.cropSource && cropEditor) {
          const crop = element('button', reference.region ? 'Edit selected area' : 'Focus on a detail', 'chip');
          crop.type = 'button';
          const regionNote = element('span', reference.region ? 'Selected area · ' + visualRegionLabel(reference.region) : '', 'visual-reference-area');
          regionNote.hidden = !reference.region;
          crop.addEventListener('click', async () => {
            crop.disabled = true;
            try {
              const chosen = await cropEditor.choose(reference.cropSource, reference.region);
              if (!chosen || !selected.includes(reference)) return;
              const preview = chosen.region ? chosen : reference.fullPreview;
              reference.canvas.replaceWith(preview.canvas);
              const { canvas, features, focus } = preview;
              Object.assign(reference, { canvas, features, focus, region: chosen.region });
              crop.textContent = chosen.region ? 'Edit selected area' : 'Focus on a detail';
              regionNote.hidden = !chosen.region;
              regionNote.textContent = chosen.region ? 'Selected area · ' + visualRegionLabel(chosen.region) : '';
              cancelComparison();
              update();
              onBriefChange();
            } catch (error) {
              setupStatus.textContent = error.message;
            } finally {
              crop.disabled = false;
              if (crop.isConnected) crop.focus({ preventScroll: true });
            }
          });
          row.append(crop, regionNote);
        }
      }
      const remove = element('button', 'Remove', 'chip');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + reference.name);
      remove.addEventListener('click', () => {
        selected = selected.filter(item => item !== reference);
        setupStatus.textContent = '';
        cancelComparison();
        drawReferences();
        (references.querySelector('select') ?? files).focus();
        onFilesChanged();
        onBriefChange();
      });
      row.append(remove);
      const count = reference.metadata?.references.length || 0;
      const conflicts = reference.metadata?.conflicts || 0;
      const side = reference === pictureOrder[0] ? 'Original picture' : reference === pictureOrder[1] ? 'Revised picture'
        : reference === sidecarOrder[0] ? 'Original sidecar' : reference === sidecarOrder[1] ? 'Revised sidecar' : '';
      const countLabel = count ? count + ' recorded ' + (count === 1 ? 'model reference' : 'model references')
        : side || reference.metadata?.source ? 'No exact model references' : 'Visual reference';
      const conflictLabel = conflicts ? conflicts + ' flagged ' + (conflicts === 1 ? 'conflict' : 'conflicts') + ' skipped' : '';
      const details = reference.metadata?.editImages ? sessionStatus(reference.metadata) : [countLabel, conflictLabel];
      if (reference.mediaId || activeScope === 'report') row.append(element('p', reference.mediaId
        ? reference.video ? 'Civitai video poster' : 'Civitai picture'
        : [side, reference.metadata?.source, ...details].filter(Boolean).join(' · '), 'visual-reference-records'));
      references.append(row);
    }
    update();
  }

  function swapReferenceOrder(order, message) {
    if (order.length !== 2 || importing) return;
    const [original, revised] = order.map(reference => selected.indexOf(reference));
    [selected[original], selected[revised]] = [selected[revised], selected[original]];
    cancelComparison();
    drawReferences();
    onFilesChanged();
    setupStatus.textContent = message;
  }
  swapPictures.addEventListener('click', () => swapReferenceOrder(pictureOrder, 'Original and revised pictures swapped.'));
  swapSidecars.addEventListener('click', () => swapReferenceOrder(sidecarOrder, 'Original and revised sidecars swapped.'));

  function defaultRole() {
    const roles = Object.keys(visualRoles);
    return roles[selected.filter(reference => reference.features).length % roles.length];
  }

  async function addPublic(id, context, trigger) {
    if (!id || !context || !canTrace || importing || publicRequest) return false;
    setup.open = true;
    if (selected.some(ref => ref.mediaId === id)) {
      setupStatus.textContent = 'This Civitai reference is already added.';
      return false;
    }
    if (selected.length >= localReferenceLimit) {
      setupStatus.textContent = 'Remove a reference to add another.';
      return false;
    }
    const controller = new AbortController();
    publicRequest = controller;
    update();
    setupStatus.textContent = 'Checking this preview on Civitai…';
    let added = false;
    try {
      const { signal } = controller;
      const [media] = await readVisualReferences(context, [id], { signal });
      if (!media?.preview || mediaUrl(media.preview) !== media.preview) {
        throw new Error('Civitai did not return an eligible picture or clip preview.');
      }
      const cropSource = signal => loadPublicPreview(document, media.preview, signal);
      const decoded = await visualPreview(await cropSource(signal), document, { signal });
      signal.throwIfAborted();
      const name = (media.video ? 'Clip #' : 'Picture #') + media.id;
      selected.push({ ...decoded, name, role: defaultRole(), polarity: 'prefer', mediaId: id, video: media.video,
        publicPreview: media.preview, cropSource, fullPreview: decoded });
      publicUrl.value = '';
      setupStatus.textContent = name + ' added from Civitai.';
      added = true;
      cancelComparison();
      onBriefChange();
    } catch (error) {
      if (!controller.signal.aborted) setupStatus.textContent = error.message || 'Civitai could not open this preview.';
    } finally {
      if (publicRequest === controller) {
        publicRequest = undefined;
        drawReferences();
        if (added) references.lastElementChild?.querySelector('select')?.focus();
        else if (trigger?.isConnected) trigger.focus();
      }
    }
    return added;
  }

  function addUrl(trigger) {
    const id = visualReferenceId(publicUrl.value.trim());
    if (id) return void addPublic(id, hostContext, trigger);
    setupStatus.textContent = 'Enter a Civitai image page link, such as https://civitai.com/images/135405057.';
    publicUrl.focus();
  }
  publicUrl.addEventListener('input', update);
  publicUrl.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (!publicAdd.disabled) addUrl(publicUrl);
  });
  publicAdd.addEventListener('click', () => addUrl(publicUrl));

  async function addFiles(supplied, { pictureSearch = false } = {}) {
    if (!supplied.length || importing || publicRequest) return false;
    const chosen = supplied.slice(0, localReferenceLimit - selected.length);
    if (!chosen.length) {
      setupStatus.textContent = 'Remove a reference to add another.';
      return false;
    }
    const version = ++importVersion;
    importing = true;
    setupStatus.textContent = 'Reading local references…';
    drawReferences();
    let rejected = 0;
    let emptyDocuments = 0;
    let added = 0;
    for (const file of chosen) {
      let decoded;
      let metadata;
      try {
        if (file.size > localReferenceBytes) throw new Error('File unavailable.');
        if (file.type === 'application/json' || /\.json$/iu.test(file.name)) {
          metadata = await inspectReferenceDocument(file);
          if (!metadata.references.length && !metadata.editImages) emptyDocuments++;
        } else {
          if (!isReferencePictureFile(file)) throw new Error('File unavailable.');
          const [preview, recorded] = await Promise.allSettled([visualPreview(file, document), inspectReferenceImage(file, { hashOriginal: true })]);
          decoded = preview.status === 'fulfilled' ? preview.value : null;
          metadata = recorded.status === 'fulfilled' ? recorded.value : null;
          if (!decoded && !metadata?.references.length && !metadata?.imageDigest) rejected++;
        }
      } catch { rejected++; }
      if (version !== importVersion) return false;
      if (pictureSearch && !decoded) {
        if (metadata?.imageDigest || metadata?.references.length) rejected++;
        continue;
      }
      if (decoded || metadata?.references.length || metadata?.conflicts || metadata?.editImages || metadata?.imageDigest ||
          metadata?.source === civiScribeSidecar) {
        selected.push({ ...decoded, metadata, name: file.name.slice(0, 100), role: defaultRole(), polarity: 'prefer',
          ...(decoded && { cropSource: file, fullPreview: decoded }) });
        added++;
      }
    }
    importing = false;
    cancelComparison();
    drawReferences();
    const paired = edits.pairs.length;
    setupStatus.textContent = [
      selected.length ? selected.length + (selected.length === 1 ? ' reference added.' : ' references added.') : '',
      paired ? paired + (paired === 1 ? ' original matched an edit session.' : ' originals matched their edit sessions.') : '',
      rejected ? 'Some files could not be read. Choose pictures or supported metadata JSON up to 24 MB.' : '',
      emptyDocuments ? 'Some metadata files had no exact model version or full file hash.' : '',
      supplied.length > chosen.length ? 'You can add up to four reference files.' : '',
    ].filter(Boolean).join(' ');
    if (added) { onFilesChanged(); onBriefChange(); }
    return Boolean(added);
  }

  files.addEventListener('change', () => {
    const supplied = [...(files.files ?? [])];
    files.value = '';
    void addFiles(supplied);
  });

  const stopComparison = () => active?.abort();
  stop.addEventListener('click', stopComparison);

  async function compare({ alignSound = false } = {}) {
    const score = visualScorer(selected);
    if (!current || active || !score) return;
    const report = current;
    const context = reportContext;
    const { stills, clips } = available();
    cancelComparison();
    const controller = new AbortController();
    const { signal } = controller;
    active = controller;
    update();
    const inspected = [];
    for (let i = 0; i < stills.length && !signal.aborted; i += 4) {
      status.textContent = (score.profiles.length ? 'Finding matching areas' : 'Comparing local image traits') + ' · ' + i + ' of ' + stills.length;
      const batch = await Promise.allSettled(stills.slice(i, i + 4).map(async item => {
        const preview = await loadPublicPreview(document, item.cover, signal);
        preview.alt = '';
        return { item, preview, ...await visualPreview(preview, document, { scorer: score, signal }) };
      }));
      if (current !== report || active !== controller) return;
      inspected.push(...batch.flatMap(row => row.status === 'fulfilled' ? [row.value] : []));
    }
    const picturesCompared = inspected.length;
    const sampled = new Set();
    let frameCount = 0;
    for (let i = 0; i < clips.length && !signal.aborted; i += 2) {
      status.textContent = (alignSound ? 'Sampling frames inside sound excerpts' : 'Sampling short clips') + ' · ' + i + ' of ' + clips.length;
      const batch = await Promise.allSettled(clips.slice(i, i + 2).map(async item =>
        (await samplePublicClip(document, item.stream, signal, score, { alignSound })).map(frame => ({ item, ...frame }))));
      if (current !== report || active !== controller) return;
      for (const row of batch) if (row.status === 'fulfilled' && row.value.length) {
        sampled.add(row.value[0].item.link);
        frameCount += row.value.length;
        inspected.push(...row.value);
      }
    }
    const seen = new Set();
    const candidates = inspected.filter(({ item, timestamp }) => !sampled.has(item.link) || Number.isFinite(timestamp));
    const ranked = rankVisualMatches(selected, candidates);
    clipSamples = ranked.filter(row => Number.isFinite(row.timestamp)).map(({ item, timestamp, stream, score, cues, preview }) =>
      ({ item, timestamp, stream, score, cues, preview }));
    alignedClips = alignSound;
    const matches = ranked.filter(({ item }) => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    }).slice(0, 6);
    const previewLabel = ({ item, timestamp }) => Number.isFinite(timestamp)
      ? ' · Frame near ' + clipTime(timestamp) : item.video ? ' · Poster preview' : '';
    report.localMatches = matches.map(match => ({ title: match.item.title + previewLabel(match), link: match.item.link,
      detail: match.cues.map(cue => cueLabel(cue) + ' ' + cuePoints(cue) + '/100').join(' · ') }));
    const tally = new Intl.ListFormat().format([
      ...(stills.length ? [picturesCompared + ' of ' + stills.length + ' pictures'] : []),
      ...(clips.length ? [sampled.size + ' of ' + clips.length + ' clips'] : []),
    ]);
    const frameTally = frameCount ? ' · ' + frameCount + ' sampled ' + (frameCount === 1 ? 'frame' : 'frames') : '';
    status.textContent = candidates.length ? (signal.aborted ? 'Stopped early. ' : '') + 'Compared ' + tally + ' in this browser' + frameTally + '.'
      : signal.aborted ? 'Comparison stopped.' : 'The browser could not read the report’s picture or clip pixels for comparison.';
    for (const match of matches) {
      const { item, canvas, preview, timestamp, stream, cues } = match;
      const picture = preview ?? canvas;
      const region = cues.find(cue => cue.region && cue.polarity !== 'avoid')?.region ?? cues.find(cue => cue.region)?.region;
      const thumbnail = showVisualRegion(picture, region);
      const card = element('article', null, 'visual-match');
      const link = sourceLink(item.link, '', context);
      link.setAttribute('aria-label', 'Open ' + item.title + ' on Civitai');
      thumbnail.setAttribute('aria-hidden', 'true');
      link.append(thumbnail, element('span', item.title + previewLabel(match)));
      card.append(link);
      if (Number.isFinite(timestamp)) {
        const watch = element('button', 'Watch preview near ' + clipTime(timestamp), 'chip');
        watch.type = 'button';
        watch.addEventListener('click', () => {
          releaseClip();
          const video = element('video');
          const url = new URL(stream);
          url.hash = 't=' + timestamp.toFixed(2);
          video.controls = true;
          video.playsInline = true;
          video.preload = 'metadata';
          video.muted = true;
          video.setAttribute('aria-label', 'Play ' + item.title + ' near ' + clipTime(timestamp));
          playingClip = { video, button: watch, thumbnail };
          watch.hidden = true;
          thumbnail.hidden = true;
          watch.after(video);
          video.src = url.href;
          video.focus();
          video.play().catch(() => {});
        });
        card.append(watch);
      }
      const pick = { link: item.link, timestamp };
      const [eligible] = visualResearchPicks(report, context.origin, [pick]);
      if (eligible && (!Number.isFinite(timestamp) || eligible.kind === 'clip')) {
        const add = element('button', '', 'chip');
        add.type = 'button';
        add.setAttribute('aria-label', 'Use ' + item.title + previewLabel(match) + ' in Deep Search');
        add.addEventListener('click', () => {
          if (current !== report) return;
          if (picks.has(pick.link)) picks.delete(pick.link);
          else if (picks.size < visualPickLimit) picks.set(pick.link, pick);
          paintPicks();
          onResearchSelection(report);
        });
        pickButtons.set(item.link, add);
        card.append(add);
      }
      const why = element('details', null, 'visual-match-details');
      why.append(element('summary', 'Match details'));
      for (const cue of cues) {
        const points = cuePoints(cue);
        const label = element('label', cueLabel(cue) + ' · ' + points + '/100');
        const meter = element('meter');
        meter.max = 100;
        meter.value = points;
        label.append(meter);
        why.append(label);
      }
      card.append(why);
      results.append(card);
    }
    paintPicks();
    const restoreFocus = signal.aborted && document.activeElement === stop;
    active = undefined;
    update();
    if (restoreFocus) action.focus();
  }
  action.addEventListener('click', compare);

  return {
    setScope(scope, context) {
      hostContext = context;
      if (scope === activeScope) return;
      activeScope = scope;
      const gallery = scope === 'gallery' || scope === 'videos';
      setup.hidden = scope !== 'report' && !gallery;
      galleryControls.hidden = composer.hidden = !gallery;
      fileLabel.textContent = gallery ? 'Add pictures from this device' : 'Add up to four pictures or metadata files';
      files.accept = gallery ? reportFileTypes.split(',').filter(type => type.startsWith('image/')).join(',') : reportFileTypes;
      fileHelp.textContent = gallery ? 'Use up to four references in any mix.' : reportFileHelp;
      compose.textContent = scope === 'videos' ? 'Find clips by reference' : 'Find pictures by reference';
      drawReferences();
    },
    addPublic, addFiles,
    brief() {
      return selected.flatMap(reference => {
        const { name, role, polarity, features, focus, region, mediaId, publicPreview, includeRecordedVersions } = reference;
        if (!features) return [];
        const versions = !mediaId && polarity !== 'avoid' && includeRecordedVersions ? recordedVersions(reference) : [];
        return [{ label: name, role, polarity, features, focus, region, mediaId, publicPreview,
          ...(versions.length && { recordedVersions: versions }) }];
      });
    },
    subjectReferences(brief) {
      if (!brief || brief.unavailableReferences) return [];
      const pictures = selected.filter(reference => reference.features);
      if (pictures.length !== brief.cues.length) return [];
      return pictures.flatMap((reference, index) => {
        const cue = brief.cues[index];
        const { name, cropSource, region, role, polarity, mediaId, publicPreview } = reference;
        if (cue.label !== name || cue.role !== role || cue.polarity !== polarity || cue.region?.join() !== region?.join()) return [];
        const anchor = { label: name, region, avoidInBrief: polarity === 'avoid' };
        if (!cue.public && cropSource instanceof Blob) return [{ ...anchor, file: cropSource }];
        if (cue.public && cue.public.id === mediaId && cue.public.preview === publicPreview && mediaUrl(publicPreview) === publicPreview) {
          return [{ ...anchor, cover: publicPreview, kind: cue.public.video ? 'Video poster' : 'Picture' }];
        }
        return [];
      });
    },
    recorded() { return selected.flatMap(reference => reference.metadata?.references.length ? [reference.metadata] : []); },
    pairedEdits() { return edits.pairs.filter(pairHasModels); },
    pairedPictures() { return picturePair && pairHasModels(picturePair) ? [picturePair] : []; },
    pairedSidecars() { return sidecarPair && pairHasModels(sidecarPair) ? [sidecarPair] : []; },
    sceneState(report) {
      return report && current === report ? { clips: available().clips, ready: selected.some(row => row.features) && !importing,
        busy: Boolean(active), frames: clipSamples, aligned: alignedClips } : { clips: [] };
    },
    compare,
    stop: stopComparison,
    researchSelection(report) { return report && current === report ? [...picks.values()] : []; },
    clearResearchSelection: clearPicks,
    enableLookup(enabled) {
      canTrace = enabled;
      update();
    },
    show(report, context) {
      if (report !== current) cancelComparison();
      current = report;
      reportContext = context;
      update();
    },
    reset() {
      importVersion++;
      importing = false;
      publicRequest?.abort();
      publicRequest = undefined;
      publicUrl.value = '';
      selected = [];
      setupStatus.textContent = '';
      cancelComparison();
      drawReferences();
    },
  };
}
