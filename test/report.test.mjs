import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverReport, reportMarkdown, reportSettings } from '../src/report.mjs';
import { reportResearchPlans, reportSynthesisPlan } from '../src/report-research.mjs';
import { articleCitations } from '../src/article-sources.mjs';
import { CATALOG } from '../src/catalog.mjs';
import { discover } from '../src/search.mjs';
import { createWorkflowSession } from '../src/workflow-session.mjs';
import { createWorkflowSimulationClient } from '../mock/client.mjs';
import { createWorkflowSimulation } from '../mock/workflows.mjs';

const origin = 'https://civitai.red';
const context = { origin };
const picture = 'https://image.civitai.com/fixture/gallery.jpg';
const stream = 'https://image.civitai.com/fixture/music.mp4';
const candidate = { id: 8, modelId: 4, model: 'Print', version: 'SDXL', creator: 'Creator', base: 'SDXL 1.0', type: 'LORA',
  link: origin + '/models/4?modelVersionId=8', examples: [{ id: 123, recorded: [8], associated: [8] }] };
const gallery = { id: 123, title: 'Gallery picture', description: 'A carved print', preview: picture, tags: [], postId: 48,
  link: origin + '/images/123' };
const article = { id: 32, title: 'A printing guide', preview: picture, link: origin + '/articles/32', summary: 'A source note' };
const post = { id: 48, title: 'A print post', tags: [], link: origin + '/posts/48', modelVersionId: 8, previews: [gallery] };
const audio = { id: 61, title: 'Music clip', video: true, stream, link: origin + '/images/61', preview: picture, tags: [] };
const collection = { id: 5, title: 'A public collection', link: origin + '/collections/5' };
const empty = scope => ({ scope, target: { kind: 'text', value: 'linocut' }, related: {}, candidates: [], flows: [], alternateQueries: [] });

test('a story brief connects gallery settings to verified models, a creator and matching tool searches', async () => {
  const app = { ...context, hosted: true, token: 'read-only-fixture', browsingLevel: 3 };
  const resultFor = (scope, rows) => ({ ...empty(scope), related: { [scope]: rows } });
  const media = { id: 123, type: 'image', url: picture, browsingLevel: 1, username: 'Publisher',
    meta: { meta: { steps: 35, sampler: 'Euler', prompt: 'private-story-prompt-canary',
      comfy: JSON.stringify({ workflow: { nodes: [{ type: 'KSampler', hidden: 'raw-graph-canary' }] } }),
      civitaiResources: [{ modelVersionId: 8, type: 'lora', weight: .7 }] } } };
  const calls = [];
  const partials = [];
  const result = await discoverReport(app, { reportType: 'stories', baseModel: ['SDXL 1.0'],
    query: 'Plan a short illustrated story about cyberpunk, find bounties' }, {
    async discoverSource(_context, filters) {
      const { scope, query, comicGenre } = filters;
      calls.push([scope, query, comicGenre]);
      if (scope === 'gallery') {
        assert.deepEqual(filters.mediaBaseModels, ['SDXL 1.0']);
        return resultFor(scope, [gallery]);
      }
      if (scope === 'comics' && comicGenre) return resultFor(scope, [{ id: 15, title: 'Space routes', link: origin + '/comics/15' }]);
      if (scope === 'articles') return resultFor(scope, [article]);
      if (scope === 'tools') return resultFor(scope, [{ id: 86, title: 'ComfyUI', link: origin + '/tools/comfyui' }]);
      if (scope === 'apps') return resultFor(scope, [{ id: 'comfy', title: 'Comfy on Civitai', link: origin + '/apps/store-preview/comfy' }]);
      if (scope === 'users') return resultFor(scope, [
        { id: 8, title: 'Publisher2', link: origin + '/user/Publisher2' },
        { id: 9, title: 'Publisher', link: origin + '/user/Publisher' },
      ]);
      if (scope === 'bounties') return resultFor(scope, [{ id: 100, title: 'Cyberpunk prompt contest', link: origin + '/bounties/100' }]);
      return empty(scope);
    },
    async fetcher(url, request) {
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, CATALOG.blockImages);
      assert.equal(url.searchParams.get('ids'), '123');
      assert.equal(request.headers.Authorization, 'Bearer read-only-fixture');
      return Response.json({ items: [media] });
    },
    async recordedSource(_context, plan, filters) {
      assert.deepEqual(plan.records, [{ versionId: 8 }]);
      assert.deepEqual(filters.baseModel, ['SDXL 1.0']);
      return { candidates: [candidate], flows: [] };
    },
    onRanked(snapshot) { partials.push(snapshot.report); },
  });
  assert.ok(partials.some(report => report.rails.some(rail => rail.scope === 'gallery' && rail.count === 1) &&
    report.rails.some(rail => rail.scope === 'tools' && rail.status === 'waiting')));
  assert.ok(partials.every(report => reportResearchPlans(report).length === 0));
  assert.deepEqual(calls.filter(([scope]) => scope === 'comics'), [['comics', 'cyberpunk', undefined], ['comics', '', 'SciFi']]);
  assert.deepEqual(calls.filter(([scope]) => ['apps', 'tools', 'users', 'bounties'].includes(scope)).map(([scope, query]) => [scope, query]),
    [['bounties', 'cyberpunk'], ['users', '@Publisher'], ['tools', 'ComfyUI'], ['apps', 'ComfyUI']]);
  assert.equal(result.report.story.relatedGenre, 'Science fiction');
  assert.equal(result.report.story.runtime, 'ComfyUI');
  assert.equal(result.report.story.toolSource, 'metadata');
  assert.equal(result.report.story.profile, origin + '/user/Publisher');
  assert.ok(result.report.connections.some(edge => edge.kind === 'recorded' && edge.items.some(item => item.versionId === 8)));
  assert.ok(result.report.connections.some(edge => edge.kind === 'creator-credit' && edge.items[1].link.endsWith('/Publisher')));
  const markdown = reportMarkdown(result.report);
  assert.match(markdown, /## Story plan[\s\S]*Choose story references[\s\S]*Find tools and apps[\s\S]*Explore project opportunities/u);
  const plans = reportResearchPlans(result.report);
  assert.deepEqual(plans.map(plan => plan.title),
    ['Draft a sourced story plan', 'Check the production plan', 'Review the visual direction']);
  assert.doesNotMatch(JSON.stringify(plans), /Publisher2|private-story-prompt-canary|raw-graph-canary/u);
});

test('a withheld story reference keeps topic matches without borrowing a runtime or uploader', async () => {
  const app = { ...context, hosted: true, token: 'read-only-fixture', browsingLevel: 3 };
  const scopes = ['gallery', 'models', 'users', 'tools', 'apps'];
  const result = await discoverReport(app, { reportType: 'stories', reportSources: scopes,
    query: 'Plan a short illustrated story about cyberpunk ' + origin + '/images/124' }, {
    async discoverSource(_context, { scope, query }) {
      assert.equal(query, 'cyberpunk');
      assert.notEqual(scope, 'users');
      if (scope === 'gallery') return { ...empty(scope), related: { gallery: [gallery] } };
      return empty(scope);
    },
    async fetcher(url) {
      assert.equal(url.searchParams.get('ids'), '124');
      return Response.json({ items: [{ id: 124, type: 'image', url: picture, browsingLevel: 4, username: 'Withheld',
        meta: { steps: 35, comfy: { workflow: { nodes: [{ type: 'KSampler' }] } } } }] });
    },
  });
  assert.equal(result.report.story.reference, null);
  assert.equal(result.report.story.missingReference, true);
  assert.equal(result.report.story.runtime, null);
  assert.equal(result.report.story.profile, undefined);
  assert.equal(result.related.gallery[0].id, 123);
  assert.doesNotMatch(reportMarkdown(result.report), /Withheld|Tool search · ComfyUI/u);
});

