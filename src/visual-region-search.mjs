const gridSize = 4;
const scales = [.62, .73, .84, 1, 1.18, 1.45];
const unit = value => Math.max(0, Math.min(1, value));

export function regionTable(pixels, size) {
  const stride = size + 1;
  const tables = Array.from({ length: 5 }, () => new Float32Array(stride ** 2));
  const luminance = index => (.213 * pixels[index] + .715 * pixels[index + 1] + .072 * pixels[index + 2]) / 255;
  for (let y = 1; y <= size; y++) {
    const sums = new Float64Array(tables.length);
    for (let x = 1; x <= size; x++) {
      const i = ((y - 1) * size + x - 1) * 4;
      const light = luminance(i);
      const edge = (x < size ? Math.abs(light - luminance(i + 4)) : 0) +
        (y < size ? Math.abs(light - luminance(i + 4 * size)) : 0);
      const values = [pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255, light, edge];
      for (let n = 0; n < tables.length; n++) {
        sums[n] += values[n];
        tables[n][y * stride + x] = tables[n][(y - 1) * stride + x] + sums[n];
      }
    }
  }
  return (channel, left, top, right, bottom) => {
    const data = tables[channel];
    return (data[bottom * stride + right] - data[top * stride + right] - data[bottom * stride + left] + data[top * stride + left]) /
      ((right - left) * (bottom - top));
  };
}

export function regionSignature(mean, size) {
  const brightness = mean(3, 0, 0, size, size);
  const layout = [];
  for (let y = 0; y < gridSize; y++) for (let x = 0; x < gridSize; x++) {
    const step = size / gridSize;
    layout.push(mean(3, x * step, y * step, (x + 1) * step, (y + 1) * step) - brightness);
  }
  return { colors: [0, 1, 2].map(channel => mean(channel, 0, 0, size, size)),
    brightness, edges: mean(4, 0, 0, size, size), layout };
}

function placements(span) {
  return Array.from({ length: Math.ceil(span / 2) + 1 }, (_, i) => Math.min(span, i * 2));
}

export function proposePictureRegions(mean, signature, side, aspect, scale, roles) {
  const shape = { palette: roles.includes('palette'), lighting: roles.includes('lighting'),
    layout: roles.includes('composition'), texture: roles.includes('texture') };
  const extents = new Set();
  const regions = [];
  for (const fraction of scales) {
    const size = Math.max(.1, Math.min(.99, scale * fraction));
    const width = Math.round(side * Math.min(1, aspect) * size);
    const height = Math.round(side * Math.min(1, 1 / aspect) * size);
    const key = width + 'x' + height;
    if (width < gridSize || height < gridSize || extents.has(key)) continue;
    extents.add(key);
    const xEdges = Array.from({ length: gridSize + 1 }, (_, i) => Math.round(i * width / gridSize));
    const yEdges = Array.from({ length: gridSize + 1 }, (_, i) => Math.round(i * height / gridSize));
    const best = [];
    for (const top of placements(side - height)) for (const left of placements(side - width)) {
      const right = left + width;
      const bottom = top + height;
      const light = mean(3, left, top, right, bottom);
      let loss = shape.lighting ? Math.abs(signature.brightness - light) : 0;
      if (shape.palette) for (let channel = 0; channel < 3; channel++) {
        loss += Math.abs(signature.colors[channel] - mean(channel, left, top, right, bottom)) / 3;
      }
      if (shape.texture) loss += Math.abs(signature.edges - mean(4, left, top, right, bottom));
      if (shape.layout) for (let y = 0; y < gridSize; y++) for (let x = 0; x < gridSize; x++) {
        const cell = mean(3, left + xEdges[x], top + yEdges[y], left + xEdges[x + 1], top + yEdges[y + 1]);
        loss += Math.abs(signature.layout[y * gridSize + x] - (cell - light)) / 4;
      }
      if (best.length < 2 || loss < best.at(-1).loss) {
        best.push({ loss, bounds: [left, top, right, bottom] });
        best.sort((a, b) => a.loss - b.loss);
        if (best.length > 2) best.pop();
      }
    }
    regions.push(...best.map(row => row.bounds.map(edge => unit(edge / side))));
  }
  return regions;
}
