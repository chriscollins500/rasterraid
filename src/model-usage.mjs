import { text } from './catalog.mjs';

export const modelUseChoices = Object.freeze({
  Image: { label: 'Sell generated images', commercial: true },
  RentCivit: { label: 'Offer paid generation on Civitai', commercial: true },
  Rent: { label: 'Offer paid generation elsewhere', commercial: true },
  Sell: { label: 'Sell the model', commercial: true },
  SellMerge: { label: 'Sell merges', commercial: true, field: 'derivatives' },
  None: { label: 'No commercial use listed', commercial: true },
  Derivatives: { label: 'Share merges or derivatives', field: 'derivatives' },
  OptionalCredit: { label: 'Credit is optional', field: 'creditOptional' },
  DifferentLicense: { label: 'Use different terms for merges', field: 'differentLicense' },
});

export function modelUseLabel(value) {
  return Object.hasOwn(modelUseChoices, value) ? modelUseChoices[value].label : value;
}

export function modelUsage(model) {
  const commercial = Array.isArray(model?.allowCommercialUse) ? model.allowCommercialUse :
    typeof model?.allowCommercialUse === 'string' ? model.allowCommercialUse.trim().replace(/^\{|\}$/gu, '').split(',') : null;
  return {
    creditOptional: typeof model?.allowNoCredit === 'boolean' ? model.allowNoCredit : null,
    derivatives: typeof model?.allowDerivatives === 'boolean' ? model.allowDerivatives : null,
    differentLicense: typeof model?.allowDifferentLicense === 'boolean' ? model.allowDifferentLicense : null,
    commercial: commercial ? [...new Set(commercial.slice(0, 12).map(code => text(code, 40)).filter(Boolean))] : null,
  };
}

export function matchesModelUse(usage, required) {
  return required.every(choice => {
    if (!usage || !Object.hasOwn(modelUseChoices, choice)) return false;
    const { commercial, field } = modelUseChoices[choice];
    if (field && usage[field] !== true || choice === 'DifferentLicense' && usage.derivatives !== true) return false;
    if (!commercial) return true;
    if (!Array.isArray(usage.commercial) || !usage.commercial.includes(choice)) return false;
    return choice === 'None' ? usage.commercial.length === 1 : !usage.commercial.includes('None');
  });
}

// The Site API combines repeated allowCommercialUse values with OR. Send one
// necessary condition to narrow retrieval, then match every flag on the record.
export function siteUseCondition(required) {
  return ['None', 'SellMerge', 'Sell', 'Rent', 'RentCivit', 'Image'].find(value => required.includes(value));
}

export function modelLicenseLink(origin, id, base) {
  if (!Number.isSafeInteger(id) || id <= 0 || !['SD 1.5', 'SDXL 1.0'].includes(base)) return null;
  return new URL('/models/license/' + id, origin).href;
}
