import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogSearchText, downloadReferenceNote } from '../src/model-access.mjs';
import { discoverReport, reportMarkdown } from '../src/report.mjs';
import { reportResearchPlans } from '../src/report-research.mjs';
import { discover, searchTarget } from '../src/search.mjs';
import { quickSearchIntent } from '../src/search-intent.mjs';
import { checkWorkspaceAsset, workspaceFilters } from '../src/workspace.mjs';

const origin = 'https://civitai.com';
const context = { origin, hosted: true, token: 'fixture', browsingLevel: 3 };
const download = origin + '/api/download/models/62';
const pinned = download + '?fileId=92';
const marked = download + '?token=' + 'private-canary'.repeat(50) + '&fileId=92#private-fragment';
const files = [
  { id: 91, type: 'Archive', name: 'image.zip', metadata: { format: 'Other' }, downloadUrl: download + '?fileId=91' },
  { id: 92, type: 'Archive', name: 'video.zip', metadata: { format: 'Other' }, downloadUrl: pinned },
  { id: 93, type: 'VAE', name: 'component.safetensors', metadata: { format: 'SafeTensor' }, downloadUrl: download + '?type=VAE&format=SafeTensor' },
];
const version = { id: 62, modelId: 41, name: 'v2', baseModel: 'SDXL 1.0', browsingLevel: 1, availability: 'Public',
  status: 'Published', files, images: [] };

function fixture(reads, { visible = true, published = version, appVersion = version } = {}) {
  return (url, init) => {
    reads.push(url.pathname);
    assert.equal(url.origin, origin);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.method, undefined);
    assert.doesNotMatch(url.href, /private-canary|token=|\/api\/download\//u);
    if (url.pathname === '/api/v1/blocks/models') {
      assert.equal(init.headers.Authorization, 'Bearer fixture');
      assert.equal(url.searchParams.get('modelVersionIds'), '62');
      return Response.json({ items: visible ? [{ id: 41, name: 'Frame setup', type: 'Workflows', modelVersions: [appVersion] }] : [] });
    }
    if (url.pathname === '/api/v1/blocks/images') return Response.json({ items: [] });
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(url.pathname, '/api/v1/model-versions/62');
    return Response.json(published);
  };
}

test('download link inputs retain file identity and omit credentials and fragments', () => {
  assert.deepEqual(searchTarget(marked), { kind: 'version', id: 62, fileId: 92, download: { link: pinned, selectors: {} } });
  assert.equal(catalogSearchText(marked), pinned);
  assert.equal(workspaceFilters({ scope: 'models', query: marked }).query, pinned);
  assert.equal(quickSearchIntent('Explore ' + pinned + '&token=private-canary').query, pinned);
  assert.throws(() => searchTarget(pinned + '&fileId=91'), /file ID/u);
  assert.throws(() => searchTarget(download + '?type=VAE&type=Model'), /one value/u);
  assert.throws(() => searchTarget(download + '?epoch=4'), /training epoch/u);
  assert.throws(() => searchTarget(pinned.replace('civitai.com', 'example.com')), /Civitai.com or Civitai.red/u);
});

test('a pinned download matches the secondary file only after the App and metadata agree', async () => {
  const reads = [];
  const result = await discover(context, { scope: 'gallery', query: marked }, { catalogOnly: true, fetcher: fixture(reads) });
  assert.deepEqual(reads, ['/api/v1/blocks/models', '/api/v1/model-versions/62']);
  assert.equal(result.scope, 'models');
  assert.equal(result.candidates[0].selectedFile.id, 92);
  assert.equal(result.candidates[0].link, origin + '/models/41?modelVersionId=62');
  assert.match(downloadReferenceNote(result.target, result.candidates), /exact file ID/u);
  assert.doesNotMatch(JSON.stringify(result), /private-canary/u);
});

test('explicit pins cannot fall back to a sibling file, linked component, or Site-only result', async () => {
  for (const [query, options, expectedReads] of [
    [download + '?fileId=95', {}, 1], [download + '?fileId=93', {}, 2],
    [pinned, { visible: false }, 1], [pinned, { published: { ...version, modelId: 42 } }, 2],
    [pinned, { published: { ...version, files: [] } }, 2],
  ]) {
    const reads = [];
    const result = await discover(context, { scope: 'models', query }, { catalogOnly: true, fetcher: fixture(reads, options) });
    assert.equal(result.candidates.length, 0);
    assert.equal(reads.length, expectedReads);
    assert.match(downloadReferenceNote(result.target, result.candidates), /could not confirm/u);
  }
});

test('legacy options retain ambiguity and a bare URL identifies only the release', async () => {
  const reads = [];
  const fetcher = fixture(reads);
  const legacy = await discover(context, { scope: 'models', query: download + '?type=Archive&format=Other' }, { catalogOnly: true, fetcher });
  assert.deepEqual(legacy.candidates[0].matchingFiles.map(file => file.id), [91, 92]);
  assert.equal(legacy.candidates[0].selectedFile, undefined);
  assert.equal(legacy.shortlisted.length, 0);
  const component = await discover(context, { scope: 'models', query: files[2].downloadUrl }, { catalogOnly: true, fetcher });
  assert.equal(component.candidates[0].selectedFile.id, 93);
  assert.match(downloadReferenceNote(component.target, component.candidates), /matches the download link’s options/u);
  const release = await discover(context, { scope: 'models', query: download }, { catalogOnly: true, fetcher });
  assert.equal(release.candidates[0].selectedFile, undefined);
  assert.match(downloadReferenceNote(release.target, release.candidates), /identifies this release/u);
  assert.deepEqual(reads, Array(3).fill('/api/v1/blocks/models'));
});

test('release reports preserve verified file facts and exclude credential text from exports and Deep Search inputs', async () => {
  const result = await discoverReport(context, { scope: 'report', reportType: 'release', reportSources: ['models', 'gallery'], query: marked },
    { fetcher: fixture([]) });
  const markdown = reportMarkdown(result.report);
  assert.match(markdown, /File #92[\s\S]*video\.zip/u);
  assert.match(markdown, /Verified the download link’s exact file ID/u);
  const plans = reportResearchPlans(result.report);
  assert.ok(plans.length);
  assert.doesNotMatch(markdown + JSON.stringify(plans), /private-canary|private-fragment/u);
});

test('the workspace checks an explicitly pinned download without submitting its credential', async () => {
  const modelVersion = { ...version, files: [{ ...files[1], type: 'Model', name: 'model.safetensors' }] };
  const result = await checkWorkspaceAsset(context, { kind: 'Checkpoint', file: 'local.safetensors' }, '', {
    reference: marked, fetcher: fixture([], { appVersion: modelVersion, published: modelVersion }),
    readHistory: async () => ({ candidates: [], flows: [], listed: 0, verified: 0 }),
  });
  assert.equal(result.identity, 'download');
  assert.deepEqual(result.matching.map(({ model, file }) => [model.id, file.id]), [[62, 92]]);
});
