import { articlePassageCards, articlePassageLimit, rankArticlePassages, readArticlePassageSources } from './article-passages.mjs';
import { attachInputAssist } from './input-assist.js';
import { searchWords } from './query-language.mjs';
import { createProofreader, draftSuggestions } from './text-assist.mjs';
import { element, sourceLink } from './view.js';

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

function passageCard(row, context, onFollow) {
  const item = element('li', null, 'article-passage');
  const copy = element('div', null, 'article-passage-copy');
  const anchor = row.sectionLink ?? row.articleLink;
  if (row.preview) {
    const img = element('img');
    img.src = row.preview;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { img.remove(); }, { once: true });
    item.append(img);
  }
  const heading = element('h3', row.heading || row.title);
  const updated = row.updatedAt && 'Updated ' + date.format(new Date(row.updatedAt));
  const byline = [row.heading && row.title, row.creator && 'by ' + row.creator, updated].filter(Boolean).join(' · ');
  const quote = element('blockquote');
  let position = 0;
  for (const [start, end] of row.matches) {
    quote.append(row.excerpt.slice(position, start), element('mark', row.excerpt.slice(start, end)));
    position = end;
  }
  quote.append(row.excerpt.slice(position));
  if (byline) copy.append(element('p', byline, 'article-passage-byline'));
  const actions = element('div', null, 'article-passage-actions');
  const label = row.sectionLink ? 'Jump to section' : 'Open article';
  const source = sourceLink(anchor, label, context);
  const arrow = element('span', ' ↗');
  arrow.setAttribute('aria-hidden', 'true');
  source.append(arrow);
  const destination = row.sectionLink ? row.heading + ' in ' + row.title : row.title;
  source.setAttribute('aria-label', label + ' · ' + destination + ' on Civitai');
  const follow = element('button', 'Follow guide links', 'chip');
  follow.type = 'button';
  follow.addEventListener('click', () => onFollow(row.articleLink));
  actions.append(source, follow);
  copy.prepend(heading);
  copy.append(quote, actions);
  item.append(copy);
  return item;
}

export function configureArticlePassages(document, { getSearch, getContext, followGuide }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('article-passages');
  const form = byId('article-passage-form');
  const input = byId('article-passage-query');
  const choice = byId('article-passage-sources');
  const status = byId('article-passage-status');
  const list = byId('article-passage-results');
  const submit = byId('article-passage-submit');
  let session;
  let pending;
  const assist = attachInputAssist(input, {
    getRows: value => draftSuggestions(value, session?.vocabulary ?? [], 'query'),
    getWritingHelp: createProofreader(),
  });

  function clearResults() {
    pending?.abort();
    pending = undefined;
    submit.removeAttribute('aria-disabled');
    status.textContent = '';
    list.replaceChildren();
  }

  function close() {
    clearResults();
    assist.close();
    session = undefined;
    input.value = '';
    choice.replaceChildren();
    if (dialog.open) dialog.close();
  }

  function open(search, trigger) {
    if (dialog.open || search !== getSearch() || search.context !== getContext()) return;
    const cards = articlePassageCards(search.groups.articles ?? [], search.context.origin);
    if (!cards.length) return;
    const plan = search.result.directory?.scope === 'articles' ? search.result.directory.plan : undefined;
    const initial = plan?.query ?? (search.result.target.kind === 'text' ? search.result.target.value : '');
    const option = (label, value) => {
      const row = element('option', label);
      row.value = value;
      return row;
    };
    const listLabel = cards.length > articlePassageLimit ? 'First ' + articlePassageLimit + ' results'
      : 'All ' + cards.length + ' results';
    choice.replaceChildren(option(listLabel, ''),
      ...cards.map(card => option(card.title + (card.creator ? ' · ' + card.creator : ''), String(card.id))));
    choice.parentElement.hidden = cards.length === 1;
    session = { search, plan, cards, trigger, vocabulary: [...new Set(cards.slice(0, 36).flatMap(card => searchWords(card.title)))] };
    input.value = initial.slice(0, input.maxLength);
    dialog.showModal();
    input.focus();
  }

  const isCurrent = current => current && current === session && dialog.open &&
    current.search === getSearch() && current.search.context === getContext();

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const trigger = session?.trigger;
    close();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  });
  input.addEventListener('input', clearResults);
  choice.addEventListener('change', clearResults);
  async function find() {
    const current = session;
    if (pending || !isCurrent(current)) return;
    const question = input.value.trim();
    if (!question) {
      status.textContent = 'Enter words to look for.';
      input.focus();
      return;
    }
    const selected = choice.value;
    const cards = selected ? current.cards.filter(card => String(card.id) === selected) : current.cards;
    const controller = new AbortController();
    const { signal } = controller;
    pending = controller;
    list.replaceChildren();
    submit.setAttribute('aria-disabled', 'true');
    status.textContent = 'Checking the published text on Civitai…';
    try {
      const reading = current.reading?.selection === selected ? current.reading.value
        : await readArticlePassageSources(current.search.context, cards, current.plan, {
          signal,
          onProgress(attempted, requested) {
            if (isCurrent(current)) status.textContent = 'Checked ' + attempted + ' of ' + requested + ' articles…';
          },
        });
      if (signal.aborted || !isCurrent(current)) return;
      if (reading.sources.length === reading.requested) current.reading = { selection: selected, value: reading };
      const passages = rankArticlePassages(reading.sources, question);
      const coverage = reading.sources.length + ' of ' + reading.requested + ' article texts read.';
      const detail = reading.paused ? ' Civitai paused further reads.' : '';
      const outcome = passages.length ? passages.length + (passages.length === 1 ? ' matching passage.' : ' matching passages.')
        : reading.sources.length ? 'No match in the text checked. Try a shorter phrase.' : 'Article text is unavailable.';
      status.textContent = outcome + ' ' + coverage + detail;
      list.replaceChildren(...passages.map(row => passageCard(row, current.search.context, link => {
        if (isCurrent(current)) {
          close();
          followGuide(link);
        }
      })));
    } catch {
      if (!signal.aborted && isCurrent(current)) status.textContent = 'Civitai couldn’t return article text. Try again.';
    } finally {
      if (pending === controller) {
        pending = undefined;
        submit.removeAttribute('aria-disabled');
      }
    }
  }
  // The hosted iframe has allow-scripts and may block native form submission.
  submit.addEventListener('click', () => { void find(); });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    void find();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void find();
  });
  return { open, close };
}
