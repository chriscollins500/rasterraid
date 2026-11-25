import { editComparisonText, editPictureSummary, editReferenceLabel, editReferenceSource, guideTraceCoverage, localTraceCoverage, localTraceRows, maximumReportSources, reportConstraint, reportMarkdown, reportSourceStatus,
  portfolioCoverage, portfolioReleaseFacts, publicWorkCoverage, referenceFileFacts, reportSources, reportTypes } from './report.mjs';
import { hashLookupNote } from './search.mjs';
import { pictureIntegrityText } from './reference-provenance.mjs';
import { element, evidenceSource, sourceLink } from './view.js';
import { upgradeFacts, upgradeGuideLabel, upgradeMemoryComparison, upgradeStorageChange } from './upgrade-evidence.mjs';
import { collectionTraceCoverage } from './collection-trace.mjs';
import { releasePictureComparisonText, releaseSampleCoverage } from './release-trail.mjs';
import { earlierSourceStatus, reportComparisonMarkdown } from './report-checkpoint.mjs';
import { exampleModelFacts, unlinkedUseLabel } from './gallery-setup.mjs';
import { exampleSide, exampleVersionUse } from './example-comparison.mjs';
import { maximumStorySources } from './story-research.mjs';
import { recordedAcrossPosts } from './report-media-models.mjs';

export function configureReportControls(form) {
  const setup = form.querySelector('#report-setup');
  const summary = form.querySelector('#report-source-count');
  const fieldset = form.querySelector('#report-source-options');
  const select = form.elements.reportType;
  const fields = new Map();
  for (const [value, { title }] of Object.entries(reportTypes)) {
    const option = element('option', title);
    option.value = value;
    select.append(option);
  }
  const publicWorkOption = select.querySelector('option[value="publicWork"]');
  for (const [scope, name] of Object.entries(reportSources)) {
    const label = element('label');
    const input = element('input');
    input.type = 'checkbox';
    label.append(input, element('span', name));
    fields.set(scope, input);
    fieldset.append(label);
  }

  const sources = () => [...fields].flatMap(([scope, input]) => input.checked ? [scope] : []);
  function update() {
    const portfolio = select.value === 'portfolio';
    const creator = select.value === 'creator';
    const fixed = reportTypes[select.value]?.fixed;
    summary.parentElement.hidden = Boolean(fixed);
    const allowed = new Set(portfolio || fixed ? reportTypes[select.value].sources : creator ? reportTypes.creator.available : []);
    for (const [scope, input] of fields) {
      const supported = portfolio || creator || fixed ? allowed.has(scope) : scope !== 'ownedModels';
      const required = portfolio && ['ownedModels', 'gallery'].includes(scope) || select.value === 'release' && scope === 'models' ||
        creator && scope === 'users' || fixed && supported;
      input.parentElement.hidden = !supported;
      if (!supported || required) input.checked = required;
      input.disabled = !supported || required;
    }
    const count = sources().length;
    summary.textContent = 'Choose sources · ' + count + ' selected';
    select.setCustomValidity(count < 2 ? 'Choose at least two public sources.' : '');
    const limit = select.value === 'stories' ? maximumStorySources : maximumReportSources;
    if (count >= limit) for (const input of fields.values()) {
      if (!input.checked) input.disabled = true;
    }
  }
  function preset() {
    const selected = new Set(reportTypes[select.value]?.sources ?? reportTypes.style.sources);
    for (const [name, input] of fields) input.checked = selected.has(name);
    update();
  }
  select.addEventListener('change', preset);
  fieldset.addEventListener('change', update);
  preset();
  return {
    sources,
    restore(type, selected) {
      select.value = Object.hasOwn(reportTypes, type) ? type : 'style';
      if (!Array.isArray(selected)) return preset();
      const saved = new Set(selected);
      for (const [scope, input] of fields) input.checked = saved.has(scope);
      update();
    },
    sync(active, publicWorkAvailable) {
      publicWorkOption.hidden = publicWorkOption.disabled = !publicWorkAvailable;
      if (!publicWorkAvailable && select.value === 'publicWork') {
        select.value = 'style';
        preset();
      }
      setup.hidden = !active;
      fieldset.disabled = !active;
      select.disabled = !active;
    },
  };
}

