import { numericId, SITE_ORIGINS, text } from './catalog.mjs';
import { hydratePosts } from './community.mjs';
import { readAppMediaByIds, sampleMediaByPost } from './gallery.mjs';
import { hasCollectionAccess, readLibraryPage } from './library.mjs';
import { readRecordedVersions } from './search.mjs';

export const collectionTrailSources = ['gallery', 'videos', 'posts', 'models'];
const mediaPerPage = 8;
const displayPerType = 5;
const postLimit = 3;
const versionLimit = 5;

function trailEdges(collection, featured, posts, models) {
  const cardsByVersion = new Map(models.map(model => [model.id, model]));
  const postsByMedia = new Map(posts.flatMap(post => post.previews.map(item => [item.id, post])));
  const records = featured.map(item => {
    const post = postsByMedia.get(item.id);
    const linked = cardsByVersion.get(post?.modelVersionId);
    const recorded = (item.recorded ?? []).map(id => cardsByVersion.get(id)).filter(Boolean);
    const associated = (item.associated ?? []).filter(id => !item.recorded?.includes(id)).map(id => cardsByVersion.get(id)).filter(Boolean);
    return { item, post, linked, recorded, associated };
  });
  const priority = record => record.linked ? 3 : record.recorded.length ? 2 : record.post ? 1 : 0;
  records.sort((a, b) => priority(b) - priority(a));
  const membership = item => ({ kind: 'collection-media', label: 'This collection includes the example', first: collection.link, second: item.link });
  const postLink = ({ item, post }) => ({ kind: 'post-media', label: 'The example is part of this public post', first: item.link, second: post.link });
  const versionLinks = ({ item, post, linked, recorded, associated }) => [
    ...(linked ? [{ version: linked.id, kind: 'post-model', label: 'The post lists this exact model version', first: post.link, second: linked.link }] : []),
    ...recorded.map(model => ({ version: model.id, kind: 'recorded', label: 'This example records the exact model version', first: item.link, second: model.link })),
    ...associated.map(model => ({ version: model.id, kind: 'catalog', label: 'Civitai links this example to the model version', first: item.link, second: model.link })),
  ];
  const coveredPosts = new Set();
  const coveredVersions = new Set();
  const leading = [];
  for (const record of records) {
    const newPost = record.post && !coveredPosts.has(record.post.id);
    const versions = versionLinks(record).filter(edge => {
      if (coveredVersions.has(edge.version)) return false;
      coveredVersions.add(edge.version);
      return true;
    });
    if (newPost || versions.length) {
      leading.push(membership(record.item));
      if (record.post) leading.push(postLink(record));
      leading.push(...versions);
    }
    if (newPost) coveredPosts.add(record.post.id);
  }
  return [...leading, ...records.map(record => membership(record.item)), ...records.filter(record => record.post).map(postLink),
    ...records.flatMap(versionLinks)];
}

