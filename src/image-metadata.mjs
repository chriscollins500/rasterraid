// Read generation fields only. Container offsets and decoded text are bounded
// independently from the image size. Pixel data stays with the visual preview.
const maxImage = 24_000_000;
const maxText = 1_500_000;
const utf8 = new TextDecoder();
const latin = new TextDecoder('iso-8859-1');
const keywords = /^(?:parameters(?:_utf8)?|prompt|workflow|comment|civitai(?:[_ -]?(?:resources|metadata))?|extraMetadata)$/iu;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const ascii = (bytes, start, end) => latin.decode(bytes.subarray(start, end));
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const clean = value => value.replace(/\0+$/u, '').trim();
const pngPictureChunks = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'acTL', 'fcTL', 'fdAT']);
const webpPictureChunks = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function pngCrc(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(bytes) {
  if (!bytes.length || bytes.length > maxText || typeof DecompressionStream !== 'function') return '';
  let reader;
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const decoder = new TextDecoder();
    const output = [];
    let count = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return output.join('') + decoder.decode();
      count += value.length;
      if (count > maxText) return '';
      output.push(decoder.decode(value, { stream: true }));
    }
  } catch { return ''; }
  finally {
    if (reader) await reader.cancel().catch(() => {});
  }
}

async function pngText(chunk, body) {
  const zero = body.indexOf(0);
  if (zero < 1 || zero > 79) return null;
  const keyword = ascii(body, 0, zero);
  if (!keywords.test(keyword)) return null;
  let value = '';
  if (chunk === 'tEXt' || chunk === 'comf') value = latin.decode(body.subarray(zero + 1));
  if (chunk === 'zTXt' && body[zero + 1] === 0) value = await inflate(body.subarray(zero + 2));
  if (chunk === 'iTXt' && [0, 1].includes(body[zero + 1]) && body[zero + 2] === 0) {
    const language = body.indexOf(0, zero + 3);
    const translated = language < 0 ? -1 : body.indexOf(0, language + 1);
    if (translated >= 0) value = body[zero + 1] ? await inflate(body.subarray(translated + 1)) : utf8.decode(body.subarray(translated + 1));
  }
  return clean(value) ? { keyword, value: clean(value), field: 'PNG ' + keyword } : null;
}

