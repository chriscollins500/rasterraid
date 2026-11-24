import { catalogRead, civitaiAir, numericId, text } from './catalog.mjs';
import { downloadJson, modelIdentityFilename } from './download-json.js';
import { studioIdentitySchema } from './reference-provenance.mjs';
import { formatKey } from './release-compatibility.mjs';
import { element } from './view.js';

const sha256 = value => typeof value === 'string' && /^[a-f\d]{64}$/iu.test(value) ? value.toLowerCase() : null;
const label = (value, limit) => text(value, limit).replace(/[\p{Cc}\p{Cf}]/gu, '');
const fileRoles = new Map([
  ['clipvision', 'vision_encoder'], ['controlnet', 'controlnet'], ['diffusion model', 'unet'],
  ['enhancement lora', 'lora'], ['negative', 'embedding'], ['pruned model', 'checkpoint'],
  ['text encoder', 'clip'], ['unet', 'unet'], ['upscaler', 'upscaler'], ['vae', 'vae'], ['vision encoder', 'vision_encoder'],
]);

export function modelFileIdentity(model, file) {
  const digest = sha256(file?.sha256);
  if (!numericId(model?.modelId) || !numericId(model?.id) || !numericId(file?.id) || !digest ||
      ![model.selectedFile, ...(model.matchingFiles ?? [])].some(pin => pin?.id === file.id && sha256(pin.sha256) === digest)) return null;
  const type = label(model.type, 40);
  const fileType = label(file.fileType, 40);
  const role = fileRoles.get(fileType.toLowerCase()) ?? (/^(?:locon|dora)$/iu.test(type) ? 'lora' : undefined);
  return {
    name: label(model.model, 220) || 'Civitai model #' + model.modelId,
    type, ...(role && { role }), versionName: label(model.version, 100), baseModel: label(model.base, 80),
    modelId: model.modelId, modelVersionId: model.id, fileId: file.id,
    format: label(file.format, 40), fileType, hashes: { SHA256: digest },
  };
}

export function studioModelIdentity(resource) {
  return { schema: studioIdentitySchema, schemaVersion: 1, resources: [resource] };
}

export async function readCiviScribeMapping(origin, resource, options) {
  const { modelId, modelVersionId, fileId, hashes } = resource;
  const { data } = await catalogRead(origin, '/api/v1/model-versions/' + modelVersionId, {}, options);
  if (data.id !== modelVersionId || (data.modelId ?? data.model?.id) !== modelId) return null;
  const file = Array.isArray(data.files) ? data.files.find(row => row?.id === fileId) : null;
  if (!file || sha256(file.hashes?.SHA256) !== hashes.SHA256) return null;

  const candidateAir = civitaiAir(file.air ?? data.air);
  if (candidateAir?.kind !== 'version' || candidateAir.modelId !== modelId || candidateAir.id !== modelVersionId ||
      candidateAir.fileId !== null && candidateAir.fileId !== fileId ||
      !/^urn:air:[a-z\d_-]+:[a-z\d_-]+:/iu.test(candidateAir.air)) return null;
  // A version's AIR describes the main model. A separately typed file needs its own file-qualified AIR.
  if (file.air != null && candidateAir.fileId !== fileId ||
      candidateAir.fileId === null && (candidateAir.format || !/^model$/iu.test(file.type ?? ''))) return null;
  const format = formatKey(file.metadata?.format);
  if (candidateAir.format && format && format !== 'other' && formatKey(candidateAir.format) !== format) return null;
  const suffix = candidateAir.format?.toLowerCase() || (/^[a-z\d][a-z\d_-]{0,31}$/u.test(format) && format !== 'other' ? format : '');
  const air = (candidateAir.air.split('@')[0] + '@' + modelVersionId + '+' + fileId + (suffix ? '.' + suffix : '')).toLowerCase();
  return [{ match: { hashes: { SHA256: hashes.SHA256 } }, air }];
}

