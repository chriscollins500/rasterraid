import { element, sourceLink } from './view.js';
import { workflowAssetLabel, workflowInspectionLabel } from './workflow-profile.mjs';

const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const shortTitle = model => [model.model, model.version].filter(Boolean).join(' · ') || 'Version ' + model.id;
const size = kb => Number.isFinite(kb) && kb > 0 ? numbers.format(kb / 1024) + ' MiB on disk' : '';
const fileFacts = file => [file.name, 'File #' + file.id, file.format, file.precision, file.fileVariant, size(file.sizeKB)].filter(Boolean);
const modelFacts = model => [model.base, model.type, model.checkpointRole, model.publishedAt?.slice(0, 10)].filter(Boolean);

export function workflowFileStatus(check) {
  if (!check) return 'Civitai check unavailable';
  if (check.sharedHash) return 'SHA-256 matches several versions';
  if (check.matching.length > 1) return 'Multiple published matches';
  if (!check.current) return check.exactVersion ? 'Version confirmed · File unresolved'
    : check.partial ? 'Catalog check incomplete' : 'No published match found';
  if (check.fitIssue) return 'Review setup fit';
  if (check.newer) return 'Newer matching release';
  if (check.partial) return 'File found · Some releases unchecked';
  return check.identity === 'hash' ? 'SHA-256 matched' : check.identity === 'air' ? 'File ID matched'
    : check.identity === 'version' ? 'Version and filename matched' : 'Published filename found';
}

function identityDescription(check) {
  if (!check.current) return '';
  const differs = check.file && check.matching[0].file.name.normalize('NFKC').toLowerCase() !== check.file.normalize('NFKC').toLowerCase();
  const note = differs ? ' The workflow uses a different filename.' : '';
  if (check.identity === 'hash') return 'The entered SHA-256 matches this published file.' + note;
  if (check.identity === 'air') return 'The AIR address identifies this model, release, and file.' + note;
  if (check.identity === 'version') return 'The recorded version contains this filename. A SHA-256 can verify the file contents.';
  return 'The workflow filename matches the catalog. A SHA-256 can verify the file contents.';
}

function addVersion(parent, label, match, evidence, context) {
  const { model, file } = match;
  const title = element('h4', label);
  const source = element('p');
  source.append(sourceLink(model.link, shortTitle(model), context));
  const availability = [
    evidence.availability,
    evidence.generationListed === true ? 'On-site generation listed'
      : evidence.generationListed === false ? 'On-site generation listed as unavailable' : '',
  ].filter(Boolean).join(' · ');
  parent.append(title, source, element('p', modelFacts(model).join(' · ')), element('p', fileFacts(file).join(' · ')));
  if (availability) parent.append(element('p', availability));
  if (evidence.usage.length) parent.append(element('p', 'Creator’s listed usage options · ' + evidence.usage.join(' · ')));
  if (model.releaseNotes) {
    const notes = element('details');
    notes.append(element('summary', 'Creator’s release notes'), element('p', model.releaseNotes));
    parent.append(notes);
  }
}

