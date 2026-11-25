export function startSoundWorker(window, moduleUrl) {
  const loader = 'import ' + JSON.stringify(moduleUrl.href) + ';';
  return new window.Worker('data:text/javascript;charset=UTF-8,' + encodeURIComponent(loader), { type: 'module' });
}

export function requestSoundWorker(worker, message, signal, timeout, { progress = () => {}, transfer = [] } = {}) {
  const guard = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
  guard.throwIfAborted();
  return new Promise((resolve, reject) => {
    const clear = () => {
      guard.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
    };
    const fail = error => { clear(); reject(error); };
    const abort = () => fail(guard.reason);
    guard.addEventListener('abort', abort, { once: true });
    worker.onerror = worker.onmessageerror = () => fail(new Error('This browser could not start the sound model.'));
    worker.onmessage = event => {
      if (!event.isTrusted || event.origin !== '' || event.source !== null || event.ports.length !== 0) return;
      const data = event.data;
      if (!data || typeof data.type !== 'string') {
        fail(new Error('The sound model returned an unexpected reply.'));
      } else if (data.type === 'progress') {
        progress(data);
      } else {
        clear();
        resolve(data);
      }
    };
    try { worker.postMessage(message, transfer); }
    catch (error) { fail(error); }
  });
}
