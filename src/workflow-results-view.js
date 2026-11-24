import { downloadJson, workflowReportFilename } from './download-json.js';
import { showReportExport } from './report-view.js';
import { element, evidenceSource } from './view.js';
import { isWorkflowId, workflowIdBelongsToViewer } from './workflow-client.mjs';
import { workflowOutputPending } from './workflow-session.mjs';
import { workflowReportFile } from './workflow-report-file.mjs';

const labels = {
  compare_evidence: 'Model comparison', verify_constraints: 'Compatibility check',
  report_brief: 'Research brief', report_source_check: 'Source check', report_fit: 'Options that fit',
  report_alternatives: 'Alternatives', report_picture_check: 'Picture comparison', report_transcript: 'Transcript',
  report_music: 'Music description', report_synthesis: 'Decision and next steps', visual_picture_review: 'Public picture comparison',
  compare_public_previews: 'Public preview review response', public_preview_search_words: 'Written search comparison input',
  visual_catalog_check: 'Catalog evidence', visual_clip_transcript: 'Clip transcript', visual_clip_music: 'Music description',
  scene_transcript: 'Full-clip transcript', scene_catalog_check: 'Linked Civitai records',
  transcript: 'Transcript', sound_transcript: 'Full-clip transcript', describe_sound: 'Music description',
};

const transcriptNotes = {
  clip: 'Whole recording · Times unavailable',
  repetitive: 'Repeated transcript · Check the source recording',
  silent: 'Civitai reported that the clip has no audio track.',
  empty: 'Civitai returned no recognizable words.',
};

const messages = {
  unassigned: 'Waiting for Civitai', queued: 'Queued', pending: 'Queued', processing: 'Analyzing', running: 'Analyzing',
  succeeded: 'Complete', failed: 'Some work could not finish', canceled: 'Canceled', expired: 'Expired',
  refused: 'The workflow was refused', unknown: 'The submission outcome is unknown',
  'not-started': 'Stopped before submission', unconfirmed: 'Unresolved receipt saved',
};

export const workflowStatusLabel = status => Object.hasOwn(messages, status) ? messages[status] : 'Status unavailable';
const units = simulated => simulated ? ' simulated credits' : ' Buzz';
const comparisonBasis = 'The comparison uses still previews for video clips.';
const previewRankNote = 'Free preview rank follows the order shown for the same set of previews in RasterRaid.';
const subjectRankNote = 'On-device subject rank compares the same previews by subject.';

function stepTitle(name, type) {
  if (type === 'composeMedia') return 'Soundtrack extraction';
  if (type === 'audioClassification') return 'Music, singing and speech estimates';
  if (Object.hasOwn(labels, name)) return labels[name];
  const picture = /^model_picture_(\d+)$/u.exec(name);
  if (picture) return 'Example picture ' + picture[1];
  const preview = /^(?:catalog|report|compose|visual|public_preview)_picture_(\d+)$/u.exec(name);
  if (preview) return 'Preview description ' + preview[1];
  const sample = /^(?:visual|scene|report_clip)_(frame|caption|vector|audio)(?:_(\d+))?$/u.exec(name);
  if (sample) return ({ frame: 'Sampled frame', caption: 'Scene description', vector: 'Visual comparison input',
    audio: 'Full-clip sound description' }[sample[1]]) + (sample[2] ? ' ' + sample[2] : '');
  return ({ mediaCaptioning: 'Picture description', transcription: 'Transcript', audioCaptioning: 'Music description' })[type] ?? 'Analysis step';
}

function historyContext(snapshot) {
  if (!snapshot.civitaiHistoryOnly) return '';
  return 'Exact sources and itemized estimates use the saved RasterRaid receipt.' +
    (snapshot.historyIncludesEmbeddings ? ' That receipt also links the visual comparisons to their pictures.' : '');
}