test('a pair compares reported settings and strengths and verifies each linked public source', async () => {
  const app = { ...context, hosted: true, token: 'read-only-fixture', browsingLevel: 3 };
  const requests = [];
  const first = { id: 201, type: 'image', url: picture, browsingLevel: 1, postId: 48, username: 'First',
    meta: { meta: { steps: 12, seed: '4294967297', prompt: 'do-not-include-example-prompt',
      civitaiResources: [{ modelVersionId: 8, type: 'lora', weight: .65 }] } } };
  const second = { id: 202, type: 'video', url: stream, width: 1280, height: 720, browsingLevel: 1, postId: 49, username: 'Second',
    meta: { steps: 24, civitaiResources: [{ modelVersionId: 8, type: 'lora', weight: .85 }, { modelVersionId: 12, weight: 0 }] } };
  const result = await discoverReport(app, { reportType: 'examplePair', query: origin + '/images/201 202' }, {
    async fetcher(url, request) {
      assert.equal(url.origin, origin);
      assert.equal(request.credentials, 'omit');
      requests.push(url.pathname);
      if (url.pathname === CATALOG.blockImages) {
        assert.equal(url.searchParams.get('ids'), '201,202');
        assert.equal(url.searchParams.get('withMeta'), 'true');
        assert.equal(request.headers.Authorization, 'Bearer read-only-fixture');
        return Response.json({ items: [second, { ...first, id: 299 }, first] });
      }
      assert.equal(request.headers.Authorization, undefined);
      const id = Number(url.pathname.split('/').at(-1));
      assert.ok([48, 49].includes(id));
      return Response.json({ id, title: 'Published example ' + id, publishedAt: '2026-11-23T12:00:00Z', nsfwLevel: 1,
        ...(id === 49 && { modelVersionId: 15 }),
        images: [{ id: id === 48 ? 201 : 202, postId: id, browsingLevel: 1 }] });
    },
    async recordedSource(_context, plan) {
      assert.deepEqual(plan.records, [{ versionId: 8 }, { versionId: 12 }, { versionId: 15 }]);
      return { candidates: [candidate, { ...candidate, id: 15, link: origin + '/models/4?modelVersionId=15' },
        { ...candidate, id: 12, link: 'https://example.com/models/4?modelVersionId=12' }], flows: [] };
    },
  });
  const { examples, settings, versions } = result.report.exampleComparison;
  assert.deepEqual(requests, [CATALOG.blockImages, '/api/v1/posts/48', '/api/v1/posts/49']);
  assert.deepEqual(examples.map(({ id, item, post, postModel }) => [id, item.creator, post?.id, postModel?.id]),
    [[201, 'First', 48, undefined], [202, 'Second', 49, 15]]);
  assert.deepEqual(settings, [{ label: 'Steps', values: ['12', '24'] }, { label: 'Seed', values: ['4294967297', null] }]);
  assert.deepEqual(versions.map(({ id, model, values }) => [id, model?.id, values.map(record => record?.weights)]),
    [[8, 8, [[.65], [.85]]], [12, undefined, [undefined, [0]]]]);
  assert.equal(result.report.connections.filter(edge => edge.kind === 'post-media').length, 2);
  assert.equal(result.report.connections.filter(edge => edge.kind === 'post-model').length, 1);
  const markdown = reportMarkdown(result.report);
  assert.match(markdown, /Steps \| 12 \| 24/u);
  assert.match(markdown, /Version #12 · Listing unverified \| Unreported \| Strength 0/u);
  assert.match(markdown, /Version listed by the post/u);
  assert.doesNotMatch(markdown, /do-not-include-example-prompt|example\.com/u);
  const escapedTable = reportMarkdown({ ...result.report, exampleComparison: { ...result.report.exampleComparison,
    settings: [{ label: 'Test field', values: [String.raw`one\|two`, '<three>'] }],
  } });
  assert.ok(escapedTable.includes(String.raw`| Test field | one\\\|two | \<three\> |`));
  const plans = reportResearchPlans(result.report);
  assert.deepEqual(plans.map(plan => plan.body.steps.length), [1, 3, 5]);
  assert.deepEqual(plans.at(-1).inputs.map(input => input.link), [origin + '/images/201', origin + '/images/202']);
  assert.equal(plans.at(-1).stepEvidence.report_clip_caption.sourceLink, origin + '/images/202');
  assert.doesNotMatch(JSON.stringify(plans), /do-not-include-example-prompt|example\.com/u);
});

test('an inaccessible example keeps the other side and cannot become a Deep Search input', async () => {
  const app = { ...context, hosted: true, token: 'read-only-fixture', browsingLevel: 3 };
  const filters = { reportType: 'examplePair', query: '201 202' };
  const result = await discoverReport(app, filters, {
    fetcher(url) {
      assert.equal(url.pathname, CATALOG.blockImages);
      return Response.json({ items: [
        { id: 201, type: 'image', url: picture, browsingLevel: 1, meta: { steps: 12 } },
        { id: 202, type: 'image', url: picture, browsingLevel: 4, postId: 9, meta: { steps: 24 } },
      ] });
    },
  });
  assert.deepEqual(result.report.exampleComparison.examples.map(({ item }) => item?.id), [201, undefined]);
  assert.deepEqual(result.report.exampleComparison.settings, [{ label: 'Steps', values: ['12', null] }]);
  assert.deepEqual(result.report.evidence.map(item => item.link), [origin + '/images/201']);
  assert.deepEqual(reportResearchPlans(result.report), []);
  for (const query of ['201 201', '201 ' + origin + '/images/202?token=fixture', '201 https://example.com/images/202']) {
    await assert.rejects(discoverReport(app, { ...filters, query }, { fetcher: () => assert.fail('Invalid pair made a network request') }),
      /two different Civitai/u);
  }
});

test('a creator report verifies the profile, selected work and public post membership', async () => {
  const profile = { id: 21, title: 'Creator', link: origin + '/user/Creator' };
  const scenes = [{ ...gallery, creator: 'Creator' }, { ...gallery, id: 124, creator: 'Other', link: origin + '/images/124' }];
  const video = { ...audio, postId: 99, creator: 'Creator', width: 720, height: 480 };
  const calls = [];
  const result = await discoverReport(context, { query: '@Creator linocut', reportType: 'creator', baseModel: 'SDXL 1.0',
    reportSources: ['models', 'gallery', 'videos', 'articles', 'posts'] }, {
    async discoverSource(_context, choices) {
      calls.push(choices);
      const { scope } = choices;
      if (scope === 'users') return { ...empty(scope), related: { users: [profile, { id: 22, title: 'Creator2', link: origin + '/user/Creator2' }] } };
      if (scope === 'models') return { ...empty(scope), candidates: [candidate, { ...candidate, creator: 'Other' }] };
      const items = { gallery: scenes, videos: [video], articles: [{ ...article, creator: 'Creator' }] }[scope];
      return { ...empty(scope), related: { [scope]: items } };
    },
    async fetcher(url, options) {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      const id = Number(url.pathname.split('/').at(-1));
      assert.ok([48, 99].includes(id));
      return Response.json({ id, user: { username: id === 48 ? 'Creator' : 'Other' }, title: 'Published images',
        nsfwLevel: 1, publishedAt: '2026-11-23T00:00:00Z', modelVersionId: 8,
        images: [{ id: id === 48 ? 123 : 61, postId: id, browsingLevel: 1 }] });
    },
  });
  assert.deepEqual(calls.find(call => call.scope === 'users'), { scope: 'users', query: '@Creator' });
  assert.deepEqual(calls.find(call => call.scope === 'models'), { scope: 'models', query: 'linocut', modelAuthor: 'Creator', baseModel: 'SDXL 1.0' });
  assert.equal(calls.find(call => call.scope === 'gallery').mediaCreator, 'Creator');
  assert.equal(calls.find(call => call.scope === 'articles').articleAuthor, 'Creator');
  assert.deepEqual(result.related.gallery.map(item => item.id), [123]);
  assert.deepEqual(result.related.posts.map(item => item.id), [48]);
  assert.deepEqual(result.candidates.map(item => item.id), [8]);
  assert.equal(result.report.creator.profile.id, 21);
  assert.equal(result.report.connections.filter(edge => edge.kind === 'creator-credit').length, 5);
  assert.ok(result.report.connections.some(edge => edge.kind === 'post-media'));
  const markdown = reportMarkdown(result.report);
  assert.match(markdown, /Verified public profile/u);
  assert.match(markdown, /This account uploaded the clip/u);
  assert.doesNotMatch(markdown, /Creator2|\/posts\/99/u);
  assert.deepEqual(reportResearchPlans(result.report).map(plan => plan.title),
    ['Summarize the public work', 'Cross-check creator credits', 'Check catalog and media together']);
});

test('creator leads reward work across sources and exclude unconfirmed accounts', async () => {
  const title = 'cinematic ink';
  const calls = [];
  const result = await discoverReport(context, { query: title, reportType: 'creator', reportSources: ['models', 'gallery', 'articles'] }, {
    async discoverSource(_context, { scope, query }) {
      calls.push([scope, query]);
      if (scope === 'users') {
        const handle = query.slice(1);
        return { ...empty(scope), related: { users: handle === 'Ghost' ? [] : [{ id: handle === 'Creator' ? 21 : 22, title: handle, link: origin + '/user/' + handle }] } };
      }
      if (scope === 'models') return { ...empty(scope), candidates: [{ ...candidate, creator: 'Creator' }] };
      const items = { gallery: [{ ...gallery, creator: 'Other' }], articles: [{ ...article, creator: 'Creator' },
        { ...article, id: 33, creator: 'Ghost', link: origin + '/articles/33' }] }[scope];
      return { ...empty(scope), related: { [scope]: items } };
    },
  });
  assert.deepEqual(calls.slice(0, 3), [['models', title], ['gallery', title], ['articles', title]]);
  assert.deepEqual(result.report.creator.leads.map(lead => [lead.profile.title, lead.examples.length]), [['Creator', 2], ['Other', 1]]);
  assert.equal(result.report.evidence.some(item => item.link.endsWith('/33')), false);
  assert.match(reportMarkdown(result.report), /Creator leads from public work/u);
});

test('a missing creator profile stops work searches', async () => {
  const calls = [];
  const result = await discoverReport(context, { query: 'User #290', reportType: 'creator' }, {
    async discoverSource(_context, choices) { calls.push(choices); return empty(choices.scope); },
  });
  assert.deepEqual(calls, [{ scope: 'users', query: 'User #290' }]);
  assert.equal(result.report.creator.unavailable, true);
  assert.equal(result.report.rails.length, 1);
  assert.deepEqual(reportResearchPlans(result.report), []);
});

test('an exact public example joins reported settings to checked versions without assigning legacy strengths', async () => {
  assert.deepEqual(reportSettings('trace', ['models', 'gallery', 'articles', 'posts']).sources,
    reportSettings('trace').sources);
  const hosted = { ...context, hosted: true, token: 'catalog-fixture', browsingLevel: 3 };
  const calls = [];
  const fixture = {
    id: 123, type: 'image', browsingLevel: 1, url: picture, username: 'Publisher', modelVersionIds: [8, 9, 14],
    meta: { meta: { width: 832, height: 1216, steps: 20, seed: '18446744073709551615', cfgScale: 0,
      sampler: 'DPM++ 2M Karras', prompt: 'private-prompt-canary', negativePrompt: 'negative-canary',
      civitaiResources: [
        { modelVersionId: 8, weight: .7, type: 'lora' },
        { modelVersionId: 8, weight: .8, type: 'lora' },
        { modelVersionId: 15, weight: 0, type: 'lora' },
        { modelVersionId: 10, versionId: 14, weight: .9, type: 'lora' },
      ],
      resources: [
        { modelVersionId: 8, weight: .7, type: 'lora' },
        { name: 'path/private-legacy-lora', weight: .5, type: 'lora' },
      ],
    } },
  };
  const filters = { query: gallery.link, reportType: 'trace', reportSources: ['gallery', 'models'] };
  const options = {
    fetcher(url, request) {
      assert.equal(url.origin, origin);
      assert.equal(request.headers.Authorization, 'Bearer catalog-fixture');
      calls.push([url.pathname, Object.fromEntries(url.searchParams)]);
      if (url.pathname === CATALOG.blockImages) return Response.json({ items: [fixture] });
      assert.equal(url.pathname, CATALOG.blockModels);
      return Response.json({ items: [8, 9, 10, 14].map(id => ({
        id: 100 + id, name: 'Published model ' + id, type: 'LORA',
        modelVersions: [{ id, name: 'Release ' + id, baseModel: 'SDXL 1.0', files: [] }],
      })) });
    },
  };
  const result = await discoverReport(hosted, filters, options);
  assert.deepEqual(calls, [
    [CATALOG.blockImages, { imageId: '123', limit: '1', withMeta: 'true' }],
    [CATALOG.blockModels, { modelVersionIds: '8,15,9,14', limit: '4' }],
  ]);
  const setup = result.report.exampleSetup;
  assert.equal(setup.link, gallery.link);
  assert.equal(setup.preview, picture);
  assert.deepEqual(setup.settings, [
    { label: 'Size', value: '832 × 1216' }, { label: 'Steps', value: '20' },
    { label: 'Sampler', value: 'DPM++ 2M Karras' }, { label: 'Seed', value: '18446744073709551615' },
    { label: 'Guidance (CFG)', value: '0' },
  ]);
  assert.deepEqual(setup.recorded.map(row => [row.versionId, row.weights, Boolean(row.model)]), [[8, [.7, .8], true], [15, [0], false]]);
  assert.deepEqual(setup.associated.map(row => row.versionId), [9, 14]);
  assert.equal(setup.unlinked.length, 2);
  assert.equal(setup.unlinked[1].name, 'private-legacy-lora');
  const markdown = reportMarkdown(result.report);
  assert.match(markdown, /Version #8.*Different recorded strengths · 0\.7, 0\.8/u);
  assert.match(markdown, /Version #15.*Recorded strength 0.*unverified/u);
  assert.match(markdown, /## Catalog associations/u);
  assert.doesNotMatch(markdown, /private-prompt-canary|negative-canary/u);
  const plans = reportResearchPlans(result.report);
  assert.deepEqual(plans.map(row => row.id), ['reportbrief', 'reportcheck', 'reportmedia']);
  const proof = JSON.parse(plans[0].body.steps[0].input.messages[1].content);
  assert.deepEqual(proof.publishedSetup.recordedVersions.map(row => [row.versionId, row.weights]), [[8, [.7, .8]]]);
  assert.equal(proof.publishedSetup.strengthsAwaitingVersion, 2);
  assert.doesNotMatch(JSON.stringify(proof), /private-prompt-canary|negative-canary|private-legacy-lora/u);
  assert.equal(plans.at(-1).inputs[0].link, gallery.link);

  const filtered = await discoverReport(hosted, { ...filters, baseModel: 'Krea 2' }, options);
  assert.equal(calls.length, 4, 'Apply the model filter on the original catalog read.');
  assert.deepEqual(filtered.candidates, []);
  assert.ok(filtered.report.exampleSetup.recorded.every(row => !row.model));
  assert.ok(filtered.report.evidence.every(row => row.group !== 'models'));
});

test('an eligible clip poster can carry recorded settings and held media cannot', async () => {
  const hosted = { ...context, hosted: true, token: 'catalog-fixture', browsingLevel: 3 };
  const fetcher = (url) => {
    assert.equal(url.pathname, CATALOG.blockImages);
    const requested = Number(url.searchParams.get('imageId'));
    return Response.json({ items: [{ id: requested, type: 'video', browsingLevel: requested === 61 ? 1 : 8, url: stream,
      thumbnail: { url: picture }, meta: { seed: 1, steps: 70, Size: '640x960' } }] });
  };
  const result = await discoverReport(hosted, { query: audio.link, reportType: 'trace', reportSources: ['videos', 'models'] }, { fetcher });
  assert.equal(result.report.anchor[0].link, audio.link);
  assert.equal(result.report.anchor[0].group, 'videos');
  assert.equal(result.report.exampleSetup.video, true);
  assert.deepEqual(result.report.exampleSetup.settings, [
    { label: 'Size', value: '640 × 960' }, { label: 'Steps', value: '70' }, { label: 'Seed', value: '1' },
  ]);
  const held = await discover(hosted, { query: origin + '/images/62' }, { fetcher, includePublishedSetup: true });
  assert.equal(held.reference, null);
  assert.deepEqual(held.candidates, []);
});

test('mixed reports add exact preview versions, retain ranked models, and cite a clip’s verified post', async () => {
  const hosted = { ...context, hosted: true, token: 'fixture-public-catalog', browsingLevel: 3 };
  const clip = { ...audio, postId: 49, width: 768, height: 768 };
  const head = Array.from({ length: 5 }, (_, i) => ({ ...candidate, id: 8 + i,
    link: origin + '/models/4?modelVersionId=' + (8 + i), examples: [] }));
  const calls = [];
  const interim = [];
  const result = await discoverReport(hosted, { query: 'carved engraving', reportSources: ['models', 'gallery', 'videos', 'posts'],
    baseModel: 'SDXL 1.0' }, {
    onRanked: row => interim.push(row.candidates.map(model => model.id)),
    discoverSource(_, { scope }) {
      return { ...empty(scope), candidates: scope === 'models' ? head : [],
        related: scope === 'gallery' ? { gallery: [gallery] } : scope === 'videos' ? { videos: [clip] } : {} };
    },
    fetcher(url) {
      assert.equal(url.origin, origin);
      calls.push([url.pathname, Object.fromEntries(url.searchParams)]);
      if (url.pathname === CATALOG.blockImages) {
        assert.equal(url.searchParams.get('ids'), '123,61');
        assert.equal(url.searchParams.get('withMeta'), 'true');
        return Response.json({ items: [
          { id: 123, type: 'image', browsingLevel: 1, postId: 48, url: picture, modelVersionIds: [70, 71],
            meta: { civitaiResources: [{ modelVersionId: 71 }, { modelVersionId: 72 }], prompt: 'omit-picture-prompt' } },
          { id: 61, type: 'video', browsingLevel: 1, postId: 49, url: stream, thumbnail: { url: picture }, modelVersionIds: [70] },
        ] });
      }
      if (url.pathname === CATALOG.blockModels) {
        assert.equal(url.searchParams.get('modelVersionIds'), '71,72,70');
        return Response.json({ items: [
          { id: 77, name: 'Traced printer', type: 'LORA', modelVersions: [
            { id: 71, name: 'SDXL style', baseModel: 'SDXL 1.0', files: [] },
            { id: 72, name: 'Other family', baseModel: 'SD 1.5', files: [] },
          ] },
          { id: 78, name: 'Posted checkpoint', type: 'Checkpoint', modelVersions: [{ id: 70, name: 'One', baseModel: 'SDXL 1.0', files: [] }] },
        ] });
      }
      const id = Number(url.pathname.split('/').at(-1));
      assert.ok(id === 48 || id === 49);
      return Response.json({ id, title: 'Public post ' + id, nsfwLevel: 1, publishedAt: '2026-01-02T00:00:00Z',
        ...(id === 49 && { modelVersionId: 70 }), images: [{ id: id === 49 ? 61 : 123, postId: id, browsingLevel: 1 }] });
    },
  });
  assert.deepEqual(interim[0], head.map(model => model.id));
  assert.deepEqual(result.candidates.map(row => row.id), [...head.map(row => row.id), 71, 70]);
  assert.deepEqual(calls.map(([path]) => path).sort(), [CATALOG.blockImages, CATALOG.blockModels, '/api/v1/posts/48', '/api/v1/posts/49'].sort());
  const connections = result.report.connections;
  const has = (kind, first, second) => connections.some(edge => edge.kind === kind &&
    edge.items.some(item => item.link === first) && edge.items.some(item => item.link === second));
  const [fromPicture, fromPost] = result.candidates.slice(-2).map(row => row.link);
  assert.ok(has('recorded', gallery.link, fromPicture));
  assert.ok(has('catalog', clip.link, fromPost));
  assert.ok(has('post-media', clip.link, origin + '/posts/49'));
  assert.ok(has('post-model', origin + '/posts/49', fromPost));
  assert.deepEqual(result.report.mediaModelTrace, { previews: 2, links: [fromPicture, fromPost], partial: false });
  const markdown = reportMarkdown(result.report);
  assert.ok(markdown.includes(fromPicture) && markdown.includes(fromPost));
  const plans = reportResearchPlans(result.report);
  const proof = JSON.parse(plans[0].body.steps[0].input.messages[1].content);
  assert.ok(proof.sources.some(row => row.link === fromPicture) && proof.sources.some(row => row.link === fromPost));
  assert.ok(proof.recordedConnections.every(edge => edge.links.every(link => proof.sources.some(source => source.link === link))));
  assert.doesNotMatch(JSON.stringify(proof), /omit-picture-prompt/u);
  const media = plans.find(plan => plan.id === 'reportmedia');
  assert.deepEqual(media.body.steps.slice(-2).map(step => step.$type), ['videoFrameExtraction', 'mediaCaptioning']);
  assert.equal(media.stepEvidence.report_clip_caption.sourceLink, clip.link);
  assert.equal(media.dependentInputs, true);
});

test('preview model tracing respects the chosen sources and preserves first results when the catalog limits it', async () => {
  const hosted = { ...context, hosted: true, token: 'fixture', browsingLevel: 3 };
  const calls = [];
  const options = {
    discoverSource(_, { scope }) {
      return { ...empty(scope), candidates: scope === 'models' ? [candidate] : [],
        related: scope === 'gallery' ? { gallery: [gallery] } : {} };
    },
    fetcher(url) { calls.push(url.pathname); return Response.json({}, { status: 429 }); },
  };
  const snapshots = await discoverReport(hosted, { query: 'print', reportSources: ['gallery', 'videos'] }, options);
  assert.deepEqual(calls, []);
  assert.equal(snapshots.report.mediaModelTrace, undefined);
  const throttled = await discoverReport(hosted, { query: 'print', reportSources: ['models', 'gallery'] }, options);
  assert.deepEqual(calls, [CATALOG.blockImages]);
  assert.deepEqual(throttled.candidates, [candidate]);
  assert.deepEqual(throttled.related.gallery, [gallery]);
  assert.equal(throttled.report.rails.find(rail => rail.scope === 'models').status, 'partial');
});

test('a model release report joins exact model, picture, clip, and public post reads before quoting a sampled frame', async () => {
  const appContext = { origin, hosted: true, browsingLevel: 3, token: 'read-only-fixture' };
  const reads = [];
  const model = { id: 4, name: 'Print', type: 'LORA', modelVersions: [{ id: 8, name: 'SDXL', baseModel: 'SDXL 1.0', files: [] }] };
  const media = (id, type, postId, options = {}) => ({ id, type, postId, username: 'Uploader', browsingLevel: 1, baseModel: 'SDXL 1.0',
    meta: { prompt: 'engraving', ...(id === 123 && { civitaiResources: [{ modelVersionId: 8 }] }) },
    url: type === 'image' ? picture : stream, ...(type === 'video' && { thumbnail: { url: picture }, width: 768, height: 768 }), ...options });
  const posts = {
    48: { id: 48, title: 'A print post', modelVersionId: 8, images: [{ id: 123, postId: 48, browsingLevel: 1 }] },
    49: { id: 49, title: 'Clip post', modelVersionId: 9, images: [{ id: 61, postId: 49, browsingLevel: 1 }] },
    50: { id: 50, title: 'Nonmatching post', modelVersionId: 8, images: [{ id: 888, postId: 50, browsingLevel: 1 }] },
  };
  const report = await discoverReport(appContext, { reportType: 'release', query: candidate.link, mediaCreator: 'Uploader',
    mediaBaseModels: 'SDXL 1.0', mediaPeriod: 'Year', mediaSort: 'Newest', mediaPublishedPrompt: 'true' }, {
    fetcher(url, options) {
      assert.equal(url.origin, origin);
      reads.push(url.pathname);
      if (url.pathname === CATALOG.blockModels) {
        assert.equal(url.searchParams.get('modelVersionIds'), '8');
        return Response.json({ items: [model] });
      }
      if (url.pathname === CATALOG.blockImages) {
        assert.equal(options.headers.Authorization, 'Bearer read-only-fixture');
        assert.deepEqual(Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'type')), {
          sort: 'Newest', baseModels: 'SDXL 1.0', period: 'Year', username: 'Uploader', modelVersionId: '8', withMeta: 'true', limit: '12', withTags: 'true',
        });
        const images = [media(123, 'image', 48), media(124, 'image', 50), media(125, 'image', 51, { browsingLevel: 8 }),
          media(126, 'image', 52, { meta: {} }), media(127, 'image', 53, { needsReview: true })];
        const stills = url.searchParams.get('type') === 'image';
        const response = Response.json({ items: stills ? images : [media(61, 'video', 49)],
          metadata: { nextCursor: 'next-catalog-page' } });
        return stills ? new Promise(resolve => setImmediate(() => resolve(response))) : response;
      }
      assert.equal(options.headers.Authorization, undefined);
      const id = Number(url.pathname.split('/').at(-1));
      assert.ok(posts[id]);
      return Response.json({ ...posts[id], nsfwLevel: 1, publishedAt: '2026-01-02T00:00:00Z' });
    },
  });
  assert.deepEqual(reads, [CATALOG.blockModels, CATALOG.blockImages, CATALOG.blockImages, '/api/v1/posts/48', '/api/v1/posts/49', '/api/v1/posts/50']);
  assert.deepEqual(report.report.rails.map(({ scope, count, status }) => [scope, count, status]),
    [['models', 1, 'traced'], ['gallery', 2, 'traced'], ['videos', 1, 'traced'], ['posts', 2, 'traced']]);
  assert.deepEqual(report.report.releaseSample.media, { gallery: { shown: 2, more: true, recorded: 1 }, videos: { shown: 1, more: true, recorded: 0 } });
  assert.deepEqual(Object.keys(report.report.releaseSample.media), ['gallery', 'videos']);
  assert.deepEqual(report.report.releaseSample.posts, { linksSampled: 3, verified: 2, listRelease: 1, more: false });
  const edges = report.report.connections;
  assert.ok(edges.some(edge => edge.kind === 'recorded' && edge.items.some(item => item.link === gallery.link)));
  assert.ok(edges.some(edge => edge.kind === 'catalog' && edge.items.some(item => item.link === audio.link)));
  assert.ok(edges.some(edge => edge.kind === 'post-media' && edge.items.some(item => item.link === origin + '/posts/49')));
  assert.deepEqual(edges.filter(edge => edge.kind === 'post-model').map(edge => edge.items[0].link), [post.link]);
  assert.match(reportMarkdown(report.report), /Release gallery sample[\s\S]+2 sampled pictures[\s\S]+post lists this exact model version/u);
  const plans = reportResearchPlans(report.report);
  assert.deepEqual(plans.map(plan => [plan.id, plan.body.steps.length]), [['reportbrief', 1], ['reportcheck', 3], ['reportmedia', 5]]);
  const mediaPlan = plans.at(-1);
  assert.equal(mediaPlan.dependentInputs, true);
  assert.equal(mediaPlan.stepEvidence.report_clip_caption.sourceLink, audio.link);
  assert.deepEqual(mediaPlan.body.steps.at(-1).input.mediaUrl, { $ref: 'report_clip_frame', path: 'output.frames[0].url' });

  let now = 1_000;
  let receipt;
  const mock = createWorkflowSimulation({ now: () => now });
  const client = createWorkflowSimulationClient('http://127.0.0.1:8000', async (url, request) => {
    const response = mock(request.method, url.pathname, JSON.parse(request.body));
    return Response.json(response.body, { status: response.status });
  });
  const settings = { client, origin, now: () => now, journal: {
    read: async () => structuredClone(receipt), write: async value => { receipt = structuredClone(value); },
  } };
  const session = createWorkflowSession(settings);
  await session.prepare(mediaPlan, mediaPlan.sources);
  assert.equal(session.state().quote.price.total, 10);
  assert.equal(session.state().quote.price.authorFee, 1);
  await session.confirm();
  now += 4_000;
  const reopened = createWorkflowSession(settings);
  await reopened.restore();
  await reopened.refresh();
  const { run, snapshot } = reopened.state();
  assert.equal(run.status, 'succeeded');
  const caption = snapshot.steps.find(step => step.name === 'report_clip_caption');
  assert.equal(caption.sourceLink, audio.link);
  assert.match(caption.lines[0], /frame near 0 seconds/u);
  const still = snapshot.steps.find(step => step.name === 'report_picture_1');
  assert.equal(still.purpose, 'Visual evidence');
  assert.ok(mediaPlan.inputs.some(item => item.link === still.sourceLink && item.kind === 'Picture'));
  assert.ok(still.lines.length);
  assert.deepEqual(reportSynthesisPlan(run, snapshot).body.steps.map(step => step.name), ['report_synthesis']);
});

test('release report waits for a choice before reading a gallery when a name matches multiple models', async () => {
  const report = await discoverReport({ origin, hosted: true, browsingLevel: 3, token: 'read-only-fixture' },
    { reportType: 'release', query: 'Print' }, {
      fetcher(url) {
        assert.equal(url.pathname, CATALOG.blockModels);
        assert.equal(url.searchParams.get('query'), 'Print');
        return Response.json({ items: [4, 5].map(id => ({ id, name: 'Print', modelVersions: [{ id: id + 10, name: 'v1' }] })) });
      },
      discoverSource() { assert.fail('The user must choose a release before an exact read.'); },
    });
  assert.deepEqual(report.report.releaseLookup.choices.map(choice => choice.versionId), [14, 15]);
  assert.equal(report.report.evidence.length, 0);
  assert.deepEqual(reportResearchPlans(report.report), []);
});

test('a release must satisfy explicit model requirements before its media enters the report', async () => {
  const result = await discoverReport(context, { reportType: 'release', query: candidate.link, supportsGeneration: 'true' }, {
    fetcher() { assert.fail('Unverified release must not lead to catalog media reads.'); },
    async discoverSource() { return { ...empty('models'), candidates: [candidate] }; },
  });
  assert.deepEqual(result.report.constraints, [['supportsGeneration', 'true']]);
  assert.equal(result.report.evidence.length, 0);
  assert.deepEqual(reportResearchPlans(result.report), []);
});

test('a report joins six public searches, preserves model constraints, and records verified relationships', async () => {
  const reads = [];
  const partial = [];
  const searches = ['models', 'gallery', 'articles', 'posts', 'collections', 'audio'];
  const report = await discoverReport(context, { query: 'linocut', scope: 'report', reportSources: searches, baseModel: 'SDXL 1.0' }, {
    onRanked: value => partial.push(value),
    async discoverSource(_context, filters) {
      reads.push(filters);
      const source = empty(filters.scope);
      if (filters.scope === 'models') return { ...source, candidates: [candidate] };
      const results = { gallery: [gallery], articles: [article], posts: [post], collections: [collection], audio: [audio] };
      return { ...source, related: { [filters.scope]: results[filters.scope] } };
    },
  });
  assert.deepEqual(reads.map(read => [read.scope, read.baseModel]), searches.map(scope => [scope, scope === 'models' ? 'SDXL 1.0' : undefined]));
  assert.equal(partial.length, 1);
  assert.equal(partial[0].report.rails.at(-1).status, 'waiting');
  assert.deepEqual(report.report.rails.map(source => [source.status, source.count]), searches.map(() => ['ready', 1]));
  assert.deepEqual(report.report.connections.map(item => item.kind), ['recorded', 'post-model', 'post-media']);
  assert.deepEqual(report.report.constraints, [['baseModel', 'SDXL 1.0']]);
  assert.ok(reportMarkdown(report.report).includes('https://civitai.red/models/4?modelVersionId=8'));
  const plans = reportResearchPlans(report.report);
  assert.deepEqual(plans.map(plan => [plan.id, plan.body.steps.length]), [['reportbrief', 1], ['reportcheck', 3], ['reportmedia', 6]]);
  assert.deepEqual(plans.at(-1).body.steps.map(step => step.$type),
    ['chatCompletion', 'chatCompletion', 'mediaCaptioning', 'transcription', 'composeMedia', 'audioCaptioning']);
  assert.deepEqual(plans.at(-1).inputs.map(({ link, purpose }) => [link, purpose]), [
    [gallery.link, 'Visual evidence'], [audio.link, 'Full transcript and music description'],
  ]);
});

test('a report keeps each selected model facet in the free read and quoted evidence', async () => {
  const baseModel = ['SDXL 1.0', 'Flux.1 D'];
  const resourceType = ['Checkpoint', 'LORA'];
  const report = await discoverReport(context, { scope: 'report', query: 'print', reportSources: ['models', 'articles'],
    baseModel, resourceType, supportsGeneration: 'true' }, {
    async discoverSource(_context, filters) {
      if (filters.scope === 'models') {
        assert.deepEqual({ baseModel: filters.baseModel, resourceType: filters.resourceType,
          supportsGeneration: filters.supportsGeneration }, { baseModel, resourceType, supportsGeneration: 'true' });
        return { ...empty('models'), candidates: [{ ...candidate, generationListed: true }] };
      }
      return { ...empty('articles'), related: { articles: [article] } };
    },
  });
  assert.match(reportMarkdown(report.report), /Base model · SDXL 1\.0 or Flux\.1 D/u);
  const planned = reportResearchPlans(report.report)[0].body.steps[0].input.messages[1].content;
  assert.deepEqual(JSON.parse(planned).modelFilters, { baseModel, resourceType, supportsGeneration: 'true' });
});

test('a source failure preserves the other results, shows the gap, and keeps private scopes out', async () => {
  const result = await discoverReport(context, { query: 'linocut', scope: 'report', reportSources: ['gallery', 'tools', 'articles'] }, {
    async discoverSource(_context, { scope }) {
      if (scope === 'tools') throw new Error('Unavailable');
      return { ...empty(scope), related: scope === 'gallery' ? { gallery: [gallery] } : { articles: [article] } };
    },
  });
  assert.deepEqual(result.report.rails.map(source => source.status), ['ready', 'unavailable', 'ready']);
  assert.equal(result.related.articles[0].id, 32);
  assert.equal(result.related.gallery[0].id, 123);
  assert.deepEqual(result.flows.map(flow => flow.label), ['Tools']);
  const noRead = { discoverSource() { assert.fail('A private search must not start'); } };
  await assert.rejects(discoverReport(context, { query: 'linocut', reportSources: ['models', 'messages'] }, noRead), /public sources/u);
  await assert.rejects(discoverReport(context, { query: origin + '/user/notifications' }, noRead), /public Civitai link/u);
  assert.throws(() => reportSettings('style', ['models', 'models']), /between two and eight/u);
});

test('a public link is verified first and its identity stays distinct from the report matches', async () => {
  const reads = [];
  const result = await discoverReport(context, { query: candidate.link, reportSources: ['models', 'articles'], baseModel: 'Flux' }, {
    async discoverSource(_context, filters) {
      reads.push(filters);
      if (filters.scope === 'all') return { ...empty('all'), candidates: [candidate] };
      return { ...empty(filters.scope), related: filters.scope === 'articles' ? { articles: [article] } : {} };
    },
  });
  assert.equal(result.target.value, candidate.link);
  assert.deepEqual(reads.map(read => [read.scope, read.query]), [['all', candidate.link], ['models', 'Print'], ['articles', 'Print']]);
  assert.equal(result.report.anchor[0].versionId, 8);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.report.rails.map(source => source.status), ['empty', 'ready']);
  assert.match(reportMarkdown(result.report), /Reference used for search.*Print/u);
});

test('a report recovers linked model pictures when the gallery search needs a native handoff', async () => {
  const model = { ...candidate, examples: [{ ...candidate.examples[0], preview: picture, link: gallery.link }] };
  const result = await discoverReport(context, { query: 'linocut', reportSources: ['models', 'gallery'] }, {
    async discoverSource(_context, { scope }) {
      const source = empty(scope);
      return scope === 'models' ? { ...source, candidates: [model] }
        : { ...source, gallery: { nativeLink: origin + '/images?query=linocut' } };
    },
  });
  assert.equal(result.report.rails[1].status, 'linked');
  assert.equal(result.report.rails[1].nativeLink, origin + '/images?query=linocut');
  assert.equal(result.related.gallery[0].source, candidate.link);
  assert.deepEqual(result.report.connections.map(connection => connection.kind), ['recorded']);
});

test('trace an exact image reuses its version and reads the public post by ID', async () => {
  const requests = [];
  const result = await discoverReport(context, { query: gallery.link, reportType: 'trace' }, {
    async discoverSource(_context, { scope, query }) {
      requests.push([scope, query]);
      if (scope === 'all') return { ...empty(scope), candidates: [{ ...candidate, examples: [] }],
        reference: { ...gallery, recorded: [8], associated: [] } };
      if (scope === 'posts') return { ...empty(scope), related: { posts: [post], postMedia: [gallery] } };
      return { ...empty(scope), related: { articles: [article] } };
    },
  });
  assert.deepEqual(requests, [['all', gallery.link], ['posts', post.link], ['articles', 'Print']]);
  assert.equal(result.report.anchor[0].link, gallery.link);
  assert.deepEqual(result.report.rails.map(rail => rail.status), ['traced', 'traced', 'traced', 'ready']);
  assert.deepEqual(result.report.connections.map(connection => connection.kind), ['recorded', 'post-model', 'post-media']);
  assert.match(reportMarkdown(result.report), /Follows a Civitai reference/u);
});

test('an empty post search joins published picture and clip memberships with only exact post reads', async () => {
  const queries = [];
  const reads = [];
  const partial = [];
  const clip = { ...audio, postId: 49 };
  const withheld = { ...gallery, id: 124, postId: 49, link: origin + '/images/124' };
  const filters = { query: 'linocut', reportSources: ['gallery', 'videos', 'posts', 'articles'] };
  async function discoverSource(_context, { scope, query }) {
    queries.push([scope, query]);
    const related = { gallery: [gallery, withheld], videos: [clip], articles: [article], posts: [] };
    return { ...empty(scope), related: { [scope]: related[scope] } };
  }
  const baseline = await discoverReport(context, filters, { discoverSource, followLinks: false });
  const adaptive = await discoverReport({ ...context, hosted: true, browsingLevel: 3 }, filters, {
    discoverSource, onRanked: value => partial.push(value),
    async fetcher(url, options) {
      reads.push(url.pathname);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Authorization, undefined);
      const id = Number(url.pathname.split('/').at(-1));
      const images = id === 48 ? [{ id: gallery.id, postId: id, browsingLevel: 1 }]
        : [{ id: clip.id, postId: id, browsingLevel: 1 }, { id: withheld.id, postId: id, browsingLevel: 8 }];
      return Response.json({ id, publishedAt: '2026-01-02T00:00:00Z', nsfwLevel: 1, title: 'Verified post ' + id, images });
    },
  });
  assert.equal(baseline.report.rails[2].count, 0);
  assert.deepEqual(adaptive.report.rails.map(rail => rail.status), ['ready', 'ready', 'traced', 'ready']);
  assert.equal(adaptive.related.articles[0].id, article.id);
  assert.equal(partial.at(-1).related.gallery.length, 2);
  assert.equal(partial.at(-1).report.rails[2].count, 0);
  assert.ok(queries.every(([, query]) => query === 'linocut'));
  assert.deepEqual(reads, ['/api/v1/posts/49', '/api/v1/posts/48']);
  assert.deepEqual(adaptive.report.connections.map(({ kind, items }) => [kind, ...items.map(item => item.link)]), [
    ['post-media', clip.link, origin + '/posts/49'],
    ['post-media', gallery.link, origin + '/posts/48'],
  ]);
  assert.match(reportMarkdown(adaptive.report), /part of this public post/u);
});

