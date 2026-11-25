import { SITE_ORIGINS, text } from './catalog.mjs';
import { galleryCreator, galleryCreatorPattern } from './gallery.mjs';

export const modelChoiceFields = Object.freeze(['baseModel', 'resourceType', 'creatorUsage']);
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

const downloadPath = /^\/api\/download\/models\/([1-9]\d{0,14})\/?$/u;
const downloadSelectors = ['type', 'format', 'size', 'fp', 'quantType'];

export function civitaiDownloadReference(value) {
  if (typeof value !== 'string' || !/^\s*https?:\/\//iu.test(value) || !value.includes('/api/download/models/')) return null;
  const url = URL.parse(value.trim());
  if (!url?.pathname.startsWith('/api/download/models/')) return null;
  if (!SITE_ORIGINS.includes(url.origin) || url.username || url.password) throw new Error('Use a Civitai.com or Civitai.red download link.');
  const version = downloadPath.exec(url.pathname);
  if (!version || value.length > 16_384) throw new Error('Use a Civitai download link with a valid version ID.');
  const params = url.searchParams;
  if (params.has('epoch')) throw new Error('Open the training epoch on Civitai to check its file.');
  const files = params.getAll('fileId');
  if (files.length && (files.length !== 1 || !/^[1-9]\d{0,14}$/u.test(files[0]))) throw new Error('The download file ID is invalid.');
  const selectors = {};
  for (const key of downloadSelectors) {
    const values = params.getAll(key);
    if (!values.length) continue;
    if (values.length !== 1 || !/^[\p{L}\p{N}][\p{L}\p{N} _+.-]{0,63}$/u.test(values[0])) {
      throw new Error('Use a download link with one value per file option.');
    }
    selectors[key] = values[0];
  }
  const link = new URL('/api/download/models/' + version[1], url.origin);
  if (files.length) link.searchParams.set('fileId', files[0]);
  for (const [key, selector] of Object.entries(selectors)) link.searchParams.set(key, selector);
  return { kind: 'version', id: Number(version[1]), ...(files.length && { fileId: Number(files[0]) }),
    download: { link: link.href, selectors } };
}

export const catalogSearchText = value => civitaiDownloadReference(value)?.download.link ?? text(value, 500);

export function downloadReferenceNote(target, candidates) {
  if (!target?.download) return '';
  const model = candidates[0];
  if (!model) return 'Civitai could not confirm the version or file requested by this download link.';
  if (model.selectedFile) {
    const message = target.fileId ? 'Verified the download link’s exact file ID.' : 'One catalog file matches the download link’s options.';
    return message + ' File #' + model.selectedFile.id + ' · ' + model.selectedFile.name;
  }
  if (model.matchingFiles?.length) return 'Several catalog files match the download link’s options. Open Model details to see them.';
  return 'The download link identifies this release. Civitai chooses the file when you download.';
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
