import assert from 'node:assert/strict';
import test from 'node:test';
import { blockFixtureToken } from '../mock/host-fixture.mjs';
import { canSaveButtonLayout, moveSearchButton, normalizeButtonLayout, syncButtonLayout } from '../src/button-layout.mjs';
import { watchHost } from '../src/civitai-host.js';
import { COLLECTION_SCOPE, creationPicks, PRIVATE_COLLECTION_SCOPE, readLibraryPage } from '../src/library.mjs';
import { discover } from '../src/search.mjs';

const origin = 'https://civitai.red';
const publicContext = { origin, hosted: true, signedIn: true, token: 'fixture', scopes: [COLLECTION_SCOPE], browsingLevel: 3 };
const privateContext = { ...publicContext, scopes: [COLLECTION_SCOPE, PRIVATE_COLLECTION_SCOPE] };
const cover = 'https://image.civitai.com/fixture/cover.webp';
const publicCollection = { id: 21, name: 'Public gallery', isPublic: true, coverImageUrl: cover, coverNsfwLevel: 1, itemCount: 1, followed: true };
const privateCollection = { id: 22, name: 'Private gallery', isPublic: false, coverImageUrl: cover, coverNsfwLevel: 4 };

test('opening a library section is read-free until the viewer chooses to load collections', async () => {
  const routes = { vault: '/user/vault', saved: '/collections', downloads: '/user/downloads', creations: '/generate',
    notifications: '/user/notifications', messages: '/' };
  const fetcher = () => assert.fail('Opening a library section must not fetch personal data');
  for (const [scope, path] of Object.entries(routes)) {
    const result = await discover(privateContext, { scope }, { fetcher });
    assert.equal(result.nativeLink, origin + path);
    assert.equal(result.library.status, 'ready');
    assert.deepEqual(result.related, {});
  }
  const missing = await discover(publicContext, { scope: 'saved', libraryMode: 'mine', libraryPrivate: true }, { fetcher });
  assert.equal(missing.library.status, 'access-needed');
  const bookmarks = await discover(privateContext, { query: 'https://civitai.com/models?favorites=true' }, { fetcher });
  assert.equal(bookmarks.nativeLink, origin + '/models?favorites=true');
});

test('collection pages read only the granted data and keep Civitai’s cursor and cover ratings', async () => {
  const fetcher = (url, opts) => {
    assert.equal(url.origin, origin);
    assert.equal(opts.headers.Authorization, 'Bearer fixture');
    assert.equal(opts.cache, 'no-store');
    assert.equal(opts.credentials, 'omit');
    assert.equal(url.pathname, '/api/v1/blocks/collections');
    assert.equal(url.searchParams.get('query'), 'gallery');
    assert.equal(url.searchParams.get('userId'), null);
    assert.equal(url.searchParams.get('mode'), 'mine');
    return Response.json({ items: [publicCollection, privateCollection], nextCursor: 19 });
  };
  const filters = { scope: 'saved', libraryMode: 'mine', query: 'gallery' };
  const narrow = await discover(publicContext, filters, { fetcher });
  assert.deepEqual(narrow.related.libraryCollections.map(card => [card.id, card.preview]), [[21, cover]]);
  assert.equal(narrow.library.pager.nextCursor, 19);
  const bound = await discover(privateContext, { ...filters, libraryPrivate: true }, { fetcher });
  assert.deepEqual(bound.related.libraryCollections.map(card => [card.id, card.preview]), [[21, cover], [22, null]]);
  await assert.rejects(readLibraryPage(privateContext, narrow.library.pager.plan, {
    fetcher() { assert.fail('The server would include private data without opt-in'); },
  }), /Choose which collections/u);
});

test('followed searches use public candidates and private detail preserves opaque media cursors', async () => {
  const followed = await discover(privateContext, { scope: 'saved', libraryMode: 'followed', query: 'gallery' }, { fetcher(url) {
    assert.equal(url.searchParams.get('mode'), 'public');
    assert.equal(url.searchParams.get('query'), 'gallery');
    return Response.json({ items: [publicCollection, { ...publicCollection, id: 24, followed: false }, privateCollection], nextCursor: 10 });
  } });
  assert.deepEqual(followed.related.libraryCollections.map(card => card.id), [21]);
  assert.equal(followed.library.pager.nextCursor, 10);
  const plan = { mode: 'mine', includePrivate: true, collectionId: 22 };
  const media = await readLibraryPage(privateContext, plan, { cursor: 'part|one', fetcher(url) {
    assert.equal(url.pathname, '/api/v1/blocks/collections/22');
    assert.equal(url.searchParams.get('cursor'), 'part|one');
    return Response.json({ collection: privateCollection, items: [
      { mediaId: 7, type: 'image', url: cover, nsfwLevel: 1 },
      { mediaId: 8, type: 'image', url: cover, nsfwLevel: 4 },
    ], nextCursor: 'part|two' });
  } });
  assert.deepEqual(media.items.map(card => [card.id, card.preview]), [[7, cover]]);
  assert.equal(media.nextCursor, 'part|two');
});

