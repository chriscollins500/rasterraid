import { SITE_ORIGINS } from './catalog.mjs';
import { foldSearchText } from './query-language.mjs';

const storageScope = 'apps:storage';
const storagePath = '/api/v1/blocks/storage/prefs/search-scopes';
const localKey = 'rasterraid:search-buttons:v1';
const shortcutLimit = 5;
const searchGroups = [
  ['Find models and media', ['all', 'models', 'gallery', 'videos', 'audio', 'pictures', 'assets3d', 'collections', 'posts', 'comics', 'storylines'],
    'Pictures, videos, music, comics'],
  ['Learn or make something', ['report', 'articles', 'tools', 'aiServices', 'apps', 'reviews', 'tags'], 'Articles, tools, reviews, research reports'],
  ['Find people and discussions', ['users', 'creators', 'hubs', 'topics', 'communities', 'comments'], 'Profiles, communities, comments'],
  ['Take part or hire someone', ['bounties', 'challenges', 'crucibles', 'leaderboards', 'services', 'marketplace', 'auctions', 'prizes'],
    'Contests, bounties, rewards, creator services'],
  ['Open my Civitai', ['saved', 'ownedModels', 'vault', 'downloads', 'creations', 'notifications', 'messages'],
    'Your saved items, creations, and inbox'],
];
const searchTerms = {
  all: 'everything general start all',
  models: 'checkpoints lora weights add-ons style',
  gallery: 'pictures photos artwork art illustrations images',
  pictures: 'model examples samples reference photos images',
  videos: 'clips films animation motion footage', audio: 'songs music sound recordings',
  assets3d: 'mesh geometry objects 3D',
  collections: 'curated galleries folders playlists', comics: 'manga graphic novels illustrated stories',
  storylines: 'interactive stories fiction', posts: 'published uploads photos pictures clips',
  report: 'compare two examples inspect generation settings model versions sources research',
  articles: 'guides tutorials news help documentation', tools: 'software editors workflows',
  aiServices: 'transcribe speech text generation captioning embeddings Orchestration',
  apps: 'extensions plug-ins App Store', reviews: 'ratings feedback opinions',
  tags: 'styles genres categories synonyms', users: 'creators artists authors profile people users person',
  creators: 'creators authors artists public profiles', hubs: 'shared feeds groups communities',
  comments: 'threads discussion replies conversation', bounties: 'paid requests tasks opportunities',
  crucibles: 'contests judges competitions', leaderboards: 'ranks rankings top scores',
  services: 'hire commission training LoRA artist', marketplace: 'Buzz credits earn spending',
  saved: 'bookmarks favorites follows private collections', ownedModels: 'my uploads releases checkpoints',
  vault: 'personal library models', downloads: 'downloaded history files',
  creations: 'generated images creations history', notifications: 'alerts updates inbox',
  messages: 'private messages inbox chat',
};

export function normalizeButtonLayout(value, known) {
  const allowed = new Set(known);
  const valid = list => (Array.isArray(list) ? list : []).filter(name => allowed.has(name));
  return { order: [...new Set([...valid(value?.order), ...known])], hidden: [...new Set(valid(value?.hidden))] };
}

export function moveSearchButton(order, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= order.length || to >= order.length || from === to) return order;
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function canSaveButtonLayout(context) {
  return Boolean(context?.hosted && context.signedIn && context.token && SITE_ORIGINS.includes(context.origin) &&
    context.storageMode !== 'local-preview' && context.scopes.includes(storageScope));
}

export async function syncButtonLayout(context, { layout, version, signal, fetcher = fetch } = {}) {
  if (!canSaveButtonLayout(context)) throw new Error('Private preferences are unavailable here.');
  const body = layout ? JSON.stringify({ data: layout, ifVersion: version }) : undefined;
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + context.token };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetcher(new URL(storagePath, context.origin), {
    method: body ? 'PUT' : 'GET', headers, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(7_000)]) : AbortSignal.timeout(7_000),
    credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
  });
  const data = await response.json().catch(() => null);
  if (!body && response.status === 404 && data?.code === 'not_found') return { version: 0, data: null };
  if (!response.ok || !Number.isSafeInteger(data?.version) || data.version < 1 || !data.data || typeof data.data !== 'object') {
    throw Object.assign(new Error('Civitai could not save the button layout.'), { status: response.status });
  }
  return data;
}

