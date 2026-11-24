import { loadPublicPreview, visualPreview, visualRegion, visualRegionLabel } from './visual-analysis.mjs';
import { element } from './view.js';

const initialRegion = [.2, .2, .8, .8];
const edges = ['Left edge (%)', 'Top edge (%)', 'Right edge (%)', 'Bottom edge (%)'];

async function editorPicture(document, source, signal) {
  const url = typeof source !== 'function' && typeof createImageBitmap !== 'function' ? URL.createObjectURL(source) : null;
  const bitmap = typeof source === 'function' ? await source(signal)
    : url ? await loadPublicPreview(document, url, signal).finally(() => URL.revokeObjectURL(url)) : await createImageBitmap(source);
  try {
    signal.throwIfAborted();
    const width = bitmap.naturalWidth ?? bitmap.width;
    const height = bitmap.naturalHeight ?? bitmap.height;
    if (!width || !height) throw new Error('This picture could not be opened.');
    const scale = Math.min(1, 600 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { bitmap.close?.(); }
}

function chooseRegion(document, base, region, signal) {
  const dialog = element('dialog', null, 'button-layout visual-crop-dialog');
  dialog.setAttribute('aria-labelledby', 'visual-crop-heading');
  const heading = element('h2', 'Focus on a detail');
  heading.id = 'visual-crop-heading';
  heading.tabIndex = -1;
  heading.autofocus = true;
  const help = element('p', 'Choose two corners on the picture, or set the edges below.');
  const canvas = element('canvas', null, 'visual-crop-canvas');
  canvas.width = base.width;
  canvas.height = base.height;
  canvas.setAttribute('aria-label', 'Picture with the selected area outlined');
  const drawing = canvas.getContext('2d');
  if (!drawing) throw new Error('This browser cannot select a picture area.');
  const fieldset = element('fieldset', null, 'visual-crop-edges');
  fieldset.append(element('legend', 'Selected area'));
  const fields = edges.map((name, index) => {
    const label = element('label', name);
    const input = element('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = ((region ?? initialRegion)[index] * 100).toFixed(0);
    label.append(input);
    fieldset.append(label);
    return input;
  });
  const status = element('p', '', 'visual-crop-status');
  status.setAttribute('role', 'status');
  const actions = element('div', null, 'button-layout-actions');
  const whole = element('button', 'Use whole picture', 'chip');
  const cancel = element('button', 'Cancel', 'chip');
  const apply = element('button', 'Use selected area', 'primary');
  for (const button of [whole, cancel, apply]) button.type = 'button';
  actions.append(whole, cancel, apply);
  dialog.append(heading, help, canvas, fieldset, status, actions);
  let selected;
  let corner;

  function paint(announce = true) {
    const draft = visualRegion(fields.map(input => input.valueAsNumber / 100));
    const { width, height } = canvas;
    drawing.drawImage(base, 0, 0);
    if (draft) selected = draft;
    const [left, top, right, bottom] = (selected ?? initialRegion).map((edge, index) => edge * (index % 2 ? height : width));
    drawing.fillStyle = '#000a';
    drawing.fillRect(0, 0, width, top);
    drawing.fillRect(0, bottom, width, height - bottom);
    drawing.fillRect(0, top, left, bottom - top);
    drawing.fillRect(right, top, width - right, bottom - top);
    drawing.strokeStyle = '#e6ff6c';
    drawing.lineWidth = Math.max(2, Math.min(width, height) * .009);
    drawing.strokeRect(left, top, right - left, bottom - top);
    if (corner) {
      const [x, y] = corner;
      drawing.fillStyle = '#e6ff6c';
      drawing.fillRect(x * width - 4, y * height - 4, 8, 8);
    }
    apply.disabled = !draft;
    if (announce) status.textContent = draft ? 'Selected area · ' + visualRegionLabel(draft)
      : 'Select an area covering at least 12% of the picture’s width and height.';
  }

  canvas.addEventListener('click', event => {
    const box = canvas.getBoundingClientRect();
    const point = [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height]
      .map(value => Math.max(0, Math.min(1, value)));
    if (!corner) {
      corner = point;
      paint(false);
      status.textContent = 'Choose the opposite corner.';
      return;
    }
    const [x, y] = corner;
    corner = undefined;
    const draft = [Math.min(x, point[0]), Math.min(y, point[1]), Math.max(x, point[0]), Math.max(y, point[1])];
    fields.forEach((input, index) => { input.value = (draft[index] * 100).toFixed(0); });
    paint();
  });
  fieldset.addEventListener('input', () => { corner = undefined; paint(); });

  return new Promise(resolve => {
    function finish(result) {
      signal.removeEventListener('abort', abort);
      dialog.close();
      dialog.remove();
      resolve(result);
    }
    const abort = () => finish(null);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    cancel.addEventListener('click', abort);
    whole.addEventListener('click', () => finish({ region: null }));
    apply.addEventListener('click', () => finish({ region: selected }));
    document.body.append(dialog);
    paint();
    dialog.showModal();
    heading.focus({ preventScroll: true });
  });
}

export function createVisualCropEditor(document) {
  let active;
  return {
    close() { active?.abort(); },
    async choose(source, region) {
      if (active) return null;
      const controller = new AbortController();
      const { signal } = controller;
      active = controller;
      try {
        const canvas = await editorPicture(document, source, signal);
        const choice = await chooseRegion(document, canvas, region, signal);
        if (!choice || signal.aborted) return null;
        return { ...await visualPreview(canvas, document, { region: choice.region, signal }), region: choice.region };
      } catch (error) {
        if (!signal.aborted) throw error;
        return null;
      } finally {
        if (active === controller) active = undefined;
      }
    },
  };
}
