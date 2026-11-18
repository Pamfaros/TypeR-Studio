// The perspective of a surface, read from the page: the lines drawn on it, its edges and the
// rows of the text written on it all point at two vanishing points, one along the writing
// and one down it. The zone they give of the page, a quadrilateral, is that surface: what is
// laid on it sits there as what was written there (perspective-tool.js, and surfacesOf in
// photoshop.js). Nothing here touches the page or the screen.
(function () {
  "use strict";

  /* ------------------------------ the picture ------------------------------ */

  // Gaussian blur of a w × h Float32Array, the edges repeated
  const blur = (src, w, h, sigma, out) => {
    const dst = out || new Float32Array(w * h);
    if (sigma < 0.3) {
      dst.set(src);
      return dst;
    }
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(radius * 2 + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      kernel[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
      sum += kernel[i + radius];
    }
    for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
          acc += src[row + xx] * kernel[k + radius];
        }
        tmp[row + x] = acc;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
          acc += tmp[yy * w + x] * kernel[k + radius];
        }
        dst[y * w + x] = acc;
      }
    }
    return dst;
  };

  // The picture at 1/n of its size, each pixel the mean of n × n
  const shrink = (src, w, h, n) => {
    const W = Math.floor(w / n);
    const H = Math.floor(h / n);
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) acc += src[(y * n + j) * w + x * n + i];
      out[y * W + x] = acc / (n * n);
    }
    return { data: out, w: W, h: H };
  };

  // The thin ridges where the picture has one clear direction: the edges of its lines.
  // A screentone has none, its dots face every way at once. Each: [x, y, angle], the angle
  // of the edge between 0 and π. `ink`, if given, takes how much of a line or a letter each
  // pixel shows, from 0 to 1.
  const edgesOf = (gray, w, h, ink) => {
    const soft = blur(gray, w, h, 1);
    const xx = new Float32Array(w * h);
    const xy = new Float32Array(w * h);
    const yy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (soft[i + 1] - soft[i - 1]) / 2;
      const gy = (soft[i + w] - soft[i - w]) / 2;
      xx[i] = gx * gx;
      xy[i] = gx * gy;
      yy[i] = gy * gy;
    }
    blur(xx, w, h, 2, xx);
    blur(xy, w, h, 2, xy);
    blur(yy, w, h, 2, yy);
    const energy = soft;
    let strongest = 0;
    for (let i = 0; i < w * h; i++) {
      energy[i] = xx[i] + yy[i];
      if (energy[i] > strongest) strongest = energy[i];
    }
    const edges = [];
    if (!strongest) return edges;
    const floor = strongest * 0.0036;
    const at = (x, y) => {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const i = y0 * w + x0;
      return (energy[i] * (1 - fx) + energy[i + 1] * fx) * (1 - fy) + (energy[i + w] * (1 - fx) + energy[i + w + 1] * fx) * fy;
    };
    for (let y = 2; y < h - 3; y++) for (let x = 2; x < w - 3; x++) {
      const i = y * w + x;
      const e = energy[i];
      if (e < floor) continue;
      const coherence = Math.hypot(xx[i] - yy[i], 2 * xy[i]) / e;
      if (ink) ink[i] = coherence * coherence * Math.min(1, Math.sqrt(e / strongest) / 0.3);
      if (coherence < 0.6) continue;
      // Across the edge, the way the grey changes
      const across = Math.atan2(2 * xy[i], xx[i] - yy[i]) / 2;
      const nx = Math.cos(across);
      const ny = Math.sin(across);
      const before = at(x - nx, y - ny);
      const after = at(x + nx, y + ny);
      if (e < before || e <= after) continue;
      // The top of the ridge, between the pixels
      const bend = before - 2 * e + after;
      const shift = bend < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (before - after)) / bend)) : 0;
      let angle = across + Math.PI / 2;
      if (angle >= Math.PI) angle -= Math.PI;
      if (angle < 0) angle += Math.PI;
      edges.push([x + nx * shift, y + ny * shift, angle]);
    }
    return edges;
  };

  // The straight lines among these edges, at least `least` pixels of them: each
  // { x, y, dx, dy, length }, a point of the line, its direction, how many pixels show it.
  // `kept[i]` is set for each edge a line took.
  const HALF_DEGREES = 360;
  const linesOf = (edges, w, h, least, kept) => {
    const cx = w / 2;
    const cy = h / 2;
    const reach = Math.ceil(Math.hypot(cx, cy)) + 2;
    const width = 2 * reach + 1;
    const votes = new Float32Array(HALF_DEGREES * width);
    const cos = new Float64Array(HALF_DEGREES);
    const sin = new Float64Array(HALF_DEGREES);
    for (let a = 0; a < HALF_DEGREES; a++) {
      cos[a] = Math.cos((a * Math.PI) / HALF_DEGREES);
      sin[a] = Math.sin((a * Math.PI) / HALF_DEGREES);
    }
    // How far the line through (x, y) at angle `a` passes from the middle, and on which side
    const offset = (x, y, a) => -(x - cx) * sin[a] + (y - cy) * cos[a];
    const vote = (edge, sign) => {
      const a0 = Math.round((edge[2] * HALF_DEGREES) / Math.PI);
      for (let k = -2; k <= 2; k++) {
        const raw = a0 + k;
        const a = ((raw % HALF_DEGREES) + HALF_DEGREES) % HALF_DEGREES;
        // Half a turn on, the same line is seen from its other side
        const flip = Math.floor(raw / HALF_DEGREES) % 2 ? -1 : 1;
        const r = Math.round(flip * offset(edge[0], edge[1], a)) + reach;
        if (r >= 0 && r < width) votes[a * width + r] += sign * (3 - Math.abs(k));
      }
    };
    edges.forEach((edge) => vote(edge, 1));
    const used = new Uint8Array(edges.length);
    const lines = [];
    for (let round = 0; round < 400; round++) {
      let top = 0;
      let peak = -1;
      for (let i = 0; i < votes.length; i++) if (votes[i] > top) {
        top = votes[i];
        peak = i;
      }
      if (top < least * 1.5) break;
      const a = Math.floor(peak / width);
      const r = (peak % width) - reach;
      // The edges this line goes through, then the line that goes best through them, twice
      let dx = cos[a];
      let dy = sin[a];
      let px = cx - r * sin[a];
      let py = cy + r * cos[a];
      let members = [];
      for (let pass = 0; pass < 3; pass++) {
        const near = pass ? 1.25 : 2.5;
        const turn = Math.atan2(dy, dx);
        members = [];
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < edges.length; i++) {
          if (used[i]) continue;
          const e = edges[i];
          if (Math.abs((e[0] - px) * dy - (e[1] - py) * dx) > near) continue;
          if (apart(e[2], turn) > 6 * DEG) continue;
          members.push(i);
          sx += e[0];
          sy += e[1];
        }
        if (members.length < 2) break;
        px = sx / members.length;
        py = sy / members.length;
        let sxx = 0;
        let sxy = 0;
        let syy = 0;
        members.forEach((i) => {
          const ux = edges[i][0] - px;
          const uy = edges[i][1] - py;
          sxx += ux * ux;
          sxy += ux * uy;
          syy += uy * uy;
        });
        const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
      }
      // Not a line after all: the peak goes, so that the next one is looked at
      if (members.length < least) {
        votes[peak] = 0;
        if (members.length < 2) continue;
        // A stroke of a letter, a bit of a curve: its edges vote no more
        members.forEach((i) => {
          used[i] = 1;
          vote(edges[i], -1);
        });
        continue;
      }
      let from = Infinity;
      let to = -Infinity;
      members.forEach((i) => {
        const t = (edges[i][0] - px) * dx + (edges[i][1] - py) * dy;
        from = Math.min(from, t);
        to = Math.max(to, t);
        used[i] = 1;
        vote(edges[i], -1);
      });
      votes[peak] = 0;
      // Edges in a row by chance leave more gaps than line
      if (members.length < 0.4 * (to - from)) continue;
      members.forEach((i) => { kept[i] = 1; });
      lines.push({ x: px, y: py, dx, dy, length: members.length });
    }
    return lines;
  };

  /* ------------------------------ rows of writing ------------------------------ */

  const DEG = Math.PI / 180;
  const apart = (a, b) => {
    const d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
  };

  // How many slices the ink fills, counting a slice with little ink for little: as many as
  // there are when it is shared evenly, a single one when it is all in one. A thin line
  // left among the letters counts for the little ink it is, however sharp.
  const filledSlices = (bins, first, last, total) => {
    let entropy = 0;
    for (let b = first; b <= last; b++) {
      if (bins[b] <= 0) continue;
      const share = bins[b] / total;
      entropy -= share * Math.log(share);
    }
    return Math.exp(entropy);
  };
  // Parallel lines cut a round patch of the picture into thin slices. Along the writing,
  // each row fills some slices and leaves the ones between empty: the ink is as unevenly
  // shared as it can be. `points`: [x, y, ink] flat, from the middle of the patch.
  const unevenness = (points, count, angle, thin, bins) => {
    const dx = Math.cos(angle) / thin;
    const dy = Math.sin(angle) / thin;
    const half = bins.length >> 1;
    bins.fill(0);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const t = points[3 * i + 1] * dx - points[3 * i] * dy + half;
      const b = Math.floor(t);
      const f = t - b;
      const ink = points[3 * i + 2];
      bins[b] += ink * (1 - f);
      bins[b + 1] += ink * f;
      total += ink;
    }
    return total ? bins.length / filledSlices(bins, 0, bins.length - 1, total) : 0;
  };
  // Which way the writing runs in each part of the picture: round patches of `radius`, laid
  // half over one another, each giving the line its rows follow, as { x, y, dx, dy, length,
  // row }. Looked for within 60° of `lean`, the way the text is expected to run. A patch
  // with no writing, or whose ink lines up no better one way than another, says nothing.
  const SWEEP = 60;
  const rowsOf = (ink, w, h, wanted, lean, lines) => {
    const THIN = 2;
    // Whole patches only: one cut by the edge of the picture has its rows cut along that
    // edge, and takes it for the way they run
    const radius = Math.min(wanted, Math.floor(Math.min(w, h) / 2) - 1);
    if (radius < 16) return;
    const bins = new Float64Array(2 * Math.ceil(radius / THIN) + 4);
    const scores = new Float64Array(2 * SWEEP + 1);
    const spread = (size) => {
      const count = Math.max(1, Math.ceil((size - 2 * radius) / radius) + 1);
      return Array.from({ length: count }, (_, i) => (count === 1 ? size / 2 : radius + ((size - 2 * radius) * i) / (count - 1)));
    };
    const across = spread(w);
    for (const cy of spread(h)) for (const cx of across) {
      const all = [];
      let sx = 0;
      let sy = 0;
      let mass = 0;
      for (let y = Math.max(0, Math.ceil(cy - radius)); y <= Math.min(h - 1, Math.floor(cy + radius)); y++) for (let x = Math.max(0, Math.ceil(cx - radius)); x <= Math.min(w - 1, Math.floor(cx + radius)); x++) {
        const value = ink[y * w + x];
        if (value < 0.05 || (x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
        all.push(x - cx, y - cy, value);
        sx += x * value;
        sy += y * value;
        mass += value;
      }
      let count = all.length / 3;
      if (count < 120) continue;
      // Every nth point of a crowded patch tells as much
      const skip = Math.ceil(count / 4000);
      const points = new Float64Array(skip > 1 ? Math.floor(count / skip) * 3 : all.length);
      for (let i = 0; i < points.length / 3; i++) for (let k = 0; k < 3; k++) points[3 * i + k] = all[3 * i * skip + k];
      count = points.length / 3;
      let top = 0;
      for (let a = 0; a <= 2 * SWEEP; a++) {
        scores[a] = unevenness(points, count, lean + (a - SWEEP) * DEG, THIN, bins);
        if (scores[a] > scores[top]) top = a;
      }
      // At the end of the sweep, the rows run some other way
      if (top === 0 || top === 2 * SWEEP) continue;
      const usual = Array.from(scores).sort((p, q) => p - q)[SWEEP];
      const stands = scores[top] / usual;
      if (stands < 1.25) continue;
      // Closer: a tenth of a degree, then the top of the curve through the three best
      let angle = lean + (top - SWEEP) * DEG;
      let best = scores[top];
      const around = angle;
      for (let k = -9; k <= 9; k++) {
        const score = unevenness(points, count, around + (k / 10) * DEG, THIN, bins);
        if (score > best) {
          best = score;
          angle = around + (k / 10) * DEG;
        }
      }
      const before = unevenness(points, count, angle - 0.1 * DEG, THIN, bins);
      const after = unevenness(points, count, angle + 0.1 * DEG, THIN, bins);
      const bend = before - 2 * best + after;
      if (bend < 0) angle += Math.max(-0.1, Math.min(0.1, (0.05 * (before - after)) / bend)) * DEG;
      const clear = Math.min(1, (stands - 1.25) / 0.5 + 0.2);
      lines.push({ x: sx / mass, y: sy / mass, dx: Math.cos(angle), dy: Math.sin(angle), length: 3 * radius * clear, row: true, clear });
    }
  };

  /* ------------------------------ vanishing points ------------------------------ */

  // A vanishing point is [x, y, w]: the point (x/w, y/w), or, at w = 0, the direction (x, y)
  // of lines that stay parallel. Coordinates here are centred and in parts of the zone's
  // half diagonal, so that a far point and a near one weigh alike. What points at one is a
  // list of [x, y, dx, dy]: a place and the direction seen there.
  // How far each is from pointing at `v`: the sine of the angle, squared
  const off2 = (e, v) => {
    const ux = v[0] - e[0] * v[2];
    const uy = v[1] - e[1] * v[2];
    const cross = e[2] * uy - e[3] * ux;
    return (cross * cross) / (ux * ux + uy * uy || 1e-12);
  };
  const scoreOf = (seen, weights, v, tight2) => {
    let score = 0;
    for (let i = 0; i < seen.length; i++) {
      if (!weights[i]) continue;
      const s2 = off2(seen[i], v);
      if (s2 < tight2) {
        const t = 1 - s2 / tight2;
        score += weights[i] * t * t;
      }
    }
    return score;
  };
  // The unit vector a symmetric 3 × 3 matrix [xx, xy, xz, yy, yz, zz] shrinks most
  const smallestAxis = ([a, b, c, d, e, f]) => {
    // Inverse iteration: the inverse stretches that vector most
    const trace = a + d + f;
    if (!(trace > 0)) return null;
    const eps = trace * 1e-10;
    const A = a + eps;
    const D = d + eps;
    const F = f + eps;
    const det = A * (D * F - e * e) - b * (b * F - e * c) + c * (b * e - D * c);
    if (!det) return null;
    const inv = [(D * F - e * e) / det, (c * e - b * F) / det, (b * e - c * D) / det, (A * F - c * c) / det, (b * c - A * e) / det, (A * D - b * b) / det];
    let v = [1, 1, 1];
    for (let i = 0; i < 60; i++) {
      const x = inv[0] * v[0] + inv[1] * v[1] + inv[2] * v[2];
      const y = inv[1] * v[0] + inv[3] * v[1] + inv[4] * v[2];
      const z = inv[2] * v[0] + inv[4] * v[1] + inv[5] * v[2];
      const length = Math.hypot(x, y, z) || 1;
      v = [x / length, y / length, z / length];
    }
    return v;
  };
  // Lines that nothing shows to meet stay parallel. How near a vanishing point is, in half
  // diagonals of the zone, is taken to be about this before anything is seen: what points
  // at it has to be precise enough, and spread enough across the zone, to say otherwise.
  const NEARNESS = 0.3;
  // The point everything pointing near `v` agrees on best: each within `tight` radians
  // pulls it, the closer the harder, and the more precisely it points (`precision`: one
  // over the square of how far off it can be, in radians), again and again
  const settle = (seen, precision, start, tight) => {
    let v = start;
    const tight2 = Math.sin(tight) ** 2;
    for (let round = 0; round < 12; round++) {
      const m = [0, 0, 0, 0, 0, 0];
      let used = 0;
      for (let i = 0; i < seen.length; i++) {
        if (!precision[i]) continue;
        const e = seen[i];
        const s2 = off2(e, v);
        if (s2 >= tight2) continue;
        const t = 1 - s2 / tight2;
        const k = precision[i] * t * t;
        // The line through it: (-dy, dx, x·dy - y·dx)
        const a = -e[3];
        const b = e[2];
        const c = e[0] * e[3] - e[1] * e[2];
        m[0] += k * a * a;
        m[1] += k * a * b;
        m[2] += k * a * c;
        m[3] += k * b * b;
        m[4] += k * b * c;
        m[5] += k * c * c;
        used++;
      }
      if (used < 2) break;
      m[5] += 1 / (NEARNESS * NEARNESS);
      const next = smallestAxis(m);
      if (!next) break;
      const same = Math.abs(next[0] * v[0] + next[1] * v[1] + next[2] * v[2]) / (Math.hypot(v[0], v[1], v[2]) || 1);
      v = next;
      if (same > 1 - 1e-11) break;
    }
    return v;
  };
  // Which way lines to `v` run at the middle of the zone, between -90° and 90°
  const headingOf = (v) => Math.atan(v[1] / (v[0] || 1e-12));

  // Every point lines could run to, a degree and a twentieth of the half diagonal apart:
  // from parallel lines to a point just inside the zone
  const CANDIDATES = (() => {
    const list = [];
    for (let a = 0; a < 180; a++) for (let q = -24; q <= 24; q++) list.push([Math.cos(a * DEG), Math.sin(a * DEG), q / 20]);
    return list;
  })();
  const LOOSE = 2.5 * DEG;
  const settled = (seen, precision, from) => settle(seen, precision, settle(seen, precision, settle(seen, precision, from, LOOSE), 1.5 * DEG), 1 * DEG);
  // `weights`: how much each thing seen counts when the points are compared, the length of
  // line it stands for; `precision`: when the point is then settled
  const best = (seen, weights, precision, allowed) => {
    const tight2 = Math.sin(LOOSE) ** 2;
    let top = null;
    let topScore = 0;
    for (let i = 0; i < CANDIDATES.length; i++) {
      const v = CANDIDATES[i];
      if (!allowed(v)) continue;
      // A point nearer than another has to be shown by more
      const score = scoreOf(seen, weights, v, tight2) * (1 - 0.1 * Math.abs(v[2]));
      if (score > topScore) {
        topScore = score;
        top = v;
      }
    }
    if (!top) return null;
    const v = settled(seen, precision, top);
    return allowed(v) ? v : top;
  };
  const supportOf = (seen, weights, v, tight, from = 0, to = seen.length) => {
    const tight2 = Math.sin(tight) ** 2;
    let sum = 0;
    for (let i = from; i < to; i++) if (weights[i] && off2(seen[i], v) < tight2) sum += weights[i];
    return sum;
  };

  /* ------------------------------ the surface ------------------------------ */

  // The surface shown in a w × h zone of grey levels (0 to 255): { across, down }, the
  // vanishing points of its writing and of its upright, in the zone's pixels, and which of
  // them the zone showed (`found`): the other is the text's own, its lines parallel.
  // `lean`: which way the text to lay there runs, in radians. null where the zone shows
  // neither a straight line nor a row of writing.
  //
  // Three things point at them. The lines drawn on the surface and its edges, at both. The
  // rows of what is written on it, at the first: a letter's own strokes lean as the hand
  // that wrote them did, but its rows follow the surface. And the upright strokes of the
  // letters, at the second, where no line does.
  const detect = (gray, w, h, options = {}) => {
    let picture = { data: Float32Array.from(gray), w, h };
    let scale = 1;
    while (Math.max(picture.w, picture.h) > 720) {
      picture = shrink(picture.data, picture.w, picture.h, 2);
      scale *= 2;
    }
    const W = picture.w;
    const H = picture.h;
    if (W < 24 || H < 24) return null;
    const lean = options.lean || 0;
    const least = Math.max(24, 0.1 * Math.hypot(W, H));
    const ink = new Float32Array(W * H);
    const edges = edgesOf(picture.data, W, H, ink);
    const kept = new Uint8Array(edges.length);
    const drawn = linesOf(edges, W, H, least, kept);
    // What a line drew is no writing
    edges.forEach((edge, i) => {
      if (!kept[i]) return;
      const x0 = Math.round(edge[0]);
      const y0 = Math.round(edge[1]);
      for (let y = Math.max(0, y0 - 7); y <= Math.min(H - 1, y0 + 7); y++) for (let x = Math.max(0, x0 - 7); x <= Math.min(W - 1, x0 + 7); x++) ink[y * W + x] = 0;
    });
    // Its rows, looked for twice: as it is, for small writing, and at half its size, where
    // the dots of a screentone have melted into grey and leave the letters alone
    const rows = [];
    const size = Math.max(W, H);
    rowsOf(ink, W, H, Math.max(32, Math.round(0.11 * size)), lean, rows);
    const half = shrink(picture.data, W, H, 2);
    const halfInk = new Float32Array(half.w * half.h);
    if (Math.min(half.w, half.h) >= 24) {
      edgesOf(half.data, half.w, half.h, halfInk);
      edges.forEach((edge, i) => {
        if (!kept[i]) return;
        const x0 = Math.round(edge[0] / 2);
        const y0 = Math.round(edge[1] / 2);
        for (let y = Math.max(0, y0 - 4); y <= Math.min(half.h - 1, y0 + 4); y++) for (let x = Math.max(0, x0 - 4); x <= Math.min(half.w - 1, x0 + 4); x++) halfInk[y * half.w + x] = 0;
      });
      const halfRows = [];
      rowsOf(halfInk, half.w, half.h, Math.max(24, Math.round(0.055 * size)), lean, halfRows);
      rowsOf(halfInk, half.w, half.h, Math.max(32, Math.round(0.095 * size)), lean, halfRows);
      halfRows.forEach((line) => rows.push(Object.assign(line, { x: line.x * 2 + 0.5, y: line.y * 2 + 0.5, length: line.length * 2 })));
    }
    const strokes = [];
    edges.forEach((edge, i) => {
      if (!kept[i] && ink[Math.round(edge[1]) * W + Math.round(edge[0])] > 0) strokes.push(edge);
    });

    const cx = W / 2;
    const cy = H / 2;
    const R = Math.hypot(cx, cy);
    const seen = (line) => [(line.x - cx) / R, (line.y - cy) / R, line.dx, line.dy];
    const upright = lean + Math.PI / 2;

    // The writing: the lines and the rows that run about as the text does. When the rows
    // run another way than the lines, the lines are those of something else, a wall behind,
    // drawn longer: then the rows say, and only the lines that run with them count.
    const along = drawn.concat(rows).filter((line) => apart(Math.atan2(line.dy, line.dx), lean) < 60 * DEG);
    const alongSeen = along.map(seen);
    const alongWeights = Float64Array.from(along, (line) => line.length);
    // A line points as precisely as it is long, down to a quarter of a degree, the hand
    // that drew it; the rows of a patch, to a degree and a half at best
    const exact = (line) => (line.row ? line.clear / (0.025 * 0.025) : 1 / Math.max(0.004, 1.2 / line.length) ** 2);
    const alongPrecision = Float64Array.from(along, exact);
    const leaning = (v) => apart(headingOf(v), lean) < 50 * DEG;
    const rowsOnly = Float64Array.from(along, (line) => (line.row ? line.length : 0));
    const written = rowsOnly.reduce((sum, value) => sum + value, 0);
    let across = best(alongSeen, alongWeights, alongPrecision, leaning);
    if (across && supportOf(alongSeen, alongWeights, across, 2 * DEG) < 1.2 * least) across = null;
    if (across && written && supportOf(alongSeen, rowsOnly, across, 3 * DEG) < 0.5 * written) {
      const byRows = best(alongSeen, rowsOnly, Float64Array.from(along, (line) => (line.row ? exact(line) : 0)), leaning);
      if (byRows && supportOf(alongSeen, rowsOnly, byRows, 3 * DEG) > Math.max(0.5 * written, 2 * least)) {
        const wide2 = Math.sin(5 * DEG) ** 2;
        across = settled(alongSeen, Float64Array.from(alongPrecision, (weight, i) => (off2(alongSeen[i], byRows) < wide2 ? weight : 0)), byRows);
      }
    }

    // The upright: the lines that stand, and the strokes of the letters
    const acrossHeading = across ? headingOf(across) : lean;
    const stands = (angle) => apart(angle, upright) < 50 * DEG && apart(angle, acrossHeading) > 20 * DEG;
    const posts = drawn.filter((line) => stands(Math.atan2(line.dy, line.dx)));
    const every = Math.max(1, Math.ceil(strokes.length / 3000));
    const stems = strokes.filter((edge, i) => i % every === 0 && stands(edge[2]));
    const standing = posts.map(seen).concat(stems.map((edge) => [(edge[0] - cx) / R, (edge[1] - cy) / R, Math.cos(edge[2]), Math.sin(edge[2])]));
    const standingWeights = new Float64Array(standing.length);
    posts.forEach((line, i) => {
      standingWeights[i] = line.length;
    });
    // All the strokes together weigh as two lines would: where lines say, they add little
    let stemWeight = 0;
    for (let i = posts.length; i < standing.length; i++) {
      standingWeights[i] = (2 * least) / Math.max(stems.length, 300);
      stemWeight += standingWeights[i];
    }
    // A stroke alone points anywhere within ten degrees
    const standingPrecision = Float64Array.from(standing, (item, i) => (i < posts.length ? exact(posts[i]) : 1 / (0.18 * 0.18)));
    let down = best(standing, standingWeights, standingPrecision, (v) => apart(headingOf(v), upright) < 45 * DEG && apart(headingOf(v), acrossHeading) > 25 * DEG);
    if (down) {
      const byLines = supportOf(standing, standingWeights, down, 2 * DEG, 0, posts.length);
      const byStems = supportOf(standing, standingWeights, down, 2 * DEG, posts.length);
      // One line at least, or a fifth of the strokes that stand
      if (byLines < least && (stems.length < 150 || byStems < 0.2 * stemWeight)) down = null;
    }
    if (!across && !down) return null;

    const parallel = (angle) => [Math.cos(angle), Math.sin(angle), 0];
    const toZone = (v) => {
      // Back to the zone's pixels
      const x = (v[0] * R + cx * v[2]) * scale;
      const y = (v[1] * R + cy * v[2]) * scale;
      const n = Math.hypot(x, y, v[2]) || 1;
      return [x / n, y / n, v[2] / n];
    };
    return {
      across: toZone(across || parallel(lean)),
      down: toZone(down || parallel(upright)),
      found: { across: Boolean(across), down: Boolean(down) },
    };
  };

  /* ------------------------------ a zone of it ------------------------------ */

  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // The zone of a surface a rectangle of the page shows: four corners (top left, top right,
  // bottom right, bottom left), its top and bottom running to `plane.across`, its sides to
  // `plane.down`, each through the middle of a side of the rectangle. `lean`: which way the
  // writing runs there. null where the surface turns away inside the rectangle.
  const zoneOn = (plane, rect, lean = 0) => {
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const hw = (rect.right - rect.left) / 2;
    const hh = (rect.bottom - rect.top) / 2;
    const along = [Math.cos(lean), Math.sin(lean)];
    const over = [-along[1], along[0]];
    // How far the rectangle goes along the writing, and across it
    const reach = ([x, y]) => Math.abs(x) * hw + Math.abs(y) * hh;
    const through = (v, [x, y], far) => cross(v, [cx + x * far, cy + y * far, 1]);
    const top = through(plane.across, over, -reach(over));
    const bottom = through(plane.across, over, reach(over));
    const left = through(plane.down, along, -reach(along));
    const right = through(plane.down, along, reach(along));
    const meet = (a, b) => {
      const p = cross(a, b);
      return Math.abs(p[2]) > 1e-9 * (Math.abs(p[0]) + Math.abs(p[1]) + 1e-12) ? [p[0] / p[2], p[1] / p[2]] : null;
    };
    const corners = [meet(top, left), meet(top, right), meet(bottom, right), meet(bottom, left)];
    if (!corners.every(Boolean)) return null;
    // A zone that reads the right way round, and no larger than a few rectangles
    const limit = 4 * Math.hypot(hw, hh);
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = corners[i];
      const [bx, by] = corners[(i + 1) % 4];
      const [px, py] = corners[(i + 2) % 4];
      if ((bx - ax) * (py - by) - (by - ay) * (px - bx) <= 0 || Math.hypot(ax - cx, ay - cy) > limit) return null;
    }
    return corners;
  };
  // How long a step of one along each side of a quadrilateral shows on the page, at (u, v)
  const stepsAt = (m, u, v) => {
    const w = m[6] * u + m[7] * v + 1;
    const x = (m[0] * u + m[1] * v + m[2]) / w;
    const y = (m[3] * u + m[4] * v + m[5]) / w;
    return [Math.hypot(m[0] - m[6] * x, m[3] - m[6] * y) / Math.abs(w), Math.hypot(m[1] - m[7] * x, m[4] - m[7] * y) / Math.abs(w)];
  };
  // How many pixels of text a zone is wide and tall: [across, down]. What is written on it
  // shows `size` times its own size in the middle of the zone, 1 for as typed.
  //
  // Lines that meet tell how the surface is turned, not how much that narrows what is on
  // it: that takes how far the eye is, `focal` pixels, which no page says. Lines that stay
  // parallel narrow nothing; the nearer their vanishing point, the more.
  const unitOf = (corners, focal, size = 1) => {
    const m = squareTo(corners);
    const [cx, cy] = onQuad(m, 0.5, 0.5) || corners[0];
    const narrowed = (x, y, w) => {
      const length = Math.hypot(x - cx * w, y - cy * w);
      const far = Math.abs(w) > 1e-12 * length ? length / Math.abs(w) : Infinity;
      return focal && Number.isFinite(far) ? far / Math.hypot(far, focal) : 1;
    };
    const across = narrowed(m[0], m[3], m[6]);
    const down = narrowed(m[1], m[4], m[7]);
    const most = Math.max(across, down) || 1;
    const [du, dv] = stepsAt(m, 0.5, 0.5);
    return [(du * most) / (size * across), (dv * most) / (size * down)];
  };
  // How large what is written on a zone shows in its middle, along its height
  const sizeOn = (corners, unit, focal) => {
    const [, tall] = unitOf(corners, focal, 1);
    return tall / unit[1];
  };

  // From the unit square to a quadrilateral: [a, b, c, d, e, f, g, h] with
  // (u, v) → ((a·u + b·v + c) / w, (d·u + e·v + f) / w), w = g·u + h·v + 1
  const squareTo = ([p0, p1, p2, p3]) => {
    const dx1 = p1[0] - p2[0];
    const dx2 = p3[0] - p2[0];
    const sx = p0[0] - p1[0] + p2[0] - p3[0];
    const dy1 = p1[1] - p2[1];
    const dy2 = p3[1] - p2[1];
    const sy = p0[1] - p1[1] + p2[1] - p3[1];
    const den = dx1 * dy2 - dx2 * dy1;
    const g = den ? (sx * dy2 - dx2 * sy) / den : 0;
    const h = den ? (dx1 * sy - sx * dy1) / den : 0;
    return [p1[0] - p0[0] + g * p1[0], p3[0] - p0[0] + h * p3[0], p0[0], p1[1] - p0[1] + g * p1[1], p3[1] - p0[1] + h * p3[1], p0[1], g, h];
  };
  // Where (u, v) of the square lands; null past the line the surface vanishes on
  const onQuad = (m, u, v) => {
    const w = m[6] * u + m[7] * v + 1;
    return w < 0.05 ? null : [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
  };
  // Which (u, v) of the square lands on a point of the page
  const fromQuad = (m, x, y) => {
    const [a, b, c, d, e, f, g, h] = m;
    // The inverse of the 3 × 3 matrix, up to a factor
    const A = e - f * h;
    const B = c * h - b;
    const C = b * f - c * e;
    const D = f * g - d;
    const E = a - c * g;
    const F = c * d - a * f;
    const G = d * h - e * g;
    const H = b * g - a * h;
    const I = a * e - b * d;
    const w = G * x + H * y + I;
    return w ? [(A * x + B * y + C) / w, (D * x + E * y + F) / w] : null;
  };
  const api = { detect, zoneOn, unitOf, sizeOn, squareTo, onQuad, fromQuad };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.TypeRPerspective = api;
})();
