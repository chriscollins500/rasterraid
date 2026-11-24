import { clipAnalysisUrl } from './catalog.mjs';
import { soundMaximumSeconds, soundWindowSeconds, soundWindowStarts } from './sound-analysis.mjs';
import { describeMotion, motionPlaneSize, motionSamplePositions } from './video-motion.mjs';
import { proposePictureRegions, regionSignature, regionTable } from './visual-region-search.mjs';

const size = 64;
const cellGrid = 4;
const colorBins = 24;
const tonalBins = 16;
const minimumRegion = .12;
const entirePicture = [0, 0, 1, 1];
const colorDirections = Array.from({ length: 8 }, (_, index) => {
  const angle = Math.PI * index / 8;
  return [Math.cos(angle), Math.sin(angle)];
});
export const visualRoles = { palette: 'Color palette', lighting: 'Lighting', composition: 'Layout', texture: 'Texture' };

const linear = Array.from({ length: 256 }, (_, i) => {
  const s = i / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

function oklab(r, g, b) {
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return [.2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s];
}

const unit = value => Math.max(0, Math.min(1, value));
const bin = (value, count) => Math.min(count - 1, Math.floor(unit(value) * count));

export function visualRegion(value) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [left, top, right, bottom] = value;
  if ([left, top, right, bottom].some(edge => !Number.isFinite(edge) || edge < 0 || edge > 1)) return null;
  if (right - left + 1e-9 < minimumRegion || bottom - top + 1e-9 < minimumRegion) return null;
  return left === 0 && top === 0 && right === 1 && bottom === 1 ? null : [left, top, right, bottom];
}

export function visualRegionLabel([left, top, right, bottom]) {
  if (left === 0 && top === 0 && right === 1 && bottom === 1) return 'whole picture';
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  const vertical = y < .4 ? 'upper' : y > .6 ? 'lower' : '';
  const horizontal = x < .4 ? 'left' : x > .6 ? 'right' : '';
  return [vertical, horizontal].filter(Boolean).join(' ') || 'center';
}

function sourceDimensions(bitmap) {
  return [bitmap.naturalWidth ?? bitmap.videoWidth ?? bitmap.width, bitmap.naturalHeight ?? bitmap.videoHeight ?? bitmap.height];
}

function focusProfile(region, width, height) {
  const cropWidth = region[2] - region[0];
  const cropHeight = region[3] - region[1];
  const aspect = width * cropWidth / (height * cropHeight);
  return { aspect: Number(aspect.toFixed(3)),
    scale: Math.max(minimumRegion, Math.round(Math.max(cropWidth, cropHeight) * 20) / 20) };
}

function candidateRegions({ aspect, scale }, width, height) {
  const ratio = aspect * height / width;
  const grid = (scale, limit) => {
    const w = Math.min(1, ratio) * scale;
    const h = Math.min(1, 1 / ratio) * scale;
    const steps = length => Math.min(limit, Math.max(2, Math.ceil((1 - length) / (length * .65)) + 1));
    const columns = steps(w);
    const rows = steps(h);
    const regions = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      const left = (1 - w) * x / (columns - 1);
      const top = (1 - h) * y / (rows - 1);
      regions.push([left, top, Math.min(1, left + w), Math.min(1, top + h)]);
    }
    return regions;
  };
  const smaller = Math.max(minimumRegion, scale * .68);
  const larger = Math.min(.95, Math.max(.4, scale * 1.45));
  return [...(ratio >= .75 && ratio <= 1.33 ? [entirePicture] : []), ...grid(scale, 5),
    ...(scale - smaller >= .05 ? grid(smaller, 3) : []),
    ...(larger - scale >= .07 ? grid(larger, 3) : [])];
}

function addBin(values, position, weight = 1) {
  const offset = unit(position) * (values.length - 1);
  const first = Math.floor(offset);
  const fraction = offset - first;
  values[first] += weight * (1 - fraction);
  if (fraction) values[first + 1] += weight * fraction;
}

function normalize(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total ? values.map(value => value / total) : values;
}

