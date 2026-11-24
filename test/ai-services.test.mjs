import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiServiceFacets, aiServiceLink, aiServiceReference, rankAiServices, readAiServiceRegistry } from '../src/ai-services.mjs';
import { readDirectoryPage } from '../src/directory.mjs';
import { catalogResearch, catalogResearchItems } from '../src/catalog-research.mjs';
import { discover, searchTarget } from '../src/search.mjs';
import { resultGroups } from '../src/view.js';
import { workspaceFilters } from '../src/workspace.mjs';

const context = { origin: 'https://civitai.red', hosted: true, token: 'private-never-send', browsingLevel: 3 };
const row = (id, name, input, output, step, extra = {}) => ({
  id, name, category: id.split('/')[0], modalities: { input, output }, step,
  status: 'available', tags: ['self-hosted'], ...extra,
});
const extraction = row('video/videoFrameExtraction', 'Video Frame Extraction', ['video'], ['image'], 'videoFrameExtraction',
  { estimate: 'POST /v2/consumer/recipes/videoFrameExtraction?whatif=true' });
const transcription = row('audio/transcription', 'Cohere Transcribe', ['audio', 'video'], ['text'], 'transcription',
  { status: 'unknown', tags: ['multilingual'], metrics: { window: '24h', requests: 22, successRate: 1,
    costBuzz: { p50: 1 }, latencySeconds: { p50: 2.5 }, asOf: '2026-11-23T09:41:50.118Z' } });
const sample = [extraction, transcription, row('text/mediaCaptioning', 'Media captioning', ['video', 'image'], ['text'], 'mediaCaptioning'),
  row('3d/vendor/multiImageTo3D', 'Many pictures to 3D', ['image'], ['3d'], 'polyGen'),
  row('3d/vendor/imageTo3D', 'A picture to 3D', ['image'], ['3d'], 'polyGen'),
  row('3d/model3DPreview', 'Render a 3D preview', ['3d'], ['image'], 'model3DPreview')];

