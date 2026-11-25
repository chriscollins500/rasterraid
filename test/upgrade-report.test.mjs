import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverReport, reportMarkdown } from '../src/report.mjs';
import { reportResearchPlans } from '../src/report-research.mjs';
import { creatorMemoryClaims, upgradeForSearch, upgradeMemoryComparison, upgradeSources, upgradeStorageChange, upgradeVersionLink } from '../src/upgrade-evidence.mjs';
import { workspaceFilters } from '../src/workspace.mjs';

const origin = 'https://civitai.com';
const context = { origin, hosted: true, browsingLevel: 3, token: 'fixture' };
const pair = { from: { modelId: 41, versionId: 61, fileId: 91 }, to: { modelId: 41, versionId: 62, fileId: 92 } };
const brief = { scope: 'report', reportType: 'workflow', reportSources: upgradeSources,
  query: upgradeVersionLink(origin, pair.to), upgradePair: pair };
const guideLink = origin + '/articles/32';
const relatedLink = origin + '/articles/34';
const mediaOrigin = 'https://image.civitai.com';
const version = (id, fileId, publishedAt, sizeKB, format = 'SafeTensor') => ({ id, name: 'Release ' + id, publishedAt,
  baseModel: 'SDXL 1.0', baseModelType: 'Standard', availability: 'Public', supportsGeneration: id === 61, trainedWords: [],
  files: [{ id: fileId, name: 'paper_' + id + '.safetensors', metadata: { format, fp: 'fp16' }, sizeKB }],
});
const older = version(61, 91, '2025-01-04T00:00:00Z', 1024);
const newer = version(62, 92, '2026-01-04T00:00:00Z', 2048);

function catalogFixture(observed, { versions = [older, newer], gateStatus = 200 } = {}) {
  return (url, config) => {
    observed.push([url.pathname, url.searchParams.get('entityIds')]);
    assert.equal(config.credentials, 'omit');
    assert.equal(config.method, undefined);
    assert.equal(config.body, undefined);
    assert.doesNotMatch(url.href, /private|folder|userId/u);
    if (url.pathname === '/api/v1/blocks/models') {
      assert.equal(url.searchParams.get('modelVersionIds'), '61,62');
      assert.equal(config.headers.Authorization, 'Bearer fixture');
      return Response.json({ items: [{ id: 41, name: 'Paper texture', type: 'Checkpoint', creator: { username: 'artist' }, modelVersions: versions }] });
    }
    if (url.pathname === '/api/v1/blocks/images') {
      const id = Number(url.searchParams.get('modelVersionId'));
      return Response.json({ items: [{ id: id + 100, type: 'image', url: mediaOrigin + '/example-' + id + '.jpeg',
        meta: { civitaiResources: id === 62 ? [{ modelVersionId: id }] : [] } }] });
    }
    assert.equal(config.headers.Authorization, undefined);
    if (url.pathname === '/api/v1/permissions/check') {
      return Response.json({ 61: true, 62: false, 99: true }, { status: gateStatus });
    }
    assert.equal(url.pathname, '/api/v1/models/41');
    return Response.json({ id: 41, allowNoCredit: false, allowDerivatives: true, allowCommercialUse: '{Image}',
      description: '<p>All tests on RTX 4060 (8 GB VRAM) with FP8 at 832×1216.</p>', modelVersions: [
      { ...older, description: '<p>Original texture release.</p>' }, { ...newer, description: '<p>Revised edges. Creator recommends 12 GB VRAM.</p>' },
    ] });
  };
}

function articleSearch(calls) {
  return async (_context, { scope, query }) => {
    calls.push([scope, query]);
    if (scope !== 'articles') return { candidates: [], related: {}, flows: [] };
    const articles = [
      { id: 32, title: 'Creator’s upgrade guide', link: guideLink, author: 'artist', citations: [
        { scope: 'models', id: 41, versionId: 62, link: brief.query },
      ] },
      { id: 34, title: 'Paper texture review', link: relatedLink, author: 'reviewer', citations: [] },
    ];
    return { candidates: [], related: { articles: articles.filter(article => query === 'Paper texture' || article.link === query)
      .map(article => query === 'Paper texture' ? { id: article.id, title: article.title, link: article.link } : article) }, flows: [] };
  };
}

