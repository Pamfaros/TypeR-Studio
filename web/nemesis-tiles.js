export const SIDE = 256;
const OVERLAP = 64;
const STRIDE = SIDE - OVERLAP;

function windows(length, start, stop) {
  const size = Math.min(length, SIDE);
  if (stop - start <= size - OVERLAP || length <= SIDE) {
    return [Math.max(0, Math.min(Math.floor((start + stop - size) / 2), length - size))];
  }
  const first = Math.min(Math.max(start - OVERLAP / 2, 0), length - size);
  const last = Math.max(first, Math.min(stop + OVERLAP / 2 - size, length - size));
  const count = Math.ceil((last - first) / STRIDE);
  return Array.from({ length: count + 1 }, (_, i) => first + (count ? Math.floor((last - first) * i / count) : 0));
}

function taper(at, size, start, length) {
  return Math.min(1, start ? (at + 1) / (OVERLAP + 1) : 1,
    start + size < length ? (size - at) / (OVERLAP + 1) : 1);
}

// RGB channels are interleaved RGBA. The selection is one byte per pixel, 1 for a hole.
export async function restoreTiles(rgba, selection, width, height, predict, onProgress) {
  let left = width, top = height, right = 0, bottom = 0;
  for (let at = 0; at < width * height; at++) {
    if (!selection[at]) continue;
    const x = at % width, y = Math.floor(at / width);
    left = Math.min(left, x);
    right = Math.max(right, x + 1);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y + 1);
  }
  if (left === width) return rgba;
  const xs = windows(width, left, right);
  const ys = windows(height, top, bottom);
  const tileWidth = Math.min(SIDE, width);
  const tileHeight = Math.min(SIDE, height);
  const bandWidth = right - left;
  const band = new Float32Array(tileHeight * bandWidth * 4);
  const plane = SIDE * SIDE;
  const rgb = new Float32Array(plane * 3);
  const mask = new Float32Array(plane);
  let previous = ys[0];
  let completed = 0;

  const flush = (rows) => {
    for (let row = 0; row < rows; row++) {
      for (let x = 0; x < bandWidth; x++) {
        const k = 4 * (row * bandWidth + x);
        if (band[k + 3] <= 0) continue;
        const at = 4 * ((previous + row) * width + left + x);
        for (let c = 0; c < 3; c++) rgba[at + c] = 255 * band[k + c] / band[k + 3];
      }
    }
    const shift = rows * bandWidth * 4;
    band.copyWithin(0, shift);
    band.fill(0, band.length - shift);
  };

  for (const y0 of ys) {
    if (y0 !== previous) flush(y0 - previous);
    previous = y0;
    for (const x0 of xs) {
      mask.fill(0);
      let active = false;
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const at = (y0 + y) * width + x0 + x;
          if (!selection[at]) continue;
          mask[y * SIDE + x] = 1;
          active = true;
        }
      }
      if (active) {
        for (let y = 0; y < SIDE; y++) {
          const row = (y0 + Math.min(y, tileHeight - 1)) * width + x0;
          for (let x = 0; x < SIDE; x++) {
            const at = 4 * (row + Math.min(x, tileWidth - 1));
            const alpha = rgba[at + 3] / 255;
            for (let c = 0; c < 3; c++) rgb[c * plane + y * SIDE + x] = rgba[at + c] / 255 * alpha + 1 - alpha;
          }
        }
        const restored = await predict(rgb, mask);
        for (let y = 0; y < tileHeight; y++) {
          const wy = taper(y, tileHeight, y0, height);
          for (let x = Math.max(0, left - x0); x < Math.min(tileWidth, right - x0); x++) {
            const at = y * SIDE + x;
            if (!mask[at]) continue;
            const k = 4 * (y * bandWidth + x0 + x - left);
            const weight = wy * taper(x, tileWidth, x0, width);
            for (let c = 0; c < 3; c++) band[k + c] += restored[at + c * plane] * weight;
            band[k + 3] += weight;
          }
        }
      }
      onProgress?.(++completed, xs.length * ys.length);
    }
  }
  flush(tileHeight);
  return rgba;
}