test('only the matching host can grant private collections or return selected creations', async () => {
  const out = [];
  const parent = { postMessage: (message, host) => out.push({ ...message, host }) };
  let receive;
  let current;
  const token = scopes => blockFixtureToken({ instance: 'fixture', scopes });
  watchHost({ parent, atob, document: { body: { scrollHeight: 700 } },
    addEventListener(_type, listener) { receive = listener; } }, next => { current = next; });
  const send = (type, payload, sender = origin) => receive({ source: parent, origin: sender, data: { type, payload } });
  send('BLOCK_INIT', { blockId: 'rasterraid', blockInstanceId: 'fixture', renderMode: 'iframe',
    context: { slotId: 'app.page', viewerUserId: 39 }, viewer: { id: 21, signedIn: true, username: 'Viewer' },
    storageMode: 'local-preview', token: token([COLLECTION_SCOPE]) });
  const signal = AbortSignal.timeout(1_000);
  const permission = current.requestPrivateCollections(signal);
  assert.deepEqual(out.at(-1), { type: 'REQUEST_CONSENT', payload: { scopes: [PRIVATE_COLLECTION_SCOPE] }, host: origin });
  send('TOKEN_REFRESH', { token: token(privateContext.scopes) }, 'https://civitai.com');
  assert.equal(current.scopes.includes(PRIVATE_COLLECTION_SCOPE), false);
  send('TOKEN_REFRESH', { token: token(privateContext.scopes) });
  assert.equal((await permission).viewerUserId, 21);

  const selected = current.pickCreations('generated', signal);
  const picker = out.at(-1);
  assert.equal(picker.type, 'OPEN_IMAGE_PICKER');
  assert.deepEqual(picker.payload.sources, ['generated']);
  const pick = { source: 'generated', url: cover, width: 640, height: 640, nsfwLevel: 1 };
  send('IMAGE_PICKER_RESULT', { requestId: 'unrelated', selectedImages: [pick] });
  send('IMAGE_PICKER_RESULT', { requestId: picker.payload.requestId, selectedImages: [pick, { ...pick, url: 'https://example.com/other.png' },
    { ...pick, url: 'https://image.civitai.com/fixture/mature.webp', nsfwLevel: 4 }] });
  assert.deepEqual(creationPicks(origin, await selected, 'generated', current.browsingLevel).map(card => [card.preview, card.link]), [[cover, origin + '/generate']]);
  const paths = ['/user/vault', '/user/downloads', '/generate', '/collections', '/models?favorites=true', '/user/Viewer/following', '/user/notifications', '/'];
  for (const path of [...paths, '/generate?run=true', '/user/SomeoneElse/following', '/api/v1/vault/all', '/?chat=58', '/user/notifications?read=true']) current.open(origin + path);
  assert.deepEqual(out.filter(message => message.type === 'NAVIGATE').map(message => message.payload.path), paths);
});

test('viewer context requires a matching live block credential and signed scopes', async () => {
  const parent = { postMessage() {} };
  let receive;
  let current;
  const stop = watchHost({ parent, atob, document: { body: { scrollHeight: 700 } },
    addEventListener(_event, callback) { receive = callback; }, removeEventListener() {} }, next => { current = next; });
  const send = (type, payload) => receive({ source: parent, origin, data: { type, payload } });
  const token = blockFixtureToken({ instance: 'fixture', advertised: [PRIVATE_COLLECTION_SCOPE], viewerLevel: -1, maxLevel: -1 });
  send('BLOCK_INIT', { blockId: 'rasterraid', blockInstanceId: 'fixture', renderMode: 'iframe',
    context: { slotId: 'app.page' }, viewer: { signedIn: true }, token });
  assert.equal(current.viewerUserId, 21);
  assert.equal(current.browsingLevel, 1);
  assert.deepEqual(current.scopes, []);
  const valid = current;
  for (const invalid of [{ raw: 'no-claims', scopes: [PRIVATE_COLLECTION_SCOPE] }, blockFixtureToken({ instance: 'elsewhere' }),
    blockFixtureToken({ instance: 'fixture', blockId: 'different-app' }), blockFixtureToken({ instance: 'fixture', exp: 1 }),
    blockFixtureToken({ instance: 'fixture', viewerId: null })]) {
    send('TOKEN_REFRESH', { token: invalid });
    assert.equal(current.signedIn, false);
    assert.equal(current.token, undefined);
    assert.deepEqual(current.scopes, []);
  }
  assert.equal(await valid.requestPrivateCollections(AbortSignal.timeout(250)), null);
  stop();
});

test('button layouts merge new scopes, preserve visibility, and save only to the approved private store', async () => {
  const known = ['all', 'videos', 'saved', 'vault'];
  const layout = normalizeButtonLayout({ order: ['saved', 'old', 'all', 'saved'], hidden: ['videos', 'old'] }, known);
  assert.deepEqual(layout, { order: ['saved', 'all', 'videos', 'vault'], hidden: ['videos'] });
  assert.deepEqual(moveSearchButton(layout.order, 3, 1), ['saved', 'vault', 'all', 'videos']);
  assert.equal(moveSearchButton(layout.order, 0, -1), layout.order);
  const signed = { ...privateContext, scopes: ['apps:storage'] };
  const preview = { ...signed, storageMode: 'local-preview' };
  assert.equal(canSaveButtonLayout(preview), false);
  await assert.rejects(syncButtonLayout(preview, { fetcher() { assert.fail('Preview storage must stay in this tab'); } }));
  const initial = await syncButtonLayout(signed, { fetcher(url, opts) {
    assert.equal(url.href, origin + '/api/v1/blocks/storage/prefs/search-scopes');
    assert.equal(opts.method, 'GET');
    return Response.json({ code: 'not_found' }, { status: 404 });
  } });
  const saved = await syncButtonLayout(signed, { layout, version: initial.version, fetcher(_url, opts) {
    assert.equal(opts.method, 'PUT');
    assert.deepEqual(JSON.parse(opts.body), { data: layout, ifVersion: 0 });
    return Response.json({ data: layout, version: 1 });
  } });
  assert.equal(saved.version, 1);
});