test('an upgrade report batches exact files and combines public permissions, creator facts, examples and verified article links', async () => {
  const reads = [];
  const discovery = [];
  const privateMarker = 'private-workflow-folder';
  const result = await discoverReport(context, { ...brief, upgradePair: { ...pair, from: { ...pair.from, path: privateMarker } } },
    { fetcher: catalogFixture(reads), discoverSource: articleSearch(discovery) });
  assert.equal(reads.filter(([route]) => route === '/api/v1/blocks/models').length, 1);
  assert.ok(reads.some(([route, ids]) => route === '/api/v1/permissions/check' && ids === '61,62'));
  assert.equal(discovery.filter(([scope]) => scope === 'models' || scope === 'gallery').length, 0);
  assert.ok(discovery.some(([, query]) => query === guideLink));
  const { report } = result;
  const upgrade = report.upgrade;
  assert.equal(report.title, 'Review a workflow upgrade');
  assert.deepEqual(result.candidates.map(row => [row.id, row.selectedFile.id]), [[61, 91], [62, 92]]);
  assert.equal(upgrade.matches, true);
  assert.equal(upgrade.deltaKB, 1024);
  assert.match(upgradeStorageChange(upgrade), /1 MiB more/u);
  assert.equal(upgrade.previous.publicGeneration, true);
  assert.equal(upgrade.next.publicGeneration, false);
  assert.match(upgrade.next.hardware, /12 GB VRAM/u);
  const memory = upgradeMemoryComparison(upgrade, 8);
  assert.deepEqual(memory.sources.map(source => [source.title, source.link, source.claims[0].kind, source.claims[0].difference]), [
    ['Proposed release', brief.query, 'recommended', '4 GB below this figure'],
    ['Model listing', origin + '/models/41', 'tested', 'Same stated capacity'],
  ]);
  assert.equal(upgrade.previous.example.recorded, false);
  assert.equal(upgrade.next.example.recorded, true);
  assert.ok(upgrade.usage.includes('Credit required'));
  assert.deepEqual(upgrade.guides.map(guide => [guide.mentions, guide.creator]), [['exact', true], ['related', false]]);
  const copied = reportMarkdown(report, 8);
  assert.match(copied, /Model version \| #61 \| #62/u);
  assert.match(copied, /Generation access when signed out \| Allowed \| Gated/u);
  assert.match(copied, /Creator article · Links to version #62/u);
  assert.match(copied, /Your setup lists 8 GB[\s\S]*4 GB below this figure[\s\S]*832×1216/u);
  assert.doesNotMatch(reportMarkdown(report), /Your setup lists/u);
  assert.doesNotMatch(copied, new RegExp(privateMarker, 'u'));
  const plans = reportResearchPlans(report);
  assert.deepEqual(plans.map(plan => plan.title), ['Draft a migration checklist', 'Cross-check the upgrade', 'Check the upgrade and examples']);
  const expectedLinks = [upgrade.termsLink, ...upgrade.guides.map(guide => guide.link)];
  assert.ok(plans.every(plan => expectedLinks.every(link => plan.sources.some(source => source.link === link))));
  assert.doesNotMatch(JSON.stringify(plans), /private-workflow-folder|Bearer fixture|Your setup lists|4 GB below this figure/u);
  assert.match(JSON.stringify(plans), /catalogFit[\s\S]*fileId/u);
});

test('a withheld proposed release stays out of the report, public permission check and paid comparison', async () => {
  const reads = [];
  const result = await discoverReport(context, brief, { fetcher: catalogFixture(reads, { versions: [older], gateStatus: 429 }),
    discoverSource: articleSearch([]) });
  const upgrade = result.report.upgrade;
  assert.equal(upgrade.next, null);
  assert.equal(upgrade.previous.publicGeneration, null);
  assert.equal(upgrade.matches, false);
  assert.ok(upgrade.memorySources.every(source => source.link !== brief.query));
  assert.deepEqual(reads.filter(([route]) => route === '/api/v1/permissions/check'), [['/api/v1/permissions/check', '61']]);
  assert.deepEqual(result.candidates.map(row => row.id), [61]);
  assert.deepEqual(reportResearchPlans(result.report), []);
});

test('a saved comparison retains public exact IDs only and belongs to its proposed release link', () => {
  const input = { ...brief, upgradePair: { ...pair, to: { ...pair.to, localPath: 'private path' } } };
  assert.deepEqual(upgradeForSearch(input), pair);
  assert.deepEqual(workspaceFilters(input).upgradePair, pair);
  assert.equal(workspaceFilters({ ...input, query: origin + '/models/41?modelVersionId=68' }).upgradePair, undefined);
  assert.equal(upgradeForSearch({ ...input, scope: 'all' }), null);
  assert.equal(upgradeForSearch({ ...input, upgradePair: { ...pair, from: { ...pair.from, modelId: 99 } } }), null);
});

test('creator memory extraction preserves setup conditions and distinguishes explicit figures from mentions', () => {
  const claims = creatorMemoryClaims('<p>Minimum VRAM: 8 GB for FP8.</p>' +
    '<p>16 GB VRAM recommended for the full workflow.</p><li>Tested with 8GB VRAM and 32 GB RAM.</li>' +
    '<p>The file size is 6 GB on disk.</p><p>Some users have 10GB of VRAM.</p>');
  assert.deepEqual(claims.map(row => [row.kind, row.amount]), [['minimum', 8], ['recommended', 16], ['tested', 8], [undefined, undefined]]);
  assert.equal(claims[2].note, 'Tested with 8GB VRAM and 32 GB RAM.');
  assert.ok(claims.every(row => !row.note.includes('disk')));

  const uncertain = creatorMemoryClaims('<p>VRAM needs vary (8–16 GB).</p>' +
    '<p>Tested with 8 GB VRAM and failed.</p><p>This does not require 12 GB VRAM.</p>' +
    '<p>Requires 8 GB VRAM for FP8 and 16 GB VRAM for FP16.</p>');
  assert.equal(uncertain.length, 4);
  assert.ok(uncertain.every(row => row.amount === undefined));
});

test('local comparison stays neutral for missing figures and different units', () => {
  assert.equal(upgradeMemoryComparison({}, null), null);
  assert.match(upgradeMemoryComparison({ memoryChecked: true }, 24).empty, /contained no graphics memory figures/u);
  assert.match(upgradeMemoryComparison({}, 24).empty, /unavailable/u);
  const [claim] = creatorMemoryClaims('Requires 12 GiB of graphics memory for the full workflow.');
  const comparison = upgradeMemoryComparison({ memorySources: [{ claims: [claim] }] }, 12);
  assert.equal(comparison.sources[0].claims[0].label, 'Creator’s minimum · 12 GiB');
  assert.equal(comparison.sources[0].claims[0].difference, undefined);
});