export async function tracePublicCollection(context, collection, scopes, filters, options = {}) {
  const { signal, fetcher, onPhase = () => {} } = options;
  const { origin } = context;
  const id = numericId(collection?.id);
  const link = SITE_ORIGINS.includes(origin) && id ? new URL('/collections/' + id, origin).href : null;
  if (!link || link !== collection.link) throw new TypeError('A verified public collection is required.');
  const summary = { title: text(collection.title, 160), link, status: 'unavailable', pages: 0, members: 0, shown: 0,
    more: false, posts: 0, versions: 0, filtered: 0, unavailable: 0, unavailableVersions: 0 };
  const related = { gallery: [], videos: [], posts: [] };
  const flows = { gallery: [], videos: [], posts: [], models: [] };
  const result = { summary, related, flows, candidates: [], edges: [] };
  if (collection.collectionType && collection.collectionType !== 'Image') {
    summary.status = 'native';
    return result;
  }
  if (!hasCollectionAccess(context)) {
    summary.status = 'access-needed';
    return result;
  }

  onPhase('Opening a sample of public collection media…');
  const plan = { mode: 'public', includePrivate: false, collectionId: id };
  let page;
  try {
    page = await readLibraryPage(context, plan, { signal, fetcher, limit: mediaPerPage });
  } catch (error) {
    signal?.throwIfAborted();
    summary.status = [401, 403].includes(error.status) ? 'access-needed' : 'unavailable';
    return result;
  }
  summary.pages++;
  let members = page.items;
  const wantImages = scopes.includes('gallery');
  const wantVideos = scopes.includes('videos');
  const requested = item => (!wantImages && !wantVideos) || (item.video ? wantVideos : wantImages);
  const partial = roles => {
    summary.status = 'partial';
    for (const role of roles) flows[role].push({ label: 'Collection evidence', status: null });
  };
  if (page.nextCursor && members.filter(requested).length < 3) {
    try {
      page = await readLibraryPage(context, plan, { signal, fetcher, cursor: page.nextCursor, limit: mediaPerPage });
      summary.pages++;
      members = [...members, ...page.items];
    } catch (error) {
      signal?.throwIfAborted();
      if ([401, 403, 404].includes(error.status)) return result;
      partial(['gallery', 'videos']);
    }
  }
  members = [...new Map(members.map(item => [item.id, item])).values()];
  summary.members = members.length;
  summary.more = Boolean(page.nextCursor);
  if (summary.status !== 'partial') summary.status = members.length ? 'ready' : 'empty';
  if (!members.length) return result;

  onPhase('Checking the exact Civitai records for collection members…');
  let verified;
  try {
    verified = await readAppMediaByIds(context, members.map(item => item.id), { signal, fetcher });
  } catch (error) {
    signal?.throwIfAborted();
    if ([401, 403].includes(error.status)) {
      summary.status = 'access-needed';
      return result;
    }
    partial(collectionTrailSources);
  }
  const byId = new Map((verified ?? []).map(item => [item.id, item]));
  const available = verified ? members.flatMap(member => {
    const item = byId.get(member.id);
    if (!item || item.audio || item.video !== member.video) return [];
    return [{ ...item, preview: item.preview ?? member.preview, stream: item.stream ?? member.stream }];
  }) : members;
  summary.unavailable = members.length - available.length;
  if (summary.unavailable) partial(['gallery', 'videos']);
  const gallery = sampleMediaByPost(available.filter(item => !item.video), displayPerType);
  const videos = sampleMediaByPost(available.filter(item => item.video), displayPerType);
  const featured = [...(wantImages ? gallery : []), ...(wantVideos ? videos : [])];
  summary.shown = featured.length;
  related.gallery = gallery;
  related.videos = videos;

  const traceLeads = featured.length ? featured : [...gallery, ...videos];
  if (scopes.includes('posts') || scopes.includes('models')) {
    const postIds = new Set(traceLeads.map(item => item.postId).filter(numericId));
    const selected = new Set([...postIds].slice(0, postLimit));
    if (selected.size) {
      onPhase('Following the sampled examples to their published posts…');
      const posts = await hydratePosts(context, traceLeads.filter(item => selected.has(item.postId)), '', { signal, fetcher });
      related.posts = posts.items;
      summary.posts = posts.items.length;
      if (posts.partial) partial(['posts']);
    }
  }
  if (scopes.includes('models')) {
    const planned = [...new Set([...related.posts.map(post => post.modelVersionId),
      ...traceLeads.flatMap(item => [...(item.recorded ?? []), ...(item.associated ?? [])])].filter(numericId))].slice(0, versionLimit);
    if (planned.length) {
      onPhase('Verifying the exact model versions and your filters…');
      const models = await readRecordedVersions(context, { records: planned.map(versionId => ({ versionId })) }, filters,
        { signal, fetcher, evidenceLabel: 'Verified in the collection trail' });
      result.candidates = models.candidates;
      flows.models = models.flows;
      summary.versions = models.candidates.length;
      summary.filtered = models.filtered + models.unknownFit;
      summary.unavailableVersions = models.unavailable + models.ambiguous;
      if (models.flows.some(flow => flow.status !== 200)) partial(['models']);
    }
  }
  result.edges = trailEdges(collection, traceLeads, related.posts, result.candidates);
  return result;
}

export function collectionTraceCoverage(trace) {
  if (trace.status === 'native') return 'Open this collection on Civitai to browse its contents.';
  if (trace.status === 'access-needed') return 'The collection trail needs signed-in Civitai collection access. You can open the original below.';
  if (trace.status === 'unavailable') return 'Civitai did not return the collection media. Open the original to continue.';
  if (trace.status === 'empty') return 'Civitai returned no eligible pictures or videos in the checked pages.';
  const details = [trace.more && 'More items are available on Civitai.', trace.status === 'partial' && 'Some checks could not be completed.',
    trace.filtered > 0 && 'Model filters excluded or could not verify ' + trace.filtered + ' candidate versions.',
    trace.unavailableVersions > 0 && 'Civitai did not confirm ' + trace.unavailableVersions + ' linked versions.'].filter(Boolean);
  return ['Checked ' + trace.members + ' media ' + (trace.members === 1 ? 'item' : 'items') + ' across ' + trace.pages +
    ' ' + (trace.pages === 1 ? 'page' : 'pages') + '.', ...details].join(' ');
}
