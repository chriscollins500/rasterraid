import { SITE_ORIGINS } from './catalog.mjs';
import { modelCreatorName, modelDownloadFilter, modelDownloadFilters, modelFilterParam, modelFilterValues } from './model-access.mjs';
import { NATIVE_MODELS_INDEX } from './runtime-config.mjs';
import { protectedReference } from './text-assist.mjs';

const feed = '/models';
const legacy = '/search/models';
const maxLink = 4096;
const dates = new Set(['AllTime', 'Year', 'Month', 'Week', 'Day']);
const checkpoints = new Set(['Trained', 'Merge']);
const formats = new Set(['SafeTensor', 'PickleTensor', 'GGUF', 'Diffusers', 'Core ML', 'ONNX', 'Other']);
const legacyOrders = {
  'metrics.thumbsUpCount:desc': 'Highest Rated', 'metrics.downloadCount:desc': 'Most Downloaded',
  'metrics.favoriteCount:desc': 'Most Liked', 'metrics.commentCount:desc': 'Most Discussed',
  'metrics.collectedCount:desc': 'Most Collected', 'createdAt:desc': 'Newest',
};
const orders = new Set([...Object.values(legacyOrders), 'Most Images', 'Oldest', 'Hot', 'Recently Added']);
const aliases = { baseModel: 'baseModels', modelType: 'types', users: 'username', tags: 'tag', sortBy: 'sortBy' };
const downloadKeys = new Map(Object.entries(modelDownloadFilters).map(([choice, { parameter }]) => [parameter, choice]));
const knownUnsupported = {
  publishedFrom: 'a published date range', publishedTo: 'a published date range', lastVersionAt: 'an update date range',
  periodMode: 'a separate date mode', category: 'a legacy category', favorites: 'an account filter', hidden: 'an account filter',
  followed: 'an account filter',
};
const tracking = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);
const clean = (value, max) => value.length > 0 && value.length <= max && value.trim() === value && !/\p{Cc}/u.test(value);
const modelType = value => /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value);
const queryText = value => clean(value, 160) && !protectedReference(value);

export function readNativeModelSearch(value, { allowTracking = true } = {}) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!SITE_ORIGINS.includes(url.origin) || ![feed, legacy].includes(url.pathname.replace(/\/$/u, ''))) return null;
  const failure = reason => ({ origin: url.origin, reason });
  if (url.username || url.password || url.hash || url.href.length > maxLink) return failure('an unsupported address');
  const fromLegacy = url.pathname.startsWith(legacy);
  const filters = { scope: 'models', query: '' };
  const keys = [...new Set(url.searchParams.keys())];
  for (const key of keys) {
    if (allowTracking && tracking.has(key)) continue;
    const values = url.searchParams.getAll(key);
    const [choice] = values;
    const name = fromLegacy ? (Object.hasOwn(aliases, key) ? aliases[key] : key) : key;
    if (name === 'baseModels' || name === 'types') {
      if (fromLegacy && key === name || !values.every(value => name === 'types' ? modelType(value) : clean(value, 100))) {
        return failure('an invalid model choice');
      }
      filters[name === 'types' ? 'resourceType' : 'baseModel'] = modelFilterParam(values);
      continue;
    }
    if (values.length !== 1) return failure('multiple values for a single-choice filter');
    const tag = name === 'tag' || !fromLegacy && name === 'tagname';
    if (name === 'query' && (choice === '' || queryText(choice))) filters.query = choice;
    else if (name === 'username' && (!fromLegacy || key !== name) && modelCreatorName(choice) === choice) filters.modelAuthor = choice;
    else if (tag && (!fromLegacy || key !== name) && clean(choice, 100) && !filters.category) filters.category = choice;
    else if (name === 'checkpointType' && checkpoints.has(choice)) filters.checkpointType = choice;
    else if (!fromLegacy && name === 'fileFormats' && formats.has(choice)) filters.fileFormat = choice;
    else if (!fromLegacy && name === 'sort' && orders.has(choice)) filters.sort = choice;
    else if (fromLegacy && name === 'sortBy' && choice === NATIVE_MODELS_INDEX) continue;
    else if (fromLegacy && name === 'sortBy' && choice.startsWith(NATIVE_MODELS_INDEX + ':') &&
      Object.hasOwn(legacyOrders, choice.slice(NATIVE_MODELS_INDEX.length + 1))) {
      filters.sort = legacyOrders[choice.slice(NATIVE_MODELS_INDEX.length + 1)];
    } else if (!fromLegacy && name === 'period' && dates.has(choice)) {
      if (choice !== 'AllTime') filters.period = choice;
    } else if (!fromLegacy && ['supportsGeneration', 'fromPlatform'].includes(name) && choice === 'true') filters[name] = choice;
    else if (!fromLegacy && downloadKeys.has(name) && choice === 'true' && !filters.downloadAccess) filters.downloadAccess = downloadKeys.get(name);
    else if (!fromLegacy && name === 'view' && ['feed', 'categories'].includes(choice)) continue;
    else return failure(Object.hasOwn(knownUnsupported, key) ? knownUnsupported[key] : 'a filter RasterRaid cannot import');
  }
  if (filters.period && filters.query) return failure('a time period with search words');
  if (filters.checkpointType) {
    if (filters.resourceType && filters.resourceType !== 'Checkpoint') return failure('a checkpoint subtype combined with other model types');
    filters.resourceType = 'Checkpoint';
  }
  return { origin: url.origin, filters };
}

export function nativeModelSearchLink(origin, target, filters) {
  if (!SITE_ORIGINS.includes(origin) || !['text', 'tag'].includes(target.kind)) return null;
  const url = new URL(feed, origin);
  const access = modelDownloadFilter(filters.downloadAccess);
  const params = {
    query: target.kind === 'text' ? target.value : '',
    tag: target.kind === 'tag' ? target.value : filters.category,
    username: modelCreatorName(filters.modelAuthor),
    baseModels: modelFilterValues(filters.baseModel),
    types: modelFilterValues(filters.resourceType),
    checkpointType: filters.checkpointType,
    sort: filters.sort,
    period: filters.period,
    fileFormats: filters.fileFormat,
    supportsGeneration: filters.supportsGeneration,
    fromPlatform: filters.fromPlatform,
    ...(access && { [access.parameter]: 'true' }),
  };
  for (const [name, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(name, item));
    else if (value) url.searchParams.set(name, value);
  }
  return isNativeModelNavigation(url) ? url.href : null;
}

export function isNativeModelNavigation(url) {
  return url.pathname === feed && Boolean(readNativeModelSearch(url, { allowTracking: false })?.filters);
}