// One-dimensional transport on linearly spaced bins.
function transport(first, second) {
  let running = 0;
  let distance = 0;
  for (let i = 0; i < first.length - 1; i++) {
    running += first[i] - second[i];
    distance += Math.abs(running);
  }
  return distance / (first.length - 1);
}

function projectionDistance(first, second) {
  return first.reduce((sum, row, index) => sum + transport(row, second[index]), 0) / first.length;
}

const overlap = (first, second) => first.reduce((sum, value, i) => sum + Math.min(value, second[i]), 0);

export function describeVisuals(data) {
  if (data?.length !== size * size * 4) throw new TypeError('Expected normalized image pixels.');
  const color = colorDirections.map(() => new Float64Array(colorBins));
  const accents = colorDirections.map(() => new Float64Array(colorBins));
  const neutralTones = new Float64Array(tonalBins);
  const lighting = new Float64Array(8);
  const lightByCell = new Float64Array(cellGrid ** 2);
  const edgesByCell = new Float64Array(cellGrid ** 2);
  const texture = new Float64Array(8);
  const luminance = new Float64Array(size * size);
  const colorA = new Float32Array(luminance.length);
  const colorB = new Float32Array(luminance.length);
  const cellSize = size / cellGrid;
  let lightSum = 0;
  let lightSquareSum = 0;
  let accentWeight = 0;
  let neutralWeight = 0;
  for (let pixel = 0; pixel < luminance.length; pixel++) {
    const offset = pixel * 4;
    const [light, a, b] = oklab(linear[data[offset]], linear[data[offset + 1]], linear[data[offset + 2]]);
    luminance[pixel] = light;
    colorA[pixel] = a;
    colorB[pixel] = b;
    const cell = Math.floor(pixel / (size * cellSize)) * cellGrid + Math.floor((pixel % size) / cellSize);
    lightByCell[cell] += light;
    lightSum += light;
    lightSquareSum += light ** 2;
    lighting[bin(light, lighting.length)]++;
    const chroma = Math.hypot(a, b);
    const accent = unit((chroma - .045) / .18);
    const neutral = unit(1 - chroma / .045);
    accentWeight += accent;
    neutralWeight += neutral;
    if (neutral) addBin(neutralTones, light, neutral);
    for (let index = 0; index < colorDirections.length; index++) {
      const [x, y] = colorDirections[index];
      const projected = .5 + (x * a + y * b) / .72;
      addBin(color[index], projected);
      if (accent) addBin(accents[index], projected, accent);
    }
  }
  for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
    const i = y * size + x;
    const dx = luminance[i + 1] - luminance[i - 1];
    const dy = luminance[i + size] - luminance[i - size];
    const lumaEdge = Math.hypot(dx, dy);
    const colorEdge = Math.hypot(colorA[i + 1] - colorA[i - 1], colorB[i + 1] - colorB[i - 1],
      colorA[i + size] - colorA[i - size], colorB[i + size] - colorB[i - size]);
    const edge = Math.hypot(lumaEdge, colorEdge * .6);
    edgesByCell[Math.floor(y / cellSize) * cellGrid + Math.floor(x / cellSize)] += edge;
    texture[bin(Math.sqrt(lumaEdge), texture.length)]++;
  }
  const mean = lightSum / luminance.length;
  const deviation = Math.sqrt(Math.max(.075 ** 2, lightSquareSum / luminance.length - mean ** 2));
  return {
    palette: { color: color.map(normalize), accents: accents.map(normalize), neutralTones: normalize(neutralTones),
      accentShare: accentWeight / luminance.length, neutralShare: neutralWeight / luminance.length },
    lighting: normalize(lighting),
    composition: { light: lightByCell.map(value => unit(.5 + (value / (cellSize ** 2) - mean) / (4 * deviation))),
      edges: normalize(edgesByCell) },
    texture: normalize(texture),
  };
}

