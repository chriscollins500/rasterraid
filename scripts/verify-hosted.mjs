import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { SITE_ORIGINS } from '../src/catalog.mjs';
import { runCivitai } from './civitai-cli.mjs';

const slug = /^[a-z\d][a-z\d-]{0,62}$/u;
const version = /^\d+\.\d+\.\d+(?:[-+][a-z\d.-]+)?$/iu;
const sha = /^[a-f\d]{64}$/u;
const assetPath = /^[a-z\d_-]+(?:\.[a-z\d_-]+)*(?:\/[a-z\d_-]+(?:\.[a-z\d_-]+)*)*$/iu;
const maxAssetBytes = 2_000_000;
const maxAssetsBytes = 32_000_000;
const readTimeout = 12_000;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

function validateReceipt(receipt) {
  if (!matches(receipt?.app, slug) || !matches(receipt?.version, version) || !matches(receipt?.snapshotSha256, sha) ||
      !Array.isArray(receipt.assets) || !receipt.assets.length || receipt.assets.length > 512 ||
      !receipt.assets.every(asset => matches(asset?.path, assetPath) && matches(asset.sha256, sha) &&
        Number.isSafeInteger(asset.bytes) && asset.bytes >= 0 && asset.bytes <= maxAssetBytes)) {
    throw new TypeError('Provide the verified bundle JSON from npm run verify:bundle.');
  }
  const names = new Set(receipt.assets.map(asset => asset.path));
  if (names.size !== receipt.assets.length || !names.has('index.html') ||
      receipt.assets.reduce((total, asset) => total + asset.bytes, 0) > maxAssetsBytes) {
    throw new TypeError('The bundle receipt has duplicate, missing, or oversized assets.');
  }
}

function canonicalRuntime(app, address) {
  const runtime = 'https://' + app + '.civit.ai/';
  return typeof address === 'string' && URL.parse(address)?.href === runtime ? runtime : null;
}

function submission(row, app) {
  if (!matches(row?.id, /^pubreq_[a-z\d]{8,64}$/iu) || row.blockId !== app || !matches(row.version, version) ||
      !matches(row.status, /^[a-z-]{1,40}$/u)) return null;
  return { requestId: row.id, version: row.version, status: row.status,
    deployState: matches(row.deployState, /^[a-z-]{1,40}$/u) ? row.deployState : null,
    reportedSourceCommit: matches(row.sourceCommit, /^[a-f\d]{40}$/u) ? row.sourceCommit : null,
    reportedSourceDirty: typeof row.sourceDirty === 'boolean' ? row.sourceDirty : null,
    runtime: canonicalRuntime(app, row.liveUrl) };
}

async function submissionState(origin, app, readStatus) {
  try {
    const row = await readStatus(origin, app);
    const latest = submission(row, app);
    const active = row?.liveSubmission ? submission(row.liveSubmission, app) : latest;
    return { latest, serving: latest && active?.status === 'approved' && active.runtime ? active : null,
      ...(latest ? {} : { statusError: 'unexpected-submission' }) };
  } catch (error) {
    return { latest: null, serving: null, statusError: 'submission-read-failed',
      ...(Number.isInteger(error?.code) && { cliExitCode: error.code }) };
  }
}

function retrieve(url, fetcher) {
  return fetcher(url, { method: 'GET', credentials: 'omit', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(readTimeout) });
}

async function bytesWithin(body, limit) {
  const reader = body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, bytes);
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new RangeError('Response exceeded its expected size.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function publicListing(origin, app, fetcher) {
  try {
    const response = await retrieve(new URL('/api/v1/apps/' + app, origin), fetcher);
    if (!response.ok) {
      await response.body?.cancel();
      return { http: response.status, state: response.status === 404 ? 'unlisted' : 'unavailable' };
    }
    const data = JSON.parse(await bytesWithin(response.body, 262_144));
    const id = matches(data?.id, /^apl_[a-z\d]{8,64}$/iu) ? data.id : null;
    const runtime = canonicalRuntime(app, data?.kindData?.liveUrl);
    if (id && data.slug === app && data.kind === 'onsite' && data.kindData?.hasPage === true && runtime) {
      return { http: response.status, state: 'listed', id, runtime };
    }
    return { http: response.status, state: 'unexpected-listing' };
  } catch {
    return { http: null, state: 'unavailable' };
  }
}