export function workflowReceiptLines(run, simulated = false) {
  const rows = [];
  if (run?.retryQuote) {
    const price = run.retryQuote;
    rows.push('Confirmed retry estimate · ' + price.total + units(simulated));
    if (price.authorFee !== null) rows.push('Retry estimate author fee · ' + price.authorFee + units(simulated));
  }
  if (run?.refusalPrice) {
    rows.push('Civitai declined price · ' + run.refusalPrice.total + units(simulated));
    rows.push('This refusal incurred ' + (simulated ? '0 simulated credits.' : '0 Buzz.'));
  }
  if (['unknown', 'unconfirmed'].includes(run?.status)) rows.push('Charge status is unconfirmed.');
  if (run?.receipt) {
    const cost = run.receipt;
    const label = simulated ? 'Simulated work cost' : cost.authorFee === null ? 'Civitai reported generation cost' : 'Civitai reported total';
    rows.push(label + ' · ' + cost.total + units(simulated));
    if (cost.authorFee !== null) rows.push('Reported author fee · ' + cost.authorFee + units(simulated));
    if (!simulated && cost.status) rows.push('Cost reported while status was ' + workflowStatusLabel(cost.status).toLowerCase() + '.');
  } else if (Number.isSafeInteger(run?.cost)) {
    rows.push('Civitai listed cost · ' + run.cost + units(simulated));
  }
  return rows;
}

export function workflowResultElements(run, snapshot, { context, simulated, onLookup, outputsAccessible = true }) {
  const children = workflowReceiptLines(run, simulated).map(row => element('p', row));
  if (!outputsAccessible || snapshot?.restricted) {
    children.push(element('p', 'The run’s notes and sources require its original browsing access.'));
    return children;
  }
  if (!snapshot) return children;
  const contextNote = historyContext(snapshot);
  if (contextNote) children.push(element('p', contextNote));
  for (const step of snapshot.steps) {
    const group = element('section', null, 'workflow-step');
    group.append(element('h3', stepTitle(step.name, step.$type)), element('p', workflowStatusLabel(step.status), 'workflow-step-status'));
    const source = run.sources.find(item => item.link === step.sourceLink);
    if (source) {
      const row = element('p');
      row.append(evidenceSource(source, context, onLookup));
      if (step.purpose) row.append(' · ' + step.purpose);
      if (Number.isFinite(step.seconds)) row.append(' · Frame near ' + step.seconds + ' s');
      group.append(row);
    }
    if (Object.hasOwn(transcriptNotes, step.transcriptScope)) group.append(element('p', transcriptNotes[step.transcriptScope]));
    for (const line of step.lines) group.append(element('p', line));
    children.push(group);
  }
  for (const line of snapshot.text ?? []) children.push(element('p', line, 'workflow-step'));
  if (snapshot.withheld) children.push(element('p', snapshot.withheld, 'workflow-step'));
  if (workflowOutputPending(run, snapshot)) children.push(element('p', 'Waiting for or missing some results from Civitai.', 'workflow-step'));
  const similarity = snapshot.similarity;
  if (similarity) {
    const section = element('section', null, 'workflow-step');
    section.append(element('h3', 'Visual similarity estimates'),
      element('p', similarity.ranked.length + ' of ' + similarity.targetCount + ' comparisons available' +
        (similarity.modelRevision ? ' · ' + similarity.model + ' ' + similarity.modelRevision : '')));
    if (similarity.previewBasis === 'posters') section.append(element('p', comparisonBasis));
    if (similarity.ranked.some(match => match.previewRank)) section.append(element('p', previewRankNote));
    if (similarity.ranked.some(match => match.subjectRank)) section.append(element('p', subjectRankNote));
    const list = element('ol');
    for (const match of similarity.ranked) {
      const row = element('li');
      row.append(evidenceSource(match, context, onLookup), ' · ' + match.score.toFixed(2));
      if (match.previewRank) row.append(' · Free preview rank ' + match.previewRank);
      if (match.subjectRank) row.append(' · On-device subject rank ' + match.subjectRank);
      list.append(row);
    }
    if (similarity.ranked.length) section.append(list);
    children.push(section);
  }
  if (run.sources.length) {
    const sources = element('details', null, 'workflow-sources');
    sources.append(element('summary', 'Sources in this run'));
    const list = element('ul');
    for (const source of run.sources) {
      const row = element('li');
      row.append(evidenceSource(source, context, onLookup));
      list.append(row);
    }
    sources.append(list);
    children.push(sources);
  }
  return children;
}