function paletteMatch(reference, candidate) {
  const wholePicture = projectionDistance(reference.color, candidate.color);
  // Accents need enough chroma and pixel coverage to distinguish them from noise.
  const emphasis = .32 * unit(reference.accentShare / .02);
  const coverage = reference.accentShare ? unit(candidate.accentShare / reference.accentShare) : 0;
  const accentShift = coverage ? projectionDistance(reference.accents, candidate.accents) : 0;
  const accents = coverage * accentShift + .16 * (1 - coverage);
  const neutral = Math.min(reference.neutralShare, candidate.neutralShare) *
    transport(reference.neutralTones, candidate.neutralTones);
  return Math.exp(-8 * ((1 - emphasis) * wholePicture + emphasis * accents) - 2 * neutral);
}

function layoutMatch(reference, candidate) {
  const light = reference.light.reduce((sum, value, i) => sum + Math.abs(value - candidate.light[i]), 0);
  const edges = reference.edges.reduce((sum, value, i) => sum + (Math.sqrt(value) - Math.sqrt(candidate.edges[i])) ** 2, 0) / 2;
  return Math.exp(-5 * light / reference.light.length - 1.2 * edges);
}

const matching = {
  palette: paletteMatch,
  lighting: overlap,
  composition: layoutMatch,
  texture: overlap,
};

export function visualScorer(references) {
  const selected = references.filter(reference => Object.hasOwn(visualRoles, reference.role) && reference.features?.[reference.role]);
  if (!selected.length) return null;
  const groups = new Map();
  for (const reference of selected) {
    if (!groups.has(reference.focus)) groups.set(reference.focus, []);
    groups.get(reference.focus).push(reference);
  }
  const profiles = [...groups.keys()].filter(Boolean);
  const similarity = ({ role, features }, candidate) => unit(matching[role](features[role], candidate[role]));
  function score(candidate, windows = []) {
    const matches = new Map();
    for (const profile of profiles) {
      const references = groups.get(profile);
      let best = null;
      let support = -1;
      for (const window of windows) {
        if (window.focus !== profile) continue;
        const fit = references.reduce((product, reference) => product * similarity(reference, window.features), 1);
        if (fit > support) {
          best = window;
          support = fit;
        }
      }
      if (best) matches.set(profile, best);
    }
    const cues = selected.map(reference => {
      const { role, polarity, focus } = reference;
      const match = matches.get(focus);
      const same = similarity(reference, match?.features ?? candidate);
      return { role, polarity, score: polarity === 'avoid' ? 1 - same : same,
        ...(reference.label && { label: reference.label }),
        ...(match && { region: match.region }), ...(focus && !match && { regionUnavailable: true }) };
    });
    const support = cues.reduce((product, cue) => product * cue.score, 1);
    return { cues, score: support ** (1 / cues.length),
      mean: cues.reduce((sum, cue) => sum + cue.score, 0) / cues.length };
  }
  return Object.assign(score, { profiles, rolesFor: focus => groups.get(focus).map(reference => reference.role) });
}

export function rankVisualMatches(references, candidates) {
  const score = visualScorer(references);
  if (!score) return [];
  return candidates.filter(candidate => candidate.features).map(candidate => ({
    item: candidate.item, canvas: candidate.canvas, preview: candidate.preview, timestamp: candidate.timestamp, stream: candidate.stream,
    ...score(candidate.features, candidate.windows),
  })).sort((a, b) => b.score - a.score || b.mean - a.mean);
}