function fetchRegistry(items, extra = () => {}) {
  return (url, options) => {
    assert.equal(url.origin, 'https://orchestration.civitai.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.headers.Authorization, undefined);
    assert.doesNotMatch(url.href + JSON.stringify(options), /private-never-send|spoken%20words/u);
    extra(url);
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    return Response.json({ totalCount: items.length, offset, limit, items: items.slice(offset, offset + limit) });
  };
}

test('live registry search covers multiple pages with filters and reuses the snapshot for result paging', async () => {
  const registry = [...sample, ...Array.from({ length: 195 }, (_, index) => row('audio/speech' + index, 'Audio service ' + index, ['audio'], ['text'], 'audioCaptioning'))];
  const seen = [];
  const fetcher = fetchRegistry(registry, url => seen.push(Number(url.searchParams.get('offset'))));
  const filters = { scope: 'aiServices', serviceInput: 'audio', serviceOutput: 'text' };
  const result = await discover(context, filters, { fetcher });
  assert.deepEqual(seen, [0, 200]);
  assert.equal(result.serviceCatalog.partial, false);
  assert.equal(result.serviceCatalog.count, 201);
  assert.equal(result.serviceCatalog.matches, 196);
  assert.deepEqual(result.serviceCatalog.facets.serviceCategory, ['3d', 'audio', 'text', 'video']);
  assert.equal(result.related.aiServices.length, 18);
  const page = await readDirectoryPage(context, result.scope, result.directory.plan, { cursor: result.directory.nextCursor });
  assert.equal(page.items.length, 18);
  assert.ok(page.items.every(item => item.input.includes('audio') && item.output.includes('text')));
  assert.ok(page.items.every(item => !result.related.aiServices.some(first => first.id === item.id)));
  assert.deepEqual(seen, [0, 200]);
  assert.deepEqual(workspaceFilters(filters), filters);
});

test('capability ranking keeps exact identity and separates speech, captioning, and single-image 3D', async () => {
  const { items } = await readAiServiceRegistry({ fetcher: fetchRegistry(sample) });
  const speech = { query: 'Turn spoken words in a clip into text' };
  assert.deepEqual(rankAiServices(items, speech).map(item => item.id), [transcription.id]);
  assert.ok(rankAiServices(items, { ...speech, serviceMatch: 'keywords' }).some(item => item.id === 'text/mediaCaptioning'));
  assert.equal(rankAiServices(items, { query: 'Make still pictures from a video clip' })[0].id, extraction.id);
  assert.equal(rankAiServices(items, { query: 'Make a 3D object from one picture' })[0].id, '3d/vendor/imageTo3D');
  assert.equal(rankAiServices(items, { query: 'Video Frame Extraction', catalogSort: 'cost' })[0].id, extraction.id);
  assert.equal(rankAiServices(items, { query: 'speech to text', serviceInput: 'image', serviceOutput: '3d' }).length, 0);
  const result = await discover(context, { scope: 'aiServices', query: 'Turn spoken words into text' }, { fetcher: fetchRegistry(sample) });
  const research = catalogResearch(result, resultGroups(result), 'aiServices', context.origin);
  assert.ok(research.picks.some(item => item.link === aiServiceLink(transcription.id)));
  assert.ok(research.picks.find(item => item.title === transcription.name).facts.some(fact => /1 Buzz median/u.test(fact)));
  assert.equal(research.plans[0].body.steps[0].$type, 'chatCompletion');
  assert.deepEqual(catalogResearchItems(result, { aiServices: [{ ...result.related.aiServices[0], link: 'https://unrelated.example/product' }] },
    'aiServices', context.origin), []);
});

test('service details bind an exact public ID and distinguish a missing service', async () => {
  const link = aiServiceLink(extraction.id);
  assert.deepEqual(searchTarget(link), { kind: 'aiService', id: extraction.id });
  assert.deepEqual(searchTarget(extraction.id, { aiServices: true }), { kind: 'aiService', id: extraction.id });
  for (const bad of [link + '?token=wrong', link.replace('https://', 'http://'), link.replace('https://', 'https://example@'),
    link.replace('orchestration.civitai.com', 'orchestration.civitai.com.other.example'), 'https://civitai.com/v2/services/video/transcode']) {
    assert.equal(aiServiceReference(bad), null);
  }
  const result = await discover(context, { scope: 'all', query: link, serviceWindow: '7d' }, {
    fetcher(url, options) {
      assert.equal(url.pathname, '/v2/services/video/videoFrameExtraction');
      assert.equal(url.searchParams.get('window'), '7d');
      assert.equal(options.credentials, 'omit');
      return Response.json(extraction);
    },
  });
  assert.equal(result.related.aiServices[0].detail, true);
  assert.match(result.related.aiServices[0].recipe, /videoFrameExtraction\/openapi\.yaml$/u);
  const wrong = await discover(context, { scope: 'aiServices', query: link }, { fetcher: () => Response.json(transcription) });
  assert.equal(wrong.related.aiServices.length, 0);
  assert.equal(wrong.serviceCatalog.partial, true);
  const absent = await discover(context, { scope: 'aiServices', query: link }, { fetcher: () => new Response(null, { status: 404 }) });
  assert.equal(absent.serviceCatalog.missing, true);
});

test('partial registry coverage retains earlier pages and complete refreshes retire old facets', async () => {
  const registry = [...sample, ...Array.from({ length: 398 }, (_, index) => row('image/photo' + index, 'Image service ' + index, ['text'], ['image'], 'imageGen'))];
  const read = fetchRegistry(registry);
  const partial = await readAiServiceRegistry({ fetcher: (url, options) =>
    url.searchParams.get('offset') === '200' ? new Response(null, { status: 429 }) : read(url, options) });
  assert.equal(partial.total, 404);
  assert.equal(partial.items.length, 204);
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.flows.map(flow => flow.status), [200, 429, 200]);
  const refreshed = await readAiServiceRegistry({ fetcher: fetchRegistry([extraction]) });
  assert.deepEqual(aiServiceFacets(refreshed.items).serviceCategory, ['video']);
  assert.deepEqual(aiServiceFacets(refreshed.items).serviceState, ['available']);
});
