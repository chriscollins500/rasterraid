import assert from 'node:assert/strict';
import test from 'node:test';

const source = process.env.RASTERRAID_TEST_DIST === '1' ? '../dist/src/' : '../src/';
const { createSubjectMatcher } = await import(source + 'subject-matching.mjs');

test('only an active written comparison prepares text before the preview reads finish', async t => {
  const workers = [];
  class Worker extends EventTarget {
    messages = [];
    stopped = false;
    constructor() {
      super();
      workers.push(this);
    }
    postMessage(message, transfers) {
      this.messages.push({ message, transferCount: transfers.length });
      if (message.sample) {
        const matches = message.sample.map(({ id }) => ({ id, score: 0.5 }));
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { phase: 'complete', matches } })));
      }
    }
    terminate() { this.stopped = true; }
  }
  const canvas = {
    getContext: () => ({
      drawImage() {},
      getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    }),
  };
  const document = Object.assign(new EventTarget(), { defaultView: new EventTarget(), createElement: () => canvas });
  const browserGlobals = { Worker, isSecureContext: true, createImageBitmap: () => ({ width: 8, height: 8, close() {} }) };
  for (const [name, value] of Object.entries(browserGlobals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  let previews = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => {
    await previews.promise;
    return new Response('fixture preview');
  });
  const matcher = createSubjectMatcher(document);
  t.after(() => matcher.release());
  const sample = [1, 2].map(id => ({ id, cover: 'https://image.civitai.com/gallery/' + id + '.jpg' }));
  const cancel = new AbortController();
  const first = matcher.rank({ sample, description: 'Yellow forest at sunrise' }, { signal: cancel.signal, onProgress() {} });
  assert.deepEqual(workers[0].messages, [{ message: { type: 'prepare-text' }, transferCount: 0 }]);
  cancel.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.ok(workers[0].stopped);
  previews.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers[0].messages.length, 1);

  previews = Promise.withResolvers();
  const options = { signal: new AbortController().signal, onProgress() {} };
  const next = matcher.rank({ sample, description: 'Yellow forest at sunrise' }, options);
  assert.deepEqual(workers[1].messages, [{ message: { type: 'prepare-text' }, transferCount: 0 }]);
  previews.resolve();
  assert.deepEqual((await next).map(({ id }) => id), [1, 2]);
  assert.equal(workers[1].messages.length, 2);
  assert.equal(workers[1].messages[1].message.description, 'Yellow forest at sunrise');

  matcher.release();
  const reference = { file: new Blob(['fixture reference']) };
  const picture = matcher.rank({ reference, sample }, options);
  assert.deepEqual(workers[2].messages, []);
  assert.deepEqual((await picture).map(({ id }) => id), [1, 2]);
  assert.ok(workers[2].messages.every(({ message }) => message.type !== 'prepare-text'));
});
