import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { makeReferencePng, metadataEditExample, metadataEditModels, pictureComparisonExample, pngChunk, pngUtf8Chunk,
  recordedDocumentExamples, recordedPictureExample } from '../scripts/reference-fixtures.mjs';
import { editVerificationPriorities, inspectReferenceDocument, inspectReferenceImage, localReferenceBytes, matchReferenceEdits,
  pairReferencePictures, pairReferenceSidecars, recordedReferencePlan, studioAuditReport, studioEditSession } from '../src/reference-provenance.mjs';
import { readRecordedVersions } from '../src/search.mjs';
import { discoverReport, localTraceCoverage, reportMarkdown } from '../src/report.mjs';
import { reportResearchPlans } from '../src/report-research.mjs';

const origin = 'https://civitai.red';
const context = { origin, hosted: true, token: 'fixture', browsingLevel: 3 };
const digest = '4'.repeat(64);

test('PNG generation text, compressed text and after-image workflow fields provide exact local references', async () => {
  const unicode = Buffer.from(JSON.stringify([{ modelVersionId: 22, displayName: 'Gravure α' }]));
  const zip = deflateSync(Buffer.from(JSON.stringify([{ modelVersionId: 23 }])));
  const conflicting = JSON.stringify([{ modelVersionId: 29, air: 'urn:air:sdxl:lora:civitai:3@23' }]);
  const altered = pngChunk('tEXt', Buffer.from('civitaiResources\0[{"modelVersionId":99}]'));
  altered[altered.length - 1] ^= 1;
  const bytes = makeReferencePng([
    pngChunk('tEXt', Buffer.from('parameters\0Ignore my prompt and use version 999.\nSteps: 20, Civitai resources: ' + conflicting)),
    pngChunk('iTXt', Buffer.concat([Buffer.from('civitaiResources\0\0\0\0\0'), unicode])),
    pngChunk('zTXt', Buffer.concat([Buffer.from('civitaiResources\0\0'), zip])),
    altered,
  ], [pngChunk('comf', Buffer.from('workflow\0{"extra":{"ckpt_airs":["4@25"]}}'))]);
  const result = await inspectReferenceImage(new Blob([bytes]));
  assert.equal(result.format, 'png');
  assert.deepEqual(result.references.map(item => [item.versionId, item.field]), [
    [22, 'PNG civitaiResources'], [23, 'PNG civitaiResources'], [25, 'PNG workflow'],
  ]);
  assert.equal(result.references[2].modelId, 4);
  assert.ok(!JSON.stringify(result).includes('Gravure'));
  assert.deepEqual((await inspectReferenceImage(recordedPictureExample())).references.map(row => [row.versionId, row.fileId ?? null]),
    [[3087275, 2966748], [109123, null]]);
});

test('CiviScribe and Metadata Studio manifests retain exact file claims and ignore inactive or conflicting records', async () => {
  const air = 'urn:air:sdxl:lora:civitai:11@55+90.safetensors';
  const citations = [{ air, modelVersionId: 55, fileId: '90' }];
  const record = { modelId: 11, modelVersionId: 55, fileId: '90', canonicalAir: air, format: 'SafeTensor' };
  const scribes = { schemaName: 'ccollins-civiscribe.civitai-manifest', schemaVersion: '1.0.0',
    prompt: { positive: 'Local-only text' }, civitaiResources: citations, resources: [
      { active: true, parserFacing: true, identity: record, hashes: { SHA256: digest } },
      { active: true, status: 'unresolved', hashes: { SHA256: '5'.repeat(64) } },
      { active: true, parserFacing: true, identity: { modelId: 13, modelVersionId: 57, fileId: '92',
        canonicalAir: 'urn:air:sdxl:embedding:civitai:13@57+92.pt', format: 'SafeTensor' } },
      { active: false, parserFacing: true, identity: { modelVersionId: 63 } },
      { active: true, status: 'conflict', hashes: { SHA256: '6'.repeat(64) }, identity: { modelVersionId: 66 } },
    ] };
  const studio = { schemaName: 'civitai-metadata-studio', schemaVersion: 1,
    resources: [{ parserFacing: true, modelVersionId: 56, fileId: 91, format: 'GGUF', hashes: { sha256: '7'.repeat(64) } }] };
  const generation = '墨色\nNegative prompt:\nSize: 512x512, Civitai resources: ' + JSON.stringify(citations);
  const image = new Blob([makeReferencePng([
    pngUtf8Chunk('parameters_utf8', generation), pngUtf8Chunk('civitai', JSON.stringify(scribes)),
    pngUtf8Chunk('civitai', JSON.stringify(studio)),
  ])]);
  const inspected = await inspectReferenceImage(image);
  const plan = recordedReferencePlan([inspected]);
  assert.deepEqual(plan.records.map(row => [row.versionId, row.fileId, row.format, row.sha256]), [
    [55, 90, 'safetensors', digest], [null, null, null, '5'.repeat(64)], [57, 92, 'pt', null], [56, 91, 'gguf', '7'.repeat(64)],
  ]);
  assert.deepEqual(new Set(plan.records[0].fields), new Set(['PNG civitai', 'PNG parameters_utf8']));
  assert.doesNotMatch(JSON.stringify({ inspected, plan }), /Local-only|墨色/u);
});