export function showReportExport(markdown, { title = 'Copy research report', label = 'Research report in Markdown', note, action } = {}) {
  const dialog = element('dialog', null, 'button-layout report-export');
  const heading = element('h2', title);
  heading.id = 'report-export-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  const content = element('textarea');
  content.readOnly = true;
  content.value = markdown;
  content.setAttribute('aria-label', label);
  const actions = element('div', null, 'button-layout-actions');
  const status = element('p', '', 'quote-status');
  status.setAttribute('role', 'status');
  const copy = element('button', 'Copy', 'primary');
  const close = element('button', 'Close', 'chip');
  copy.type = close.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(content.value);
      status.textContent = 'Copied.';
    } catch {
      content.focus();
      content.select();
      status.textContent = 'Use your browser’s Copy command.';
    }
  });
  close.addEventListener('click', () => dialog.close());
  const controller = new AbortController();
  dialog.addEventListener('close', () => {
    controller.abort();
    dialog.remove();
  }, { once: true });
  actions.append(close);
  if (action) {
    const extra = element('button', action.label, 'chip');
    extra.type = 'button';
    extra.addEventListener('click', async () => {
      if (!dialog.open || extra.getAttribute('aria-disabled') === 'true') return;
      extra.setAttribute('aria-disabled', 'true');
      status.textContent = '';
      try {
        const message = await action.run(controller.signal);
        if (dialog.open && message) status.textContent = message;
      } catch (error) {
        if (dialog.open && error.name !== 'AbortError') status.textContent = error.message || 'The report action could not finish.';
      } finally { extra.removeAttribute('aria-disabled'); }
    });
    actions.append(extra);
  }
  actions.append(copy);
  dialog.append(heading);
  if (note) dialog.append(element('p', note));
  dialog.append(content, actions, status);
  document.body.append(dialog);
  dialog.showModal();
  content.focus();
  content.select();
  return dialog;
}

function renderUpgradeMemory(memory, context) {
  const details = element('details', null, 'setup-evidence');
  details.open = Boolean(memory.setup);
  details.append(element('summary', 'Compare graphics memory'));
  if (memory.setup) details.append(element('p', memory.setup));
  if (memory.empty) details.append(element('p', memory.empty));
  for (const { title, link, claims } of memory.sources) {
    const items = element('ul', null, 'report-connections');
    for (const claim of claims) {
      const item = element('li', null, 'report-connection upgrade-note');
      item.append(element('strong', claim.label), element('p', claim.note));
      if (claim.difference) item.append(element('p', claim.difference));
      items.append(item);
    }
    details.append(sourceLink(link, title, context), items);
  }
  details.append(element('p', memory.note));
  return details;
}

function renderUpgrade(comparison, context, graphicsMemory) {
  const section = element('section', null, 'upgrade-comparison');
  section.append(element('h4', 'Release comparison'), element('p', comparison.fit));
  const table = element('table', null, 'upgrade-table');
  table.append(element('caption', 'Exact Civitai release and file details', 'sr-only'));
  const heading = element('tr');
  const facts = element('th', 'Detail');
  facts.setAttribute('scope', 'col');
  heading.append(facts);
  for (const [label, release] of [['Current', comparison.previous], ['Proposed', comparison.next]]) {
    const header = element('th', label);
    header.setAttribute('scope', 'col');
    if (release) header.append(sourceLink(release.link, release.title, context));
    heading.append(header);
  }
  const head = element('thead');
  head.append(heading);
  const body = element('tbody');
  if (comparison.previous?.example || comparison.next?.example) {
    const row = element('tr');
    const label = element('th', 'Example picture');
    label.setAttribute('scope', 'row');
    row.append(label);
    for (const release of [comparison.previous, comparison.next]) {
      const item = element('td');
      if (release?.example) {
        const example = release.example;
        const description = example.recorded ? 'Example records this version' : 'Catalog example';
        const image = element('img', null, 'upgrade-preview');
        image.alt = 'Civitai example for ' + release.title;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.src = example.preview;
        item.append(image, sourceLink(example.link, description, context));
      } else item.append('Unavailable');
      row.append(item);
    }
    body.append(row);
  }
  for (const { label, current, next, changed } of upgradeFacts(comparison)) {
    const row = element('tr');
    const name = element('th', label);
    name.setAttribute('scope', 'row');
    row.append(name, element('td', current), element('td', next, changed ? 'upgrade-difference' : undefined));
    body.append(row);
  }
  table.append(head, body);
  section.append(table);
  const storage = upgradeStorageChange(comparison);
  section.append(element('p', [storage, 'Loader behavior and memory use require a local test.'].filter(Boolean).join(' ')));
  const memory = upgradeMemoryComparison(comparison, graphicsMemory);
  if (memory) section.append(renderUpgradeMemory(memory, context));
  if (comparison.termsLink) {
    const terms = element('details');
    const descriptions = element('ul');
    for (const term of comparison.usage) descriptions.append(element('li', term));
    terms.append(element('summary', 'Creator’s listing terms'), descriptions, sourceLink(comparison.termsLink, 'Open model listing', context));
    section.append(terms);
  }
  const notes = [comparison.previous, comparison.next].filter(release => release?.notes || release?.hardware);
  if (notes.length) {
    const details = element('details');
    details.append(element('summary', 'Creator release notes'));
    for (const release of notes) {
      const item = element('div', null, 'upgrade-note');
      item.append(sourceLink(release.link, release.title, context));
      if (release.notes) item.append(element('p', release.notes));
      if (release.hardware && !release.notes?.includes(release.hardware)) item.append(element('p', release.hardware));
      details.append(item);
    }
    section.append(details);
  }
  if (comparison.guides.length || comparison.guidesUnavailable) {
    const guides = element('details');
    guides.append(element('summary', 'Related articles'));
    for (const guide of comparison.guides) {
      const line = element('p');
      line.append(sourceLink(guide.link, guide.title, context), ' · ' + upgradeGuideLabel(guide));
      guides.append(line);
    }
    if (comparison.guidesUnavailable) guides.append(element('p', comparison.guidesUnavailable + ' articles unavailable for a link check.'));
    section.append(guides);
  }
  return section;
}

