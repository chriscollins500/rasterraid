export const motionPlaneSize = 80;
export const motionSamplePositions = Object.freeze([.18, .5, .8]);
export const minimumMotionScore = .6;
const offsets = [-4, -2, 0, 2, 4];
const patchCount = offsets.length ** 2;
const searchRadius = 6;
const directions = ['right', 'down and right', 'down', 'down and left', 'left', 'up and left', 'up', 'up and right'];

function patchAt(plane, x, y) {
  const samples = offsets.flatMap(dy => offsets.map(dx => plane[(y + dy) * motionPlaneSize + x + dx]));
  const mean = samples.reduce((sum, value) => sum + value, 0) / patchCount;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / patchCount;
  return { samples, variance };
}

function patchError(samples, plane, x, y) {
  let delta = 0, squared = 0, index = 0;
  for (const dy of offsets) {
    const row = (y + dy) * motionPlaneSize;
    for (const dx of offsets) {
      const difference = plane[row + x + dx] - samples[index++];
      delta += difference;
      squared += difference * difference;
    }
  }
  // Removing the mean difference lets a track survive a change in exposure.
  return (squared - delta * delta / patchCount) / patchCount;
}

function displacement(patch, target, x, y) {
  const max = motionPlaneSize - 5;
  let best = { dx: 0, dy: 0, error: patchError(patch.samples, target, x, y) };
  let bestCost = best.error;
  for (let ty = Math.max(4, y - searchRadius); ty <= Math.min(max, y + searchRadius); ty++) {
    for (let tx = Math.max(4, x - searchRadius); tx <= Math.min(max, x + searchRadius); tx++) {
      const dx = tx - x, dy = ty - y;
      if (!dx && !dy) continue;
      const error = patchError(patch.samples, target, tx, ty);
      const cost = error + (dx * dx + dy * dy) * .18;
      if (cost < bestCost) {
        bestCost = cost;
        best = { dx, dy, error };
      }
    }
  }
  return best.error <= Math.max(18, patch.variance * .36) ? best : null;
}

export function describeMotion(first, second, seconds) {
  if (first.length !== motionPlaneSize ** 2 || second.length !== first.length || !(seconds > 0)) return null;
  const vectors = [];
  let textured = 0;
  for (let y = 12; y < motionPlaneSize - 11; y += 9) for (let x = 12; x < motionPlaneSize - 11; x += 9) {
    const patch = patchAt(first, x, y);
    if (patch.variance < 65) continue;
    textured++;
    const trace = displacement(patch, second, x, y);
    if (!trace) continue;
    const { dx, dy } = trace;
    if (dx || dy) {
      const reverse = displacement(patchAt(second, x + dx, y + dy), first, x + dx, y + dy);
      if (!reverse || Math.abs(reverse.dx + dx) + Math.abs(reverse.dy + dy) > 2) continue;
    }
    vectors.push({ x: x - motionPlaneSize / 2, y: y - motionPlaneSize / 2, dx, dy, speed: Math.hypot(dx, dy) });
  }
  if (vectors.length < Math.max(6, textured * .5)) return null;
  const moving = vectors.filter(vector => vector.speed > 0);
  if (moving.length < Math.max(3, vectors.length * .12)) return null;
  const histogram = Array(8).fill(0);
  const spread = moving.length / vectors.length;
  let pace = 0, radialTotal = 0, radialScale = 0;
  for (const { x, y, dx, dy, speed } of moving) {
    const angle = (Math.atan2(dy, dx) / (Math.PI / 4) + 8) % 8;
    const sector = Math.floor(angle);
    const fraction = angle - sector;
    histogram[sector] += 1 - fraction;
    histogram[(sector + 1) % 8] += fraction;
    pace += speed;
    radialTotal += x * dx + y * dy;
    radialScale += Math.hypot(x, y) * speed;
  }
  const dominant = histogram.indexOf(Math.max(...histogram));
  const radial = radialScale ? radialTotal / radialScale * spread : 0;
  const direction = Math.abs(radial) >= .52 && spread >= .55 ? radial > 0 ? 'Outward movement' : 'Inward movement'
    : histogram[dominant] >= moving.length * .48 ? 'Movement ' + directions[dominant] : 'Movement in several directions';
  return { histogram: histogram.map(value => value / moving.length), pace: pace / (moving.length * seconds * motionPlaneSize),
    spread, radial, direction };
}

export function motionSimilarity(left, right) {
  const direction = left.histogram.reduce((sum, value, index) => sum + Math.sqrt(value * right.histogram[index]), 0);
  const pace = Math.exp(-Math.abs(Math.log(left.pace / right.pace)));
  const spread = 1 - Math.abs(left.spread - right.spread);
  const radial = Math.max(0, 1 - Math.abs(left.radial - right.radial));
  const orientation = Math.max(Math.abs(left.radial), Math.abs(right.radial)) >= .52 ? direction * .3 + radial * .7 : direction;
  return Math.min(1, orientation * .7 + pace * .19 + spread * .11);
}

export function bestMotionMatch(reference, candidate) {
  let best;
  for (const first of reference) for (const second of candidate) {
    const score = motionSimilarity(first, second);
    if (!best || score > best.score) best = {
      score, seconds: second.seconds, referenceSeconds: first.seconds, span: second.span, direction: second.direction, stream: second.stream,
    };
  }
  return best && best.score >= minimumMotionScore ? best : null;
}