export async function visualPreview(source, document, { region, scorer, signal, coarseOnly = false } = {}) {
  region = visualRegion(region);
  const profiles = scorer?.profiles ?? [];
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const drawing = canvas.getContext('2d', { willReadFrequently: true });
  if (!drawing) throw new Error('This browser cannot compare images locally.');
  const bitmap = typeof source === 'object' && 'size' in source && typeof createImageBitmap === 'function'
    ? region || profiles.length ? await createImageBitmap(source)
      : await createImageBitmap(source, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' }) : source;
  try {
    const [width, height] = sourceDimensions(bitmap);
    const draw = (context, crop) => {
      context.fillStyle = '#808080';
      context.fillRect(0, 0, size, size);
      if (crop) {
        const [left, top, right, bottom] = crop;
        context.drawImage(bitmap, left * width, top * height, (right - left) * width, (bottom - top) * height, 0, 0, size, size);
      } else context.drawImage(bitmap, 0, 0, size, size);
      return describeVisuals(context.getImageData(0, 0, size, size).data);
    };
    if ((region || profiles.length) && !(width > 0 && height > 0)) throw new Error('This picture has no readable dimensions.');
    const result = { canvas, features: draw(drawing, region) };
    if (region) Object.assign(result, { region, focus: { ...focusProfile(region, width, height),
      signature: regionSignature(regionTable(drawing.getImageData(0, 0, size, size).data, size), size) } });
    if (profiles.length) {
      const scratch = document.createElement('canvas');
      scratch.width = scratch.height = size;
      const work = scratch.getContext('2d', { willReadFrequently: true });
      if (!work) return result;
      const windows = [];
      const measured = new Map();
      const table = coarseOnly ? null : regionTable(drawing.getImageData(0, 0, size, size).data, size);
      for (const focus of profiles) {
        const dense = table && focus.signature ? proposePictureRegions(table, focus.signature, size,
          focus.aspect * height / width, focus.scale, scorer.rolesFor(focus)) : [];
        for (const region of [...dense, ...candidateRegions(focus, width, height)]) {
          signal?.throwIfAborted();
          const key = region.join(',');
          if (!measured.has(key)) {
            if (measured.size && measured.size % 12 === 0) {
              await (globalThis.scheduler?.yield?.() ?? new Promise(resolve => setTimeout(resolve, 0)));
              signal?.throwIfAborted();
            }
            measured.set(key, region === entirePicture && !result.region ? result.features : draw(work, region));
          }
          windows.push({ focus, region, features: measured.get(key) });
        }
      }
      result.windows = windows;
    }
    return result;
  } finally {
    if (bitmap !== source) bitmap.close();
  }
}

export function loadPublicPreview(document, url, signal) {
  return new Promise((resolve, reject) => {
    const image = document.createElement('img');
    image.crossOrigin = 'anonymous';
    image.referrerPolicy = 'no-referrer';
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(5500)]);
    function clean() {
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
      timeout.removeEventListener('abort', cancelled);
    }
    function loaded() { clean(); resolve(image); }
    function failed() { clean(); reject(new Error('This preview is unavailable for local comparison.')); }
    function cancelled() { clean(); image.removeAttribute('src'); reject(timeout.reason); }
    if (timeout.aborted) { cancelled(); return; }
    image.addEventListener('load', loaded, { once: true });
    image.addEventListener('error', failed, { once: true });
    timeout.addEventListener('abort', cancelled, { once: true });
    image.src = url;
  });
}