function userComment(bytes, little) {
  const marker = ascii(bytes, 0, 8);
  if (marker === 'UNICODE\0') {
    const content = bytes.subarray(8);
    const bigEndian = new TextDecoder('utf-16be');
    const littleEndian = new TextDecoder('utf-16le');
    if (content[0] === 0xfe && content[1] === 0xff) return bigEndian.decode(content);
    if (content[0] === 0xff && content[1] === 0xfe) return littleEndian.decode(content);
    // Writers can store a big-endian UserComment in a little-endian TIFF.
    const generation = /(?:^|\n)(?:(?:Steps|Seed|Size|CFG scale):\s*\d|Sampler:\s*[^,]+,)|^\s*(?:\{|civitai[_ -]?resources:|(?:prompt|workflow|parameters|extraMetadata):)/iu;
    const big = bigEndian.decode(content);
    if (generation.test(big) || !little) return big;
    const small = littleEndian.decode(content);
    return generation.test(small) ? small : big;
  }
  if (marker === 'ASCII\0\0\0' || marker === '\0'.repeat(8)) return utf8.decode(bytes.subarray(8));
  return utf8.decode(bytes);
}

function exifFields(bytes) {
  if (ascii(bytes, 0, 6) === 'Exif\0\0') bytes = bytes.subarray(6);
  const order = ascii(bytes, 0, 2);
  if (bytes.length < 8 || bytes.length > maxText || !['II', 'MM'].includes(order)) return [];
  const little = order === 'II';
  const view = viewOf(bytes);
  if (view.getUint16(2, little) !== 42) return [];
  const fields = [];
  const dirs = [view.getUint32(4, little)];
  let decoded = 0;
  for (let dir = 0; dir < dirs.length && dir < 2 && decoded <= 2 * maxText; dir++) {
    const offset = dirs[dir];
    if (offset < 8 || offset > bytes.length - 2) continue;
    const count = view.getUint16(offset, little);
    if (count > 256 || offset + 2 + count * 12 > bytes.length) continue;
    for (let i = 0; i < count && fields.length < 32 && decoded <= 2 * maxText; i++) {
      const at = offset + 2 + i * 12;
      const tag = view.getUint16(at, little);
      const type = view.getUint16(at + 2, little);
      const length = view.getUint32(at + 4, little);
      const pointer = view.getUint32(at + 8, little);
      if (!dir && tag === 0x8769 && type === 4 && length === 1) {
        if (pointer !== offset && dirs.length === 1) dirs.push(pointer);
        continue;
      }
      const user = tag === 0x9286 && [2, 7].includes(type);
      const textTag = type === 2 && tag >= 0x0100 && tag <= 0x0110;
      if ((!user && !textTag) || !length || length > maxText) continue;
      const start = length <= 4 ? at + 8 : pointer;
      if (start < 8 || start + length > bytes.length) continue;
      const data = bytes.subarray(start, start + length);
      decoded += data.length;
      const value = clean(user ? userComment(data, little) : utf8.decode(data));
      if (value) fields.push({ keyword: user ? 'parameters' : 'comment', value, field: user ? 'EXIF UserComment' : 'EXIF generation field' });
    }
  }
  return fields;
}

async function fieldsFromBytes(bytes) {
  const view = viewOf(bytes);
  const fields = [];
  if (pngSignature.every((value, index) => bytes[index] === value)) {
    if (bytes.length < 33 || ascii(bytes, 12, 16) !== 'IHDR' || view.getUint32(8) !== 13) return { format: 'png', fields };
    let attempted = 0;
    let decoded = 0;
    for (let offset = 8, count = 0; offset + 12 <= bytes.length && count < 4096 && attempted < 32 &&
      decoded <= 2 * maxText && fields.length < 32; count++) {
      const length = view.getUint32(offset);
      const chunk = ascii(bytes, offset + 4, offset + 8);
      const end = offset + 8 + length;
      if (end + 4 > bytes.length || chunk === 'IEND') break;
      if (length <= maxText && ['tEXt', 'iTXt', 'zTXt', 'comf', 'eXIf'].includes(chunk) &&
          pngCrc(bytes, offset + 4, end) === view.getUint32(end)) {
        attempted++;
        const body = bytes.subarray(offset + 8, end);
        const text = chunk === 'eXIf' ? exifFields(body) : [await pngText(chunk, body)].filter(Boolean);
        decoded += text.reduce((total, field) => total + field.value.length, 0);
        fields.push(...text.slice(0, 32 - fields.length));
      }
      offset = end + 4;
    }
    return { format: 'png', fields };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2, count = 0; offset + 3 < bytes.length && bytes[offset] === 0xff && count < 512; count++) {
      if (bytes[offset + 1] === 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset + 2);
      const end = offset + 2 + length;
      if (length < 2 || end > bytes.length) break;
      if (marker === 0xe1 && ascii(bytes, offset + 4, offset + 10) === 'Exif\0\0') {
        fields.push(...exifFields(bytes.subarray(offset + 4, end)).slice(0, 32 - fields.length));
      }
      if (fields.length >= 32) break;
      offset = end;
    }
    return { format: 'jpeg', fields };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    const limit = Math.min(bytes.length, view.getUint32(4, true) + 8);
    for (let offset = 12, count = 0; offset + 8 <= limit && count < 4096 && fields.length < 32; count++) {
      const length = view.getUint32(offset + 4, true);
      const end = offset + 8 + length;
      if (end + length % 2 > limit) break;
      if (ascii(bytes, offset, offset + 4) === 'EXIF' && length <= maxText) {
        fields.push(...exifFields(bytes.subarray(offset + 8, end)).slice(0, 32 - fields.length));
      }
      offset = end + length % 2;
    }
    return { format: 'webp', fields };
  }
  return { format: 'unknown', fields };
}

function pngPictureRanges(bytes, view) {
  if (bytes.length < 33 || view.getUint32(8) !== 13 || ascii(bytes, 12, 16) !== 'IHDR' ||
      !view.getUint32(16) || !view.getUint32(20)) return null;
  const ranges = [[0, 8]];
  let hasData = false;
  for (let offset = 8, count = 0; offset + 12 <= bytes.length && count < 4096; count++) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) return null;
    if (type === 'IEND') {
      return hasData && length === 0 && end + 4 === bytes.length && pngCrc(bytes, offset + 4, end) === view.getUint32(end)
        ? { ranges } : null;
    }
    if (pngPictureChunks.has(type)) {
      if (pngCrc(bytes, offset + 4, end) !== view.getUint32(end)) return null;
      ranges.push([offset, end + 4]);
      if (type === 'IDAT' && length) hasData = true;
    } else if ((bytes[offset + 4] & 0x20) === 0) return null;
    offset = end + 4;
  }
  return null;
}