async function readAsset(asset, runtime, fetcher) {
  try {
    const url = new URL(asset.path === 'index.html' ? '/' : asset.path, runtime);
    const response = await retrieve(url, fetcher);
    if (!response.ok) {
      await response.body?.cancel();
      return { path: asset.path, issue: 'http', http: response.status };
    }
    const bytes = await bytesWithin(response.body, asset.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== asset.bytes || sha256 !== asset.sha256) {
      return { path: asset.path, issue: 'asset-mismatch', bytes: bytes.length, sha256 };
    }
    return { path: asset.path, bytes };
  } catch (error) {
    return { path: asset.path, issue: error instanceof RangeError ? 'asset-too-large' : 'asset-unavailable' };
  }
}

async function compareAssets(receipt, runtime, fetcher) {
  const digest = createHash('sha256');
  const differences = [];
  // Check the shared runtime once, with at most four outstanding reads.
  for (let index = 0; index < receipt.assets.length; index += 4) {
    const batch = await Promise.all(receipt.assets.slice(index, index + 4).map(asset => readAsset(asset, runtime, fetcher)));
    for (const asset of batch) {
      if (asset.issue) differences.push(asset);
      else digest.update('/' + asset.path).update('\0').update(asset.bytes);
    }
  }
  const snapshotSha256 = differences.length ? null : digest.digest('hex');
  return { runtime, checkedAssets: receipt.assets.length, matchedAssets: receipt.assets.length - differences.length,
    snapshotSha256, matched: snapshotSha256 === receipt.snapshotSha256, differences };
}

export async function verifyHostedBuild(receipt, { cli, fetcher = fetch, readStatus = async (origin, app) =>
  JSON.parse(await runCivitai(cli, origin, ['app', 'status', app, '--json'])) } = {}) {
  validateReceipt(receipt);
  const { app, version: expectedVersion, snapshotSha256 } = receipt;
  const readHosts = () => Promise.all(SITE_ORIGINS.map(async origin => {
    const [state, listing] = await Promise.all([submissionState(origin, app, readStatus), publicListing(origin, app, fetcher)]);
    return { origin, ...state, listing, expectedVersionServing: state.serving?.version === expectedVersion };
  }));
  const hosts = await readHosts();
  const current = hosts[0].serving;
  const sameSubmission = Boolean(current && hosts.every(host => host.serving?.requestId === current.requestId &&
    host.serving.version === current.version));
  const sameListing = hosts.every(host => host.listing.state === 'listed' && host.listing.id === hosts[0].listing.id);
  const runtime = hosts.find(host => host.expectedVersionServing)?.serving.runtime;
  const assets = runtime ? await compareAssets(receipt, runtime, fetcher) : null;
  const eligible = assets?.matched && sameSubmission && sameListing && hosts.every(host => host.expectedVersionServing);
  const confirmation = eligible ? await readHosts() : null;
  const verified = Boolean(confirmation?.every((host, index) => host.expectedVersionServing &&
    host.serving.requestId === hosts[index].serving.requestId && host.listing.id === hosts[index].listing.id));
  return { checkedAt: new Date().toISOString(), app, expected: { version: expectedVersion, snapshotSha256, assets: receipt.assets.length },
    hosts, assets, sameSubmission, sameListing, ...(confirmation && !verified && { changedDuringCheck: confirmation }), verified, buzzSpent: 0 };
}

async function main() {
  const [cli, extra] = process.argv.slice(2);
  if (process.stdin.isTTY || extra) throw new TypeError('Pipe in the verified bundle JSON. The installed Civitai CLI path is optional.');
  const input = await bytesWithin(Readable.toWeb(process.stdin), 262_144);
  let receipt;
  try {
    receipt = JSON.parse(input);
  } catch {
    throw new TypeError('The expected bundle receipt is invalid JSON.');
  }
  const result = await verifyHostedBuild(receipt, { cli });
  console.log(JSON.stringify(result, null, 2));
  if (!result.verified) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
