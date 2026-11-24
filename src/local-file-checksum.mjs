/*
 * Incremental SHA-256 adapted from Civitai Metadata Studio 1.0.2, src/core/sha256.js.
 *
 * MIT License
 *
 * Copyright (c) 2026 Chris Collins
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const K = new Uint32Array([
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2
]);

const rightRotate = (value, count) => (value >>> count) | (value << (32 - count));

class SHA256 {
  constructor() {
    this.state = new Uint32Array([
      0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
      0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferView = new DataView(this.buffer.buffer);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.words = new Uint32Array(64);
  }

  update(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.bytesHashed += bytes.length;
    let position = 0;
    if (this.bufferLength) {
      while (position < bytes.length && this.bufferLength < 64) {
        this.buffer[this.bufferLength++] = bytes[position++];
      }
      if (this.bufferLength === 64) {
        this.compress(this.bufferView, 0);
        this.bufferLength = 0;
      }
    }
    while (position + 64 <= bytes.length) {
      this.compress(view, position);
      position += 64;
    }
    while (position < bytes.length) this.buffer[this.bufferLength++] = bytes[position++];
    return this;
  }

  compress(view, offset) {
    const words = this.words;
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + K[index] + words[index]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digest() {
    const bitLength = BigInt(this.bytesHashed) * 8n;
    this.buffer[this.bufferLength++] = 0x80;
    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this.compress(this.bufferView, 0);
      this.bufferLength = 0;
    }
    this.buffer.fill(0, this.bufferLength, 56);
    this.bufferView.setBigUint64(56, bitLength, false);
    this.compress(this.bufferView, 0);
    const output = new Uint8Array(32);
    const view = new DataView(output.buffer);
    this.state.forEach((value, index) => view.setUint32(index * 4, value, false));
    return output;
  }

}

export const modelFileLimit = 8;
const chunkSize = 1024 * 1024;
const nativeSizeLimit = 4 * chunkSize;

const hex = bytes => typeof bytes.toHex === 'function' ? bytes.toHex() :
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

async function yieldForInput() {
  if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
  else await new Promise(resolve => setTimeout(resolve, 0));
}

export async function localFileChecksum(file, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  if (file.size <= nativeSizeLimit && globalThis.crypto?.subtle) {
    const bytes = await file.arrayBuffer();
    signal?.throwIfAborted();
    if (bytes.byteLength !== file.size) throw new Error('File data changed while it was read.');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    signal?.throwIfAborted();
    onProgress?.(file.size);
    signal?.throwIfAborted();
    return hex(new Uint8Array(digest));
  }
  const hash = new SHA256();
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    signal?.throwIfAborted();
    const end = Math.min(file.size, offset + chunkSize);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength !== end - offset) throw new Error('File data changed while it was read.');
    hash.update(bytes);
    onProgress?.(end);
    // Process one bounded block between opportunities to handle keyboard or pointer input.
    await yieldForInput();
  }
  signal?.throwIfAborted();
  return hex(hash.digest());
}
