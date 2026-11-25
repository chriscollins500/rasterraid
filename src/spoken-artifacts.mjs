import { subjectCpuWasm } from './subject-artifacts.mjs';

export const speechRevision = 'd1e6c30921780b8508d04b492dfb3ce8a51605d4';
const model = 'https://huggingface.co/csukuangfj2/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27';
const asset = (name, bytes, sha256) => Object.freeze({ url: model + '/resolve/' + speechRevision + '/' + name, bytes, sha256 });

export const speechArtifacts = Object.freeze({
  encoder: asset('encoder_model.ort', 13_281_600, '94e90a4654fc45cdfedb77c4c08e1739f48862998e58fada384b25118134f221'),
  decoder: asset('decoder_model_merged.ort', 30_412_256, 'cf524c4862d36e9e5ab032eddc73637efd822d70e868ac575cf1a46e1e4708a0'),
  tokens: asset('tokens.txt', 549_350, '2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049'),
  vad: Object.freeze({
    url: 'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@63d4a2a7bfce8cd9bb39ed8fa0afcb5236d73e01/src/silero_vad/data/silero_vad_16k_sequence.onnx',
    bytes: 1_246_164,
    sha256: 'b8918bcf4e9e13870dd43a6eda22ab4faaa0afcb22b9c7cd6bc85900d30cffca',
  }),
  wasm: subjectCpuWasm,
});
export const speechDownloadBytes = Object.values(speechArtifacts).reduce((total, file) => total + file.bytes, 0);
export const speechClipLimit = 4;
export const speechSecondsLimit = 30;
