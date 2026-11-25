export const visualTextCandidateLimit = 8;
export const visualTextClipLimit = 6;
export const visualTextClipProbes = Object.freeze([.10, 7 / 30, 11 / 30, .50, 19 / 30, 23 / 30, .90]);
export const visualTextFramesPerClip = 4;
export const visualTextFrameLimit = visualTextClipLimit * visualTextFramesPerClip;
export const visualTextLengthLimit = 160;
export const visualPackName = 'rasterraid-visual-model-v1.rrvision';
export const visualPackUrl = 'https://chriscollins500.github.io/rasterraid/models/' + visualPackName;
export const visualPackMagic = 'RRVISUAL1\n';
export const visualPackRevision = 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4';
export const visualPackSha256 = 'cabf90379b5d766e7f22c96bc2ed15ba6617371a4bfec84bb877cabc06f9cbc7';

export const visualPackParts = Object.freeze([
  { key: 'body', file: 'text-body-q4.onnx', bytes: 56_393_501, compressed: 52_637_860,
    sha256: '48417c2c0ceba4df0494a9624b4ca0ff0eeee1c36fc4c87ccd04298c39eaee05' },
  { key: 'table', file: 'table-block4.bin', bytes: 104_448_000, compressed: 91_866_333,
    sha256: 'f068ff9fa41b396ad205ef4185c29c1f5682f0c1f116eca7748f1c3aaa22d2bf' },
  { key: 'special', file: 'table-exact-special.bin', bytes: 196_608, compressed: 182_597,
    sha256: '2273a849b330342b5329b6be71262c4538b9daee59bdbf399816dec01aa8b8cf' },
  { key: 'tokenizer', file: 'tokenizer.json', bytes: 34_363_039, compressed: 5_333_418,
    sha256: 'cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322' },
  { key: 'tokenizerConfig', file: 'tokenizer_config.json', bytes: 47_240, compressed: 2_291,
    sha256: '7c3a247599e741bceba1a3fe0285aea88d1044dc1fad2caa1e48cdd9fd25f630' },
].map(Object.freeze));

export const visualPackBytes = visualPackMagic.length + visualPackParts.reduce((total, part) => total + part.compressed, 0);

export function validVisualDescription(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= visualTextLengthLimit;
}