function endJpegScan(bytes, offset) {
  for (;;) {
    const markerStart = bytes.indexOf(0xff, offset);
    if (markerStart < 0) return -1;
    let codeOffset = markerStart + 1;
    while (bytes[codeOffset] === 0xff) codeOffset++;
    const marker = bytes[codeOffset];
    if (marker === undefined) return -1;
    if (marker !== 0 && (marker < 0xd0 || marker > 0xd7)) return codeOffset - 1;
    offset = codeOffset + 1;
  }
}

function jpegPictureRanges(bytes, view) {
  const ranges = [[0, 2]];
  let frame = false;
  let scans = 0;
  for (let offset = 2, count = 0; offset + 2 <= bytes.length && count < 4096; count++) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset++;
    const start = offset - 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scans && offset === bytes.length ? { ranges } : null;
    if (marker < 0xc0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) return null;
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) return null;
    if (marker === 0xda) {
      if (length < 6 || !frame) return null;
      offset = endJpegScan(bytes, end);
      if (offset <= end) return null;
      ranges.push([start, offset]);
      scans++;
    } else {
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8 || !view.getUint16(offset + 3) || !view.getUint16(offset + 5)) return null;
        frame = true;
      }
      if ((marker < 0xe0 || marker > 0xef) && marker !== 0xfe) ranges.push([start, end]);
      offset = end;
    }
  }
  return null;
}

function webpPictureRanges(bytes, view) {
  if (view.getUint32(4, true) + 8 !== bytes.length) return null;
  const ranges = [];
  let canvas;
  let still;
  let animation = false;
  let frames = 0;
  let offset = 12;
  for (let count = 0; count < 4096 && offset + 8 <= bytes.length; count++) {
    const type = ascii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    const end = body + size;
    const next = end + size % 2;
    if (next > bytes.length) return null;
    if (type === 'VP8X') {
      if (size !== 10 || offset !== 12) return null;
      const size24 = i => bytes[i] + (bytes[i + 1] << 8) + (bytes[i + 2] << 16) + 1;
      canvas = size24(body + 4) + '×' + size24(body + 7);
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (still) return null;
      let width;
      let height;
      if (type === 'VP8 ') {
        if (size <= 10 || (bytes[body] & 1) !== 0 || bytes[body + 3] !== 0x9d || bytes[body + 4] !== 1 || bytes[body + 5] !== 0x2a) return null;
        width = view.getUint16(body + 6, true) & 0x3fff;
        height = view.getUint16(body + 8, true) & 0x3fff;
      } else {
        if (size <= 5 || bytes[body] !== 0x2f) return null;
        const dimensions = view.getUint32(body + 1, true);
        if (dimensions >>> 29) return null;
        width = (dimensions & 0x3fff) + 1;
        height = ((dimensions >>> 14) & 0x3fff) + 1;
      }
      if (!width || !height) return null;
      still = width + '×' + height;
    } else if (type === 'ANIM') {
      if (animation || size !== 6) return null;
      animation = true;
    } else if (type === 'ANMF') {
      if (!animation || size <= 24) return null;
      frames++;
    }
    if (webpPictureChunks.has(type)) ranges.push([offset, end]);
    offset = next;
  }
  if (offset !== bytes.length || (animation ? !canvas || !frames || still : !still || canvas && canvas !== still)) return null;
  return { ranges, canvas: canvas ?? still };
}

async function sha256(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function pictureDataDigest(bytes, format) {
  const view = viewOf(bytes);
  const read = { png: pngPictureRanges, jpeg: jpegPictureRanges, webp: webpPictureRanges }[format];
  const layout = read(bytes, view);
  if (!layout) return null;
  const size = layout.ranges.reduce((total, [start, end]) => total + end - start, 0);
  const data = new Uint8Array(size);
  let at = 0;
  for (const [start, end] of layout.ranges) {
    data.set(bytes.subarray(start, end), at);
    at += end - start;
  }
  return (layout.canvas ? layout.canvas + '/' : '') + await sha256(data);
}

export async function generationFields(file, { hashOriginal = false } = {}) {
  if (!file || !Number.isSafeInteger(file.size) || file.size > maxImage || file.size < 8) return { format: 'unknown', fields: [] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) return { format: 'unknown', fields: [] };
  const parsed = await fieldsFromBytes(bytes);
  if (!hashOriginal || parsed.format === 'unknown' || !globalThis.crypto?.subtle) return parsed;
  const [original, picture] = await Promise.allSettled([sha256(bytes), pictureDataDigest(bytes, parsed.format)]);
  return { ...parsed, ...(original.status === 'fulfilled' && { imageDigest: original.value }),
    ...(picture.status === 'fulfilled' && picture.value && { pictureDigest: picture.value }) };
}