function renderExampleSetup(setup, context, onCompareSetup) {
  const section = element('section', null, 'collection-trail example-setup');
  section.setAttribute('aria-label', 'Recorded settings');
  const kind = setup.video ? 'clip' : 'picture';
  const heading = element('div', null, 'report-heading');
  heading.append(element('h4', 'Recorded settings'), sourceLink(setup.link, 'Open the ' + kind + ' on Civitai ↗', context));
  section.append(heading);
  const summary = element('div', null, 'example-setup-overview');
  if (setup.preview) {
    const preview = element('img', null, 'example-setup-preview');
    preview.src = setup.preview;
    preview.alt = 'Preview of the referenced ' + kind;
    preview.loading = 'lazy';
    preview.referrerPolicy = 'no-referrer';
    summary.append(preview);
  }
  if (setup.settings.length) {
    const settings = element('dl', null, 'example-settings');
    for (const { label, value } of setup.settings) {
      const row = element('div');
      row.append(element('dt', label), element('dd', value));
      settings.append(row);
    }
    summary.append(settings);
  } else {
    summary.append(element('p', 'Generation settings are unavailable for this example.'));
  }
  section.append(summary);
  if (setup.recorded.length) {
    const models = element('ul', null, 'model-edit-rows');
    for (const row of setup.recorded) {
      const item = element('li', null, 'report-connection');
      if (row.model) item.append(sourceLink(row.model.link, row.model.title, context));
      item.append(element('p', exampleModelFacts(row).join(' · ')));
      models.append(item);
    }
    section.append(element('h5', 'Model versions recorded in this example'), models);
    if (onCompareSetup && setup.recorded.some(row => row.model)) {
      const compare = element('button', 'Compare with my setup', 'chip example-compare');
      compare.type = 'button';
      compare.addEventListener('click', () => onCompareSetup(setup));
      section.append(compare);
    }
  }
  if (setup.unlinked.length) {
    const list = element('details', null, 'collection-more-connections');
    list.open = !setup.recorded.length;
    list.append(element('summary', 'Strengths awaiting a version (' + setup.unlinked.length + ')'));
    const rows = element('ul', null, 'model-edit-rows');
    for (const row of setup.unlinked) rows.append(element('li', unlinkedUseLabel(row), 'report-connection'));
    list.append(rows);
    section.append(list);
  }
  if (setup.associated.length) {
    const list = element('details', null, 'collection-more-connections');
    list.append(element('summary', 'Catalog associations (' + setup.associated.length + ')'));
    for (const row of setup.associated) {
      const item = element('div', null, 'report-connection');
      item.append(sourceLink(row.model.link, row.model.title, context), element('p', exampleModelFacts(row).join(' · ')));
      list.append(item);
    }
    section.append(list);
  }
  if (setup.limited) section.append(element('p', 'The report samples up to eight entries per list. Open the ' + kind + ' for its published details.'));
  section.append(element('p', 'The settings come from published metadata. A run with your own files and tools can verify the result.'));
  return section;
}

