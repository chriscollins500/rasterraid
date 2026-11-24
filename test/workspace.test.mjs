import assert from 'node:assert/strict';
import test from 'node:test';
import { appPrivateRecord } from '../src/workflow-journal.mjs';
import { environmentProfile, inspectWorkflowGraph } from '../src/workflow-profile.mjs';
import { discover, readModelFileHistory, searchTarget } from '../src/search.mjs';
import { checkWorkflowFiles, checkWorkspaceAsset, checkWorkspaceSetup, mergeWorkspaceBackup, readWorkspaceBackup, recentSearchLabel,
  recentWorkspaceSearches, reopenShortlist, saveWorkspaceEntry, versionReferences, workspaceBackup, workspaceBackupPlan,
  workspaceDocument, workspaceFilters } from '../src/workspace.mjs';
import { workflowAuditMarkdown } from '../src/workspace-file-view.js';
import { compareWorkspaceExample, workspaceExampleMarkdown } from '../src/workspace-example.mjs';

const origin = 'https://civitai.red';
const id = '4dc68d75-e558-4d1a-a360-f1ec18de9017';

test('example setup compares exact versions, filename clues and conflicting references without exporting local filenames', () => {
  const entry = (modelId, versionId, family = 'Krea 2') => ({ versionId, types: ['LoRA'], weights: [.7], model: {
    title: 'Model ' + modelId, modelId, family, type: 'LORA', files: ['published-' + modelId + '.safetensors'],
    link: origin + '/models/' + modelId + '?modelVersionId=' + versionId,
  } });
  const example = { link: origin + '/images/100', video: false, unlinked: [{ weight: .8 }], limited: true,
    recorded: [entry(1, 10), entry(2, 20), entry(3, 30), { versionId: 40 }, entry(5, 50)],
    associated: [entry(6, 60)] };
  const profile = { baseModel: 'KREA 2', assets: [
    { kind: 'Checkpoint', air: 'urn:air:krea2:lora:civitai:1@10+101.safetensors' },
    { kind: 'LoRA', air: 'urn:air:krea2:lora:civitai:1@11' },
    { kind: 'LoRA', file: 'C:/local-private/PUBLISHED-2.safetensors' },
    { kind: 'LoRA', file: 'published-3.safetensors', air: 'urn:air:krea2:lora:civitai:3@31' },
    { kind: 'LoRA', air: 'urn:air:krea2:lora:civitai:7@50', file: 'published-5.safetensors' },
    { kind: 'LoRA', file: 'C:/local-private/secret-name.safetensors' },
  ] };
  const comparison = compareWorkspaceExample(example, profile);
  assert.deepEqual(comparison.rows.map(row => row.identity), ['exact', 'filename', 'other', 'unavailable', 'absent']);
  assert.deepEqual(comparison.rows.map(row => row.versionId), [10, 20, 30, 40, 50]);
  assert.match(comparison.rows[0].facts.join(' · '), /pins file #101.*version #11.*listing type differs/u);
  assert.equal(comparison.rows[0].fit, 'Matches your declared family');
  assert.equal(comparison.rows[3].fit, 'Catalog model family needs verification');
  assert.equal(compareWorkspaceExample(example, { baseModel: 'SDXL 1.0' }).rows[0].fit, 'Differs from your declared family');
  assert.equal(comparison.summary, '1 exact version · 1 filename to verify');
  const markdown = workspaceExampleMarkdown(comparison);
  assert.match(markdown, /One recorded strength needs an exact version/u);
  assert.doesNotMatch(markdown, /local-private|secret-name|published-2|Model 6/u);
});

test('save a cross-source search with its exact settings and omit session credentials and private scopes', () => {
  const options = {
    scope: 'report', query: 'linocut', baseModel: 'SDXL 1.0', reportType: 'style', reportSources: ['models', 'articles', 'gallery'],
    audioFamilies: ['stale data'], token: 'private', viewerUserId: 14,
  };
  const current = workspaceDocument(null);
  const saved = saveWorkspaceEntry(current, 'searches', 'My report', options, id);
  assert.deepEqual(saved.searches[0].filters, {
    scope: 'report', query: 'linocut', baseModel: 'SDXL 1.0', reportType: 'style', reportSources: ['models', 'articles', 'gallery'],
  });
  assert.deepEqual(current.searches, []);
  assert.deepEqual(workspaceDocument(JSON.parse(JSON.stringify(saved))), saved);
  assert.equal(workspaceFilters({ scope: 'messages', query: 'private text' }), null);
  assert.equal(workspaceFilters({ scope: 'all', query: origin + '/user/downloads' }), null);
  assert.equal(workspaceFilters({ scope: 'models', query: '', workspaceShortlist: true }), null);
});

test('a workspace backup preserves active gallery refinements in gallery searches and release reports', () => {
  const filters = { query: 'cat', mediaSort: 'Newest', mediaPeriod: 'Week', mediaCreator: '@a-creator',
    mediaBaseModels: 'SDXL 1.0, Flux.1 D, Illustrious, SDXL 1.0', mediaPublishedPrompt: 'true' };
  const gallery = { scope: 'videos', ...filters };
  const workspace = saveWorkspaceEntry(workspaceDocument(null), 'searches', 'Clip search', gallery, id);
  const restored = readWorkspaceBackup(workspaceBackup(workspace));
  assert.deepEqual(restored.searches[0].filters, { ...gallery, mediaCreator: 'a-creator', mediaBaseModels: 'SDXL 1.0,Flux.1 D,Illustrious' });
  assert.deepEqual(workspaceFilters({ scope: 'articles', ...filters }), { scope: 'articles', query: 'cat', mediaSort: 'Newest' });
  const release = { ...filters, scope: 'report', reportType: 'release', query: 'https://civitai.red/models/4?modelVersionId=8' };
  assert.deepEqual(workspaceFilters(release), { ...release, mediaCreator: 'a-creator', mediaBaseModels: 'SDXL 1.0,Flux.1 D,Illustrious',
    reportSources: ['models', 'gallery', 'videos', 'posts'] });
  assert.equal(workspaceFilters({ ...release, reportSources: ['models', 'articles'] }).mediaCreator, undefined);
});

test('saved model searches preserve multi-select facets and older single choices', () => {
  const filters = { scope: 'models', query: 'DreamShaper', baseModel: ['SD 1.5', 'SDXL 1.0'],
    resourceType: ['Checkpoint', 'LORA'], supportsGeneration: 'true' };
  const workspace = saveWorkspaceEntry(workspaceDocument(null), 'searches', 'Two families', filters, id);
  assert.deepEqual(readWorkspaceBackup(workspaceBackup(workspace)).searches[0].filters, filters);
  assert.deepEqual(workspaceFilters({ ...filters, resourceType: 'LORA' }).resourceType, 'LORA');
});

test('shortlists persist exact version identities and drop versions the current viewer cannot read', async () => {
  const versions = versionReferences([{ modelId: 4, id: 6, title: 'Old label' }, { modelId: 4, id: 6 }, { modelId: 4, id: 7 }]);
  assert.deepEqual(versions, [{ modelId: 4, versionId: 6 }, { modelId: 4, versionId: 7 }]);
  const requests = [];
  const result = await reopenShortlist({ origin, browsingLevel: 1, hosted: true, token: 'catalog-token' }, versions, {
    withExamples: false,
    async fetcher(url, options) {
      assert.equal(url.origin, origin);
      assert.equal(options.headers.Authorization, 'Bearer catalog-token');
      requests.push(url.pathname + url.search);
      return Response.json({ items: [{ id: 4, name: 'Fresh label', modelVersions: [{ id: 6 }] }] });
    },
  });
  assert.deepEqual(requests, ['/api/v1/blocks/models?modelVersionIds=6%2C7&limit=2']);
  assert.deepEqual(result.candidates.map(item => item.model), ['Fresh label']);
  assert.equal(result.candidates[0].link, origin + '/models/4?modelVersionId=6');
  assert.deepEqual(result.unavailable, [{ modelId: 4, versionId: 7 }]);
});

test('a saved shortlist checks every file pin in one version batch and preserves the chosen order', async () => {
  const known = 'a'.repeat(64);
  const versions = versionReferences([
    { modelId: 8, id: 20, selectedFile: { id: 60, sha256: known.toUpperCase() } },
    { modelId: 8, id: 20, selectedFile: { id: 61 } },
    { modelId: 4, versionId: 12, filePins: [{ fileId: 70, sha256: known }] },
    { modelId: 6, versionId: 3 },
  ]);
  assert.deepEqual(versions[0].filePins, [{ fileId: 60, sha256: known }, { fileId: 61 }]);
  const requests = [];
  const result = await reopenShortlist({ origin, browsingLevel: 3, hosted: true, token: 'fixture' }, versions, {
    withExamples: false,
    fetcher(url) {
      requests.push(url.href);
      assert.deepEqual(Object.fromEntries(url.searchParams), { modelVersionIds: '20,12,3', limit: '3' });
      const filler = Array.from({ length: 24 }, (_, index) => ({ id: 100 + index, name: 'different.bin' }));
      return Response.json({ items: [
        { id: 6, name: 'Plain version', modelVersions: [{ id: 3 }] },
        { id: 4, name: 'Changed file', modelVersions: [{ id: 12, files: [
          { id: 70, name: 'different.safetensors', hashes: { SHA256: 'b'.repeat(64) } },
          { id: 71, name: 'another.safetensors', hashes: { SHA256: known } },
        ] }] },
        { id: 8, name: 'Pinned files', modelVersions: [{ id: 20, files: [...filler,
          { id: 60, name: 'first.safetensors', hashes: { SHA256: known.toUpperCase() } }, { id: 61, name: 'another.gguf' },
        ] }] },
      ] });
    },
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(result.candidates.map(row => row.id), [20, 3]);
  assert.deepEqual(result.candidates[0].savedFiles.map(file => file.id), [60, 61]);
  assert.equal(result.candidates[0].selectedFile, undefined);
  assert.deepEqual(result.unavailable, [versions[1]]);
  assert.deepEqual(result.unavailableFiles, [{ modelId: 4, versionId: 12, fileId: 70 }]);
  assert.deepEqual(versionReferences(result.candidates), [versions[0], versions[2]]);
});

test('workspace backup preserves scope, exact tag, exclusions and pins with no account or local workflow fields', () => {
  const exclude = 'watermark, ' + 'unwanted '.repeat(18).trim();
  const gallery = { scope: 'gallery', query: 'woodcut', selectedMediaTag: { id: 84, name: 'woodcut', token: 'hidden' },
    mediaSort: 'newest', useCamera: true };
  const search2 = { scope: 'models', query: 'print', exclude };
  const entries = {
    searches: [{ id, name: 'Print examples', filters: gallery }, { id: '4dc68d75-e558-4d1a-a360-f1ec18de9018', name: 'Print search', filters: search2 }],
    shortlists: [{ id, name: 'Exact models', versions: [{ modelId: 4, versionId: 8, filePins: [{ fileId: 9 }] }] }],
    profile: { runtime: 'comfyui', assets: [{ kind: 'Checkpoint', file: 'local-checkpoint.safetensors' }] },
    viewerUserId: 47, history: ['my-local-history'], credentials: 'private',
  };
  const payload = workspaceBackup(entries);
  assert.doesNotMatch(payload, /hidden|my-local-history|RuntimeData|local-checkpoint|viewerUserId|credentials|useCamera/u);
  const parsed = readWorkspaceBackup(payload);
  assert.deepEqual(parsed.searches[0].filters.selectedMediaTag, { id: 84, name: 'woodcut' });
  assert.equal(parsed.searches[1].filters.exclude, exclude);
  assert.deepEqual(parsed.shortlists, entries.shortlists);
  const invalid = JSON.parse(payload);
  invalid.shortlists[0].versions[0].filePins[0].sha256 = 'invalid';
  assert.throws(() => readWorkspaceBackup(JSON.stringify(invalid)), /invalid|incomplete/u);
  invalid.shortlists = [];
  invalid.searches[0].filters.scope = 'messages';
  assert.throws(() => readWorkspaceBackup(JSON.stringify(invalid)), /invalid/u);
});

test('workspace backup merges individual choices idempotently and keeps conflicting saved IDs separate', () => {
  const prior = saveWorkspaceEntry(workspaceDocument(null), 'searches', 'My text search', { scope: 'all', query: 'paper' }, id);
  const otherId = '4dc68d75-e558-4d1a-a360-f1ec18de9018';
  const newId = '4dc68d75-e558-4d1a-a360-f1ec18de9019';
  const backup = readWorkspaceBackup(workspaceBackup({ searches: [
    { ...prior.searches[0], id: otherId }, { ...prior.searches[0], filters: { scope: 'models', query: 'refined paper' } },
  ], shortlists: [] }));
  const plan = workspaceBackupPlan(prior, backup);
  assert.deepEqual(plan.duplicates, { searches: 1, shortlists: 0 });
  assert.equal(plan.additions.searches.length, 1);
  const merged = mergeWorkspaceBackup(prior, backup, () => newId);
  assert.deepEqual(merged.searches.map(row => [row.id, row.filters.query]), [[newId, 'refined paper'], [id, 'paper']]);
  assert.deepEqual(mergeWorkspaceBackup(merged, backup), merged);
});

test('history restores recent public searches and excludes private activity and credentials', () => {
  const report = { query: 'linocut', scope: 'report', reportType: 'trace', reportSources: ['models', 'posts'] };
  const recent = recentWorkspaceSearches([{ ...report, token: 'fixture' }, { scope: 'downloads', query: 'private' },
    { scope: 'report', reportSources: ['models', 'posts'], reportType: 'trace', query: 'linocut' },
    { scope: 'all', query: origin + '/user/vault' }, { scope: 'articles', catalogSort: 'oldest', query: '' }]);
  assert.deepEqual(recent, [report, { scope: 'articles', catalogSort: 'oldest', query: '' }]);
  assert.equal(recentSearchLabel(recent[0]), 'Trace an example');
  assert.equal(recentSearchLabel(recent[1]), 'Articles');
  assert.equal(recentWorkspaceSearches(Array.from({ length: 30 }, (_, i) => ({ scope: 'models', query: String(i) }))).length, 20);
});

test('workspace documents use the Civitai compare-and-set contract and remain bound to one viewer', async () => {
  let context = { origin, viewerUserId: 4, token: 'fixture', signedIn: true, scopes: ['apps:storage'] };
  const requests = [];
  const record = appPrivateRecord(context, () => context, 'search-workspace', {
    fetcher: async (url, config) => {
      assert.equal(url.href, origin + '/api/v1/blocks/storage/prefs/search-workspace');
      assert.equal(config.credentials, 'omit');
      requests.push(config.body ? JSON.parse(config.body) : null);
      return config.method === 'GET' ? Response.json({ code: 'not_found' }, { status: 404 }) :
        Response.json({ version: 1, data: JSON.parse(config.body).data });
    },
  });
  assert.equal(await record.read(), null);
  await record.write({ searches: [] });
  assert.deepEqual(requests, [null, { data: { searches: [] }, ifVersion: 0 }]);
  context = { ...context, viewerUserId: 9 };
  await assert.rejects(record.read(), /original Civitai account/u);
  assert.equal(requests.length, 2);
});

test('workflow inspection reads known model filenames from graph, subgraph and API formats', () => {
  const checkpoint = { kind: 'Checkpoint', file: 'print.safetensors' };
  const lora = { kind: 'LoRA', file: 'texture.safetensors' };
  const graph = { nodes: [{ type: 'CheckpointLoaderSimple', widgets_values: ['models\\print.safetensors'] }],
    definitions: { subgraphs: [{ nodes: [
      { type: 'LoraLoader', widgets_values: ['loras/texture.safetensors', 1, 1] },
      { type: 'UnrecognizedNode', widgets_values: ['noise.safetensors'] },
    ] }] } };
  assert.deepEqual(inspectWorkflowGraph(graph),
    { nodeCount: 3, assets: [checkpoint, lora], mode: 'inventory', outputs: 0, excluded: 0, unresolved: 0 });
  assert.deepEqual(inspectWorkflowGraph({ prompt: { 1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'print.safetensors' } },
    2: { class_type: 'LoraLoader', inputs: { lora_name: 'texture.safetensors' } } } }).assets, [checkpoint, lora]);
  assert.deepEqual(environmentProfile({ runtime: 'comfyui', baseModel: 'SDXL 1.0', vram: '24', assets: [checkpoint, lora, lora] }),
    { runtime: 'comfyui', baseModel: 'SDXL 1.0', vram: 24, assets: [checkpoint, lora] });
});

test('workflow filename checks find an earlier release and prefer an eligible same-family update', async () => {
  const older = { id: 3, modelId: 9, model: 'Print Texture', version: '1', link: origin + '/models/9?modelVersionId=3',
    base: 'SDXL 1.0', type: 'Checkpoint', checkpointRole: 'Standard', publishedAt: '2025-07-21T00:00:00Z',
    files: [{ id: 4, name: 'PrintTexture_v1.safetensors', format: 'SafeTensor', precision: 'fp16' }] };
  const current = { ...older, id: 5, publishedAt: '2026-11-02T00:00:00Z', formats: ['SafeTensor'],
    version: '2', link: origin + '/models/9?modelVersionId=5', releaseNotes: 'The author updated the print texture.',
    files: [{ id: 6, name: 'PrintTexture_v2.safetensors', format: 'SafeTensor', precision: 'fp16' }] };
  const different = { ...current, id: 7, base: 'Flux.1 D', publishedAt: '2026-11-21T00:00:00Z',
    link: origin + '/models/9?modelVersionId=7' };
  const inpainting = { ...current, id: 8, checkpointRole: 'Inpainting', publishedAt: '2026-11-20T00:00:00Z',
    link: origin + '/models/9?modelVersionId=8' };
  const quantized = { ...current, id: 10, publishedAt: '2026-11-19T00:00:00Z',
    files: [{ ...current.files[0], id: 268, precision: 'fp8' }], link: origin + '/models/9?modelVersionId=10' };
  const calls = [];
  const asset = { kind: 'Checkpoint', file: 'folder/PrintTexture_v1.safetensors' };
  const check = await checkWorkspaceAsset({ origin }, asset, 'SDXL 1.0', {
    async discoverSource(_context, filters, options) {
      assert.equal(options.catalogOnly, true);
      calls.push(filters);
      return { candidates: [current], flows: [] };
    },
    async readHistory(_context, modelId, { file }) {
      assert.equal(modelId, current.modelId);
      assert.equal(file, 'PrintTexture_v1.safetensors');
      return { candidates: [current, different, inpainting, quantized, older], flows: [], verified: 5, listed: 5 };
    },
  });
  assert.deepEqual(calls.map(({ query, baseModel }) => [query, baseModel]), [['PrintTexture', 'SDXL 1.0']]);
  assert.equal(check.matching[0].model.id, older.id);
  assert.equal(check.newer.id, current.id);
  assert.equal(check.newerFile.id, 6);
  assert.equal(check.verifiedReleases, 5);
  assert.equal(check.releasesChecked, true);
  assert.deepEqual(check.otherReleases.map(row => row.model.id), [7, 8, 10]);
  assert.match(check.otherReleases[1].reason, /checkpoint role/u);
  const profile = environmentProfile({ assets: [asset], baseModel: 'SDXL 1.0' });
  const exportText = workflowAuditMarkdown([{ asset: profile.assets[0], check }], profile, '2026-11-22');
  assert.match(exportText, /modelVersionId=5/u);
  assert.match(exportText, /author updated the print texture/u);
  assert.ok(!exportText.includes('folder/'));
});

test('release history prioritizes a named older file, batches App checks, and keeps withheld releases out', async () => {
  const models = Array.from({ length: 27 }, (_, index) => ({
    id: 100 + index, name: 'Version ' + (index + 1), baseModel: 'SDXL 1.0', baseModelType: 'Standard',
    publishedAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
    description: '<p>Creator release notes</p>', files: [{ id: 1000 + index, name: 'Print' + index + '.safetensors' }],
  }));
  const record = { id: 30, name: 'Print', type: 'Checkpoint', modelVersions: models, allowDerivatives: true };
  const calls = [];
  const result = await readModelFileHistory({ origin, hosted: true, browsingLevel: 3, token: 'fixture' }, 30, {
    file: 'Print0.safetensors',
    fetcher(url, request) {
      if (url.pathname === '/api/v1/models/30') {
        assert.equal(request.headers.Authorization, undefined);
        return Response.json(record);
      }
      assert.equal(url.pathname, '/api/v1/blocks/models');
      assert.equal(request.headers.Authorization, 'Bearer fixture');
      const ids = url.searchParams.get('modelVersionIds').split(',').map(Number);
      calls.push(ids);
      return Response.json({ items: [{ id: 30, name: 'Print', type: 'Checkpoint',
        modelVersions: models.filter(row => row.id !== 126 && ids.includes(row.id)).map(row => ({ ...row, description: null })) }] });
    },
  });
  assert.deepEqual(calls.map(ids => ids.length), [12, 12, 3]);
  assert.equal(calls[0][0], 100);
  assert.equal(result.listed, 27);
  assert.equal(result.verified, 26);
  assert.ok(result.candidates.every(row => row.id !== 126 && row.usage.derivatives));
  assert.equal(result.candidates.find(row => row.id === 100).releaseNotes, 'Creator release notes');
});

test('an audit preserves completed files and retries a throttled file before advancing', async () => {
  const settings = { assets: Array.from({ length: 10 }, (_, index) => ({ kind: 'LoRA', file: 'Reference_' + index + '.safetensors' })) };
  let permit = false;
  const options = {
    async discoverSource(_context, filters) {
      if (!permit && filters.query === 'Reference 1') return { candidates: [], flows: [{ status: 429, retryAfter: '15' }] };
      return { candidates: [], flows: [] };
    },
  };
  const first = await checkWorkflowFiles({ origin }, settings, options);
  assert.equal(first.next, 1);
  assert.equal(first.rows[0].asset.file, 'Reference_0.safetensors');
  assert.equal(first.retryAfter, '15');
  permit = true;
  const page = await checkWorkflowFiles({ origin }, settings, { ...options, offset: first.next });
  assert.equal(page.rows[0].asset.file, 'Reference_1.safetensors');
  assert.equal(page.next, 9);
  const last = await checkWorkflowFiles({ origin }, settings, { ...options, offset: page.next });
  assert.equal(last.next, null);
  assert.equal(last.rows[0].asset.file, 'Reference_9.safetensors');
});

test('a SHA-256 answer must contain the exact digest in the App-visible file list', async () => {
  const sha = '7'.repeat(64);
  const context = { origin, hosted: true, token: 'fixture', browsingLevel: 3 };
  let files = [{ id: 8, name: 'mismatch.safetensors', hashes: { SHA256: '8'.repeat(64) } }];
  const options = { catalogOnly: true, fetcher(url, config) {
    if (url.pathname.endsWith('/by-hash/' + sha)) {
      assert.equal(config.headers.Authorization, undefined);
      return Response.json({ id: 6, modelId: 4 });
    }
    assert.equal(url.pathname, '/api/v1/blocks/models');
    return Response.json({ items: [{ id: 4, name: 'Print', type: 'Checkpoint',
      modelVersions: [{ id: 6, baseModel: 'SDXL 1.0', files }] }] });
  } };
  assert.equal((await discover(context, { scope: 'models', query: sha }, options)).candidates.length, 0);
  files = [{ id: 7, name: 'first.safetensors', hashes: { SHA256: sha } },
    { id: 9, name: 'second.safetensors', hashes: { SHA256: sha } }];
  const result = await discover(context, { scope: 'models', query: sha }, options);
  assert.equal(result.candidates[0].selectedFile, undefined);
  assert.deepEqual(result.candidates[0].matchingFiles.map(file => file.id), [7, 9]);
});

test('setup evidence verifies exact versions before combining usable files and published usage metadata', async () => {
  const candidates = [{ id: 4, name: 'Print', modelVersions: [{ id: 6, name: '6', baseModel: 'SDXL 1.0',
    supportsGeneration: true, availability: 'Public', files: [{ id: 3, name: 'print.safetensors', metadata: { fp: 'fp16' }, sizeKB: 2048 },
      { id: 4, name: 'training.zip', type: 'Training Data' }] }] },
  { id: 5, name: 'Other', modelVersions: [{ id: 8, name: '8', baseModel: 'Flux.1 D' }] }];
  const fetches = [];
  const report = await checkWorkspaceSetup({ origin, browsingLevel: 3, hosted: true, token: 'catalog-fixture' }, [
    { modelId: 4, versionId: 6 }, { modelId: 5, versionId: 8 }, { modelId: 9, versionId: 10 },
  ], { runtime: 'comfyui', baseModel: 'SDXL 1.0', vram: 24 }, {
    async fetcher(url, request) {
      fetches.push(url.pathname);
      if (url.pathname === '/api/v1/blocks/models') {
        assert.equal(request.headers.Authorization, 'Bearer catalog-fixture');
        return Response.json({ items: candidates });
      }
      assert.equal(request.headers.Authorization, undefined);
      if (url.pathname === '/api/v1/models/4') return Response.json({ id: 4, modelVersions: [{ id: 6 }],
        allowNoCredit: false, allowDerivatives: true, allowCommercialUse: '{Image,RentCivit}' });
      return Response.json({ id: 5, modelVersions: [{ id: 8 }], allowCommercialUse: null });
    },
  });
  assert.deepEqual(fetches.sort(), ['/api/v1/blocks/models', '/api/v1/models/4', '/api/v1/models/5']);
  assert.match(report.cards[0].family, /matches your declared family/u);
  assert.equal(report.cards[0].files.length, 1);
  assert.deepEqual(report.cards[0].usage, ['Listed commercial uses · Generated images, Paid generation on Civitai', 'Credit required', 'Derivatives allowed']);
  assert.match(report.cards[1].family, /differs from/u);
  assert.deepEqual(report.cards[1].usage, []);
  assert.deepEqual(report.unavailable, [{ modelId: 9, versionId: 10 }]);
  assert.equal(report.vram, 24);
});

test('a file-pinned AIR must resolve the exact model, version and file under App access', async () => {
  const sha = '4'.repeat(64);
  const address = 'urn:air:sdxl:checkpoint:civitai:4@6+7.safetensors';
  assert.throws(() => searchTarget('urn:air:sdxl:checkpoint:huggingface:4@6'), /canonical Civitai AIR/u);
  const fetcher = url => {
    if (url.pathname === '/api/v1/blocks/models') {
      assert.equal(url.searchParams.get('modelVersionIds'), '6');
      return Response.json({ items: [{ id: 4, name: 'Print', type: 'Checkpoint', browsingLevel: 1,
        modelVersions: [{ id: 6, name: 'Exact', baseModel: 'SDXL 1.0', trainedWords: [], files: [
          { id: 7, name: 'print.safetensors', metadata: { format: 'SafeTensor' }, hashes: { SHA256: sha } },
        ] }] }] });
    }
    assert.equal(url.pathname, '/api/v1/blocks/images');
    return Response.json({ items: [] });
  };
  const context = { origin, hosted: true, token: 'fixture', browsingLevel: 3 };
  const exact = await discover(context, { scope: 'models', query: address }, { fetcher });
  assert.equal(exact.candidates[0].link, origin + '/models/4?modelVersionId=6');
  assert.deepEqual(exact.candidates[0].selectedFile, { id: 7, name: 'print.safetensors', format: 'SafeTensor', sha256: sha });
  const wrong = await discover(context, { scope: 'models', query: address.replace('+7', '+8') }, { fetcher });
  assert.deepEqual(wrong.candidates, []);
});