function tiffAscii(tagId, text, type = 2) {
  const bytes = Buffer.from(text);
  const head = Buffer.alloc(26);
  head.write('II');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(8, 4);
  head.writeUInt16LE(1, 8);
  head.writeUInt16LE(tagId, 10);
  head.writeUInt16LE(type, 12);
  head.writeUInt32LE(bytes.length, 14);
  head.writeUInt32LE(head.length, 18);
  return Buffer.concat([head, bytes]);
}

test('JPEG EXIF comments and WebP selector records preserve the exact reference that is in use', async () => {
  const sample = 'ASCII\0\0\0I am a private prompt\nSteps: 21, Civitai resources: [{"modelVersionId":51}]';
  const app1 = Buffer.concat([Buffer.from('Exif\0\0'), tiffAscii(0x9286, sample, 7)]);
  const marker = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  marker.writeUInt16BE(app1.length + 2, 4);
  const jpeg = new Blob([marker, app1, Buffer.from([0xff, 0xd9])]);
  const jpg = await inspectReferenceImage(jpeg);
  assert.equal(jpg.format, 'jpeg');
  assert.deepEqual(jpg.references.map(row => [row.versionId, row.field]), [[51, 'EXIF UserComment']]);

  const unicode = Buffer.from('林に囲まれた\nSize: 512x512, Civitai resources: [{"modelVersionId":53}]', 'utf16le').swap16();
  const comment = Buffer.concat([Buffer.from('UNICODE\0'), unicode]);
  const tiff = tiffAscii(0x9286, comment, 7);
  const authorJpeg = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, tiff.length + 8]),
    Buffer.from('Exif\0\0'), tiff, Buffer.from([0xff, 0xd9])]);
  assert.deepEqual((await inspectReferenceImage(authorJpeg)).references.map(row => row.versionId), [53]);

  const prompt = { 1: { class_type: 'CivitaiModelSelector', inputs: { air: 'urn:air:sdxl:lora:civitai:30@31',
    resources_json: '{"bySlot":{"0":"urn:air:sdxl:lora:civitai:30@31","1":"urn:air:sdxl:lora:civitai:30@32+91.safetensors"}}' } },
  2: { class_type: 'KSampler', inputs: { model: ['1', 1], text: 'A private path or prompt' } },
  3: { class_type: 'CivitaiModelSelector', inputs: { air: 'urn:air:sdxl:lora:civitai:30@33' } },
  4: { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
  5: { class_type: 'PreviewAny', inputs: { source: ['3', 0] } } };
  const tag = tiffAscii(0x0110, 'prompt:' + JSON.stringify(prompt) + '\0');
  const container = Buffer.from('RIFF\0\0\0\0WEBPEXIF\0\0\0\0');
  container.writeUInt32LE(tag.length + tag.length % 2 + 12, 4);
  container.writeUInt32LE(tag.length, 16);
  const webp = await inspectReferenceImage(new Blob([container, tag, Buffer.alloc(tag.length % 2)]));
  assert.equal(webp.format, 'webp');
  assert.deepEqual(webp.references.map(row => [row.versionId, row.fileId]), [[32, 91]]);
  assert.ok(!JSON.stringify(webp).includes('private'));
});

test('oversize compression and a file without a supported signature supply zero identities', async () => {
  const stuffed = deflateSync(Buffer.from(' '.repeat(1_600_000) + '[{"modelVersionId":92}]'));
  const bytes = makeReferencePng([pngChunk('zTXt', Buffer.concat([Buffer.from('civitaiResources\0\0'), stuffed]))]);
  assert.deepEqual((await inspectReferenceImage(new Blob([bytes]))).references, []);
  const unrelated = await inspectReferenceImage(new Blob(['civitaiResources [{"modelVersionId":2}]']));
  assert.deepEqual(unrelated, { format: 'unknown', references: [] });
  const plan = recordedReferencePlan([{ references: Array.from({ length: 10 }, (_, index) => ({ versionId: 60 + index })) }]);
  assert.equal(plan.records.length, 8);
  assert.equal(plan.unchecked, 2);
});