test('report reuses confirmed membership, preserves verified links, and keeps the leading direct posts', async () => {
  const first = [51, 52, 53, 54].map(id => ({ ...post, id, previews: [], link: origin + '/posts/' + id }));
  const clip = { ...audio, postId: 49 };
  const prior = [
    ...first, { ...post, previews: [], verifiedMediaIds: [gallery.id] },
    { ...post, id: 49, previews: [], verifiedMediaIds: [clip.id], link: origin + '/posts/49' },
  ];
  const result = await discoverReport(context, { query: 'linocut', reportSources: ['posts', 'gallery', 'videos'] }, {
    async discoverSource(_context, { scope }) {
      const related = { posts: prior, gallery: [gallery], videos: [clip] };
      return { ...empty(scope), related: { [scope]: related[scope] } };
    },
    fetcher() { assert.fail('Previously verified membership requires no additional read'); },
  });
  assert.deepEqual(result.related.posts.map(item => item.id), [51, 52, 53, 48, 49]);
  assert.equal(result.report.rails[0].count, prior.length);
  assert.deepEqual(result.report.connections.map(edge => edge.items[0].link), [gallery.link, clip.link]);
});

test('the bounded follow-up includes a clip even when several picture posts have more matching examples', async () => {
  const clip = { ...audio, postId: 49 };
  const pictures = [gallery,
    { ...gallery, id: 124, link: origin + '/images/124' },
    ...[125, 126].map(id => ({ ...gallery, id, postId: 50, link: origin + '/images/' + id })),
  ];
  const reads = [];
  const result = await discoverReport(context, { query: 'linocut', reportSources: ['gallery', 'videos', 'posts'] }, {
    async discoverSource(_context, { scope }) {
      const related = { posts: [], gallery: pictures, videos: [clip] };
      return { ...empty(scope), related: { [scope]: related[scope] } };
    },
    fetcher(url) {
      const id = Number(url.pathname.split('/').at(-1));
      reads.push(id);
      return Response.json({ id, nsfwLevel: 1, publishedAt: '2026-01-02T00:00:00Z',
        images: [...pictures, clip].filter(item => item.postId === id).map(item => ({ id: item.id, postId: id, browsingLevel: 1 })) });
    },
  });
  assert.deepEqual(reads, [48, 49]);
  assert.ok(result.report.connections.some(edge => edge.kind === 'post-media' && edge.items[0].link === clip.link));
});

