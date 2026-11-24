import { civitaiAir } from './catalog.mjs';
import { exampleModelFacts } from './gallery-setup.mjs';
import { publishedName, releaseSetupIssue } from './release-compatibility.mjs';
import { environmentProfile } from './workflow-profile.mjs';

const identities = {
  exact: 'Exact version referenced in your setup',
  filename: 'Filename matches the listing · Check the file identity',
  other: 'Another version of this model is referenced',
  absent: 'Check this version in your setup',
  empty: 'Add a workflow to compare versions',
  unavailable: 'Civitai listing needs verification',
};

export function compareWorkspaceExample(example, profile) {
  const { baseModel, assets } = environmentProfile(profile);
  const references = assets.map(asset => ({ ...asset, pin: civitaiAir(asset.air) }));
  const family = publishedName(baseModel);
  const rows = example.recorded.map(row => {
    const { model, versionId } = row;
    const published = publishedName(model?.family);
    const related = model ? references.filter(asset => asset.pin?.modelId === model.modelId) : [];
    const exact = related.filter(asset => asset.pin.id === versionId);
    const otherVersions = [...new Set(related.filter(asset => asset.pin.id !== versionId).map(asset => asset.pin.id))];
    const filenames = new Set((model?.files ?? []).map(publishedName).filter(Boolean));
    const filename = references.some(asset => !asset.pin && filenames.has(publishedName(asset.file)));
    const identity = !model ? 'unavailable' : exact.length ? 'exact' : filename ? 'filename'
      : otherVersions.length ? 'other' : assets.length ? 'absent' : 'empty';
    const fit = !family ? 'Add your model family to check fit'
      : !published || published === 'other' ? 'Catalog model family needs verification'
        : published === family ? 'Matches your declared family' : 'Differs from your declared family';
    const pins = [...new Set(exact.map(asset => asset.pin.fileId).filter(Boolean))];
    const issue = published && published !== 'other' && model.type
      ? exact.map(asset => releaseSetupIssue({ base: model.family, type: model.type }, asset.kind, '')).find(Boolean) : null;
    return {
      versionId, title: model?.title || 'Version #' + versionId, link: model?.link,
      identity, fit, facts: [
        identities[identity], ...exampleModelFacts(row),
        ...(pins.length ? ['Your workflow pins ' + pins.map(id => 'file #' + id).join(', ')] : []),
        ...(otherVersions.length ? ['Your setup references ' + otherVersions.slice(0, 4).map(id => 'version #' + id).join(', ')] : []),
        ...(issue ? [issue] : []),
      ],
    };
  });
  const matches = rows.filter(row => row.identity === 'exact').length;
  const filenames = rows.filter(row => row.identity === 'filename').length;
  const summary = assets.length ? [matches + (matches === 1 ? ' exact version' : ' exact versions'),
    filenames && filenames + (filenames === 1 ? ' filename to verify' : ' filenames to verify')].filter(Boolean).join(' · ')
    : 'Choose Read workflow JSON above to check its model references.';
  return { source: example.link, kind: example.video ? 'clip' : 'picture', baseModel, rows, summary,
    unlinked: example.unlinked.length, limited: example.limited };
}

export function workspaceExampleNotes(comparison) {
  return [
    comparison.unlinked && (comparison.unlinked === 1 ? 'One recorded strength needs an exact version.' :
      comparison.unlinked + ' recorded strengths need exact versions.'),
    comparison.limited && 'The comparison uses the published version sample shown in the report.',
    'The comparison runs on this device.',
    'A run with your own files and tools can verify the result.',
  ].filter(Boolean);
}

export function workspaceExampleMarkdown(comparison) {
  const safe = value => value.replace(/[\r\n]+/gu, ' ').replace(/[\\[\]<>*`]/gu, '\\$&');
  return ['# Compare with my setup', '', '[Source ' + comparison.kind + '](<' + comparison.source + '>)',
    ...(comparison.baseModel ? ['Declared model family · ' + safe(comparison.baseModel)] : []), comparison.summary, '',
    ...comparison.rows.flatMap(row => [
      '## ' + (row.link ? '[' + safe(row.title) + '](<' + row.link + '>)' : safe(row.title)),
      ...[row.fit, ...row.facts].map(fact => '- ' + safe(fact)), '',
    ]), ...workspaceExampleNotes(comparison)].join('\n') + '\n';
}
