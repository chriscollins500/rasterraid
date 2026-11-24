const previewSide = 192;
const levels = [1, .8, .64];
const radius = 10;
const border = radius + 2;
const tileCount = 7;
const minInliers = 9;
const transformError = 3 ** 2;

// Compare the relative brightness of a fixed set of point pairs in each patch.
const pointPairs = (() => {
  let state = 59;
  function point() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const angle = (state & 65535) * 2 * Math.PI / 65536;
    const distance = Math.sqrt((state >>> 16) / 65536) * radius;
    return [Math.cos(angle) * distance, Math.sin(angle) * distance];
  }
  return Array.from({ length: 128 }, () => [...point(), ...point()]);
})();

function luminance(data) {
  const values = new Float32Array(data.length / 4);
  for (let i = 0; i < values.length; i++) {
    const offset = i * 4;
    values[i] = .213 * data[offset] + .715 * data[offset + 1] + .072 * data[offset + 2];
  }
  return values;
}

function sample(plane, x, y) {
  const { width, values } = plane;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const offset = iy * width + ix;
  const dx = x - ix;
  const dy = y - iy;
  const top = values[offset] * (1 - dx) + values[offset + 1] * dx;
  const bottom = values[offset + width] * (1 - dx) + values[offset + width + 1] * dx;
  return top * (1 - dy) + bottom * dy;
}

function freshPlane(source, document, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = '#808080';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  return { width, height, values: luminance(context.getImageData(0, 0, width, height).data) };
}

export function pictureCopyProfile(source, document) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  if (!(width > 0 && height > 0)) return null;
  const scale = previewSide / Math.max(width, height);
  const [w, h] = [Math.round(width * scale), Math.round(height * scale)];
  if (Math.min(w, h) < 45) return null;
  const plane = freshPlane(source, document, w, h);
  if (!plane) return null;
  let points;
  return { plane, points: () => points ??= levels.flatMap(level => {
    const resized = level === 1 ? plane : freshPlane(source, document, Math.round(w * level), Math.round(h * level));
    return resized ? landmarks(resized, w / resized.width, h / resized.height) : [];
  }) };
}

function landmarks(plane, scaleX, scaleY) {
  const { width, height, values } = plane;
  const cells = Array.from({ length: tileCount ** 2 }, () => []);
  for (let y = border; y < height - border; y += 2) for (let x = border; x < width - border; x += 2) {
    let xx = 0;
    let yy = 0;
    let xy = 0;
    for (let row = -2; row <= 2; row += 2) for (let col = -2; col <= 2; col += 2) {
      const at = (y + row) * width + x + col;
      const dx = values[at + 1] - values[at - 1];
      const dy = values[at + width] - values[at - width];
      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    }
    // Approximate the strength of the weaker direction of a local corner.
    const strength = (xx * yy - xy * xy) / (xx + yy + 1);
    if (strength < 65) continue;
    const cell = cells[Math.floor(y * tileCount / height) * tileCount + Math.floor(x * tileCount / width)];
    cell.push({ x, y, strength });
  }
  return cells.flatMap(cell => {
    const chosen = [];
    cell.sort((a, b) => b.strength - a.strength);
    for (const point of cell) {
      if (chosen.some(other => (other.x - point.x) ** 2 + (other.y - point.y) ** 2 < 8 ** 2)) continue;
      chosen.push(point);
      if (chosen.length === 2) break;
    }
    return chosen.map(({ x, y }) => ({ x: x * scaleX, y: y * scaleY, bits: patchBits(plane, x, y) }));
  });
}

function patchBits(plane, x, y) {
  const { width, values } = plane;
  let horizontal = 0;
  let vertical = 0;
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (dx * dx + dy * dy > 49) continue;
    const light = values[(y + dy) * width + x + dx];
    horizontal += dx * light;
    vertical += dy * light;
  }
  const length = Math.hypot(horizontal, vertical) || 1;
  const cosine = horizontal / length;
  const sine = vertical / length;
  const bits = new Uint32Array(4);
  const light = (u, v) => sample(plane, x + u * cosine - v * sine, y + u * sine + v * cosine);
  for (const [index, [u, v, p, q]] of pointPairs.entries()) {
    if (light(u, v) > light(p, q)) bits[index >>> 5] |= 1 << (index & 31);
  }
  return bits;
}