test('failed or mismatched post lookups leave direct search results and mark incomplete evidence', async () => {
  const direct = { ...post, id: 51, previews: [], link: origin + '/posts/51' };
  const clip = { ...audio, postId: 49 };
  const reads = [];
  const result = await discoverReport(context, { query: 'linocut', reportSources: ['posts', 'gallery', 'videos'] }, {
    async discoverSource(_context, { scope }) {
      const related = { posts: [direct], gallery: [gallery], videos: [clip] };
      return { ...empty(scope), related: { [scope]: related[scope] } };
    },
    fetcher(url) {
      reads.push(url.pathname);
      return url.pathname.endsWith('/49') ? Response.json({ error: 'Unavailable' }, { status: 503 })
        : Response.json({ id: 99, nsfwLevel: 1, publishedAt: '2026-01-02T00:00:00Z',
          images: [{ id: gallery.id, postId: 48, browsingLevel: 1 }] });
    },
  });
  assert.deepEqual(reads, ['/api/v1/posts/48', '/api/v1/posts/49']);
  assert.deepEqual(result.related.posts.map(item => item.id), [51]);
  assert.equal(result.report.rails[0].status, 'partial');
  assert.equal(result.report.connections.length, 0);
});

test('trace uses the post’s exact version when the image has no resource metadata', async () => {
  const requests = [];
  const result = await discoverReport(context, { query: gallery.link, reportType: 'trace', baseModel: 'SDXL 1.0' }, {
    async discoverSource(_context, filters) {
      requests.push([filters.scope, filters.query, filters.baseModel]);
      if (filters.scope === 'all') return { ...empty('all'), reference: gallery };
      if (filters.scope === 'posts') return { ...empty('posts'), related: { posts: [post], postMedia: [gallery] } };
      if (filters.scope === 'models') return { ...empty('models'), candidates: [candidate] };
      return { ...empty('articles'), related: { articles: [article] } };
    },
  });
  assert.deepEqual(requests, [['all', gallery.link, 'SDXL 1.0'], ['posts', post.link, undefined],
    ['models', 'version: 8', 'SDXL 1.0'], ['articles', 'Print', undefined]]);
  assert.equal(result.report.anchor[0].link, gallery.link);
  assert.equal(result.candidates[0].id, 8);
  assert.ok(result.report.connections.some(connection => connection.kind === 'post-model'));
});