function clipPoster(video, document) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const drawing = canvas.getContext('2d');
  if (!drawing) return null;
  drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function waitForClip(video, event, signal) {
  return new Promise((resolve, reject) => {
    function stop() {
      video.removeEventListener(event, loaded);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', canceled);
    }
    function loaded() { stop(); resolve(); }
    function failed() { stop(); reject(new Error('The browser could not read the clip.')); }
    function canceled() { stop(); reject(signal.reason); }
    if (signal.aborted) { canceled(); return; }
    video.addEventListener(event, loaded, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', canceled, { once: true });
  });
}

async function seekFrame(video, seconds, signal) {
  signal.throwIfAborted();
  const ready = waitForClip(video, 'seeked', signal);
  video.currentTime = seconds;
  await ready;
  signal.throwIfAborted();
}

async function readClip(document, url, end, preload, maximumDuration, read) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = preload;
  video.muted = true;
  video.playsInline = true;
  try {
    const metadata = waitForClip(video, 'loadedmetadata', end);
    video.src = url;
    await metadata;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration < .5 || duration > maximumDuration ||
        !video.videoWidth || !video.videoHeight || video.videoWidth > 4096 || video.videoHeight > 4096) return [];
    return await read(video, end, url);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function sampleClipFrames(video, document, url, end, score, alignSound) {
  const duration = video.duration;
  const frames = [];
  try {
    const excerptHalf = Math.min(duration, soundWindowSeconds) / 2;
    const checkpoints = alignSound ? soundWindowStarts(duration).map(start => start + excerptHalf)
      : [.2, .5, .8, .05, .95].map(fraction => duration * fraction);
    async function capture(seconds) {
      await seekFrame(video, seconds, end);
      const frame = await visualPreview(video, document, { scorer: score, signal: end });
      frames.push({ ...frame, preview: clipPoster(video, document), timestamp: video.currentTime, stream: url });
    }
    for (const seconds of checkpoints) await capture(seconds);
    if (score) {
      const best = frames.reduce((top, frame, index) => {
        const value = score(frame.features, frame.windows).score;
        return value > top.value ? { index, value } : top;
      }, { index: 0, value: -Infinity });
      const center = checkpoints[best.index];
      const left = alignSound ? center - excerptHalf : Math.max(duration * .005, ...checkpoints.filter(time => time < center));
      const right = alignSound ? center + excerptHalf : Math.min(duration * .995, ...checkpoints.filter(time => time > center));
      for (const neighbor of [left, right]) await capture((center + neighbor) / 2);
    }
    return frames;
  } catch (error) {
    if (!frames.length) throw error;
    return frames;
  }
}

async function samplePublicMedia(document, url, signal, maximumDuration, read) {
  signal.throwIfAborted();
  const preview = clipAnalysisUrl(url);
  if (!preview) return [];
  const end = AbortSignal.any([signal, AbortSignal.timeout(8500)]);
  try {
    const frames = await readClip(document, preview, end, preview === url ? 'metadata' : 'auto', maximumDuration, read);
    signal.throwIfAborted();
    return frames;
  } catch (error) {
    if (preview === url || end.aborted) throw error;
    const frames = await readClip(document, url, end, 'metadata', maximumDuration, read);
    signal.throwIfAborted();
    return frames;
  }
}

export function samplePublicClip(document, url, signal, score, { alignSound = false } = {}) {
  return samplePublicMedia(document, url, signal, alignSound ? soundMaximumSeconds : 60,
    (video, end, stream) => sampleClipFrames(video, document, stream, end, score, alignSound));
}

async function sampleMotionWindows(video, document, signal, stream, withAppearance = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = motionPlaneSize;
  const drawing = canvas.getContext('2d', { willReadFrequently: true });
  if (!drawing) return [];
  const span = Math.min(.32, video.duration / 3);
  const windows = [];
  async function capture(seconds) {
    await seekFrame(video, seconds, signal);
    drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
    const { data } = drawing.getImageData(0, 0, canvas.width, canvas.height);
    const light = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < light.length; index++) {
      const pixel = index * 4;
      light[index] = (54 * data[pixel] + 183 * data[pixel + 1] + 19 * data[pixel + 2] + 128) >> 8;
    }
    return light;
  }
  try {
    for (const fraction of motionSamplePositions) {
      const start = Math.max(.01, video.duration * fraction - span / 2);
      const first = await capture(start);
      const seconds = video.currentTime;
      const appearance = withAppearance ? (await visualPreview(video, document, { signal })).features : undefined;
      async function measure(gap) {
        const second = await capture(start + gap);
        const elapsed = video.currentTime - seconds;
        return elapsed > 0 ? { seconds, span: elapsed, stream, motion: describeMotion(first, second, elapsed) } : null;
      }
      let window = await measure(span);
      if (!window?.motion && span > .24) window = await measure(span / 2) ?? window;
      if (window) windows.push(withAppearance ? { ...window, appearance, videoDuration: video.duration } : window);
    }
    return windows;
  } catch (error) {
    if (!windows.length) throw error;
    return windows;
  }
}

export function samplePublicMotion(document, url, signal) {
  return samplePublicMedia(document, url, signal, Infinity, (video, end, stream) => sampleMotionWindows(video, document, end, stream));
}

export function samplePublicScene(document, url, signal) {
  return samplePublicMedia(document, url, signal, Infinity, (video, end, stream) => sampleMotionWindows(video, document, end, stream, true));
}