export function workflowReportMarkdown(records, { simulated = false } = {}) {
  const plain = value => String(value).replace(/[\\[\]<>*`]/gu, '\\$&');
  const result = [simulated ? '# Simulated Deep Search' : '# Deep Search', ''];
  for (const { run, snapshot, restricted } of records) {
    if (!run) continue;
    const hide = restricted || snapshot?.restricted;
    result.push('## ' + plain(hide ? 'Deep Search run' : run.title), '', 'Status · ' + workflowStatusLabel(run.status));
    if (run.workflowId) result.push('Workflow ID · ' + plain(run.workflowId));
    if (run.operationId) result.push('Operation ID · ' + plain(run.operationId));
    if (Number.isFinite(run.createdAt) && Number.isFinite(new Date(run.createdAt).getTime())) {
      result.push('Started · ' + new Date(run.createdAt).toISOString());
    }
    if (run.quote) {
      result.push('Quoted total · ' + run.quote.total + units(simulated));
      if (run.quote.authorFee !== null) result.push('Quoted author fee · ' + run.quote.authorFee + units(simulated));
    }
    result.push(...workflowReceiptLines(run, simulated));
    if (hide || !snapshot) {
      result.push('');
      continue;
    }
    const contextNote = historyContext(snapshot);
    if (contextNote) result.push('', contextNote);
    for (const step of snapshot.steps) {
      result.push('', '### ' + stepTitle(step.name, step.$type), workflowStatusLabel(step.status));
      const source = run.sources.find(item => item.link === step.sourceLink);
      if (source) result.push('[' + plain(source.title) + '](<' + source.link + '>)' +
        (step.purpose ? ' · ' + plain(step.purpose) : '') +
        (Number.isFinite(step.seconds) ? ' · Frame near ' + step.seconds + ' s' : ''));
      if (Object.hasOwn(transcriptNotes, step.transcriptScope)) result.push(plain(transcriptNotes[step.transcriptScope]));
      for (const note of step.lines) result.push(...note.split(/\r?\n/u).map(line => '> ' + plain(line)));
    }
    for (const note of snapshot.text ?? []) result.push(...note.split(/\r?\n/u).map(line => '> ' + plain(line)));
    if (snapshot.withheld) result.push('', '> ' + plain(snapshot.withheld));
    if (workflowOutputPending(run, snapshot)) result.push('', 'Some results were unavailable when this report was copied.');
    if (snapshot.similarity?.ranked.length) {
      const { ranked, previewBasis } = snapshot.similarity;
      result.push('', '### Visual similarity estimates');
      if (previewBasis === 'posters') result.push(comparisonBasis);
      if (ranked.some(match => match.previewRank)) result.push(previewRankNote);
      if (ranked.some(match => match.subjectRank)) result.push(subjectRankNote);
      result.push(...ranked.map(match => '- [' + plain(match.title) + '](<' + match.link + '>) · ' + match.score.toFixed(2) +
        (match.previewRank ? ' · Free preview rank ' + match.previewRank : '') +
        (match.subjectRank ? ' · On-device subject rank ' + match.subjectRank : '')));
    }
    if (run.sources.length) result.push('', '### Civitai sources',
      ...run.sources.map(source => '- [' + plain(source.title) + '](<' + source.link + '>)'));
    result.push('');
  }
  return result.join('\n').replace(/\r\n?/gu, '\n');
}

export function copyWorkflowReport(records, options = {}) {
  const { context, receipt, partial, simulated = false } = options;
  const title = receipt ? 'Copy Deep Search receipt' : partial ? 'Copy available results' : undefined;
  const markdown = workflowReportMarkdown(records, options);
  const workflowId = records.at(-1)?.run?.workflowId;
  const canSave = !receipt && context && (simulated ? isWorkflowId(workflowId) : workflowIdBelongsToViewer(workflowId, context.viewerUserId));
  const capturedAt = Date.now();
  const dialog = showReportExport(markdown, { title, action: canSave ? {
    label: 'Save report file',
    async run(signal) {
      const json = await workflowReportFile(context, workflowId, markdown, { simulated, capturedAt });
      if (!dialog.open) return;
      await downloadJson(window, context, workflowReportFilename, json, signal);
      return 'Download started.';
    },
  } : undefined });
  return dialog;
}
