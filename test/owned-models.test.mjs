import assert from 'node:assert/strict';
import test from 'node:test';

const root = process.env.RASTERRAID_TEST_DIST ? '../dist/src/' : '../src/';
const { discover, readModelPage } = await import(root + 'search.mjs');
const { discoverReport, reportMarkdown } = await import(root + 'report.mjs');
const { reportResearchPlans } = await import(root + 'report-research.mjs');
const { workspaceFilters } = await import(root + 'workspace.mjs');

const origin = 'https://civitai.com';
const author = { origin, hosted: true, token: 'fixture-credential', viewerUserId: 21, viewerUsername: 'FixtureViewer', browsingLevel: 3 };
const digest = 'a'.repeat(64);
const pictureURL = 'https://image.civitai.com/fixture/woodcut.png';
const file = (id, SHA256 = digest) => ({ id, name: 'woodcut.safetensors', hashes: { SHA256 }, metadata: { format: 'SafeTensor' } });
const model = (id, name, versions = [id + 100], extra) => ({
  id, name, type: 'LORA', userId: 21, tags: ['linocut'], creator: { username: 'FixtureViewer' },
  availability: 'Public', modelVersions: versions.map(id => ({
    id, name: 'v1', availability: 'Public', baseModel: 'SDXL 1.0', supportsGeneration: true,
    files: [file(id + 100)], publishedAt: '2026-11-02T09:15:00Z', trainedWords: ['woodcut'],
  })), ...extra,
});
const image = version => ({ id: version + 200, postId: 81, url: pictureURL, browsingLevel: 1,
  meta: { civitaiResources: [{ modelVersionId: version }] } });
const owned = (items, nextCursor) => Response.json({ items, metadata: { owner: 'mine', nextCursor } });
const filters = { scope: 'ownedModels', query: '', sort: 'Newest', category: 'linocut', supportsGeneration: 'true',
  resourceType: 'LORA', baseModel: 'SDXL 1.0', fileFormat: 'SafeTensor' };

test('my published models bind transport, filters, order and cursor to the current Civitai viewer', async () => {
  for (const domain of ['https://civitai.com', 'https://civitai.red']) {
    const context = { ...author, origin: domain };
    const reads = [];
    const first = model(31, 'Woodcut release');
    const fetcher = async (url, options) => {
      assert.equal(url.origin, domain);
      assert.equal(options.headers.Authorization, 'Bearer ' + context.token);
      assert.equal(options.credentials, 'omit');
      if (url.pathname.endsWith('/images')) return Response.json({ items: [image(Number(url.searchParams.get('modelVersionId')))] });
      assert.equal(url.pathname, '/api/v1/blocks/models');
      assert.equal(options.cache, 'no-store');
      const params = Object.fromEntries(url.searchParams);
      const { cursor, ...rest } = params;
      assert.deepEqual(rest, { owner: 'mine', limit: '6', sort: 'Newest', types: 'LORA', baseModels: 'SDXL 1.0', supportsGeneration: 'true' });
      reads.push(cursor);
      if (cursor) return owned([first, model(72, 'Older release')], cursor);
      return owned([first, model(35, 'Second release'), model(33, 'Someone else', undefined, { userId: 90 }),
        model(34, 'Private', undefined, { availability: 'Private' }), model(36, 'Wrong tag', undefined, { tags: ['painting'] })], 'native-cursor');
    };
    const result = await discover(context, filters, { fetcher });
    assert.equal(result.ownerStatus, 'ready');
    assert.deepEqual(result.candidates.map(row => row.modelId), [31, 35]);
    assert.equal(result.nativeLink, domain + '/user/FixtureViewer/models');
    assert.equal(result.candidates[0].examples[0].preview, pictureURL);
    assert.deepEqual(result.candidates[0].examples[0].associated, [131]);
    await assert.rejects(readModelPage({ ...context, viewerUserId: 90 }, result.modelPager.nextCursor, { fetcher }), /access changed/iu);
    await assert.rejects(readModelPage({ ...context, browsingLevel: 1 }, result.modelPager.nextCursor, { fetcher }), /access changed/iu);
    assert.deepEqual(reads, [undefined]);
    const page = await readModelPage(context, result.modelPager.nextCursor, { fetcher });
    assert.deepEqual(page.items.map(row => row.modelId), [72]);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(reads, [undefined, 'native-cursor']);
  }
});

