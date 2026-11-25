import assert from 'node:assert/strict';
import test from 'node:test';

const source = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { writeWorkspaceChange, workspaceBackup, workspaceDocument, saveWorkspaceEntry } = await import(source + 'workspace.mjs');
const { appPrivateRecord } = await import(source + 'workflow-journal.mjs');
const origin = 'https://civitai.red';
const stamp = '2026-11-25T18:00:00.000Z';
const id = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const title = 'Linocut comparison';
const filters = { scope: 'models', query: 'Linocut' };
const unavailable = () => new TypeError('The reply was lost.');
const change = () => ({ id: id(1), apply: workspace => saveWorkspaceEntry(workspace, 'searches', title, filters, id(2)) });

function broker({ write, read } = {}) {
  let current = { version: 7, createdAt: stamp, data: workspaceDocument(null) };
  let context = { origin, viewerUserId: 21, signedIn: true, token: 'fixture', scopes: ['apps:storage'] };
  const submitted = [];
  const committed = [];
  const api = {
    submitted, committed,
    get current() { return structuredClone(current); },
    refuse(status, code) { return Response.json({ code }, { status }); },
    accept(request) {
      if (request.ifVersion !== current.version) return api.refuse(409, 'version_conflict');
      current = { ...current, version: current.version + 1, data: structuredClone(request.data) };
      committed.push(current.data.workspaceWrites?.ids[0]);
      return Response.json(current);
    },
    otherTab(count, legacy = false) {
      // Independent storage model. Each unrelated write advances the version and leaves
      // its own single latest item. A legacy writer lacks the bounded receipt field.
      const other = { id: id(102), name: 'Another tab', filters };
      const history = currentTrail(current);
      const nextVersion = current.version + count;
      const newer = Array.from({ length: count }, (_, i) => id(1000 + count - i));
      const data = { ...current.data, searches: [other, ...current.data.searches.filter(row => row.id !== other.id)] };
      if (legacy) delete data.workspaceWrites;
      else data.workspaceWrites = { version: nextVersion, ids: [...newer, ...history].slice(0, 32) };
      current = { ...current, version: nextVersion, data };
    },
    replace() {
      current = { ...current, version: 1, createdAt: '2026-11-25T18:01:00.000Z', data: workspaceDocument(null) };
    },
    store: appPrivateRecord(context, () => context, 'search-workspace', { fetcher: async (url, request) => {
      assert.equal(url.href, origin + '/api/v1/blocks/storage/prefs/search-workspace');
      assert.equal(request.credentials, 'omit');
      assert.equal(request.headers.Authorization, 'Bearer fixture');
      if (request.method === 'GET') {
        await read?.(api);
        return Response.json(current);
      }
      const operation = JSON.parse(request.body);
      submitted.push(operation);
      return write ? write(operation, api) : api.accept(operation);
    } }),
    changeViewer() { context = { ...context, viewerUserId: 22 }; },
  };
  return api;
}

function currentTrail(snapshot) {
  return snapshot.data.workspaceWrites?.version === snapshot.version ? snapshot.data.workspaceWrites.ids : [];
}

test('interrupted work follows the independent conditional-write model across bounded schedules', async () => {
  for (const beforeCommit of [false, true]) {
    for (const edits of [0, 1, 8, 31, 32, 33]) {
      for (const legacy of [false, true]) {
        if (!edits && legacy) continue;
        const label = JSON.stringify({ beforeCommit, edits, legacy });
        const api = broker({ write(request, model) {
          if (model.submitted.length > 1) return model.accept(request);
          if (!beforeCommit) assert.equal(model.accept(request).status, 200);
          if (edits) model.otherTab(edits, legacy);
          throw unavailable();
        } });
        const started = await api.store.readSnapshot();
        const operation = change();
        const result = await writeWorkspaceChange(api.store, started, operation);
        const proofGone = legacy || edits >= 32 && !beforeCommit || edits > 32;
        assert.equal(result.outcome, proofGone ? 'review' : 'saved', label);
        assert.deepEqual(result.snapshot, api.current, label);
        const accepted = api.committed.filter(id => id === operation.id);
        assert.equal(accepted.length, !beforeCommit || !proofGone ? 1 : 0, label);
        assert.equal(api.submitted.length, beforeCommit && !proofGone ? 2 : 1, label);
        assert.ok(api.submitted.every(message => message.data.workspaceWrites.ids[0] === operation.id), label);
        assert.equal(api.current.data.searches.filter(row => row.name === title).length, accepted.length, label);
        if (edits) assert.ok(api.current.data.searches.some(row => row.name === 'Another tab'), label);
      }
    }
  }
});

test('a delayed first request can win the conditional retry without adding the item twice', async () => {
  let delayed;
  const api = broker({ write(request, model) {
    if (model.submitted.length === 1) { delayed = request; throw unavailable(); }
    assert.equal(model.accept(delayed).status, 200);
    return model.accept(request);
  } });
  const initial = await api.store.readSnapshot();
  const operation = change();
  const result = await writeWorkspaceChange(api.store, initial, operation);
  assert.equal(result.outcome, 'saved');
  assert.deepEqual(api.submitted.map(row => row.ifVersion), [7, 7]);
  assert.deepEqual(api.committed, [operation.id]);
  assert.deepEqual(api.current.data.searches.map(row => row.name), [title]);
  assert.doesNotMatch(workspaceBackup(api.current.data), /workspaceWrites/u);
});

test('an unreadable check keeps the original action until a read resolves it', async () => {
  let dropRead = false;
  const api = broker({
    read() { if (dropRead) { dropRead = false; throw unavailable(); } },
    write(request, model) { model.accept(request); dropRead = true; throw unavailable(); },
  });
  const initial = await api.store.readSnapshot();
  const operation = change();
  const pending = await writeWorkspaceChange(api.store, initial, operation);
  assert.equal(pending.outcome, 'check');
  assert.equal(pending.snapshot.version, 7);
  const saved = await writeWorkspaceChange(api.store, pending.snapshot, operation);
  assert.equal(saved.outcome, 'saved');
  assert.deepEqual(api.committed, [operation.id]);
  assert.equal(api.submitted.length, 1);
});

test('an observed document reset or a switched account prevents any replay', async () => {
  for (const definiteConflict of [false, true]) {
    const api = broker({ write(request, model) {
      model.replace();
      if (definiteConflict) return model.refuse(409, 'version_conflict');
      throw unavailable();
    } });
    const snapshot = await api.store.readSnapshot();
    const action = change();
    assert.equal((await writeWorkspaceChange(api.store, snapshot, action)).outcome, 'review');
    assert.equal(api.submitted.length, 1);
  }
  const api = broker({ write(_request, model) { model.changeViewer(); throw unavailable(); } });
  const snapshot = await api.store.readSnapshot();
  assert.equal((await writeWorkspaceChange(api.store, snapshot, change())).outcome, 'check');
  assert.equal(api.submitted.length, 1);
  assert.deepEqual(api.committed, []);
});