test('guide citations canonically identify public sources without retaining tracking or private routes', () => {
  const html = [
    '<a href="https://civitai.com/models/4/print?modelVersionId=8&amp;tracking=yes">Version</a>',
    '<a href="/models/4?modelVersionId=8">Same version</a>',
    '<a href="/models/4?modelVersionId=8&amp;modelVersionId=9">Ambiguous version</a>',
    '<a href="/models/4?modelVersionId=nope">Invalid version</a>',
    '<a href="/models/4/print">Model page</a>',
    '<a href="/images/123/picture">Picture</a>',
    '<a href="/apps/run/some-app">App</a>',
    '<a href="/user/Creator">Creator</a>',
    '<a href="/user/notifications">Private</a>',
    '<a href="/user/creator?chat=secret">Private</a>',
    '<a href="/api/download/models/8">Download</a>',
    '<a href="https://civitai.red.example.org/models/4">External</a>',
  ].join('');
  assert.deepEqual(articleCitations(html, origin).map(({ scope, link }) => [scope, link]), [
    ['models', origin + '/models/4?modelVersionId=8'], ['models', origin + '/models/4'],
    ['gallery', origin + '/images/123'], ['apps', origin + '/apps/store-preview/some-app'], ['users', origin + '/user/Creator'],
  ]);
});

