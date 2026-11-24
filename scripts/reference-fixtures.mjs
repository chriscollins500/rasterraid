import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { upgradeSources, upgradeVersionLink } from '../src/upgrade-evidence.mjs';

export const exampleSetupMedia = { picture: 145616716, legacy: 2354945, clip: 80205619 };

export function recordedSettingsFixture(versionId) {
  return {
    id: 777, url: 'https://image.civitai.com/fixture/recorded.png', type: 'image', browsingLevel: 1, username: 'Fixture',
    meta: { width: 832, height: 1216, steps: 24, sampler: 'DPM++ 2M', seed: 15, cfgScale: 1,
      civitaiResources: [{ modelVersionId: versionId, type: 'lora', weight: .7 }] },
  };
}

export function pngChunk(name, body) {
  const type = Buffer.from(name, 'ascii');
  const header = Buffer.alloc(4);
  const check = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  check.writeUInt32BE(crc32(Buffer.concat([type, body])));
  return Buffer.concat([header, type, body, check]);
}

export function makeReferencePng(before = [], after = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), ...before,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 170, 90, 35]))), ...after, pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function pngUtf8Chunk(keyword, value) {
  return pngChunk('iTXt', Buffer.from(keyword + '\0\0\0\0\0' + value));
}

export function recordedPictureExample() {
  const records = [
    { air: 'urn:air:sdxl:lora:civitai:2744788@3087275+2966748.safetensors' },
    { modelId: 4384, modelVersionId: 109123 },
  ];
  const manifest = { schemaName: 'ccollins-civiscribe.civitai-manifest', schemaVersion: '1.0.0',
    prompt: { positive: 'Fixture prompt kept on device' }, civitaiResources: records };
  return new Blob([makeReferencePng([pngUtf8Chunk('civitai', JSON.stringify(manifest))])], { type: 'image/png' });
}

export function recordedDocumentExamples() {
  return [
    new Blob([JSON.stringify({
      schemaName: 'ccollins-civiscribe.sidecar', schemaVersion: '2.0.0',
      artifact: { fileName: 'local-picture-canary.png' },
      generationRecord: {
        prompts: { positive: { text: 'local-prompt-canary' } },
        resources: [
          { active: true, parserFacing: true, identity: {
            canonicalAir: 'urn:air:sdxl:lora:civitai:2744788@3087275+2966748.safetensors',
          } },
          { active: false, parserFacing: true, identity: { modelVersionId: 3999999 } },
        ],
      },
      payloads: { workflow: { note: 'local-workflow-canary' } },
    })], { type: 'application/json' }),
    new Blob([JSON.stringify({
      schema: 'civitai-metadata-studio.identity-cache', schemaVersion: 1,
      resources: [
        { modelId: 4384, modelVersionId: 109123, fileId: '77036', name: 'edited-resource-canary' },
        { modelVersionId: 3999998, verification: 'conflict' },
      ],
    })], { type: 'application/json' }),
  ];
}

export const metadataEditModels = Object.freeze([
  { modelId: 2744788, modelVersionId: 3087275, fileId: 2966748, format: 'SafeTensor', title: 'Linocut', family: 'SDXL 1.0' },
  { modelId: 4384, modelVersionId: 128713, fileId: 93211, format: 'SafeTensor', title: 'DreamShaper', family: 'SD 1.5' },
  { modelId: 4384, modelVersionId: 109123, fileId: 77036, format: 'SafeTensor', title: 'DreamShaper', family: 'SD 1.5' },
]);

export function metadataEditExample() {
  const [remove, retain, add] = metadataEditModels;
  const picture = makeReferencePng([
    pngUtf8Chunk('parameters', 'edit-original-private-prompt\nSteps: 20, Civitai resources: ' + JSON.stringify([remove, retain])),
  ]);
  const imageDigest = createHash('sha256').update(picture).digest('hex');
  const draft = new Blob([JSON.stringify({ schema: 'civitai-metadata-studio.edit-session', schemaVersion: 1,
    images: [{ sha256: imageDigest, format: 'png', edits: {
      fields: { positivePrompt: { value: 'edit-session-private-prompt' } },
      resources: [{ ...remove, removed: true }, retain, { ...add, canonicalAir: '', rawAir: '', verification: 'unresolved' },
        { filename: 'C:\\local-unidentified-model-canary.safetensors', hashes: { SHA256: imageDigest } }],
    } }],
  })], { type: 'application/json' });
  return { picture, draft, imageDigest };
}

export function pictureComparisonExample() {
  const { picture: original, imageDigest } = metadataEditExample();
  const revised = makeReferencePng([
    pngUtf8Chunk('parameters', 'revised-private-prompt\nSteps: 20, Civitai resources: ' + JSON.stringify(metadataEditModels.slice(1))),
  ]);
  return { original, revised, imageDigest, revisedDigest: createHash('sha256').update(revised).digest('hex') };
}

export function sidecarComparisonExample() {
  const [lora, original, revised] = metadataEditModels;
  const document = (model, strengths) => new Blob([JSON.stringify({
    schemaName: 'ccollins-civiscribe.sidecar', schemaVersion: '2.0.0',
    generationRecord: { prompts: { positive: 'sidecar-private-prompt-canary' }, resources: [
      { active: true, parserFacing: true, identity: lora, role: 'lora', strengths },
      { active: true, parserFacing: true, identity: model, role: 'base_model' },
    ] },
  })], { type: 'application/json' });
  return [document(original, { model: 0.8, clip: 0.6, weight: 0.75 }), document(revised, { model: 0, clip: -0.25, weight: 0.75 })];
}

export function workflowUpgradeExample(origin) {
  const upgradePair = {
    from: { modelId: 4384, versionId: 109123, fileId: 77036 },
    to: { modelId: 4384, versionId: 128713, fileId: 93211 },
  };
  return { scope: 'report', reportType: 'workflow', reportSources: upgradeSources,
    query: upgradeVersionLink(origin, upgradePair.to), baseModel: 'SD 1.5', upgradePair };
}