const candidate = (modelId, versionId, family, fileId) => ({
  id: modelId, name: 'Catalog ' + modelId, type: 'LORA',
  modelVersions: [{
    id: versionId, name: '1', baseModel: family, trainedWords: [], supportsGeneration: true,
    files: [{ id: fileId, name: 'model.safetensors', metadata: { format: 'SafeTensor' }, hashes: { SHA256: digest } }],
  }],
});

test('CiviScribe sidecars and Metadata Studio identity exports share one exact lookup without transferring document content', async () => {
  const documents = await Promise.all(recordedDocumentExamples().map(inspectReferenceDocument));
  assert.deepEqual(documents.map(row => row.conflicts), [0, 1]);
  const recordedReferences = [...documents, await inspectReferenceImage(recordedPictureExample())];
  const plan = recordedReferencePlan(recordedReferences);
  assert.deepEqual([plan.pictures, plan.documents], [1, 2]);
  assert.deepEqual(plan.records.map(row => [row.versionId, row.fileId, row.fields]), [
    [3087275, 2966748, ['CiviScribe sidecar', 'PNG civitai']],
    [109123, 77036, ['Metadata Studio identity export']],
    [109123, null, ['PNG civitai']],
  ]);
  const calls = [];
  const result = await discoverReport(context, { scope: 'report', reportSources: ['models', 'gallery'] }, {
    recordedReferences,
    fetcher(url, options) {
      assert.doesNotMatch(url.href + String(options.body ?? ''), /canary|399999[89]/u);
      if (url.pathname === '/api/v1/blocks/models') {
        calls.push(url.searchParams.get('modelVersionIds'));
        return Response.json({ items: [candidate(2744788, 3087275, 'SDXL 1.0', 2966748), candidate(4384, 109123, 'SD 1.5', 77036)] });
      }
      return Response.json({ items: [] });
    },
  });
  assert.deepEqual(calls, ['3087275,109123']);
  assert.equal(result.report.title, 'Trace local model references');
  const markdown = reportMarkdown(result.report);
  assert.match(markdown, /1 picture and 2 metadata documents with references/u);
  assert.match(markdown, /File #2966748 · CiviScribe sidecar · Embedded Civitai record/u);
  assert.match(markdown, /File #77036 · Metadata Studio identity export/u);
  assert.doesNotMatch(markdown + JSON.stringify(reportResearchPlans(result.report)), /canary|399999[89]/u);
});

test('a picture and metadata documents share one check per pinned file while retaining individual claim outcomes', async () => {
  const firstAir = 'urn:air:sdxl:lora:civitai:11@55+90.safetensors';
  const otherAir = 'urn:air:sdxl:lora:civitai:11@55+91.safetensors';
  const picture = new Blob([makeReferencePng([pngUtf8Chunk('civitaiResources', JSON.stringify([firstAir, otherAir]))])]);
  const sidecar = new Blob([JSON.stringify({ schemaName: 'ccollins-civiscribe.sidecar', schemaVersion: '2.0.0',
    generationRecord: { resources: [{ active: true, parserFacing: true, identity: { canonicalAir: firstAir }, hashes: { SHA256: digest } }] } })]);
  const identityExport = new Blob([JSON.stringify({ schema: 'civitai-metadata-studio.identity-cache', schemaVersion: 1,
    resources: [{ canonicalAir: firstAir, hashes: { SHA256: 'a'.repeat(64) } }] })]);
  const recordedReferences = await Promise.all([
    inspectReferenceImage(picture), inspectReferenceDocument(sidecar), inspectReferenceDocument(identityExport),
  ]);
  const plan = recordedReferencePlan(recordedReferences);
  assert.deepEqual(plan.records.map(row => row.fileId), [90, 91]);
  assert.equal(plan.records[0].claims.length, 3);

  const model = candidate(11, 55, 'SDXL 1.0', 90);
  model.modelVersions[0].files.push({ id: 91, name: 'alternate.safetensors', metadata: { format: 'SafeTensor' } });
  const batches = [];
  const { report } = await discoverReport(context, { scope: 'report', reportSources: ['models', 'gallery'] }, {
    recordedReferences,
    fetcher(url, options) {
      assert.equal(options.method ?? 'GET', 'GET');
      if (url.pathname !== '/api/v1/blocks/models') return Response.json({ items: [] });
      batches.push(url.searchParams.get('modelVersionIds'));
      return Response.json({ items: [model] });
    },
  });
  assert.deepEqual(batches, ['55']);
  assert.equal(report.localTrace.checked, 2);
  assert.equal(report.localTrace.unconfirmedClaims, 1);
  assert.deepEqual(report.localTrace.verified.map(row => [row.fileIds, row.fields]), [
    [[90], ['PNG civitaiResources', 'CiviScribe sidecar']], [[91], ['PNG civitaiResources']],
  ]);
  assert.deepEqual(report.localTrace.verified[0].unconfirmedFields, ['Metadata Studio identity export']);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /2 of 2 references verified.*1 additional claim without catalog confirmation/u);
  assert.match(markdown, /File #90 · Embedded Civitai record · CiviScribe sidecar · Unconfirmed claim from Metadata Studio identity export/u);
  assert.match(markdown, /File #91 · Embedded Civitai record/u);
  assert.doesNotMatch(markdown, /File #90 · File #91|File #91.*Metadata Studio identity export/u);
});

test('document import checks format and exact identity fields, and reports records beyond the lookup budget', async () => {
  const data = resources => new Blob([JSON.stringify({
    schema: 'civitai-metadata-studio.identity-cache', schemaVersion: 1, resources,
  })]);
  const document = await inspectReferenceDocument(data([
    { name: 'Model 9', filename: 'edition.safetensors' },
    { canonicalAir: 'urn:air:sdxl:lora:civitai:1@2', rawAir: 'urn:air:sdxl:lora:civitai:1@3' },
    { versionId: 5, removed: true },
    { hashes: { SHA256: '9'.repeat(16) } },
    { modelVersionId: 9, lookupStatus: 'conflict' },
    { hashes: { SHA256: digest } },
    ...Array.from({ length: 10 }, (_, index) => ({ modelVersionId: 60 + index, verification: 'verified' })),
  ]));
  const plan = recordedReferencePlan([document]);
  assert.equal(document.conflicts, 1);
  assert.equal(document.references.length, 11);
  assert.equal(plan.records[0].sha256, digest);
  assert.equal(plan.records[0].versionId, null);
  assert.equal(plan.unchecked, 3);
  await assert.rejects(inspectReferenceDocument(new Blob(['{"schema":"civitai-metadata-studio.identity-cache","schemaVersion":2,"resources":[]}'])), /CiviScribe sidecar/u);
  await assert.rejects(inspectReferenceDocument({ size: localReferenceBytes + 1 }), /24 MB/u);
  await assert.rejects(inspectReferenceDocument(new Blob([new Uint8Array([0xff, 0xfe])])));
});

test('an edit session requires the byte-identical original and its format, and overlapping drafts need a choice', async () => {
  const { picture, draft, imageDigest } = metadataEditExample();
  const copy = new Uint8Array(picture);
  copy[copy.length - 1] ^= 1;
  const [original, altered, session, alternate] = await Promise.all([
    inspectReferenceImage(new File([picture], 'same.png'), { hashOriginal: true }),
    inspectReferenceImage(new File([copy], 'same.png'), { hashOriginal: true }),
    inspectReferenceDocument(draft), inspectReferenceDocument(draft),
  ]);
  assert.equal(original.imageDigest, imageDigest);
  assert.notEqual(altered.imageDigest, imageDigest);
  assert.equal(recordedReferencePlan([session]).records.length, 0);
  assert.equal(matchReferenceEdits([session, altered]).pairs.length, 0);
  assert.equal(matchReferenceEdits([session, { ...original, format: 'jpeg' }]).pairs.length, 0);
  const matched = matchReferenceEdits([session, original, original]);
  assert.equal(matched.pairs.length, 1);
  assert.equal(matched.sessions.get(session).matched, 1);
  assert.equal(matched.pairs[0].draft.unresolved, 1);
  assert.doesNotMatch(JSON.stringify(matched.pairs), new RegExp(imageDigest + '|private-prompt|model-canary', 'u'));
  const overlap = matchReferenceEdits([session, alternate, original]);
  assert.equal(overlap.pairs.length, 0);
  assert.equal(overlap.sessions.get(session).ambiguous, 1);
  const invalid = JSON.parse(await draft.text());
  invalid.images[0].edits.resources.push({ hashes: { SHA256: altered.imageDigest } });
  const otherDigest = await inspectReferenceDocument(new Blob([JSON.stringify(invalid)]));
  const [withoutImageDigest] = matchReferenceEdits([otherDigest, original, altered]).pairs;
  assert.equal(withoutImageDigest.draft.unresolved, 2);
  assert.doesNotMatch(JSON.stringify(withoutImageDigest), new RegExp(altered.imageDigest, 'u'));
  invalid.images.push(invalid.images[0]);
  await assert.rejects(inspectReferenceDocument(new Blob([JSON.stringify(invalid)])), /invalid original-image entries/u);
});

test('Metadata Studio audit reports contribute exact active references without leaking the rest of the report', async () => {
  const privateValue = 'audit-private-canary';
  const report = { schema: 'civitai-metadata-studio.audit-report', schemaVersion: 1, image: { filename: privateValue },
    changes: { prompt: privateValue }, manifest: { schemaName: 'civitai-metadata-studio', schemaVersion: 1,
      prompt: { positive: privateValue }, resources: [
        { parserFacing: true, modelVersionId: 55, modelId: 11, fileId: '90', filename: privateValue },
        { parserFacing: true, modelVersionId: 56, verification: 'conflict' },
        { parserFacing: true, modelVersionId: 57, removed: true },
        { parserFacing: false, modelVersionId: 58 },
        { parserFacing: false, name: 'Unpublished model file', hashes: { SHA256: digest } },
      ] } };
  const document = await inspectReferenceDocument(new Blob([JSON.stringify(report)]));
  assert.equal(document.source, studioAuditReport);
  assert.equal(document.conflicts, 1);
  const plan = recordedReferencePlan([document]);
  assert.equal(plan.documents, 1);
  assert.deepEqual(plan.records.map(row => [row.versionId, row.fileId, row.sha256, row.fields]),
    [[55, 90, null, [studioAuditReport]], [null, null, digest, [studioAuditReport]]]);
  assert.doesNotMatch(JSON.stringify({ document, plan }), /audit-private-canary/u);
  report.manifest.schemaVersion = 2;
  await assert.rejects(inspectReferenceDocument(new Blob([JSON.stringify(report)])), /audit report/u);
});

test('picture comparison deduplicates exact files and keeps their presence, order and private content distinct', async () => {
  const fixture = pictureComparisonExample();
  const [original, revised] = await Promise.all([fixture.original, fixture.revised]
    .map(bytes => inspectReferenceImage(new Blob([bytes]), { hashOriginal: true })));
  const exact = pairReferencePictures({ ...original, references: [...original.references, { sha256: revised.imageDigest }] }, revised);
  assert.equal(exact.original.references.length, 2);
  assert.equal(exact.integrity, 'same-picture-data');
  assert.equal(pairReferencePictures(original, original).integrity, 'same-file');
  assert.equal(pairReferencePictures(original, { ...revised, format: 'unknown' }), null);
  const empty = pairReferencePictures(original, { ...revised, references: [] });
  assert.equal(empty.original.references.length, 2);
  assert.equal(empty.draft.references.length, 0);
  const batches = [];
  const privateData = new RegExp([fixture.imageDigest, fixture.revisedDigest, original.pictureDigest, 'private-prompt'].join('|'), 'u');
  const fetcher = (url, options) => {
    assert.doesNotMatch(url.href + String(options.body ?? ''), privateData);
    if (url.pathname !== '/api/v1/blocks/models') return Response.json({ items: [] });
    assert.equal(options.method ?? 'GET', 'GET');
    batches.push(url.searchParams.get('modelVersionIds'));
    return Response.json({ items: metadataEditModels.map(row => ({
      ...candidate(row.modelId, row.modelVersionId, row.family, row.fileId), name: row.title,
    })) });
  };
  const filters = { scope: 'report', reportSources: ['models', 'gallery'] };
  const { report } = await discoverReport(context, filters, { editPairs: [exact], fetcher });
  assert.equal(report.title, 'Compare picture models');
  assert.deepEqual(batches, ['3087275,128713,109123']);
  assert.equal(report.localTrace.pictures, 2);
  assert.equal(report.localTrace.documents, 0);
  assert.equal(report.localTrace.verified.length, 3);
  assert.deepEqual(report.localTrace.edits[0].rows.map(row => row.labels), [['Original only'], ['Both pictures'], ['Revised only']]);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /Original PNG → Revised PNG · 1 shared · 1 original only · 1 revised only/u);
  assert.match(markdown, /Encoded picture data matches\./u);
  assert.match(markdown, /File #77036 · Revised only/u);
  const plans = reportResearchPlans(report);
  assert.ok(plans.length);
  assert.doesNotMatch(markdown + JSON.stringify(report) + JSON.stringify(plans), privateData);
  assert.doesNotMatch(JSON.stringify(plans), /Both pictures|Revised only|Encoded picture data/u);
  const { report: reverse } = await discoverReport(context, filters, { editPairs: [pairReferencePictures(revised, original)], fetcher });
  assert.match(reportMarkdown(reverse), /File #77036 · Original only/u);
});

test('local picture evidence covers animation changes, simple and extended WebP, and an incomplete container', async () => {
  const inspect = bytes => inspectReferenceImage(new Blob([bytes]), { hashOriginal: true });
  const compare = async (original, revised) => pairReferencePictures(...await Promise.all([inspect(original), inspect(revised)])).integrity;
  function animatedPng(delay, note) {
    const animation = Buffer.alloc(8);
    animation.writeUInt32BE(2);
    function frame(sequence, duration) {
      const control = Buffer.alloc(26);
      control.writeUInt32BE(sequence);
      control.writeUInt32BE(1, 4);
      control.writeUInt32BE(1, 8);
      control.writeUInt16BE(duration, 20);
      control.writeUInt16BE(100, 22);
      return pngChunk('fcTL', control);
    }
    return makeReferencePng([pngChunk('acTL', animation), frame(0, 10), pngUtf8Chunk('parameters', note)], [
      frame(1, delay), pngChunk('fdAT', Buffer.concat([Buffer.from([0, 0, 0, 2]), deflateSync(Buffer.from([0, 33, 111, 80]))])),
    ]);
  }
  const png = animatedPng(20, 'original');
  assert.equal(await compare(png, animatedPng(20, 'revised note')), 'same-picture-data');
  assert.equal(await compare(png, animatedPng(50, 'revised timing')), 'picture-data-changed');
  assert.equal(await compare(png, png.subarray(0, -12)), 'unconfirmed');

  // Lossless 2×2 payload from the CiviScribe project’s synthetic RGBA fixture.
  const image = Buffer.from('LwFAABCFQICIsuHJoMCbnz9DQ0BQeG56AbXZAQ==', 'base64');
  function webpChunk(name, body) {
    const header = Buffer.alloc(8);
    header.write(name);
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
  }
  function webp(chunks) {
    const body = Buffer.concat(chunks);
    const header = Buffer.from('RIFF\0\0\0\0WEBP');
    header.writeUInt32LE(body.length + 4, 4);
    return Buffer.concat([header, body]);
  }
  const lossless = webpChunk('VP8L', image);
  const bare = webp([lossless]);
  const extended = webp([webpChunk('VP8X', Buffer.from([24, 0, 0, 0, 1, 0, 0, 1, 0, 0])), lossless,
    webpChunk('EXIF', Buffer.from('replacement metadata'))]);
  assert.equal(await compare(bare, extended), 'same-picture-data');
  assert.equal(await compare(png, bare), 'format-changed');
});

test('sidecar comparison keeps separate strengths and repeated active uses for a single file check', async () => {
  const [lora, checkpoint, revisedOnly] = metadataEditModels;
  const row = ({ modelVersionId, modelId, fileId }, role, strengths) => ({ active: true, parserFacing: true,
    identity: { modelVersionId, modelId, fileId }, role, strengths, filename: 'sidecar-private-path-canary' });
  const oldUse = row(lora, 'lora', { model: 0.8, clip: 0.6, weight: 0.75 });
  const newUse = row(lora, 'lora', { model: 0, clip: -0.25, weight: 0.75 });
  const source = resources => inspectReferenceDocument(new Blob([JSON.stringify({
    schemaName: 'ccollins-civiscribe.sidecar', schemaVersion: '2.0.0', generationRecord: {
      resources, prompts: { positive: 'sidecar-private-prompt-canary' },
    }, payloads: { workflow: 'sidecar-private-workflow-canary' },
  })]));
  const [original, revised] = await Promise.all([
    source([row(checkpoint, 'base_model'), oldUse, { ...oldUse, active: false }]),
    source([newUse, newUse, row(revisedOnly, 'base_model'), { ...oldUse, status: 'conflict' },
      { ...row(checkpoint, 'sidecar-private-role-canary', { weight: 'sidecar-private-weight-canary' }), active: false }]),
  ]);
  const privateData = /sidecar-private-/u;
  const batches = [];
  const fetcher = (url, options) => {
    assert.doesNotMatch(url.href + String(options.body ?? ''), privateData);
    assert.equal(options.method ?? 'GET', 'GET');
    if (url.pathname !== '/api/v1/blocks/models') return Response.json({ items: [] });
    batches.push(url.searchParams.get('modelVersionIds'));
    return Response.json({ items: metadataEditModels.map(item => ({
      ...candidate(item.modelId, item.modelVersionId, item.family, item.fileId), name: item.title,
    })) });
  };
  const filters = { scope: 'report', query: 'sidecar-private-previous-query', reportSources: ['models', 'gallery'] };
  const compare = (original, revised) => discoverReport(context, filters, { editPairs: [pairReferenceSidecars(original, revised)], fetcher });
  const { report } = await compare(original, revised);
  assert.equal(report.title, 'Compare sidecar models');
  assert.deepEqual(batches, ['128713,3087275,109123']);
  assert.equal(report.localTrace.documents, 2);
  assert.equal(report.localTrace.verified.length, 3);
  assert.deepEqual(report.localTrace.edits[0].rows.map(({ labels }) => labels), [
    ['Original only'], ['Both sidecars', 'Recorded use changed'], ['Revised only'],
  ]);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /1 shared · 1 original only · 1 revised only/u);
  assert.match(markdown, /Original · LoRA · Model strength 0\.8 · CLIP strength 0\.6 · Weight 0\.75/u);
  assert.match(markdown, /Revised · LoRA · Model strength 0 · CLIP strength -0\.25 · Weight 0\.75 \(2 uses\)/u);
  const plans = reportResearchPlans(report);
  assert.ok(plans.length);
  assert.doesNotMatch(markdown + JSON.stringify(report) + JSON.stringify(plans), privateData);
  assert.doesNotMatch(JSON.stringify(plans), /Recorded use changed|CLIP strength|Weight 0\.75/u);
  const { report: reverse } = await compare(revised, original);
  assert.match(reportMarkdown(reverse), /Original · LoRA · Model strength 0 · CLIP strength -0\.25/u);
});

test('the matching draft joins original, proposed and removed entries with one public catalog batch', async () => {
  const { picture, draft, imageDigest } = metadataEditExample();
  const original = await inspectReferenceImage(new Blob([picture]), { hashOriginal: true });
  const session = await inspectReferenceDocument(draft);
  const { pairs: editPairs } = matchReferenceEdits([original, session]);
  const batches = [];
  const { report } = await discoverReport(context, { scope: 'report', reportSources: ['models', 'gallery'] }, {
    editPairs,
    fetcher(url, options) {
      const sensitive = new RegExp(imageDigest + '|private-prompt|model-canary', 'u');
      assert.doesNotMatch(url.href + String(options.body ?? ''), sensitive);
      assert.equal(options.method ?? 'GET', 'GET');
      if (url.pathname === '/api/v1/blocks/models') {
        batches.push(url.searchParams.get('modelVersionIds'));
        return Response.json({ items: metadataEditModels.map(row => ({
          ...candidate(row.modelId, row.modelVersionId, row.family, row.fileId), name: row.title,
        })) });
      }
      return Response.json({ items: [] });
    },
  });
  assert.equal(report.title, 'Compare model edits');
  assert.deepEqual(batches, ['3087275,128713,109123']);
  assert.equal(report.localTrace.checked, 3);
  assert.equal(report.localTrace.verified.length, 3);
  assert.deepEqual(report.localTrace.edits[0].rows.map(row => [row.versionId, row.fileId, row.labels]), [
    [3087275, 2966748, ['Original', 'Removal marked']], [128713, 93211, ['Original and proposed']], [109123, 77036, ['Proposed']],
  ]);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /Picture 1 · PNG · 1 edit entry needs more identity evidence/u);
  assert.match(markdown, /Version #3087275 · File #2966748 · Original · Removal marked/u);
  const plans = reportResearchPlans(report);
  assert.ok(plans.length);
  assert.match(JSON.stringify(plans), /modelVersionId=109123/u);
  assert.doesNotMatch(markdown + JSON.stringify(report) + JSON.stringify(plans),
    new RegExp(imageDigest + '|private-prompt|model-canary', 'u'));
  assert.doesNotMatch(JSON.stringify(plans), /Removal marked|edit entry needs/u);
});

test('a long edit comparison spends the catalog check budget on changed references first', () => {
  const before = Array.from({ length: 10 }, (_, index) => ({ versionId: index + 1, fileId: index + 20 }));
  const added = { versionId: 11, fileId: 30 };
  const proposed = [...before.slice(0, -1), added];
  const removed = [before.at(-1)];
  const original = { format: 'png', references: before };
  const editPairs = [{ original, draft: { references: proposed, removed } }];
  const plan = recordedReferencePlan([original, { source: studioEditSession, references: [...proposed, ...removed] }],
    { priority: editVerificationPriorities(editPairs) });
  assert.deepEqual(plan.records.map(row => row.versionId), [11, 10, 1, 2, 3, 4, 5, 6]);
  assert.equal(plan.unchecked, 3);
});

test('recorded ID and digest resolution use a single exact App batch and preserve filters, file pins and unavailable records', async () => {
  const calls = [];
  const plan = recordedReferencePlan([{ references: [
    { versionId: 55, modelId: 11, fileId: 90, format: 'safetensors', field: 'PNG parameters' },
    { versionId: 56, modelId: 12, field: 'PNG workflow' }, { versionId: 55, modelId: 2 },
    { sha256: digest, field: 'EXIF UserComment' }, { versionId: 59 },
  ] }]);
  const fetcher = (url, config) => {
    assert.equal(url.origin, origin);
    calls.push(url.pathname);
    if (url.pathname.endsWith('/by-hash/ids')) {
      assert.equal(config.headers.Authorization, undefined);
      assert.equal(config.credentials, 'omit');
      assert.equal(config.method, 'POST');
      assert.equal(config.cache, 'no-store');
      assert.deepEqual(JSON.parse(config.body), [digest]);
      return Response.json([{ modelVersionId: 55, modelId: 11, hash: digest }]);
    }
    assert.equal(url.pathname, '/api/v1/blocks/models');
    assert.equal(config.headers.Authorization, 'Bearer fixture');
    assert.equal(url.searchParams.get('modelVersionIds'), '55,56,59');
    return Response.json({ items: [candidate(11, 55, 'SDXL 1.0', 90), candidate(12, 56, 'Flux.1 D', 91)] });
  };
  const result = await readRecordedVersions(context, plan, { baseModel: 'SDXL 1.0' }, { fetcher });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.candidates.map(row => [row.id, row.selectedFile.id]), [[55, 90]]);
  assert.deepEqual([result.verified.length, result.filtered, result.unavailable, result.checked], [2, 1, 2, 5]);
  const locked = await readRecordedVersions(context, plan, { category: 'Style' }, { fetcher });
  assert.equal(locked.candidates.length, 0);
  assert.equal(locked.unknownFit, 3);
});

test('a shared SHA-256 remains ambiguous through visibility and family filters until an exact file ID resolves it', async () => {
  const model = candidate(11, 55, 'SDXL 1.0', 90);
  model.modelVersions[0].files.unshift({ id: 93, name: 'other.safetensors', metadata: { format: 'SafeTensor' },
    hashes: { SHA256: 'a'.repeat(64) } });
  const plan = recordedReferencePlan([{ references: [
    { sha256: digest }, { sha256: digest, fileId: 90, format: 'SafeTensor' },
    { sha256: digest, versionId: 55, format: 'SafeTensor' }, { sha256: digest, versionId: 55, fileId: 93 },
  ] }]);
  const calls = [];
  let hidden = true;
  const fetcher = (url) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith('/by-hash/ids')) return Response.json([
      { modelVersionId: 55, modelId: 11, hash: digest }, { modelVersionId: 55, modelId: 11, hash: digest },
      { modelVersionId: 56, modelId: 12, hash: digest },
    ]);
    assert.equal(url.searchParams.get('modelVersionIds'), '55,56');
    // Model 56 fails the hosted visibility check. Its label and files stay unavailable.
    return Response.json({ items: hidden ? [model] : [model, candidate(12, 56, 'Flux.1 D', 91)] });
  };
  const result = await readRecordedVersions(context, plan, { baseModel: 'SDXL 1.0' }, { fetcher });
  assert.equal(calls.length, 2);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.unavailable, 1);
  assert.equal(result.filtered, 0);
  assert.deepEqual(result.verified.map(row => [row.versionId, row.fileIds]), [[55, [90]], [55, [90]]]);
  assert.deepEqual(result.candidates.map(row => row.modelId), [11]);
  assert.match(localTraceCoverage({ pictures: 1, ...result }), /1 reference matches multiple versions/u);
  hidden = false;
  const bothVisible = await readRecordedVersions(context, plan, { baseModel: 'SDXL 1.0' }, { fetcher });
  assert.deepEqual([bothVisible.ambiguous, bothVisible.filtered], [1, 0]);
});

