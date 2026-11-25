import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyHostedBuild } from '../scripts/verify-hosted.mjs';

const origins = ['https://civitai.com', 'https://civitai.red'];
const app = 'rasterraid';
const runtime = 'https://rasterraid.civit.ai/';
const pin = '0.0.7';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = new Map([['index.html', '<title>RasterRaid</title>'], ['src/startup.js', 'export const ready = true;']]);
const snapshot = createHash('sha256');
const assets = [...files].map(([path, body]) => {
  snapshot.update('/' + path).update('\0').update(body);
  return { path, bytes: Buffer.byteLength(body), sha256: digest(body) };
});
const receipt = { app, version: pin, assets, snapshotSha256: snapshot.digest('hex') };
const approved = { id: 'pubreq_0123456789', blockId: app, version: pin, status: 'approved', deployState: 'live', liveUrl: runtime,
  sourceCommit: '1'.repeat(40), sourceDirty: false };
const pending = { id: 'pubreq_11123456789', blockId: app, version: '0.0.8', status: 'pending', deployState: 'preview-live',
  deployDetail: 'moderator-only details' };
const listed = { id: 'apl_0123456789', slug: app, kind: 'onsite', kindData: { hasPage: true, liveUrl: runtime.slice(0, -1) } };

function fixture({ statuses, listings, assetBodies } = {}) {
  const calls = [];
  const statusCalls = [];
  return { calls, statusCalls,
    async readStatus(origin, name) {
      statusCalls.push(origin);
      assert.equal(name, app);
      return statuses ? statuses(origin) : approved;
    },
    async fetcher(url, request) {
      assert.equal(request.credentials, 'omit');
      assert.equal(request.method, 'GET');
      assert.equal(request.redirect, 'error');
      assert.equal(request.headers.Authorization, undefined);
      calls.push(url.href);
      if (origins.includes(url.origin)) {
        assert.equal(url.pathname, '/api/v1/apps/rasterraid');
        return listings ? listings(url.origin) : Response.json(listed);
      }
      assert.equal(url.origin, new URL(runtime).origin);
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      assert.ok(files.has(path));
      return new Response(assetBodies?.[path] ?? files.get(path));
    },
  };
}

test('the published app and both listings match the expected bundle and use one shared root check', async () => {
  const transport = fixture();
  const result = await verifyHostedBuild(receipt, transport);
  assert.equal(result.verified, true);
  assert.equal(result.assets.snapshotSha256, receipt.snapshotSha256);
  assert.deepEqual(result.assets.differences, []);
  assert.deepEqual(result.hosts.map(host => host.origin), origins);
  assert.deepEqual(transport.statusCalls, [...origins, ...origins]);
  assert.equal(transport.calls.filter(url => url === runtime).length, 1);
  assert.equal(transport.calls.length, 6);
  assert.equal(result.buzzSpent, 0);
});

test('a pending review and a public 404 never qualify a moderator preview', async () => {
  const transport = fixture({ statuses: () => pending, listings: () => Response.json({}, { status: 404 }) });
  const result = await verifyHostedBuild(receipt, transport);
  assert.equal(result.verified, false);
  assert.equal(result.assets, null);
  assert.ok(result.hosts.every(host => host.latest.status === 'pending' && host.serving === null && host.listing.state === 'unlisted'));
  assert.equal(transport.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /moderator-only/u);
});

test('the serving row can match the expected release while a newer submission is in review', async () => {
  const transport = fixture({ statuses: () => ({ ...pending, liveSubmission: approved }) });
  const result = await verifyHostedBuild(receipt, transport);
  assert.equal(result.verified, true);
  assert.equal(result.hosts[0].latest.version, '0.0.8');
  assert.equal(result.hosts[0].serving.version, pin);
  const elsewhere = await verifyHostedBuild({ ...receipt, version: '0.0.8' }, transport);
  assert.equal(elsewhere.verified, false);
  assert.equal(elsewhere.sameSubmission, true);
  assert.equal(elsewhere.sameListing, true);
  assert.equal(elsewhere.assets, null);
});

test('changed bytes and an inconsistent receipt digest fail independently of the reported source commit', async () => {
  const transport = fixture({ assetBodies: { 'src/startup.js': 'export const ready = nope;' } });
  const wrongAsset = await verifyHostedBuild(receipt, transport);
  assert.equal(wrongAsset.assets.matched, false);
  assert.deepEqual(wrongAsset.assets.differences.map(row => [row.path, row.issue]), [['src/startup.js', 'asset-mismatch']]);
  assert.equal(wrongAsset.verified, false);
  const wrongSnapshot = await verifyHostedBuild({ ...receipt, snapshotSha256: 'a'.repeat(64) }, fixture());
  assert.equal(wrongSnapshot.assets.matchedAssets, 2);
  assert.equal(wrongSnapshot.verified, false);
});

test('a foreign launch address or inconsistent listing is recorded without following it', async () => {
  const transport = fixture({ listings: origin => Response.json(origin === origins[0] ? listed :
    { ...listed, kindData: { ...listed.kindData, liveUrl: 'https://example.org/?launch=private' } }) });
  const remote = await verifyHostedBuild(receipt, transport);
  assert.equal(remote.assets.matched, true);
  assert.equal(remote.verified, false);
  assert.equal(remote.hosts[1].listing.state, 'unexpected-listing');
  assert.ok(transport.calls.every(url => !url.includes('example.org')));
  const inconsistent = await verifyHostedBuild(receipt, fixture({ listings: origin => Response.json(origin === origins[0] ? listed :
    { ...listed, id: 'apl_0123456788' }) }));
  assert.equal(inconsistent.sameListing, false);
  assert.equal(inconsistent.verified, false);
});

test('a deployment changing while assets are checked leaves the proof incomplete', async () => {
  let reads = 0;
  const transport = fixture({ statuses: () => ++reads <= 2 ? approved : { ...approved, id: 'pubreq_0123456799' } });
  const result = await verifyHostedBuild(receipt, transport);
  assert.equal(result.assets.matched, true);
  assert.equal(result.verified, false);
  assert.ok(result.changedDuringCheck.every(host => host.serving.requestId === 'pubreq_0123456799'));
});

test('invalid asset paths and a missing app name fail before any request', async () => {
  const transport = fixture();
  await assert.rejects(verifyHostedBuild({ ...receipt, app: undefined }, transport), /bundle JSON/u);
  await assert.rejects(verifyHostedBuild({ ...receipt, assets: [...assets, { ...assets[1], path: '../private' }] }, transport), /bundle JSON/u);
  assert.equal(transport.calls.length, 0);
  assert.equal(transport.statusCalls.length, 0);
});
