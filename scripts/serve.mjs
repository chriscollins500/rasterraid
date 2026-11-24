import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFiles } from './assets.mjs';
import { createFilterHandler } from './filter-feed.mjs';
import { PUBLIC_FILTER_FEED } from '../src/runtime-config.mjs';
import { PREVIEW_QUOTE_MAX_AGE_MS, quotePrice } from '../src/quotes.mjs';
import { SITE_ORIGINS } from '../src/catalog.mjs';
import { subjectAssetOrigins } from '../src/subject-artifacts.mjs';
import { orchestrationOrigin } from '../src/ai-services.mjs';
import { MOCK_API, MOCK_PAGE } from '../mock/client.mjs';
import { createMockBackend } from '../mock/backend.mjs';
import { createWorkflowSimulation, SIMULATION_WORKFLOWS } from '../mock/workflows.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 5188);
const customBuild = process.argv.indexOf('--build-dir');
let dir = process.argv[3] === 'dist' ? join(root, 'dist') : root;
const inside = (parent, target) => {
  const path = relative(parent, target);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
};
if (customBuild >= 0) {
  if (!process.argv[customBuild + 1]) throw new TypeError('Provide a workspace build directory.');
  dir = await realpath(resolve(root, process.argv[customBuild + 1]));
  if (!inside(await realpath(root), dir)) throw new TypeError('Preview builds must resolve within the workspace.');
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid preview port.');
const mockBackend = process.argv.includes('--mock-deep-search') ? createMockBackend() : null;
const workflowSimulation = mockBackend ? createWorkflowSimulation() : null;

const assets = new Map();
const digest = createHash('sha256');
const previewAssetLimit = 2_000_000n;
const previewRoot = await realpath(dir);

async function readPreviewAsset(base, path) {
  const target = await realpath(path);
  if (!inside(base, target)) {
    throw new Error('Preview requires regular, bounded build files.');
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const entry = await lstat(path, { bigint: true });
    if (!opened.isFile() || !entry.isFile() || opened.size > previewAssetLimit) {
      throw new Error('Preview requires regular, bounded build files.');
    }
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || await realpath(path) !== target) {
      throw new Error('The preview file changed while opening it.');
    }
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== Number(opened.size)) throw new Error('The preview file changed while reading it.');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

for (const [route, type] of Object.entries(previewFiles)) {
  const body = await readPreviewAsset(previewRoot, resolve(dir, route.slice(1)));
  digest.update(route);
  digest.update('\0');
  digest.update(body);
  assets.set(route, { type, body });
}
const mockAssets = new Map();
if (mockBackend) {
  const workspaceRoot = await realpath(root);
  for (const file of ['panel.mjs', 'client.mjs', 'sample.mjs']) {
    const route = '/mock/' + file;
    const body = await readPreviewAsset(workspaceRoot, join(root, route.slice(1)));
    mockAssets.set(route, { type: 'text/javascript; charset=utf-8', body });
  }
}

const filterHandler = createFilterHandler();
const publicFeedOrigin = new URL(PUBLIC_FILTER_FEED).origin;
const quoteReceipts = new Map();
if (process.argv.includes('--preview-quotes')) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const [index, domain] of ['com', 'red'].entries()) {
    const origin = SITE_ORIGINS[index];
    const batches = [];
    for (const sample of ['linocut-batch-baseline', 'wemm-visual-neighbors', 'picture-linocut-native-media', 'picture-catalog', 'picture-visual-composition', 'picture-visual-brief', 'picture-visual-focus',
      'picture-media-models', 'picture-story', 'linocut-native-media', 'linocut-scenes', 'linocut-redesign', 'linocut-ux', 'linocut-cross-surface', 'linocut-refresh', 'linocut', 'catalog', 'report', 'coverage', 'guide', 'reference', 'upgrade', 'visual-focus', 'sound', 'collection-trail',
      'scenes', 'descriptive-media', 'portfolio', 'creator', 'release-trail', 'visual-neighbors', 'visual-composition', 'media-models', 'visual-brief', 'example-setup',
      'example-pair', 'story', 'quick-tools']) {
      const filename = 'rasterraid-' + version + '-' + domain + '-' + sample + '.json';
      let raw;
      try {
        raw = await readFile(join(root, 'evidence', filename), 'utf8');
      } catch (error) {
        if (sample !== 'linocut' && error.code === 'ENOENT') continue;
        throw error;
      }
      const receipt = JSON.parse(raw);
      const capturedAt = Date.parse(receipt.capturedAt);
      if (receipt.catalogOrigin !== origin || receipt.balanceRecordUnchanged !== true ||
          receipt.pricing !== 'RasterRaid App /api/v1/blocks/workflows/estimate' ||
          !Number.isFinite(capturedAt) || capturedAt > Date.now() + 60_000) {
        throw new Error('Expected a recent, verified Civitai estimate receipt for ' + domain + '/' + sample + '.');
      }
      if (Date.now() - capturedAt > PREVIEW_QUOTE_MAX_AGE_MS) continue;
      const quotes = receipt.quotes.flatMap(row => {
        const price = quotePrice({ status: row.status, cost: { total: row.buzz, authorFee: row.authorFee } });
        if (row.priced !== true || !price || !/^[a-z]+$/.test(row.id) || !/^[a-f\d]{64}$/.test(row.exactBodySha256)) return [];
        return [{ id: row.id, bodySha256: row.exactBodySha256, ...price }];
      });
      batches.push({ origin, capturedAt: receipt.capturedAt, quotes });
    }
    quoteReceipts.set(domain, batches);
  }
}
const server = createServer({ maxHeaderSize: 16_384 }, async (request, response) => {
  const address = server.address();
  const host = request.headers.host ?? '';
  const url = request.url ?? '';
  const loopback = ['127.0.0.1:' + address.port, 'localhost:' + address.port].includes(host);
  if (!loopback && !/^dev-[a-f0-9]{16}\.civit\.ai(?::443)?$/u.test(host)) return response.writeHead(421).end();
  const bundleOrigin = (loopback ? 'http://' : 'https://') + host;
  if (!url.startsWith('/') || url.length > 8192) return response.writeHead(400).end();

  const route = url.split('?', 1)[0];
  const privateMock = route === MOCK_PAGE || route.startsWith('/mock/') || route.startsWith(MOCK_API + '/');
  if (privateMock && (!mockBackend || !loopback)) return response.writeHead(404).end();
  if (route.startsWith(MOCK_API + '/')) {
    if ((request.headers.origin && request.headers.origin !== 'http://' + host) ||
        request.headers['sec-fetch-site'] === 'cross-site') return response.writeHead(403).end();
    const simulateWorkflow = route.startsWith(SIMULATION_WORKFLOWS);
    const inputLimit = simulateWorkflow ? 160_000 : 16_384;
    let payload;
    if (request.method === 'POST' || request.method === 'PUT') {
      if (request.headers['content-type'] !== 'application/json') return response.writeHead(415).end();
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > inputLimit) return response.writeHead(413).end();
          chunks.push(chunk);
        }
        payload = JSON.parse(Buffer.concat(chunks));
      } catch {
        return response.writeHead(400).end();
      }
    }
    const handle = simulateWorkflow ? workflowSimulation : mockBackend;
    const { status, body } = handle(request.method, route, payload);
    return response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    }).end(JSON.stringify(body));
  }
  if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
  if (route === '/filter-options.json') {
    const result = await filterHandler(new Request(new URL(url, 'http://localhost'), { method: request.method }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    return response.end(request.method === 'GET' ? Buffer.from(await result.arrayBuffer()) : undefined);
  }
  if (route === '/preview-quotes.json') {
    const params = new URL(url, 'http://localhost').searchParams;
    const knownParams = [...params.keys()].every(key => ['domain', 'dev'].includes(key) && params.getAll(key).length === 1);
    const receipt = knownParams ? quoteReceipts.get(params.get('domain')) : null;
    if (!receipt) return response.writeHead(404).end();
    const body = JSON.stringify(receipt);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
    return response.end(request.method === 'GET' ? body : undefined);
  }
  const asset = route.startsWith('/mock/') ? mockAssets.get(route)
    : assets.get(route === '/' || route === MOCK_PAGE ? '/index.html' : route);
  if (!asset) return response.writeHead(404).end();

  response.writeHead(200, {
    'Content-Type': asset.type,
    'Content-Length': asset.body.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(privateMock ? {} : { 'Access-Control-Allow-Origin': '*' }),
    'Content-Security-Policy': "default-src 'none'; script-src 'self' " + bundleOrigin + " 'wasm-unsafe-eval'; worker-src data: " + bundleOrigin +
      "; style-src 'self'; connect-src 'self' https://civitai.com https://civitai.red https://image.civitai.com https://blobs-b2.civitai.com " +
      [orchestrationOrigin, publicFeedOrigin, ...subjectAssetOrigins].join(' ') + "; img-src https://image.civitai.com https://blobs-b2.civitai.com; media-src https://image.civitai.com https://blobs-b2.civitai.com; frame-ancestors " +
      (privateMock ? "'none'" : SITE_ORIGINS.join(' ')) + "; object-src 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(request.method === 'GET' ? asset.body : undefined);
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({
    origin: 'http://127.0.0.1:' + server.address().port,
    snapshotSha256: digest.digest('hex'),
    files: [...assets.keys()],
    ...(mockBackend && { mockPreview: MOCK_PAGE }),
  }));
});
const lifetime = setTimeout(() => server.close(), 30 * 60 * 1000);
lifetime.unref();
server.once('close', () => clearTimeout(lifetime));
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => server.close());
