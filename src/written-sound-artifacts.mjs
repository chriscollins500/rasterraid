import { subjectCpuWasm } from './subject-artifacts.mjs';

export const audioPackName = 'rasterraid-audio-text-v1.rraudio';
export const audioPackUrl = 'https://chriscollins500.github.io/rasterraid/models/' + audioPackName;
export const audioPackMagic = 'RRAUDIO1\n';
export const audioPackSha256 = 'fa98ba0fa110c8f276779e17a951e803380f24549476fb9fea6c4e5c33b4d448';
export const audioPackRevision = '8ffad49f4134b11df3d80c21aceb556f3dfcc511';
export const audioPackParts = Object.freeze([
  { key: 'audio', file: 'audio-int8-weights.onnx', bytes: 9_688_827, compressed: 7_924_659,
    sha256: '26dddcb5c6b4f197f888b30c0e6f84ec9b2848f5c10e6a7b6973171bf0a2c3ac' },
  { key: 'text', file: 'text-int8-weights.onnx', bytes: 20_580_456, compressed: 18_057_046,
    sha256: '96fdc86c5f57414bdaab92f5cd21c21d07384edb66fcb5df6712056a8f1f1b85' },
  { key: 'tokenizer', file: 'tokenizer.json', bytes: 3_559_421, compressed: 627_358,
    sha256: 'ea41bbe8b758ffe23143019ea39cfa21b3c92223fa28b04055932f60266ff5f8' },
  { key: 'tokenizerConfig', file: 'tokenizer_config.json', bytes: 399, compressed: 229,
    sha256: '10aa2b147ea5d1129b6aa8a726f985abb94880233b93bfe82787050aab6be1b1' },
].map(Object.freeze));
export const audioPackBytes = audioPackMagic.length + audioPackParts.reduce((size, part) => size + part.compressed, 0);
export const audioDownloadBytes = audioPackBytes + subjectCpuWasm.bytes;
