import { text } from './catalog.mjs';

const loaderTypes = { Checkpoint: ['checkpoint'], LoRA: ['lora', 'locon'], VAE: ['vae'], ControlNet: ['controlnet'],
  Upscaler: ['upscaler'], 'Text encoder': ['textencoder'], 'Vision encoder': ['clipvision'], 'Style model': ['stylemodel'] };
const usageNames = { None: 'None listed', Image: 'Generated images', RentCivit: 'Paid generation on Civitai',
  Rent: 'External paid generation', Sell: 'Model sales', SellMerge: 'Sales of merges' };

export const publishedName = value => text(value, 260).normalize('NFKC').toLowerCase();
export const isModelFile = file => Boolean(file && (!file.fileType || file.fileType === 'Model'));
export const formatKey = value => publishedName(value).replace(/^safetensors?$/u, 'safetensor');
const fileFormat = file => formatKey(file.format || file.name?.split('.').at(-1));

export function releaseSetupIssue(model, kind, family) {
  if (!model.base || publishedName(model.base) === 'other') return 'Model family needs verification.';
  if (family && publishedName(model.base) !== publishedName(family)) return 'The model lists a different family from your setup.';
  const expected = Object.hasOwn(loaderTypes, kind) ? loaderTypes[kind] : null;
  return expected && !expected.includes(publishedName(model.type)) ? 'The listing type differs from this workflow loader.' : '';
}

export function comparePublishedRelease(current, version, kind, family) {
  const { model, file } = current;
  const fit = releaseSetupIssue(model, kind, family);
  const sameBase = publishedName(version.base) === publishedName(model.base);
  const sameType = publishedName(version.type) === publishedName(model.type);
  const sameRole = publishedName(version.checkpointRole) === publishedName(model.checkpointRole) &&
    (publishedName(model.type) !== 'checkpoint' || Boolean(model.checkpointRole));
  const formatted = (version.files ?? []).filter(entry => isModelFile(entry) && fileFormat(entry) === fileFormat(file));
  const selected = formatted.find(entry => (!file.precision || publishedName(entry.precision) === publishedName(file.precision)) &&
    (!file.fileVariant || publishedName(entry.fileVariant) === publishedName(file.fileVariant)));
  const reason = fit || (!sameBase ? 'Different model family' : !sameType ? 'Different listing type' :
    !sameRole ? 'Different or unverified checkpoint role' : !formatted.length ? 'Different or unverified file format' :
      !selected ? 'Different or unverified file precision or variant' : '');
  return { reason, file: selected ?? null };
}

export function listedCreatorTerms(usage = {}) {
  usage ??= {};
  const statements = [
    typeof usage.creditOptional === 'boolean' ? usage.creditOptional ? 'Credit optional' : 'Credit required' : '',
    typeof usage.derivatives === 'boolean' ? usage.derivatives ? 'Derivatives allowed' : 'Derivatives restricted' : '',
    typeof usage.differentLicense === 'boolean' ? usage.differentLicense ? 'A different derivative license is allowed' : 'A different derivative license is restricted' : '',
  ].filter(Boolean);
  if (usage.commercial?.length) statements.unshift('Listed commercial uses · ' +
    usage.commercial.map(value => Object.hasOwn(usageNames, value) ? usageNames[value] : value).join(', '));
  return statements;
}