function comparisonTable(title, firstColumn, rows) {
  const table = element('table', null, 'example-comparison-table');
  table.append(element('caption', title));
  const heading = element('tr');
  for (const label of [firstColumn, exampleSide(0), exampleSide(1)]) {
    const cell = element('th', label);
    cell.scope = 'col';
    heading.append(cell);
  }
  const head = element('thead');
  head.append(heading);
  const body = element('tbody');
  for (const { label, source, values } of rows) {
    const row = element('tr');
    if (values.every(Boolean) && values[0] !== values[1]) row.classList.add('example-difference');
    const field = element('th', source ? null : label);
    field.scope = 'row';
    if (source) field.append(source);
    row.append(field, ...values.map(value => element('td', value ?? 'Unreported')));
    body.append(row);
  }
  table.append(head, body);
  return table;
}

function renderExampleComparison({ examples, settings, versions, limited }, context) {
  const section = element('section', null, 'collection-trail example-comparison');
  section.setAttribute('aria-label', 'Example comparison');
  section.append(element('h4', 'Example comparison'));
  const previews = element('div', null, 'example-setup-overview');
  for (const [index, { item, post, postModel }] of examples.entries()) {
    const card = element('article', null, 'report-source-card example-comparison-source');
    card.append(element('h5', exampleSide(index)));
    if (!item) {
      card.append(element('p', 'This example is unavailable through Civitai.'));
    } else {
      if (item.preview) {
        const picture = element('img', null, 'example-setup-preview');
        picture.src = item.preview;
        picture.alt = item.video ? 'Clip poster' : 'Picture preview';
        picture.loading = 'lazy';
        picture.referrerPolicy = 'no-referrer';
        card.append(picture);
      }
      card.append(sourceLink(item.link, item.title + ' · #' + item.id + ' ↗', context));
      if (post) card.append(sourceLink(post.link, 'Published post ↗', context));
      if (postModel) card.append(sourceLink(postModel.link, 'Version listed by the post ↗', context));
      if (!item.publishedSetup.settings.length && !item.publishedSetup.recorded.length) card.append(element('p', 'Civitai returned no recorded settings.'));
      if (item.publishedSetup.unlinked.length) card.append(element('p', item.publishedSetup.unlinked.length + ' strengths awaiting a version'));
    }
    previews.append(card);
  }
  section.append(previews);
  if (settings.length) section.append(comparisonTable('Recorded settings', 'Setting', settings));
  if (versions.length) section.append(comparisonTable('Recorded model versions', 'Version', versions.map(({ id, model, values }) => ({
    label: 'Version #' + id + ' · Listing unverified',
    source: model && sourceLink(model.link, model.model + ' · ' + model.version + ' · #' + id + ' ↗', context),
    values: values.map(record => record ? exampleVersionUse(record) : null),
  }))));
  if (limited) section.append(element('p', 'The comparison uses a bounded sample of recorded model entries.'));
  section.append(element('p', 'Settings and strengths come from published metadata. Remix ancestry is unverified.'));
  return section;
}

function renderReleaseComparison(comparison, context, onLookup) {
  const section = element('section', null, 'release-picture-comparison');
  section.setAttribute('aria-label', 'Pictures to compare');
  section.append(element('h5', 'Pictures to compare'), element('p', releasePictureComparisonText(comparison)));
  const previews = element('div', null, 'example-setup-overview');
  for (const { id, preview, link } of comparison.pictures) {
    const card = sourceLink(link, 'Picture #' + id + ' ↗', context);
    const picture = element('img', null, 'example-setup-preview');
    picture.src = preview;
    picture.alt = '';
    picture.loading = 'lazy';
    picture.referrerPolicy = 'no-referrer';
    card.prepend(picture);
    previews.append(card);
  }
  section.append(previews);
  if (onLookup) {
    const button = element('button', 'Compare recorded settings', 'chip');
    button.type = 'button';
    button.addEventListener('click', () => onLookup(comparison.pictures.map(item => item.link).join(' '),
      'report', undefined, 'examplePair'));
    section.append(button);
  }
  return section;
}