export function configureSearchButtons(win, onScope) {
  const doc = win.document;
  const toolbar = doc.getElementById('search-scope-buttons');
  const dialog = doc.getElementById('button-layout');
  const list = doc.getElementById('button-layout-list');
  const note = doc.getElementById('button-layout-status');
  const applyButton = doc.getElementById('button-layout-apply');
  const opener = doc.getElementById('customize-buttons');
  const areas = doc.getElementById('search-areas');
  const areaOpener = doc.getElementById('open-search-areas');
  const areaQuery = doc.getElementById('search-area-query');
  const areaShortcuts = doc.getElementById('area-shortcuts');
  const areaList = doc.getElementById('search-area-list');
  const areaStatus = doc.getElementById('search-area-status');
  const scope = doc.querySelector('select[name="scope"]');
  const buttons = new Map([...toolbar.querySelectorAll('[data-search-scope]')].map(button => [button.dataset.searchScope, button]));
  for (const option of scope.options) {
    if (buttons.has(option.value)) continue;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.searchScope = option.value;
    button.textContent = option.textContent;
    button.hidden = true;
    button.setAttribute('aria-pressed', 'false');
    buttons.set(option.value, button);
    toolbar.append(button);
  }
  const known = [...buttons.keys()];
  let current = normalizeButtonLayout(null, known);
  let draft;
  let context;
  let viewerKey;
  let revision;
  let editing = false;
  let dragging;

  function paint() {
    const focused = areas.open ? doc.activeElement : null;
    const shortcuts = new Set(current.order.filter(name => !current.hidden.includes(name)).slice(0, shortcutLimit));
    for (const [index, name] of current.order.entries()) {
      const button = buttons.get(name);
      const occupant = toolbar.children[index] ?? null;
      if (occupant !== button) toolbar.insertBefore(button, occupant);
      const hidden = !shortcuts.has(name);
      if (button.hidden !== hidden) button.hidden = hidden;
    }
    if (areas.open) {
      renderAreas();
      const name = focused?.dataset.searchScope ?? focused?.dataset.areaScope;
      if (name) {
        const target = available().find(button => (button.dataset.searchScope ?? button.dataset.areaScope) === name);
        (target ?? areaQuery).focus({ preventScroll: true });
      }
    }
  }

  const label = name => buttons.get(name).textContent.trim();
  const areaGroups = [...searchGroups, ['Other areas', known.filter(name => !searchGroups.some(([, names]) => names.includes(name)))]];
  const available = () => [
    ...(areaShortcuts.hidden ? [] : toolbar.querySelectorAll('button:not([hidden])')),
    ...[...areaList.querySelectorAll('[data-area-scope]')].filter(button => !button.closest('details:not([open])')),
  ];

  function chooseArea(name) {
    areas.close();
    onScope(name);
  }

  toolbar.addEventListener('click', event => {
    const button = event.target.closest('[data-search-scope]');
    if (button) chooseArea(button.dataset.searchScope);
  });

  function renderAreas() {
    const query = foldSearchText(areaQuery.value).trim();
    const words = query.split(/\s+/u).filter(Boolean);
    const openGroup = areaList.querySelector('details[open]')?.dataset.areaGroup;
    function relevance(name, group) {
      const title = foldSearchText(label(name));
      if (!words.length || title === query) return 0;
      if (title.startsWith(query)) return 1;
      if (words.every(word => title.includes(word))) return 2;
      const search = foldSearchText([title, searchTerms[name], group].filter(Boolean).join(' '));
      return words.every(word => search.includes(word)) ? 3 : Infinity;
    }
    areaShortcuts.hidden = Boolean(query) || ![...buttons.values()].some(button => !button.hidden);
    const matches = areaGroups.flatMap(([group, names]) => names.filter(name => buttons.has(name) && (query || buttons.get(name).hidden))
      .map(name => ({ name, group, rank: relevance(name, group) }))).filter(row => Number.isFinite(row.rank));
    const groups = query ? [['Matches', matches.sort((a, b) => a.rank - b.rank)]]
      : areaGroups.map(([group, , description]) => [group, matches.filter(row => row.group === group), description]);
    areaList.replaceChildren(...groups.flatMap(([group, rows, description]) => {
      if (!rows.length) return [];
      const section = doc.createElement(query ? 'section' : 'details');
      const heading = doc.createElement(query ? 'h3' : 'summary');
      const title = doc.createElement('strong');
      title.textContent = group;
      heading.append(title);
      if (!query) {
        section.className = 'area-group';
        section.name = 'search-area-group';
        section.dataset.areaGroup = group;
        section.open = group === openGroup;
        if (description) {
          const hint = doc.createElement('span');
          hint.textContent = description;
          heading.append(hint);
        }
      }
      const choices = doc.createElement('div');
      choices.className = 'search-area-options';
      for (const { name } of rows) {
        const button = modalButton(label(name), label(name), () => chooseArea(name));
        button.dataset.areaScope = name;
        button.setAttribute('aria-pressed', String(name === scope.value));
        choices.append(button);
      }
      section.append(heading, choices);
      return [section];
    }));
    areaStatus.textContent = query ? matches.length ? matches.length + (matches.length === 1 ? ' area found' : ' areas found')
      : 'No search areas match. Try a shorter word.' : '';
  }

  areaOpener.addEventListener('click', () => {
    areaQuery.value = '';
    areaList.querySelector('details[open]')?.removeAttribute('open');
    renderAreas();
    areas.showModal();
    areaQuery.focus();
  });
  areaQuery.addEventListener('input', renderAreas);
  areas.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      areas.close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    const options = available();
    const index = options.indexOf(doc.activeElement);
    if (!options.length || index < 0 && doc.activeElement !== areaQuery) return;
    if (event.key === 'Enter') {
      if (doc.activeElement !== areaQuery || !areaQuery.value.trim()) return;
      event.preventDefault();
      options[0].click();
      return;
    }
    event.preventDefault();
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  });

  function modalButton(label, accessibleName, action) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = label;
    button.setAttribute('aria-label', accessibleName);
    button.addEventListener('click', action);
    return button;
  }

  function move(name, to, control) {
    draft.order = moveSearchButton(draft.order, draft.order.indexOf(name), to);
    draw();
    if (control) {
      const row = [...list.children].find(item => item.dataset.scope === name);
      const next = row.querySelector('[data-direction=' + control + ']');
      (next.disabled ? row.querySelector('input') : next).focus();
    }
  }

  function draw() {
    list.replaceChildren(...draft.order.map((name, index) => {
      const row = doc.createElement('li');
      row.className = 'button-layout-row';
      row.dataset.scope = name;
      row.draggable = true;
      const label = doc.createElement('label');
      const checked = doc.createElement('input');
      const title = buttons.get(name).textContent.trim();
      checked.type = 'checkbox';
      checked.checked = !draft.hidden.includes(name);
      checked.setAttribute('aria-label', 'Show ' + title);
      checked.addEventListener('change', () => {
        draft.hidden = checked.checked ? draft.hidden.filter(id => id !== name) : [...draft.hidden, name];
      });
      label.append(checked, doc.createTextNode(title));
      const up = modalButton('↑', 'Move ' + title + ' up', () => move(name, index - 1, 'up'));
      const down = modalButton('↓', 'Move ' + title + ' down', () => move(name, index + 1, 'down'));
      up.dataset.direction = 'up';
      down.dataset.direction = 'down';
      up.disabled = index === 0;
      down.disabled = index === draft.order.length - 1;
      row.addEventListener('dragstart', event => {
        dragging = name;
        event.dataTransfer?.setData('text/plain', name);
      });
      row.addEventListener('dragend', () => { dragging = undefined; });
      row.addEventListener('dragover', event => { if (dragging) event.preventDefault(); });
      row.addEventListener('drop', event => {
        if (!dragging) return;
        event.preventDefault();
        move(dragging, index);
        dragging = undefined;
      });
      row.append(label, up, down);
      return row;
    }));
  }

  opener.addEventListener('click', () => {
    if (applyButton.disabled) return;
    editing = true;
    draft = normalizeButtonLayout(current, known);
    draw();
    note.textContent = canSaveButtonLayout(context) ? 'This layout is private to your RasterRaid account.'
      : context?.hosted ? 'Changes apply to this tab in the preview.' : 'Changes apply in this browser.';
    areas.close();
    dialog.showModal();
  });
  dialog.addEventListener('close', () => { editing = false; dragging = undefined; });
  doc.getElementById('button-layout-reset').addEventListener('click', () => { draft = normalizeButtonLayout(null, known); draw(); });
  applyButton.addEventListener('click', async () => {
    const layout = normalizeButtonLayout(draft, known);
    const key = viewerKey;
    const viewer = context;
    current = layout;
    paint();
    if (!canSaveButtonLayout(context)) {
      if (!context?.hosted) {
        try { win.localStorage.setItem(localKey, JSON.stringify(layout)); } catch { /* Opaque frames keep the tab layout. */ }
      }
      dialog.close();
      return;
    }
    applyButton.disabled = true;
    note.textContent = 'Saving your layout…';
    try {
      const version = revision ?? (await syncButtonLayout(viewer)).version;
      if (key !== viewerKey) return;
      const saved = await syncButtonLayout(viewer, { layout, version });
      if (key === viewerKey) { revision = saved.version; dialog.close(); }
    } catch (error) {
      if (key === viewerKey) {
        revision = undefined;
        note.textContent = error.status === 409 ? 'Another tab changed the layout. Apply again to save this one.'
          : 'Applied in this tab. Civitai could not save it to your account.';
      }
    } finally { applyButton.disabled = false; }
  });

  return async update => {
    context = update;
    const key = update.hosted ? update.origin + ':' + update.viewerUserId + ':' + canSaveButtonLayout(update) : 'local';
    if (key === viewerKey) return;
    viewerKey = key;
    revision = undefined;
    current = normalizeButtonLayout(null, known);
    if (dialog.open) dialog.close();
    if (!update.hosted) {
      try { current = normalizeButtonLayout(JSON.parse(win.localStorage.getItem(localKey)), known); } catch { /* No saved browser layout. */ }
    }
    paint();
    if (!canSaveButtonLayout(update)) return;
    try {
      const stored = await syncButtonLayout(update);
      if (key !== viewerKey || revision !== undefined) return;
      revision = stored.version;
      if (!editing && !applyButton.disabled) { current = normalizeButtonLayout(stored.data, known); paint(); }
    } catch { /* The same controls still work in memory. */ }
  };
}
