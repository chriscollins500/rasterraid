import { element } from './view.js';

export function attachInputAssist(input, { getRows, getWritingHelp, emptyMessage, onChoose }) {
  const panel = element('div', null, 'input-assist');
  const list = element('div', null, 'assist-list');
  const empty = element('p', emptyMessage, 'assist-empty');
  empty.setAttribute('role', 'status');
  panel.hidden = true;
  panel.append(list, empty);
  input.parentElement.append(panel);
  list.id = input.id + '-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-labelledby', input.id + '-label');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');

  let rows = [];
  let options = [];
  let active = -1;
  let editing = false;
  let composing = false;
  let timer;
  let check;
  let revision;

  function select(index) {
    if (options[active]) options[active].setAttribute('aria-selected', 'false');
    active = index;
    if (!options[active]) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const option = options[active];
    option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function draw() {
    if (!editing || composing || input.disabled) return;
    const activeValue = rows[active]?.value;
    rows = getRows(input.value);
    if (revision && !rows.some(row => row.value === revision)) {
      rows.unshift({ value: revision, label: revision, group: 'Spelling and grammar', detail: 'Apply correction' });
    }
    if (rows.length && !panel.hidden && options.length === rows.length && options.every((option, i) =>
      option.dataset.value === rows[i].value && option.dataset.label === rows[i].label)) return;

    const groups = new Map();
    options = rows.map((row, index) => {
      if (!groups.has(row.group)) groups.set(row.group, []);
      const option = element('div', null, 'assist-option');
      option.id = list.id + '-' + index;
      option.dataset.index = index;
      option.dataset.value = row.value;
      option.dataset.label = row.label;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.append(element('span', row.label, 'assist-option-label'));
      if (row.detail) option.append(element('span', row.detail, 'assist-option-detail'));
      groups.get(row.group).push(option);
      return option;
    });
    list.replaceChildren(...[...groups].map(([name, items]) => {
      if (!name) return items;
      const group = element('div', null, 'assist-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', name);
      const title = element('span', name, 'assist-group-title');
      title.setAttribute('aria-hidden', 'true');
      group.append(title, ...items);
      return group;
    }).flat());
    list.hidden = !rows.length;
    empty.hidden = Boolean(rows.length || !emptyMessage);
    panel.hidden = !rows.length && empty.hidden;
    input.setAttribute('aria-expanded', String(Boolean(rows.length)));
    select(activeValue === undefined ? -1 : rows.findIndex(row => row.value === activeValue));
  }

  function close() {
    editing = false;
    clearTimeout(timer);
    check?.abort();
    revision = undefined;
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    select(-1);
  }

  function choose(index) {
    const row = rows[index];
    if (!row) return;
    if (onChoose) {
      close();
      onChoose(row.value);
      return;
    }
    input.value = row.value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  input.addEventListener('focus', () => { editing = true; draw(); });
  input.addEventListener('blur', close);
  input.addEventListener('compositionstart', () => { composing = true; close(); });
  input.addEventListener('compositionend', () => { composing = false; editing = true; draw(); });
  input.addEventListener('input', () => {
    if (composing) return;
    editing = true;
    revision = undefined;
    select(-1);
    check?.abort();
    clearTimeout(timer);
    draw();
    if (!getWritingHelp) return;
    const value = input.value;
    timer = setTimeout(async () => {
      check = new AbortController();
      const { signal } = check;
      const result = await getWritingHelp(value, signal);
      if (!signal.aborted && editing && value === input.value && result?.length <= input.maxLength) {
        revision = result;
        draw();
      }
    }, 480);
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (panel.hidden) { editing = true; draw(); }
      if (!rows.length || panel.hidden) return;
      event.preventDefault();
      const last = rows.length - 1;
      select(event.key === 'ArrowDown' ? Math.min(active + 1, last) : active <= 0 ? last : active - 1);
    } else if (event.key === 'Enter' && !panel.hidden && active >= 0) {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault();
      close();
    }
  });
  list.addEventListener('pointerdown', event => event.preventDefault());
  list.addEventListener('click', event => choose(Number(event.target.closest('[data-index]')?.dataset.index)));
  return { refresh: draw, close };
}
