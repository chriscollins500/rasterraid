import { numericId, SITE_ORIGINS } from './catalog.mjs';
import { workflowReadResult } from './published-workflow.mjs';
import { crucibleFilters, crucibleReference } from './community.mjs';
import { leaderboardLink, leaderboardReference } from './leaderboards.mjs';
import { isCommerceNavigation } from './marketplace.mjs';
import { isDirectoryNavigation } from './directory.mjs';
import { isAppStoreNavigation } from './app-store.mjs';
import { opportunityReference } from './opportunities.mjs';
import { isSocialNavigation } from './social-search.mjs';
import { isLibraryNavigation, PICK_LIMIT, PRIVATE_COLLECTION_SCOPE } from './library.mjs';
import { APP_ESTIMATE_BATCH_MAX, batchQuotePrices, QUOTE_SCOPE } from './quotes.mjs';
import { isNativeGalleryNavigation } from './gallery.mjs';
import { isNativeModelNavigation } from './native-model-search.mjs';
import { modelIdentityFilename, workflowReportFilename, workspaceBackupFilename } from './download-json.js';

const blockId = 'rasterraid';
const reconnectInterval = 30_000;
const batchQuoteTimeout = 40_000;
const browsingMask = value => Number.isSafeInteger(value) && value >= 0 && value <= 63;
const hostMask = value => value === undefined ? 63 : browsingMask(value) ? value : 1;
const viewerId = value => Number.isSafeInteger(value) && value > 0 ? value : null;

function hostViewer(payload) {
  if (Object.hasOwn(payload, 'viewer')) {
    const value = payload.viewer;
    return value?.signedIn === true ? { id: value.id, username: value.username } : null;
  }
  const id = viewerId(payload.context.viewerUserId);
  return id ? { id, username: payload.context.viewerUsername } : null;
}

