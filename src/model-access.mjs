import { text } from './catalog.mjs';
import { galleryCreator, galleryCreatorPattern } from './gallery.mjs';

export const modelChoiceFields = Object.freeze(['baseModel', 'resourceType']);
export const modelChoiceKey = value => text(value, 100).normalize('NFKC').toLowerCase();

export function modelCreatorName(value) {
  const name = galleryCreator(value);
  return galleryCreatorPattern.test(name) ? name : '';
}

export function modelFilterValues(value) {
  const values = new Map();
  for (const item of Array.isArray(value) ? value : [value]) {
    if (typeof item !== 'string' || item.length > 100 || /\p{Cc}/u.test(item)) continue;
    const key = modelChoiceKey(item);
    if (key && !values.has(key)) values.set(key, item.trim());
  }
  return [...values.values()];
}

export function modelFilterParam(value) {
  const values = modelFilterValues(value);
  return values.length > 1 ? values : values[0];
}

export const modelDownloadFilters = Object.freeze({
  free: { label: 'Free versions', parameter: 'hidePaid' },
  paid: { label: 'Paid access', parameter: 'paidAccess' },
  early: { label: 'Early access', parameter: 'earlyAccess' },
  sale: { label: 'Models on sale', parameter: 'onSale' },
});

export function modelDownloadFilter(value) {
  return Object.hasOwn(modelDownloadFilters, value) ? modelDownloadFilters[value] : null;
}

export function modelVersionDownload(version) {
  const gate = version.paidAccess;
  if (gate === null) return { downloadAccess: 'free' };
  if (gate?.permanent === true && gate.endsAt === null) return { downloadAccess: 'paid' };
  if (gate?.permanent === false && typeof gate.endsAt === 'string' && Number.isFinite(Date.parse(gate.endsAt))) {
    return { downloadAccess: 'early', downloadAccessEndsAt: gate.endsAt };
  }
  return {};
}

export function matchesModelDownload(candidate, choice, now = Date.now()) {
  if (!modelDownloadFilter(choice)) return true;
  if (choice === 'sale') return candidate.listingOnSale === true && candidate.downloadAccess === 'paid';
  return candidate.downloadAccess === choice && (choice !== 'early' || Date.parse(candidate.downloadAccessEndsAt) > now);
}

export function modelDownloadLabel(candidate, now = Date.now()) {
  if (candidate.downloadAccess === 'free') return 'No paid download gate';
  if (candidate.downloadAccess === 'paid') return 'Paid download';
  if (matchesModelDownload(candidate, 'early', now)) return 'Early access through ' + new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
  }).format(new Date(candidate.downloadAccessEndsAt));
  return '';
}
