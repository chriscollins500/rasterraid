import { numericId } from './catalog.mjs';
import { hydratePosts } from './community.mjs';
import { prepareGallery, readGalleryPage, sampleMediaByPost } from './gallery.mjs';
import { comparePublishedSettings } from './gallery-setup.mjs';

const mediaScopes = ['gallery', 'videos'];
export const releaseMediaSources = new Set([...mediaScopes, 'posts']);
const sampleLimit = 5;
const pageLimit = 12;
const postLimit = 3;

function pictureAsset(preview) {
  const { pathname } = new URL(preview);
  const [, delivery, id] = pathname.split('/');
  return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id) ? delivery + '/' + id.toLowerCase() : pathname;
}

function suggestPictureComparison(items, versionId) {
  const seen = new Set();
  const comparable = items.slice(0, pageLimit).flatMap(item => {
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    if (!item.preview || item.id > 2_147_483_647 ||
        !item.publishedSetup?.recorded.some(row => row.versionId === versionId)) return [];
    const { id, title, link, preview } = item;
    return [{ picture: { id, title, link, preview }, asset: pictureAsset(preview),
      settings: item.publishedSetup.settings.filter(({ label, value }) => label !== 'Seed' || value !== '-1') }];
  });
  const pairs = [];
  for (const [index, first] of comparable.entries()) {
    for (const second of comparable.slice(index + 1)) {
      if (first.asset === second.asset) continue;
      const fields = comparePublishedSettings(first.settings, second.settings);
      const shared = [];
      const different = [];
      const unreported = [];
      for (const { label, values: [left, right] } of fields) {
        if (left === null || right === null) unreported.push(label);
        else if (left === right) shared.push(label);
        else different.push(label);
      }
      if (shared.length >= 2 && different.length) {
        pairs.push({ pictures: [first.picture, second.picture], shared, different, unreported });
      }
    }
  }
  return pairs.sort((a, b) => b.shared.length - a.shared.length ||
    a.different.length - b.different.length || a.unreported.length - b.unreported.length)[0];
}

export function releasePictureComparisonText({ shared, different, unreported }) {
  return 'Both pictures record this exact release. Matching settings include ' + shared.join(', ') +
    '. Different values appear for ' + different.join(', ') + '.' +
    (unreported.length ? ' Only one side reports a comparable value for ' + unreported.join(', ') + '.' : '') +
    ' Published metadata can omit other settings.';
}

export async function traceReleaseMedia(context, model, scopes, filters, { signal, fetcher, onPhase }) {
  const options = { signal, fetcher };
  const wantsPosts = scopes.includes('posts');
  const enabled = mediaScopes.filter(scope => scopes.includes(scope));
  const mediaReads = enabled.length || !wantsPosts ? enabled : mediaScopes;
  const source = { modelId: model.modelId, versionId: model.id, link: model.link, title: model.model, version: model.version };
  const target = { kind: 'version', id: model.id, modelId: model.modelId };
  if (mediaReads.length) onPhase('Checking picture and clip examples for the exact release…');
  const pages = await Promise.all(mediaReads.map(async scope => {
    const gallery = await prepareGallery(context, target, { ...filters, scope }, options);
    const row = { scope, traced: true, candidates: [], related: { [scope]: [] }, gallery, flows: [] };
    try {
      const withSetup = scope === 'gallery' && enabled.includes(scope);
      const page = await readGalleryPage(context, { ...gallery.plan, withMeta: true, exampleSource: source },
        { ...options, limit: pageLimit, withSetup });
      const comparison = withSetup ? suggestPictureComparison(page.items, model.id) : undefined;
      const sampled = sampleMediaByPost(page.items, sampleLimit).map(({ publishedSetup, ...item }) => item);
      row.related[scope] = sampled;
      const coverage = { shown: sampled.length, more: Boolean(page.nextCursor || sampled.length < page.items.length),
        recorded: sampled.filter(item => item.recorded.includes(model.id)).length };
      return { row, coverage, comparison };
    } catch (error) {
      signal?.throwIfAborted();
      row.flows.push({ label: scope, status: error.status ?? null });
      return { row };
    }
  }));
  signal?.throwIfAborted();
  const results = new Map(pages.map(({ row }) => [row.scope, row]));
  const preview = Object.fromEntries(pages.flatMap(({ row, coverage }) => coverage ? [[row.scope, coverage]] : []));
  const comparison = pages.find(page => page.comparison)?.comparison;
  let posts;
  if (wantsPosts) {
    const samples = mediaScopes.map(scope => results.get(scope)?.related[scope] ?? []);
    const leads = Array.from({ length: sampleLimit }, (_, index) => samples.flatMap(items => items[index] ?? [])).flat();
    const ids = [...new Set(leads.map(item => numericId(item.postId)).filter(id => id && id <= 2_147_483_647))];
    const chosen = new Set(ids.slice(0, postLimit));
    if (chosen.size) onPhase('Verifying the public posts for those examples…');
    const verified = await hydratePosts(context, leads.filter(item => chosen.has(item.postId)), '', options);
    const incomplete = verified.partial || mediaReads.some(scope => results.get(scope).flows.length);
    posts = { linksSampled: chosen.size, verified: verified.items.length,
      listRelease: verified.items.filter(post => post.modelVersionId === model.id).length, more: ids.length > chosen.size };
    // The post previews are already included in the media samples. Keep the
    // links to them while avoiding a duplicate gallery in the report.
    results.set('posts', { scope: 'posts', traced: true, candidates: [], related: { posts: verified.items },
      flows: incomplete ? [{ label: 'Public posts', status: null }] : [] });
  }
  return { results, sample: { ...source, media: preview, ...(posts && { posts }), ...(comparison && { comparison }) } };
}

export function releaseSampleCoverage(sample) {
  const rows = mediaScopes.flatMap(scope => {
    const count = sample.media[scope];
    if (!count) return [];
    const name = scope === 'gallery' ? (count.shown === 1 ? 'picture' : 'pictures') : (count.shown === 1 ? 'clip' : 'clips');
    return [count.shown + ' sampled ' + name + (count.recorded ? ' · ' + count.recorded + ' record the exact release' : '') + '.'];
  });
  if (sample.posts) {
    rows.push(sample.posts.verified + ' published posts verified from ' + sample.posts.linksSampled + ' sampled links' +
      (sample.posts.listRelease ? ' · ' + sample.posts.listRelease + ' list the exact release' : '') + '.');
  }
  if (Object.values(sample.media).some(row => row.more) || sample.posts?.more) rows.push('Open the source links to browse beyond this sample.');
  return rows.join(' ');
}
