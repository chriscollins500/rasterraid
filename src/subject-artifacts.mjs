export const subjectSide = 224;
export const subjectCandidateLimit = 6;
export const subjectAssetOrigins = Object.freeze([
  'https://huggingface.co', 'https://us.aws.cdn.hf.co', 'https://cas-bridge.xethub.hf.co', 'https://cdn.jsdelivr.net',
]);

export const subjectVisionModel = Object.freeze({
  url: 'https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/resolve/ba1f3b0843f24bc5417d38e19c37b287d719b2f4/onnx/vision_model_q4.onnx',
  bytes: 63_267_466,
  sha256: '03e61be280fb24114facd87a1e1e6b2b654aad49845686da2f930c72740914aa',
});

export const subjectWasm = Object.freeze({
  url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.jspi.wasm',
  bytes: 17_920_659,
  sha256: 'b89a3efceeb6df2ba29a66fef59f48fd7b7c22a62af54c3cfe05e63863a07fd5',
});

export const subjectCpuWasm = Object.freeze({
  url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm',
  bytes: 14_848_852,
  sha256: '4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d',
});

export const subjectDownloadBytes = subjectVisionModel.bytes + Math.max(subjectWasm.bytes, subjectCpuWasm.bytes);

export function subjectWasmAvailable() {
  // Validate a minimal function with a SIMD instruction before fetching large artifacts.
  return typeof globalThis.WebAssembly?.validate === 'function' &&
    WebAssembly.validate(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10,
      10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11));
}