test('an article-guided report verifies links, follows chosen sources, and includes exact media evidence in its Deep Search plans', async () => {
  const model = { ...candidate, examples: [{ ...gallery, recorded: [] }] };
  const exactArticle = { ...article, updatedAt: '2026-11-22T10:00:00.000Z', citations: articleCitations([
    '<a href="/models/4?modelVersionId=8">Confirmed version</a>',
    '<a href="/models/4?modelVersionId=9">Version needs access</a>',
    '<a href="/posts/48">Confirmed post</a>',
    '<a href="/apps/store-preview/example-app">Unselected app</a>',
    '<a href="/models/956?modelVersionId=8">Wrong model ID</a>',
    '<a href="/models/44?modelVersionId=888">Fifth candidate to read</a>',
    '<a href="/articles/32">Same article</a>',
  ].join(''), origin) };
  const input = { query: article.link, reportType: 'guide', reportSources: ['articles', 'models', 'posts', 'gallery'], baseModel: 'SDXL 1.0' };
  const requests = [];
  const phases = [];
  const options = {
    onPhase: phase => phases.push(phase),
    async discoverSource(_context, filters) {
      requests.push(filters);
      if (filters.scope === 'all' && filters.query === article.link) return { ...empty('articles'), related: { articles: [exactArticle] } };
      if (filters.scope === 'models' && filters.query.includes('/models/')) {
        assert.equal(filters.baseModel, 'SDXL 1.0');
        return { ...empty('models'), candidates: [model] };
      }
      if (filters.query === post.link) return { ...empty('posts'), related: { posts: [post], postMedia: [gallery] } };
      return empty(filters.scope);
    },
  };
  const baseline = await discoverReport(context, input, { ...options, followLinks: false });
  assert.equal(baseline.report.connections.length, 0);
  assert.equal(baseline.candidates.length, 0);
  requests.length = 0;
  const result = await discoverReport(context, input, options);
  assert.deepEqual(result.candidates.map(row => row.id), [8]);
  assert.equal(result.related.posts[0].id, 48);
  assert.equal(result.related.gallery[0].id, 123);
  assert.equal(result.report.guideTrace.confirmed, 2);
  assert.equal(result.report.guideTrace.unavailable, 2);
  assert.equal(result.report.guideTrace.unchecked, 1);
  assert.deepEqual(result.report.rails.map(rail => rail.status), ['traced', 'cited', 'cited', 'cited']);
  assert.deepEqual(result.report.connections.slice(0, 3).map(({ kind }) => kind), ['guide-version', 'guide-link', 'guide-model-example']);
  assert.equal(requests.filter(row => row.query === article.link).length, 1);
  assert.equal(requests.filter(row => /\/models\//u.test(row.query)).length, 3);
  assert.ok(!requests.some(row => row.query.includes('example-app') || row.query.includes('modelVersionId=888')));
  assert.ok(phases.includes('Verifying exact resources linked in the guides…'));
  assert.match(reportMarkdown(result.report), /Civitai updated 2026-11-22T10:00/u);
  const plans = reportResearchPlans(result.report);
  assert.deepEqual(plans.map(plan => plan.body.steps.length), [1, 3, 3]);
  assert.ok(JSON.stringify(plans).includes('The guide links to this exact model version'));
  assert.ok(!JSON.stringify(plans).includes('/models/956'));
});

test('guide text opens only leading article records, and unverifiable model filters prevent cited versions from entering the report', async () => {
  const nextArticle = { ...article, id: 33, title: 'Another guide', link: origin + '/articles/33' };
  const exact = { ...article, citations: articleCitations('<a href="/models/4?modelVersionId=8">Version</a>', origin) };
  const requests = [];
  const result = await discoverReport(context, { query: 'print setup', reportType: 'guide', reportSources: ['articles', 'models'],
    period: 'Week', category: 'Style' }, { async discoverSource(_context, filters) {
    requests.push([filters.scope, filters.query, filters.period]);
    if (filters.query === article.link) return { ...empty('articles'), related: { articles: [exact] } };
    if (filters.query === nextArticle.link) throw new Error('Unavailable');
    if (filters.scope === 'models') return empty('models');
    return { ...empty('articles'), related: { articles: [article, nextArticle, { ...article, link: origin + '/articles/34' }] } };
  } });
  assert.deepEqual(result.report.guideTrace.guides.map(guide => guide.link), [article.link]);
  assert.equal(result.report.guideTrace.needFilterEvidence, 1);
  assert.equal(result.report.guideTrace.unreadGuides, 1);
  assert.equal(result.candidates.length, 0);
  assert.ok(requests.some(([scope, , period]) => scope === 'models' && period === 'Week'));
  assert.ok(!requests.some(([, query]) => query.includes('/models/') || query.endsWith('/34')));
});