function hamming(a, b) {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let bits = a[i] ^ b[i];
    bits -= (bits >>> 1) & 0x55555555;
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
    distance += (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return distance;
}

function correspondingPoints(left, right) {
  const nearestRight = right.map(() => ({ index: -1, distance: 129 }));
  const nearestLeft = left.map((point, index) => {
    let best = { index: -1, distance: 129 };
    let second = 129;
    for (const [j, peer] of right.entries()) {
      const distance = hamming(point.bits, peer.bits);
      if (distance < nearestRight[j].distance) nearestRight[j] = { index, distance };
      if (distance < best.distance) {
        second = best.distance;
        best = { index: j, distance };
      } else if (distance < second) second = distance;
    }
    return best.distance < 33 && best.distance < second * .85 ? best : null;
  });
  return nearestLeft.flatMap((match, i) => match && nearestRight[match.index].index === i
    ? [{ left: left[i], right: right[match.index], distance: match.distance }] : []).sort((a, b) => a.distance - b.distance);
}

function alignment(pairs) {
  const center = (side, axis) => pairs.reduce((sum, pair) => sum + pair[side][axis], 0) / pairs.length;
  const x = center('left', 'x');
  const y = center('left', 'y');
  const u = center('right', 'x');
  const v = center('right', 'y');
  let dot = 0;
  let cross = 0;
  let spread = 0;
  for (const { left, right } of pairs) {
    dot += (left.x - x) * (right.x - u) + (left.y - y) * (right.y - v);
    cross += (left.x - x) * (right.y - v) - (left.y - y) * (right.x - u);
    spread += (left.x - x) ** 2 + (left.y - y) ** 2;
  }
  if (spread < 72) return null;
  const a = dot / spread;
  const b = cross / spread;
  const scale = Math.hypot(a, b);
  return scale >= .54 && scale <= 1.86 ? { a, b, tx: u - a * x + b * y, ty: v - b * x - a * y, scale } : null;
}

function agreeingPoints(pairs, { a, b, tx, ty }) {
  return pairs.filter(({ left, right }) => (a * left.x - b * left.y + tx - right.x) ** 2 +
    (b * left.x + a * left.y + ty - right.y) ** 2 <= transformError);
}

function widespread(points, plane, side) {
  const space = new Set(points.map(pair => {
    const { x, y } = pair[side];
    return Math.floor(y * 4 / plane.height) * 4 + Math.floor(x * 4 / plane.width);
  }));
  return space.size >= 5;
}

function checkedAlignment(left, right, pairs) {
  if (pairs.length < minInliers) return null;
  let best = [];
  const seeds = Math.min(24, pairs.length);
  for (let i = 0; i < seeds; i++) for (let j = i + 1; j < seeds; j++) {
    const guess = alignment([pairs[i], pairs[j]]);
    if (!guess) continue;
    const inliers = agreeingPoints(pairs, guess);
    if (inliers.length > best.length) best = inliers;
  }
  if (best.length < minInliers || !widespread(best, left, 'left') || !widespread(best, right, 'right')) return null;
  const fitted = alignment(best);
  return fitted && { ...fitted, points: best.length };
}

function correlation() {
  let sx = 0;
  let sy = 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  let count = 0;
  return {
    add(x, y) {
      count++;
      sx += x;
      sy += y;
      xx += x * x;
      yy += y * y;
      xy += x * y;
    },
    value(minVariance) {
      const left = xx - sx * sx / count;
      const right = yy - sy * sy / count;
      return Math.min(left, right) >= count * minVariance ? (xy - sx * sy / count) / Math.sqrt(left * right) : 0;
    },
    count: () => count,
  };
}

function verifyPixels(left, right, { a, b, tx, ty, scale, points }) {
  const tone = correlation();
  const contours = correlation();
  const leftStride = Math.max(3, 3 / scale);
  const rightStride = leftStride * scale;
  const surround = (plane, x, y, dx, dy) => (sample(plane, x + dx, y + dy) + sample(plane, x - dx, y - dy) +
    sample(plane, x - dy, y + dx) + sample(plane, x + dy, y - dx)) / 4;
  let available = 0;
  const margin = Math.ceil(leftStride) + 1;
  for (let y = margin; y < left.height - margin; y += 3) for (let x = margin; x < left.width - margin; x += 3) {
    available++;
    const u = a * x - b * y + tx;
    const v = b * x + a * y + ty;
    if (u < rightStride + 1 || u >= right.width - rightStride - 1 || v < rightStride + 1 || v >= right.height - rightStride - 1) continue;
    // Smooth over thumbnail resampling and JPEG artifacts before comparing edges.
    const p = .5 * (sample(left, x, y) + surround(left, x, y, leftStride / 3, 0));
    const q = .5 * (sample(right, u, v) + surround(right, u, v, a * leftStride / 3, b * leftStride / 3));
    tone.add(p, q);
    contours.add(p - surround(left, x, y, leftStride, 0), q - surround(right, u, v, a * leftStride, b * leftStride));
  }
  const overlap = Math.min(1, tone.count() / available, tone.count() * 9 * scale ** 2 / (right.width * right.height));
  const detail = contours.value(15);
  if (overlap < (points ? .54 : .86) || tone.value(100) < (points ? .91 : .98) || detail < (points ? .78 : .9)) return null;
  return { overlap, strength: detail, points };
}

export function comparePictureCopies(reference, candidate) {
  if (!reference || !candidate) return null;
  const left = reference.plane;
  const right = candidate.plane;
  const quick = verifyPixels(left, right, { a: 1, b: 0, tx: 0, ty: 0, scale: 1, points: 0 });
  if (quick) return quick;
  const pairs = correspondingPoints(reference.points(), candidate.points());
  const fitted = checkedAlignment(left, right, pairs);
  return fitted && verifyPixels(left, right, fitted);
}