export function renderWorkflowFile(row, context, { expanded = false, onUpgrade } = {}) {
  const panel = element('details', null, 'setup-evidence workflow-file-evidence');
  panel.open = expanded;
  const summary = element('summary');
  summary.append(element('span', workflowAssetLabel(row.asset)), element('span', workflowFileStatus(row.check), 'workflow-file-status'));
  panel.append(summary);
  const facts = element('div', null, 'workflow-file-facts');
  facts.append(element('p', row.asset.kind));
  const { check } = row;
  if (check?.current) {
    facts.append(element('p', identityDescription(check)));
    if (check.fitIssue) facts.append(element('p', check.fitIssue));
    addVersion(facts, 'Published match', check.matching[0], check.current, context);
    if (check.newer) {
      addVersion(facts, 'Newer release with matching catalog details', { model: check.newer, file: check.newerFile }, check.update, context);
      if (onUpgrade) {
        const compare = element('button', 'Review upgrade', 'chip');
        compare.type = 'button';
        compare.addEventListener('click', () => onUpgrade(check));
        facts.append(compare);
      }
    }
    else if (check.releasesChecked) facts.append(element('p', 'No newer release with these catalog details was found.'));
    if (check.otherReleases.length) {
      facts.append(element('h4', 'Other newer releases'));
      const choices = element('ul');
      for (const { model, reason } of check.otherReleases) {
        const item = element('li');
        item.append(sourceLink(model.link, shortTitle(model), context), ' · ' + reason);
        choices.append(item);
      }
      facts.append(choices);
    }
    if (check.listedReleases) facts.append(element('p', check.verifiedReleases + ' releases verified out of ' + check.listedReleases + ' listed.'));
  } else if (check?.exactVersion && !check.matching.length) {
    const model = check.exactVersion;
    const catalog = element('p');
    catalog.append(sourceLink(model.link, shortTitle(model), context));
    facts.append(element('h4', 'Recorded version'), catalog, element('p', modelFacts(model).join(' · ')),
      element('p', 'Enter a file reference to check a specific download.'));
  } else if (check?.matching.length || check?.alternatives.length) {
    const exact = check.matching.length > 0;
    facts.append(element('h4', exact ? 'Matching listings' : 'Similar catalog names'));
    const choices = element('ul');
    const rows = exact ? check.matching : check.alternatives.map(model => ({ model }));
    for (const { model, file } of rows.slice(0, 6)) {
      const item = element('li');
      item.append(sourceLink(model.link, [shortTitle(model), model.base].filter(Boolean).join(' · '), context));
      if (file) item.append(' · ' + fileFacts(file).join(' · '));
      choices.append(item);
    }
    facts.append(choices);
  }
  if (check?.sharedHash) facts.append(element('p', 'Enter a file-pinned Civitai AIR to identify the intended listing.'));
  if (check?.partial) facts.append(element('p', 'Some catalog information was unavailable.'));
  panel.append(facts);
  return panel;
}

const line = value => String(value ?? '').replace(/[\r\n]+/gu, ' ').replace(/[\\[\]`<>*_]/gu, '\\$&');
const source = model => '[' + line(shortTitle(model)) + '](<' + model.link + '>)';

export function workflowAuditMarkdown(rows, profile, checkedAt, trace) {
  const lines = ['# Civitai workflow file check', '', 'Checked ' + checkedAt,
    [profile.runtime === 'comfyui' ? 'Local ComfyUI' : 'Civitai', profile.baseModel, profile.vram && profile.vram + ' GB VRAM'].filter(Boolean).join(' · '),
    rows.length + ' of ' + profile.assets.length + ' model files and references checked.',
    'Catalog file sizes describe storage. Loader behavior and runtime memory require a local test.'];
  if (trace?.source) {
    const workflow = trace.source;
    lines.push('', '## Published workflow source',
      '[' + line(workflow.modelName || 'Civitai workflow') + '](<' + workflow.link + '>) · Version #' + workflow.versionId,
      'File #' + workflow.fileId + ' · ' + line(workflow.fileName),
      'Graph · ' + line(workflow.graph) + ' · ' + line(workflow.format));
    if (workflow.truncated) lines.push('Civitai omitted some entries from this archive.');
  }
  if (trace) lines.push(workflowInspectionLabel(trace));
  for (const { asset, check } of rows) {
    lines.push('', '## ' + line(workflowAssetLabel(asset)), line(asset.kind) + ' · ' + workflowFileStatus(check));
    if (!check) continue;
    for (const { model, file } of check.matching.slice(0, 6)) lines.push('- Published match · ' + source(model) +
      ' · ' + [...modelFacts(model), ...fileFacts(file)].map(line).join(' · '));
    if (check.current) {
      lines.push(identityDescription(check));
      if (check.fitIssue) lines.push(check.fitIssue);
      if (check.current.usage.length) lines.push('- Creator’s listed usage options · ' + check.current.usage.map(line).join(' · '));
    }
    if (check.exactVersion && !check.matching.length) lines.push('- Recorded version · ' + source(check.exactVersion));
    if (check.sharedHash) lines.push('Enter a file-pinned Civitai AIR to identify the intended listing.');
    if (check.newer) {
      lines.push('- Newer release · ' + source(check.newer) + ' · ' + [...modelFacts(check.newer), ...fileFacts(check.newerFile)].map(line).join(' · '));
      if (check.newer.releaseNotes) lines.push('- Creator’s release notes · ' + line(check.newer.releaseNotes));
    }
    for (const { model, reason } of check.otherReleases) lines.push('- Other release · ' + source(model) + ' · ' + line(reason));
    if (check.partial) lines.push('Some catalog information was unavailable.');
  }
  return lines.join('\n') + '\n';
}