function renderStoryPlan(report, context, onLookup) {
  const { stages, reference, profile, setup, runtime, toolSource, relatedGenre, missingReference, topic } = report.story;
  const plan = element('section', null, 'collection-trail story-plan');
  plan.setAttribute('aria-label', 'Story plan');
  plan.append(element('h4', 'Story plan'));
  if (missingReference) plan.append(element('p', 'Civitai could not return your reference picture.'));
  if (relatedGenre) plan.append(element('p', 'Comic suggestions include the ' + relatedGenre + ' genre.'));
  const stack = element('ol', null, 'story-steps');
  for (const { title, items } of stages) {
    const step = element('li', null, 'story-step');
    step.append(element('h5', title));
    if (title === 'Find tools and apps' && runtime) {
      const basis = element('p', toolSource === 'brief' ? runtime + ' was requested in your brief.'
        : runtime + ' is recorded in the reference picture. ');
      if (toolSource === 'metadata' && reference) basis.append(sourceLink(reference, 'View source ↗', context));
      step.append(basis);
    }
    const choices = element('ul', null, 'story-picks');
    for (const item of items) {
      const choice = element('li');
      if (item.link === reference && item.cover) {
        const preview = element('img', null, 'story-reference-preview');
        preview.src = item.cover;
        preview.alt = 'Reference picture';
        preview.loading = 'lazy';
        preview.referrerPolicy = 'no-referrer';
        choice.append(preview);
      }
      choice.append(sourceLink(item.link, item.title + ' ↗', context));
      if (item.link === reference && setup?.settings.length) {
        const brief = setup.settings.filter(setting => ['Size', 'Steps', 'Sampler'].includes(setting.label)).slice(0, 3);
        if (brief.length) choice.append(element('p', brief.map(({ label, value }) => label + ' ' + value).join(' · ')));
        if (onLookup) {
          const inspect = element('button', 'See recorded settings', 'text-button');
          inspect.type = 'button';
          inspect.addEventListener('click', () => onLookup(reference, 'report', undefined, 'trace'));
          choice.append(inspect);
        }
      }
      if (item.link === profile) choice.append(element('p', 'Uploaded the reference picture'));
      if (item.storyBasis) {
        const basis = element('p', item.storyBasis);
        if (item.storyProof) basis.append(' · ', sourceLink(item.storyProof, 'Source picture ↗', context));
        choice.append(basis);
      }
      choices.append(choice);
    }
    step.append(choices);
    stack.append(step);
  }
  if (stages.length) plan.append(stack);
  if (onLookup && topic && !report.rails.some(rail => ['bounties', 'challenges', 'services'].includes(rail.scope))) {
    const follow = element('button', 'Find related opportunities', 'chip');
    follow.type = 'button';
    follow.addEventListener('click', () => onLookup(topic, 'report', undefined, 'opportunities'));
    plan.append(follow);
  }
  return plan;
}