export function showModelHandoff(window, context, model, file) {
  const resource = modelFileIdentity(model, file);
  if (!resource) return;
  window.document.querySelector('dialog.model-handoff')?.close();
  const dialog = element('dialog', null, 'button-layout report-export model-handoff');
  const heading = element('h2', 'Use this model in other tools');
  heading.id = 'model-handoff-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  const identity = element('p', [resource.name, resource.versionName, 'File #' + resource.fileId].filter(Boolean).join(' · '));
  const controller = new AbortController();
  const { signal } = controller;
  const action = (name, handler) => {
    const button = element('button', name, 'chip');
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  };
  const status = () => {
    const node = element('p', null, 'quote-status');
    node.setAttribute('role', 'status');
    return node;
  };
  const jsonView = name => {
    const field = element('textarea');
    field.readOnly = field.hidden = true;
    field.setAttribute('aria-label', name);
    return field;
  };
  async function copyJson(json, field, message) {
    try {
      await window.navigator.clipboard.writeText(json);
      if (!signal.aborted) message.textContent = 'Copied.';
    } catch {
      if (signal.aborted) return;
      field.value = json;
      field.hidden = false;
      field.focus();
      field.select();
      message.textContent = 'Use your browser’s Copy command.';
    }
  }
  const studio = element('section');
  const studioStatus = status();
  const studioText = jsonView('Metadata Studio identity JSON');
  const json = JSON.stringify(studioModelIdentity(resource), null, 2);
  const download = action('Download identity JSON', async () => {
    download.disabled = true;
    studioStatus.textContent = 'Preparing the download…';
    try {
      await downloadJson(window, context, modelIdentityFilename, json, signal);
      if (!signal.aborted) studioStatus.textContent = 'Download started.';
    } catch (error) {
      if (!signal.aborted) studioStatus.textContent = error.message || 'The download is unavailable. You can copy the identity JSON.';
    } finally {
      if (!signal.aborted) download.disabled = false;
    }
  });
  const studioActions = element('div', null, 'model-handoff-actions');
  studioActions.append(download, action('Copy identity JSON', () => copyJson(json, studioText, studioStatus)));
  studio.append(element('h3', 'Civitai Metadata Studio'),
    element('p', 'Open a picture in Metadata Studio and choose Resources → Import identities.'), studioActions, studioStatus, studioText);

  const scribe = element('section');
  const scribeStatus = status();
  const scribeText = jsonView('CiviScribe manual resource identities JSON');
  const scribeCopy = action('Copy CiviScribe mapping', () => copyJson(scribeText.value, scribeText, scribeStatus));
  scribeCopy.hidden = true;
  const prepare = action('Prepare CiviScribe mapping', async () => {
    prepare.disabled = true;
    scribeStatus.textContent = 'Checking the published AIR…';
    try {
      const mapping = await readCiviScribeMapping(context.origin, resource, { signal });
      signal.throwIfAborted();
      if (!mapping) {
        scribeStatus.textContent = 'Civitai could not confirm a file-qualified AIR for this file.';
        return;
      }
      scribeText.value = JSON.stringify(mapping, null, 2);
      scribeText.hidden = scribeCopy.hidden = false;
      scribeStatus.textContent = 'Mapping ready.';
      prepare.hidden = true;
      scribeCopy.focus();
    } catch (error) {
      if (!signal.aborted) scribeStatus.textContent = error.status === 429
        ? 'Civitai is limiting catalog requests. Try again after the pause.' : 'Could not check the AIR. Try again.';
    } finally {
      if (!signal.aborted) prepare.disabled = false;
    }
  });
  scribe.append(element('h3', 'CiviScribe'), element('p', 'Enable manual resource identities and paste the mapping into Manual resource identities JSON. Use full hashing if CiviScribe needs to calculate the file’s SHA-256.'),
    prepare, scribeCopy, scribeStatus, scribeText);
  const actions = element('div', null, 'button-layout-actions');
  actions.append(action('Close', () => dialog.close()));
  dialog.append(heading, identity, studio, scribe, actions);
  dialog.addEventListener('close', () => { controller.abort(); dialog.remove(); }, { once: true });
  window.document.body.append(dialog);
  dialog.showModal();
}
