import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFiles } from './assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
const assetsByPath = Object.keys(previewFiles).map(route => route.slice(1));
const sha256 = content => createHash('sha256').update(content).digest('hex');
const digest = createHash('sha256');

const folder = await lstat(output);
assert.ok(folder.isDirectory() && !folder.isSymbolicLink(), 'Expected the local dist directory.');
const entries = await readdir(output, { recursive: true, withFileTypes: true });
assert.ok(entries.every(entry => entry.isDirectory() || entry.isFile()), 'The artifact contains a link or special file.');
const found = entries.filter(entry => entry.isFile()).map(entry => relative(output, join(entry.parentPath, entry.name)).replace(/\\/gu, '/'));
assert.deepEqual(found.sort(), [...assetsByPath].sort(), 'The artifact file list differs from the approved asset manifest.');

const patterns = [
  [/\beyJ[\w-]{20,}\.[\w-]{20,}\.[\w-]{20,}\b/u, 'credential pattern'],
  [/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/u, 'private key pattern'],
  [/\b(?:innerHTML|outerHTML)\s*=|\beval\s*\(|\bnew Function\s*\(/u, 'dynamic execution or markup pattern'],
];
const assets = [];
for (const path of assetsByPath) {
  const [source, built] = await Promise.all([readFile(join(root, path)), readFile(join(output, path))]);
  assert.ok(source.equals(built), path + ' differs from source.');
  const content = built.toString('utf8');
  for (const [pattern, description] of patterns) {
    if (pattern.test(content)) throw new Error(path + ' contains a ' + description + '.');
  }
  digest.update('/' + path).update('\0').update(built);
  assets.push({ path, bytes: built.length, sha256: sha256(built) });
}

const [manifestFile, lockFile, packageFile] = await Promise.all(
  ['block.manifest.json', 'package-lock.json', 'package.json'].map(path => readFile(join(root, path))));
const [manifest, lock, pkg] = [manifestFile, lockFile, packageFile].map(file => JSON.parse(file));
assert.equal(manifest.version, pkg.version, 'App and package versions differ.');
assert.equal(lock.packages[''].version, pkg.version, 'Package and lockfile versions differ.');
assert.equal(manifest.iframe.sandbox, 'allow-scripts', 'The manifest changed the preview iframe sandbox.');
const { minHeight, maxHeight } = manifest.iframe;
assert.ok(Number.isFinite(minHeight) && minHeight >= 40 && minHeight <= 4000,
  'Civitai requires iframe.minHeight to be between 40 and 4000.');
assert.ok(maxHeight === null || Number.isFinite(maxHeight) && maxHeight >= minHeight && maxHeight <= 4000,
  'Civitai requires an explicit iframe.maxHeight of null or a number from minHeight through 4000.');

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), node: process.version, app: manifest.blockId, version: manifest.version,
  buildCommand: manifest.buildCommand, snapshotSha256: digest.digest('hex'), manifestSha256: sha256(manifestFile),
  iframeHeight: { minHeight, maxHeight },
  lockfileSha256: sha256(lockFile), files: assets.length, bytes: assets.reduce((sum, entry) => sum + entry.bytes, 0),
  lockedRuntimePackages: Object.entries(lock.packages).filter(([path, info]) => path && !info.dev).length,
  artifactPatternsChecked: patterns.map(([, description]) => description), assets,
}, null, 2));