test('local-image trace joins approved examples and catalog sources without putting the private image, prompt or digest in quotes', async () => {
  const reference = { format: 'png', name: 'private-reference-filename', references: [
    { versionId: 55, modelId: 11, fileId: 90, field: 'PNG parameters' },
  ] };
  const input = { scope: 'report', reportSources: ['models', 'gallery', 'articles'] };
  const result = await discoverReport(context, input, { recordedReferences: [reference],
    fetcher(url, options) {
      assert.equal(url.origin, origin);
      assert.equal(options.method ?? 'GET', 'GET');
      if (url.pathname === '/api/v1/blocks/models') {
        return Response.json({ items: [candidate(11, 55, 'SDXL 1.0', 90)] });
      }
      assert.equal(url.pathname, '/api/v1/blocks/images');
      assert.equal(url.searchParams.get('modelVersionId'), '55');
      return Response.json({ items: [{ id: 101, type: 'image', url: 'https://image.civitai.com/fixture.jpg', modelVersionIds: [55] }] });
    },
    async discoverSource(_viewer, filters) {
      assert.equal(filters.scope, 'articles');
      assert.equal(filters.query, 'Catalog 11');
      return { candidates: [], related: { articles: [{ id: 24, title: 'Guide', link: origin + '/articles/24' }] }, flows: [] };
    },
  });
  assert.equal(result.report.title, 'Trace a local picture');
  assert.equal(result.report.localTrace.verified.length, 1);
  assert.equal(result.related.gallery[0].id, 101);
  assert.ok(result.report.connections.some(row => row.kind === 'catalog'));
  assert.match(reportMarkdown(result.report), /File #90 · Generation settings/u);
  const plans = JSON.stringify(reportResearchPlans(result.report));
  assert.match(plans, /localReferenceCatalogLinks/u);
  assert.ok(!plans.includes('private-reference-filename') && !plans.includes(digest));
  assert.match(plans, /https:\/\/image\.civitai\.com\/fixture\.jpg/u);
});
