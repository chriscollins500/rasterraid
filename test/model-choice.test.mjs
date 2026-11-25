import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, SITE_ORIGINS } from '../src/catalog.mjs';
import { rankDistinctModelFiles } from '../src/model-reranker.mjs';
import { discover, readModelPage } from '../src/search.mjs';

const hashes = 'abcdef12'.split('').map(digit => digit.repeat(64));
const listing = (id, title, hash, extra = {}) => ({
  id, name: title, type: 'LORA', status: 'Published', availability: 'Public', creator: { username: 'PrintCreator' },
  allowNoCredit: true, allowDerivatives: true, allowDifferentLicense: true, allowCommercialUse: ['Image'],
  modelVersions: [{ id: id + 100, name: 'v1.0', baseModel: 'SDXL 1.0', baseModelType: 'Standard',
    status: 'Published', availability: 'Public', paidAccess: null, supportsGeneration: true, trainedWords: ['print'],
    files: [{ id: id + 200, name: 'print.safetensors', type: 'Model', metadata: { format: 'SafeTensor' }, hashes: { SHA256: hash } }],
    ...extra }],
});
const models = [
  listing(1, 'Linocut', hashes[0]), listing(2, 'Linocut Shadow', hashes[1]), listing(3, 'Linocut Paper', hashes[2]),
  listing(4, 'Linocut Line', hashes[3]), listing(5, 'Linocut Ink', hashes[4]),
  listing(6, 'Linocut Ink', hashes[4].toUpperCase()), listing(7, 'Linocut Stamp', hashes[6]),
];
const versions = rows => rows.map(row => row.id);

for (const origin of SITE_ORIGINS) {
  test('model relevance makes room for a distinct file and retains both exact links on ' + origin, async () => {
    const context = { origin, token: 'readonly-fixture', hosted: true, browsingLevel: 3 };
    const calls = [];
    const fetcher = async (url, request) => {
      assert.equal(url.origin, origin);
      assert.equal(request.credentials, 'omit');
      calls.push(url.pathname);
      if ([CATALOG.models, CATALOG.blockModels].includes(url.pathname)) {
        const exact = url.searchParams.get('modelVersionIds')?.split(',').map(Number);
        const items = exact ? models.filter(model => exact.includes(model.modelVersions[0].id)) :
          url.searchParams.get('query')?.toLowerCase().startsWith('linocut') ? models : [];
        return Response.json({ items });
      }
      if (url.pathname === CATALOG.blockImages) return Response.json({ items: [] });
      if (url.pathname === CATALOG.tags) return Response.json({ items: [] });
      assert.fail('Unexpected catalog endpoint ' + url.pathname);
    };
    const filters = { scope: 'models', query: 'Linocut', resourceType: 'LORA', baseModel: 'SDXL 1.0' };
    const prior = await discover(context, filters, { fetcher, rankModelEvidence: false });
    const baselineCalls = calls.splice(0).toSorted();
    const preview = [];
    const ranked = await discover(context, filters, { fetcher, onRanked: row => preview.push(versions(row.candidates)) });
    assert.deepEqual(versions(prior.candidates), [101, 102, 103, 104, 105, 106]);
    assert.deepEqual(versions(ranked.candidates), [101, 102, 103, 104, 105, 107]);
    assert.deepEqual(preview, [[101, 102, 103, 104, 105, 107]]);
    assert.deepEqual(versions(ranked.shortlisted), versions(prior.shortlisted));
    assert.deepEqual(calls.splice(0).toSorted(), baselineCalls);
    assert.ok(ranked.candidates.every(row => row.base === 'SDXL 1.0' && row.type === 'LORA'));
    const next = await readModelPage(context, ranked.modelPager.nextCursor, { fetcher });
    assert.deepEqual(versions(next.items), [106]);
    const [otherListing] = next.items;
    assert.deepEqual(otherListing.sameDownloadAs, { modelId: 5, id: 105 });
    assert.equal(otherListing.link, origin + '/models/6?modelVersionId=106');
    const sameName = await discover(context, { ...filters, query: 'Linocut Ink' }, { fetcher, catalogOnly: true });
    // All exact-name matches stay ahead of alternatives when the viewer searches that name.
    const exactRows = sameName.candidates.filter(row => row.nameMatch);
    assert.deepEqual(versions(exactRows), [105, 106]);
    const newest = await discover(context, { ...filters, sort: 'Newest' }, { fetcher });
    assert.deepEqual(versions(newest.candidates), versions(prior.candidates));
  });
}

test('same-file ranking abstains for changed license, incomplete provenance, or weak alternatives', () => {
  const item = (id, name, hash, extra = {}) => ({
    id, modelId: id + 100, model: name, version: 'v1.0', creator: 'PrintCreator', base: 'SDXL 1.0', type: 'LORA',
    publiclyListed: true, downloadAccess: 'free', completeFileHashes: true, files: [{ fileType: 'Model', sha256: hash }],
    match: 1, rank: .05, usage: { creditOptional: true, commercial: ['Image', 'Rent'] }, ...extra,
  });
  const lead = item(1, 'Linocut Print', hashes[0]);
  const repeat = item(2, lead.model, hashes[0], { usage: { creditOptional: true, commercial: ['Rent', 'Image'] } });
  const choice = item(3, 'Linocut Title', hashes[1]);
  assert.deepEqual(versions(rankDistinctModelFiles([lead, repeat, choice], 2)), [1, 3, 2]);
  for (const different of [
    { nameMatch: 2 }, { base: 'Flux.1 D' }, { version: 'v1.1' }, { downloadAccess: 'paid' },
    { files: [{ fileType: 'Model', sha256: hashes[5] }] },
    { files: [...repeat.files, { fileType: 'VAE', sha256: hashes[2] }] }, { creator: 'OtherCreator' },
    { completeFileHashes: false }, { usage: { creditOptional: false, commercial: ['Image', 'Rent'] } },
    { generationListed: false }, { publiclyListed: false },
  ]) {
    const candidates = [lead, { ...repeat, ...different }, choice];
    assert.equal(rankDistinctModelFiles(candidates, 2), candidates, JSON.stringify(different));
  }
  for (const weak of [{ match: .5 }, { rank: .002 }, { completeFileHashes: false }, { nameMatch: 2 }]) {
    const candidates = [lead, repeat, { ...choice, ...weak }];
    assert.equal(rankDistinctModelFiles(candidates, 2), candidates, JSON.stringify(weak));
  }
  const beyondWindow = [lead, repeat, ...[4, 5, 6].map(id => item(id, 'Weak result ' + id, hashes[id], { match: 0 })), choice];
  assert.equal(rankDistinctModelFiles(beyondWindow, 2), beyondWindow);
});