test('my published models verify exact pins and reject older responses and guest reads', async () => {
  const fetcher = async url => {
    assert.equal(url.searchParams.get('owner'), 'mine');
    assert.equal(url.searchParams.get('query'), null);
    assert.equal(url.searchParams.get('modelVersionIds'), '131');
    assert.equal(url.pathname, '/api/v1/blocks/models');
    return owned([model(31, 'Woodcut', [131, 150]), model(32, 'Another contributor', [131], { userId: 90 })]);
  };
  const exact = 'https://civitai.red/models/31?modelVersionId=131';
  const result = await discover(author, { scope: 'ownedModels', query: exact }, { fetcher, catalogOnly: true });
  assert.deepEqual(result.candidates.map(row => row.id), [131]);
  assert.equal(result.candidates[0].link, origin + '/models/31?modelVersionId=131');
  const wrong = await discover(author, { scope: 'ownedModels', query: 'https://civitai.com/models/99?modelVersionId=131' }, { fetcher, catalogOnly: true });
  assert.deepEqual(wrong.candidates, []);
  for (const metadata of [{ owner: 'any' }, {}]) {
    const old = await discover(author, { scope: 'ownedModels', query: 'Woodcut' }, {
      fetcher: async url => {
        assert.equal(url.pathname, '/api/v1/blocks/models');
        return Response.json({ items: [model(31, 'Wrong scope')], metadata });
      },
    });
    assert.equal(old.ownerStatus, 'unverified');
    assert.deepEqual(old.candidates, []);
    assert.equal(old.modelPager, undefined);
  }
  const fail = () => assert.fail('The guest or non-model reference must not reach the catalog.');
  const guest = await discover({ ...author, token: null, viewerUserId: null }, { scope: 'ownedModels' }, { fetcher: fail });
  assert.equal(guest.ownerStatus, 'sign-in');
  assert.equal(guest.nativeLink, origin + '/');
  assert.equal((await discover(author, { scope: 'ownedModels', query: origin + '/images/123' }, { fetcher: fail })).ownerStatus, 'wrong-reference');
});

test('a shared digest retains distinct eligible versions and leaves the intended listing unselected', async () => {
  const paths = [];
  const fetcher = async (url, options) => {
    paths.push(url.pathname);
    if (url.pathname.endsWith('/by-hash/ids')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, undefined);
      assert.deepEqual(JSON.parse(options.body), [digest]);
      return Response.json([131, 132, 133].map(modelVersionId => ({ modelVersionId, hash: digest.toUpperCase() })));
    }
    assert.equal(url.pathname, '/api/v1/blocks/models');
    assert.equal(url.searchParams.get('modelVersionIds'), '131,132,133');
    return Response.json({ items: [model(31, 'An eligible woodcut', [131, 132])] });
  };
  const result = await discover(author, { scope: 'models', query: digest.toUpperCase() }, { fetcher, catalogOnly: true });
  assert.equal(result.hashStatus, 'shared');
  assert.deepEqual(result.candidates.map(row => [row.id, row.selectedFile.id]), [[132, 232], [131, 231]]);
  assert.deepEqual(result.shortlisted, []);
  assert.deepEqual(paths, ['/api/v1/model-versions/by-hash/ids', '/api/v1/blocks/models']);
});

test('a release report combines only owner-verified versions, exact example media and verified public posts', async () => {
  const checked = [];
  const fetcher = async (url, options) => {
    checked.push(url.pathname);
    if (url.pathname.endsWith('/models')) {
      assert.equal(url.searchParams.get('owner'), 'mine');
      return owned([model(31, 'Woodcut'), model(33, 'Wrong owner', undefined, { userId: 90 })]);
    }
    if (url.pathname.endsWith('/images')) {
      assert.equal(url.searchParams.get('modelVersionId'), '131');
      return Response.json({ items: [image(131)] });
    }
    assert.equal(url.pathname, '/api/v1/posts/81');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ id: 81, title: 'Woodcut examples', publishedAt: '2026-11-02T09:15:00Z', nsfwLevel: 1,
      modelVersionId: 131, images: [{ id: 331, postId: 81, browsingLevel: 1 }] });
  };
  const preset = { scope: 'report', reportType: 'portfolio', query: '' };
  const { report } = await discoverReport(author, preset, { fetcher });
  assert.deepEqual(checked, ['/api/v1/blocks/models', '/api/v1/blocks/images', '/api/v1/posts/81']);
  assert.deepEqual(report.rails.map(rail => [rail.scope, rail.status, rail.count]),
    [['ownedModels', 'ready', 1], ['gallery', 'traced', 1], ['posts', 'traced', 1]]);
  assert.deepEqual(report.connections.map(row => row.kind), ['recorded', 'post-model', 'post-media']);
  assert.equal(report.portfolio.releases[0].recorded, 1);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /Published 2026-11-02.*1 listed trigger phrase shown.*1 of 1 sampled previews record this version/u);
  assert.doesNotMatch(markdown, /Wrong owner|fixture-credential/u);
  const plans = reportResearchPlans(report);
  assert.deepEqual(plans.map(plan => plan.title), ['Draft a release checklist', 'Audit release evidence', 'Review the release previews']);
  const research = JSON.stringify(plans);
  assert.match(research, /releaseSample.*331/u);
  assert.doesNotMatch(research, /Wrong owner|fixture-credential|viewerUserId/u);
  assert.deepEqual(workspaceFilters(preset).reportSources, ['ownedModels', 'gallery', 'posts']);

  const denied = await discoverReport(author, preset, { fetcher: async url => {
    assert.equal(url.pathname, '/api/v1/blocks/models');
    return Response.json({ items: [model(31, 'Untrusted listing')] });
  } });
  assert.equal(denied.report.rails[0].status, 'unavailable');
  assert.deepEqual(denied.report.evidence, []);
  assert.deepEqual(denied.report.portfolio.releases, []);
});