function blockSession(win, token, binding) {
  const raw = token?.raw;
  if (token?.kind !== undefined && token.kind !== 'block' || typeof raw !== 'string' || raw.length > 16_384 ||
      !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(raw)) return null;
  let claims;
  try {
    claims = JSON.parse(win.atob(raw.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/')));
  } catch { return null; }
  // These client checks keep the view synchronized with the trusted host. Civitai verifies the signature on every protected request.
  const expiresAt = claims?.exp * 1000;
  if (claims?.blockId !== blockId || claims.blockInstanceId !== binding.id ||
      !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return null;
  const subject = /^user:([1-9]\d{0,11})$/u.exec(claims.sub ?? '');
  const id = subject ? Number(subject[1]) : null;
  if (binding.viewer ? !id || binding.viewer.id !== undefined && binding.viewer.id !== id : claims.sub !== 'anon') return null;
  const allowed = new Set(Array.isArray(claims.scopes) ? claims.scopes : []);
  const scopes = id && Array.isArray(token.scopes) ? [...new Set(token.scopes.slice(0, 64).filter(scope => allowed.has(scope) && typeof scope === 'string'))] : [];
  const browsingLevel = browsingMask(claims.viewerBrowsingLevel) && browsingMask(claims.maxBrowsingLevel)
    ? claims.viewerBrowsingLevel & claims.maxBrowsingLevel : 1;
  const username = binding.viewer?.username;
  return { raw, id, scopes, browsingLevel, expiresAt,
    username: id && /^[\p{L}\p{N}_-]{1,80}$/u.test(username ?? '') ? username : null };
}

export function watchHost(win, onContext) {
  if (win.parent === win) {
    onContext({ origin: SITE_ORIGINS[0], token: undefined, hosted: false, browsingLevel: 1, scopes: [] });
    return () => {};
  }

  let hostOrigin;
  let binding;
  let storageMode;
  let currentContext;
  let pendingConsent;
  let pendingQuoteBatch;
  let pendingPicker;
  let pendingDownload;
  let pendingWorkflowFile;
  let expiresAt;
  let expiryTimer;
  let reconnectRequest;
  let nextReconnect = 0;
  let suspended = false;

  function reconnect() {
    if (suspended || !currentContext?.connectionLost || Date.now() < nextReconnect) return;
    reconnectRequest = crypto.randomUUID();
    nextReconnect = Date.now() + reconnectInterval;
    win.parent.postMessage({ type: 'REQUEST_TOKEN', payload: { requestId: reconnectRequest, blockInstanceId: binding.id } }, hostOrigin);
  }

  function scheduleTokenExpiry() {
    clearTimeout(expiryTimer);
    if (!expiresAt) return;
    const remaining = Math.max(0, expiresAt - Date.now());
    expiryTimer = setTimeout(checkTokenExpiry, Math.min(remaining, 2_147_483_647));
    expiryTimer.unref?.();
  }

  function checkTokenExpiry() {
    if (expiresAt && expiresAt <= Date.now()) {
      acceptContext(null);
      reconnect();
    } else {
      scheduleTokenExpiry();
    }
  }

  function receive(event) {
    if (event.source !== win.parent || !SITE_ORIGINS.includes(event.origin)) return;
    const { type, payload } = event.data ?? {};
    if (type === 'BLOCK_INIT' && !hostOrigin) {
      if (
        payload?.blockId !== blockId ||
        typeof payload.blockInstanceId !== 'string' ||
        !payload.blockInstanceId.length || payload.blockInstanceId.length > 128 ||
        payload.context?.slotId !== 'app.page' ||
        payload.renderMode !== 'iframe'
      ) return;

      hostOrigin = event.origin;
      binding = { id: payload.blockInstanceId, viewer: hostViewer(payload),
        browsingLevel: hostMask(payload.maxBrowsingLevel) & hostMask(payload.effectiveBrowsingLevel) };
      storageMode = payload.storageMode === 'local-preview' ? 'local-preview' : undefined;
      if (payload.theme === 'dark' || payload.theme === 'light') {
        win.document.documentElement.dataset.theme = payload.theme;
      }

      const height = Math.max(540, Math.min(1400, win.document.body.scrollHeight + 28));
      win.parent.postMessage({ type: 'BLOCK_READY', payload: { height } }, hostOrigin);
      acceptContext(blockSession(win, payload.token, binding));
      reconnect();
      return;
    }

    if (!binding || event.origin !== hostOrigin) return;
    if (type === 'THEME_CHANGE' && (payload?.theme === 'light' || payload?.theme === 'dark')) {
      win.document.documentElement.dataset.theme = payload.theme;
    }
    if (type === 'TOKEN_REFRESH') {
      reconnectRequest = undefined;
      acceptContext(blockSession(win, payload?.token, binding));
      reconnect();
    }
    if (type === 'TOKEN_REFRESH_RESPONSE' && reconnectRequest && payload?.requestId === reconnectRequest) {
      reconnectRequest = undefined;
      const session = blockSession(win, payload.token, binding);
      if (session) acceptContext(session);
    }
    if (type === 'SUSPEND') {
      suspended = true;
      pendingQuoteBatch?.finish(new DOMException('The Civitai page paused.', 'AbortError'));
      pendingDownload?.finish(new Error('Civitai paused this page. Check your downloads before trying again.'));
      pendingWorkflowFile?.finish({ status: 'unavailable' });
    }
    if (type === 'RESUME') {
      suspended = false;
      checkTokenExpiry();
      reconnect();
    }
    if (type === 'CONSENT_UNAVAILABLE') pendingConsent?.finish(null);
    if (type === 'ESTIMATE_BATCH_RESULT' && pendingQuoteBatch && payload?.requestId === pendingQuoteBatch.id) {
      const { count, finish } = pendingQuoteBatch;
      try { finish(null, batchQuotePrices(payload, count)); }
      catch (error) { finish(error); }
    }
    if (type === 'IMAGE_PICKER_RESULT' && pendingPicker && payload?.requestId === pendingPicker.id) {
      pendingPicker.finish(payload.error ? null : Array.isArray(payload.selectedImages) ? payload.selectedImages.slice(0, PICK_LIMIT) : []);
    }
    if (type === 'RESOURCE_FILE_RESULT' && pendingWorkflowFile && payload?.requestId === pendingWorkflowFile.id) {
      pendingWorkflowFile.finish(workflowReadResult(payload, pendingWorkflowFile.expected));
    }
    if (type === 'SAVE_IMAGE_RESULT' && pendingDownload && payload?.requestId === pendingDownload.id) {
      const { finish, description } = pendingDownload;
      if (!Object.hasOwn(payload, 'error') && payload.ok === true) finish();
      else if (payload.ok === false || typeof payload.error === 'string' && payload.error.length <= 512) {
        finish(new Error(payload.error === 'busy' ? 'Civitai is busy. Try again or copy ' + description + '.' :
          'Civitai could not start the download. Copy ' + description + ' to keep it.'));
      }
    }
  }

  function requestQuoteBatch(bodies, signal) {
    signal.throwIfAborted();
    if (suspended || pendingQuoteBatch) throw new Error('Civitai is unavailable for a quote right now.');
    if (!Array.isArray(bodies) || !bodies.length || bodies.length > APP_ESTIMATE_BATCH_MAX) {
      throw new TypeError('Choose at most ' + APP_ESTIMATE_BATCH_MAX + ' Deep Search options to price together.');
    }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, prices) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        pendingQuoteBatch = undefined;
        if (error) reject(error);
        else resolve(prices);
      };
      const abort = () => finish(signal.reason);
      // Civitai gives its batch estimator 30 seconds. A slow host should not get parallel single estimates.
      const timer = setTimeout(() => finish(new DOMException('Civitai took too long to price these options.', 'TimeoutError')), batchQuoteTimeout);
      pendingQuoteBatch = { id, count: bodies.length, finish };
      signal.addEventListener('abort', abort, { once: true });
      try { win.parent.postMessage({ type: 'ESTIMATE_WORKFLOW_BATCH', payload: { requestId: id, bodies } }, hostOrigin); }
      catch (error) { finish(error); }
    });
  }

  function requestGrant(scope, signal) {
    if (!currentContext?.signedIn || !currentContext.token || signal.aborted) return Promise.resolve(null);
    if (currentContext.scopes.includes(scope)) return Promise.resolve(currentContext);
    if (pendingConsent) return Promise.resolve(null);
    return new Promise(resolve => {
      const finish = value => {
        signal.removeEventListener('abort', abort);
        pendingConsent = undefined;
        resolve(value);
      };
      const abort = () => finish(null);
      signal.addEventListener('abort', abort, { once: true });
      pendingConsent = { scope, finish };
      win.parent.postMessage({ type: 'REQUEST_CONSENT', payload: { scopes: [scope] } }, hostOrigin);
    });
  }

  function pickCreations(source, signal) {
    if (!currentContext?.signedIn || !['generated', 'posted'].includes(source) || signal.aborted || pendingPicker) return Promise.resolve(null);
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const finish = value => {
        signal.removeEventListener('abort', abort);
        pendingPicker = undefined;
        resolve(value);
      };
      const abort = () => finish(null);
      signal.addEventListener('abort', abort, { once: true });
      pendingPicker = { id, finish };
      win.parent.postMessage({ type: 'OPEN_IMAGE_PICKER', payload: { requestId: id, sources: [source], multiple: { max: PICK_LIMIT } } }, hostOrigin);
    });
  }

  function downloadJson(filename, bytes, signal) {
    const description = filename === workspaceBackupFilename ? 'the backup' : filename === modelIdentityFilename ? 'the identity JSON'
      : filename === workflowReportFilename ? 'the Deep Search report' : null;
    if (!description) return Promise.reject(new Error('Unknown download.'));
    const unavailable = 'The Civitai download is unavailable. Copy ' + description + ' to keep it.';
    if (!currentContext || suspended || !(bytes instanceof ArrayBuffer) || bytes.byteLength < 1 || bytes.byteLength > 50 * 1024 * 1024) {
      return Promise.reject(new Error(unavailable));
    }
    if (pendingDownload) return Promise.reject(new Error('Wait for Civitai to respond to the current download.'));
    if (signal.aborted) return Promise.reject(signal.reason);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        pendingDownload = undefined;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal.reason);
      const timer = setTimeout(() => finish(new Error('Civitai did not confirm the download. Check your downloads before trying again.')), 20_000);
      pendingDownload = { id, finish, description };
      signal.addEventListener('abort', abort, { once: true });
      try { win.parent.postMessage({ type: 'SAVE_IMAGE', payload: { requestId: id, bytes, filename } }, hostOrigin); }
      catch { finish(new Error(unavailable)); }
    });
  }

  function readWorkflowFile(expected, signal) {
    const { modelId, versionId, fileId } = expected;
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' });
    if (!currentContext?.signedIn) return Promise.resolve({ status: 'unauthorized' });
    if (suspended || !numericId(modelId) || !numericId(versionId) || fileId !== undefined && !numericId(fileId)) {
      return Promise.resolve({ status: 'unavailable' });
    }
    if (pendingWorkflowFile) return Promise.resolve({ status: 'busy' });
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const finish = result => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        pendingWorkflowFile = undefined;
        resolve(result);
      };
      const abort = () => finish({ status: 'cancelled' });
      const timer = setTimeout(() => finish({ status: 'timeout' }), 120_000);
      pendingWorkflowFile = { id, expected, finish };
      signal.addEventListener('abort', abort, { once: true });
      try {
        win.parent.postMessage({ type: 'GET_RESOURCE_FILE', payload: {
          requestId: id, modelVersionId: versionId, ...(fileId !== undefined && { fileId }),
        } }, hostOrigin);
      } catch { finish({ status: 'unavailable' }); }
    });
  }

  function acceptContext(session) {
    if (session && session.expiresAt <= Date.now()) session = null;
    const viewerUserId = session?.id ?? null;
    // The page only sends its visibility projection during initialization. Token rotation may narrow it further.
    const browsingLevel = (session?.browsingLevel ?? 1) & binding.browsingLevel;
    if (pendingQuoteBatch && (currentContext.viewerUserId !== viewerUserId || currentContext.browsingLevel !== browsingLevel ||
        !session?.scopes.includes(QUOTE_SCOPE))) pendingQuoteBatch.finish(new DOMException('Civitai quote access changed.', 'AbortError'));
    if (currentContext && (currentContext.viewerUserId !== viewerUserId ||
      (currentContext.browsingLevel & browsingLevel) !== currentContext.browsingLevel)) {
      pendingConsent?.finish(null);
      pendingPicker?.finish(null);
      pendingDownload?.finish(new DOMException('Civitai access changed.', 'AbortError'));
      pendingWorkflowFile?.finish({ status: 'cancelled' });
    }
    expiresAt = session?.expiresAt;
    scheduleTokenExpiry();
    if (session) nextReconnect = 0;
    const viewerUsername = session?.username ?? null;
    const sameViewer = () => currentContext?.viewerUserId === viewerUserId;
    currentContext = {
      origin: hostOrigin,
      token: session?.raw,
      browsingLevel,
      scopes: session?.scopes ?? [],
      hosted: true,
      signedIn: viewerUserId !== null, connectionLost: Boolean(binding.viewer && !session), viewerUserId, viewerUsername, storageMode,
      requestSignIn() {
        if (sameViewer() && !binding.viewer && !suspended) {
          win.parent.postMessage({ type: 'REQUEST_SIGN_IN', payload: {} }, hostOrigin);
        }
      },
      requestQuoteAccess: signal => sameViewer() ? requestGrant(QUOTE_SCOPE, signal) : Promise.resolve(null),
      requestQuoteBatch(bodies, signal) {
        if (!sameViewer() || !currentContext.signedIn || !currentContext.scopes.includes(QUOTE_SCOPE) ||
            currentContext.browsingLevel !== browsingLevel) throw new Error('Civitai quote access changed.');
        return requestQuoteBatch(bodies, signal);
      },
      requestWorkflowHistoryAccess: signal => sameViewer() && currentContext.signedIn ? requestGrant(QUOTE_SCOPE, signal) : Promise.resolve(null),
      requestPrivateCollections: signal => sameViewer() && currentContext.signedIn ? requestGrant(PRIVATE_COLLECTION_SCOPE, signal) : Promise.resolve(null),
      pickCreations: (source, signal) => sameViewer() ? pickCreations(source, signal) : Promise.resolve(null),
      downloadJson: (filename, bytes, signal) => sameViewer() && (currentContext.browsingLevel & browsingLevel) === browsingLevel
        ? downloadJson(filename, bytes, signal) : Promise.reject(new DOMException('Civitai access changed.', 'AbortError')),
      readWorkflowFile: (expected, signal) => sameViewer() && (currentContext.browsingLevel & browsingLevel) === browsingLevel
        ? readWorkflowFile(expected, signal) : Promise.resolve({ status: 'cancelled' }),
      open(url) {
        if (!sameViewer()) return;
        let target;
        try { target = new URL(url); } catch { return; }
        if (/^\/user\/notifications\/?$/u.test(target.pathname) && (target.search || target.hash)) return;
        const detail = /^\/(models|images|articles|collections|comics|3d-models|posts|storylines|bounties|challenges(?:\/events)?)\/[1-9]\d*$/u;
        const listing = /^\/(?:user\/[\w%-]+|3d-models|storylines|bounties|challenges\/winners)$/u;
        const gallery = isNativeGalleryNavigation(target);
        const models = isNativeModelNavigation(target);
        const postFeed = target.pathname === '/posts' &&
          [...target.searchParams].every(([key]) => ['tags', 'username', 'modelId', 'modelVersionId'].includes(key));
        const bountySearch = target.pathname === '/search/bounties' &&
          [...target.searchParams].every(([key]) => ['query', 'users', 'tags', 'type', 'baseModel'].includes(key));
        const challengeFeed = target.pathname === '/challenges' &&
          [...target.searchParams].every(([key, value]) => key === 'status' && ['active', 'upcoming', 'completed'].includes(value));
        const crucible = crucibleReference(target.pathname);
        const crucibleDetail = crucible && target.pathname === '/crucibles/' + crucible.id && !target.search && !target.hash;
        const crucibleFeed = target.pathname === '/crucibles' && !target.hash && [...target.searchParams].every(([key, value]) =>
          target.searchParams.getAll(key).length === 1 && (key === 'query' ? value.length <= 100
            : Object.hasOwn(crucibleFilters, key) && Object.hasOwn(crucibleFilters[key], value)));
        const board = leaderboardReference(target);
        const leaderboard = board && leaderboardLink(hostOrigin, board) === target.href;
        const commerce = isCommerceNavigation(target, hostOrigin);
        const directory = isDirectoryNavigation(target) || isAppStoreNavigation(target);
        const opportunity = !target.search && !target.hash && opportunityReference(target);
        const social = isSocialNavigation(target);
        const library = isLibraryNavigation(target, viewerUsername);
        if (target.origin !== hostOrigin || target.username || target.password ||
            (!gallery && !models && !postFeed && !bountySearch && !challengeFeed && !crucibleDetail && !crucibleFeed && !leaderboard && !commerce &&
              !directory && !opportunity && !social && !library && !detail.test(target.pathname) && !listing.test(target.pathname))) return;
        win.parent.postMessage({
          type: 'NAVIGATE',
          payload: { path: target.pathname + target.search + (leaderboard || commerce || social || directory ? target.hash : ''), scope: 'site', target: 'new_tab' },
        }, hostOrigin);
      },
    };
    onContext(currentContext);
    if (pendingConsent && currentContext.scopes.includes(pendingConsent.scope)) pendingConsent.finish(currentContext);
  }

  win.addEventListener('message', receive);
  return () => {
    clearTimeout(expiryTimer);
    pendingConsent?.finish(null);
    pendingQuoteBatch?.finish(new DOMException('The Civitai page closed.', 'AbortError'));
    pendingPicker?.finish(null);
    pendingDownload?.finish(new DOMException('The Civitai page closed.', 'AbortError'));
    pendingWorkflowFile?.finish({ status: 'cancelled' });
    currentContext = undefined;
    win.removeEventListener('message', receive);
  };
}