export function renderReport(container, report, context, onLookup, { onCompareSetup, graphicsMemory } = {}) {
  container.replaceChildren();
  container.hidden = !report;
  if (!report) return;
  const header = element('div', null, 'report-heading');
  const copy = element('button', 'Copy report', 'chip');
  copy.type = 'button';
  copy.addEventListener('click', () => showReportExport(reportMarkdown(report, graphicsMemory)));
  header.append(element('h3', 'Search summary'), copy);
  container.append(header);
  const hashNote = hashLookupNote(report.hashStatus);
  if (hashNote) container.append(element('p', hashNote));
  if (report.downloadNote) container.append(element('p', report.downloadNote));
  if (report.releaseLookup) {
    const { choices, query } = report.releaseLookup;
    const panel = element('section', null, 'report-anchor');
    panel.append(element('h4', choices.length ? 'Choose the model release' : 'Choose an exact model release'));
    if (!choices.length) panel.append(element('p', report.constraints.length ? 'Civitai did not confirm a release with these model filters.'
      : 'Enter the full model name or paste a model release link.'));
    for (const choice of choices) {
      const button = element('button', [choice.title, choice.version].filter(Boolean).join(' · '), 'chip');
      button.type = 'button';
      button.addEventListener('click', () => onLookup?.(choice.link, 'report'));
      panel.append(button);
    }
    if (!choices.length) {
      const button = element('button', 'Find a model', 'chip');
      button.type = 'button';
      button.addEventListener('click', () => onLookup?.(query, 'models'));
      panel.append(button);
    }
    container.append(panel);
    return;
  }
  if (report.referenceUnavailable) {
    if (!hashNote) container.append(element('p', 'Civitai did not return readable catalog details for this link. Open the original to learn more.'));
    return;
  }
  if (report.anchor.length && !report.localTrace && !report.upgrade && !report.collectionTrace && !report.releaseSample && !report.exampleSetup) {
    const anchor = element('div', null, 'report-anchor');
    anchor.append(element('p', 'Starting reference'));
    for (const item of report.anchor) {
      anchor.append(evidenceSource(item, context, onLookup));
      const files = referenceFileFacts(item);
      if (files.length) anchor.append(element('p', files.join(' · ')));
    }
    container.append(anchor);
  }
  if (report.constraints.length) {
    container.append(element('p', 'Model filters · ' + report.constraints.map(reportConstraint).join(' · ')));
  }
  if (report.publicWork) {
    const panel = element('section', null, 'report-anchor');
    panel.append(element('p', publicWorkCoverage(report.publicWork)));
    if (report.publicWork.profile) panel.append(sourceLink(report.publicWork.profile.link, 'Open my Civitai profile ↗', context));
    container.append(panel);
  }
  if (report.creator) {
    const { profile, topic, leads, unavailable } = report.creator;
    const panel = element('section', null, 'collection-trail');
    if (profile) {
      panel.append(element('h4', 'Verified creator profile'), sourceLink(profile.link, '@' + profile.title + ' ↗', context),
        element('p', 'Each connection shows what Civitai credits to this account. The report samples the public work you selected.'));
    } else if (unavailable) {
      panel.append(element('h4', 'Creator profile unavailable'), element('p', 'Check the handle or paste the public profile link.'));
    } else {
      panel.append(element('h4', 'Creator leads from public work'));
      if (!leads.length) panel.append(element('p', 'Try a broader topic or type an exact @username.'));
      const list = element('ol', null, 'report-connections');
      for (const lead of leads) {
        const row = element('li', null, 'report-connection');
        const account = '@' + lead.profile.title;
        const action = element('button', 'Explore ' + account, 'chip');
        action.type = 'button';
        action.addEventListener('click', () => onLookup?.(account + ' ' + topic, 'report', undefined, 'creator'));
        row.append(sourceLink(lead.profile.link, account + ' ↗', context));
        if (onLookup) row.append(action);
        const examples = element('ul', null, 'report-connections');
        for (const item of lead.examples) {
          const sample = element('li');
          sample.append(sourceLink(item.link, reportSources[item.scope] + ' · ' + item.title, context));
          examples.append(sample);
        }
        if (lead.examples.length) row.append(examples);
        list.append(row);
      }
      if (leads.length) panel.append(list);
    }
    container.append(panel);
  }
  if (report.exampleSetup) container.append(renderExampleSetup(report.exampleSetup, context, onCompareSetup));
  if (report.exampleComparison) container.append(renderExampleComparison(report.exampleComparison, context));
  if (report.story) container.append(renderStoryPlan(report, context, onLookup));
  if (report.upgrade) container.append(renderUpgrade(report.upgrade, context, graphicsMemory));
  if (report.releaseSample) {
    const release = report.releaseSample;
    const panel = element('section', null, 'collection-trail');
    panel.append(element('h4', 'Release gallery sample'),
      sourceLink(release.link, [release.title, release.version].filter(Boolean).join(' · ') + ' ↗', context));
    const details = releaseSampleCoverage(release);
    if (details) panel.append(element('p', details));
    if (release.comparison) panel.append(renderReleaseComparison(release.comparison, context, onLookup));
    container.append(panel);
  }
  if (report.portfolio) {
    const portfolio = report.portfolio;
    const panel = element('section', null, 'collection-trail');
    panel.append(element('h4', 'Published release evidence'), element('p', portfolioCoverage(portfolio)));
    if (portfolio.releases.length) {
      const stages = element('ol', null, 'report-connections');
      for (const release of portfolio.releases) {
        const item = element('li', null, 'report-connection');
        item.append(sourceLink(release.link, release.title, context),
          element('p', portfolioReleaseFacts(release, portfolio.checkPosts).join(' · ')));
        stages.append(item);
      }
      panel.append(stages);
    }
    container.append(panel);
  }
  if (report.collectionTrace) {
    const trace = report.collectionTrace;
    const panel = element('section', null, 'collection-trail');
    const heading = element('div', null, 'report-heading');
    heading.append(element('h4', 'Collection trail'), sourceLink(trace.link, 'Open ' + trace.title + ' on Civitai ↗', context));
    panel.append(heading, element('p', collectionTraceCoverage(trace)));
    if (trace.members) {
      const stages = element('ol', null, 'collection-stages');
      for (const [count, label] of [[trace.members, 'Media checked'], [trace.posts, 'Published posts linked'], [trace.versions, 'Exact model versions verified']]) {
        const step = element('li');
        step.append(element('strong', String(count)), element('span', label));
        stages.append(step);
      }
      panel.append(stages);
    }
    container.append(panel);
  }
  if (report.guideTrace) {
    const trail = element('div', null, 'report-anchor');
    trail.append(element('h4', 'Guide references'), element('p', guideTraceCoverage(report.guideTrace)));
    container.append(trail);
  }
  if (report.localTrace) {
    if (report.localTrace.edits) container.append(renderModelEdits(report, context));
    const trail = element('div', null, 'report-connections');
    trail.append(element('h4', 'Recorded model references'), element('p', localTraceCoverage(report.localTrace)));
    if (report.localTrace.ambiguous) trail.append(element('p', 'An exact version or file ID can identify the intended listing.'));
    for (const { source, description } of localTraceRows(report)) {
      const row = element('div', null, 'report-connection');
      row.append(sourceLink(source.link, source.title, context));
      if (description) row.append(element('p', description));
      trail.append(row);
    }
    container.append(trail);
  }
  const grid = element('div', null, 'report-source-grid');
  const constraintsShown = report.constraints.length > 0;
  for (const rail of report.rails) {
    const card = element('article', null, 'report-source-card');
    card.append(element('h4', rail.label));
    const status = reportSourceStatus(rail.status);
    card.append(element('p', rail.count ? rail.count + (rail.count === 1 ? ' match' : ' matches') +
      (rail.status === 'ready' ? '' : ' · ' + status) : status));
    if (['models', 'ownedModels'].includes(rail.scope) && constraintsShown) card.classList.add('report-filtered');
    if (rail.picks[0]) card.append(evidenceSource(rail.picks[0], context, onLookup));
    if (rail.nativeLink && (rail.scope === 'models' || rail.status !== 'ready' || !rail.count)) {
      card.append(sourceLink(rail.nativeLink, 'Browse on Civitai ↗', context));
      if (rail.nativeModelExclusions) card.append(element('p', 'Word exclusions apply in RasterRaid.'));
      if (rail.nativeModelUsage) card.append(element('p', 'Creator usage checks apply in RasterRaid.'));
    }
    grid.append(card);
  }
  container.append(grid);
  if (report.connections.length) {
    const linked = element('div', null, 'report-connections');
    linked.append(element('h4', 'Verified connections'));
    const relations = report.connections.map(connection => {
      const row = element('div', null, 'report-connection');
      row.dataset.connection = connection.kind;
      row.append(element('p', connection.label));
      for (const item of connection.items) {
        const source = evidenceSource(item, context, onLookup);
        if (connection.kind === recordedAcrossPosts && item.cover) {
          source.classList.add('report-example-link');
          const thumbnail = element('img');
          thumbnail.alt = '';
          thumbnail.loading = 'lazy';
          thumbnail.referrerPolicy = 'no-referrer';
          thumbnail.src = item.cover;
          thumbnail.addEventListener('error', () => thumbnail.remove(), { once: true });
          source.prepend(thumbnail);
        }
        row.append(source);
      }
      return row;
    });
    if ((report.collectionTrace || report.releaseSample) && relations.length > 3) {
      const more = element('details', null, 'collection-more-connections');
      more.append(element('summary', 'Show ' + (relations.length - 3) + ' more verified links'), ...relations.slice(3));
      linked.append(...relations.slice(0, 3), more);
    } else {
      linked.append(...relations);
    }
    container.append(linked);
  }
}

function addCheckpointAction(container, comparison, updateCheckpoint, search) {
  if (!comparison.checkpoint || !updateCheckpoint) return;
  const button = element('button', (search ? 'Use these results' : 'Use this report') + ' for the next comparison', 'chip');
  button.type = 'button';
  const status = element('p');
  status.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    button.disabled = true;
    const saved = await updateCheckpoint(comparison.checkpoint);
    if (!button.isConnected) return;
    status.textContent = saved ? (search ? 'These results are' : 'This report is') + ' saved for the next comparison.'
      : 'Reopen the saved ' + (search ? 'search' : 'report') + ' to try again.';
    button.disabled = Boolean(saved);
  });
  const actions = element('div', null, 'report-heading');
  actions.append(button, status);
  container.append(actions);
}

export function renderReportChanges(container, comparison, context, updateCheckpoint, onLookup) {
  container.replaceChildren();
  container.hidden = !comparison;
  if (!comparison) return;
  const search = comparison.kind === 'search';
  const kind = search ? 'search' : 'report';
  const heading = element('h3', comparison.status === 'baseline-ready' ? 'Track changes to this search' : 'Changes since saved ' + kind);
  heading.id = 'report-change-title';
  heading.tabIndex = -1;
  container.append(heading);
  if (comparison.status === 'baseline-ready') {
    container.append(element('p', 'Save this result sample to see what changes the next time you open this search.'));
    addCheckpointAction(container, comparison, updateCheckpoint, true);
    return;
  }
  if (comparison.status === 'context-changed') {
    container.append(element('p', 'This ' + kind + ' was saved on ' + new URL(comparison.origin).hostname +
      ' with different access. These results use your current Civitai view.'));
    return;
  }
  const { savedAt, checkedAt, added, older, same } = comparison;
  const header = element('div', null, 'report-heading');
  const copy = element('button', 'Copy comparison', 'chip');
  copy.type = 'button';
  copy.addEventListener('click', () => showReportExport(reportComparisonMarkdown(comparison),
    { title: 'Copy ' + kind + ' comparison', label: 'Comparison in Markdown' }));
  header.append(heading, copy);
  container.append(header);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  container.append(element('p', 'Saved ' + date.format(Date.parse(savedAt)) + ' · Checked ' + date.format(Date.parse(checkedAt))));
  const counts = element('ul', null, 'report-change-counts');
  counts.append(element('li', added.length + ' new in this sample'), element('li', same + (search ? ' still in this sample' : ' still in the report')),
    element('li', older.length + ' earlier sources outside this sample'));
  container.append(counts);
  if (comparison.incomplete) container.append(element('p', 'Some sources could not be checked. Your saved comparison point is kept.'));

  if (added.length) {
    const details = element('details');
    const list = element('ul', null, 'report-change-list');
    for (const item of added) {
      const row = element('li');
      row.append(evidenceSource(item, context, onLookup));
      list.append(row);
    }
    details.append(element('summary', 'New in this sample'), list);
    container.append(details);
  }
  if (older.length) {
    const details = element('details');
    const list = element('ul', null, 'report-change-list');
    for (const item of older) {
      const row = element('li');
      row.append(item.link ? sourceLink(item.link, item.title, context) : element('span', item.title),
        element('small', ' · ' + earlierSourceStatus[item.status]));
      list.append(row);
    }
    details.append(element('summary', 'Check earlier sources'), list);
    container.append(details);
  }
  addCheckpointAction(container, comparison, updateCheckpoint, search);
}

function renderModelEdits(report, context) {
  const panel = element('section', null, 'report-connections');
  const { title, description } = editComparisonText(report.localTrace.edits);
  panel.append(element('h4', title), element('p', description));
  for (const [index, picture] of report.localTrace.edits.entries()) {
    const group = element('div', null, 'model-edit-picture');
    group.append(element('h5', editPictureSummary(picture, index)));
    const integrity = pictureIntegrityText(picture.integrity);
    if (integrity) group.append(element('p', integrity));
    const rows = element('ul', null, 'model-edit-rows');
    for (const row of picture.rows) {
      const item = element('li', null, 'report-connection');
      const source = editReferenceSource(report, row);
      if (source) item.append(sourceLink(source.link, source.title, context));
      item.append(element('span', editReferenceLabel(row)), element('p', row.labels.join(' · ')));
      for (const use of row.recordedUses ?? []) item.append(element('p', use));
      rows.append(item);
    }
    group.append(rows);
    panel.append(group);
  }
  return panel;
}
