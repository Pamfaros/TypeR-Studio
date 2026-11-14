// Photoshop's Warp Text: a text bent into an arc, a flag, a fish… and still a text.
//
// Photoshop lays the text's bounds on a surface of 4 × 4 control points (a bicubic Bézier
// patch) and draws every point of the letters where the surface puts it. The 16 points
// below are Photoshop's own, measured on Photoshop 2026 from the outlines of warped texts
// (Create Work Path): for each style, Bend, both distortions and both orientations, they
// land within 0.002 px of Photoshop's on 300 cases.
//
// A warp is { style, bend, horizontal, vertical, rotate }: one of STYLES, Bend and the two
// distortions in percent (-100 to 100), and "horizontal" or "vertical" (the orientation).

(function () {
  "use strict";

  const STYLES = ["arc", "arcLower", "arcUpper", "arch", "bulge", "shellLower", "shellUpper", "flag", "wave", "fish", "rise", "fisheye", "inflate", "squeeze", "twist"];
  // Their names in Photoshop's Style list
  const NAMES = { arc: "Arc", arcLower: "Arc Lower", arcUpper: "Arc Upper", arch: "Arch", bulge: "Bulge", shellLower: "Shell Lower", shellUpper: "Shell Upper", flag: "Flag", wave: "Wave", fish: "Fish", rise: "Rise", fisheye: "Fisheye", inflate: "Inflate", squeeze: "Squeeze", twist: "Twist" };
  // Where Photoshop's list draws a line: after the arcs, after the waves
  const GROUPS = [["arc", "arcLower", "arcUpper"], ["arch", "bulge", "shellLower", "shellUpper"], ["flag", "wave", "fish", "rise"], ["fisheye", "inflate", "squeeze", "twist"]];
  // The styles whose middle rows lie straight between the top one and the bottom one
  const RULED = new Set(["arc", "arcLower", "arcUpper", "arch", "bulge", "flag", "fish", "rise"]);

  const percent = (value) => Math.max(-100, Math.min(100, Number(value) || 0));
  // A warp as it is kept: null when there is none
  const clean = (warp) => {
    if (!warp || !STYLES.includes(warp.style)) return null;
    return { style: warp.style, bend: percent(warp.bend), horizontal: percent(warp.horizontal), vertical: percent(warp.vertical), rotate: warp.rotate === "vertical" ? "vertical" : "horizontal" };
  };
  const on = (warp) => Boolean(warp && STYLES.includes(warp.style));
  const keyOf = (warp) => (on(warp) ? [warp.style, warp.bend, warp.horizontal, warp.vertical, warp.rotate].join(",") : "");

  // The points at rest: [across, down] in parts of the bounds, row by row from the top
  const grid = () => {
    const out = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) out.push([i / 3, j / 3]);
    return out;
  };
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const about = (c, p, f) => [c[0] + (p[0] - c[0]) * f, c[1] + (p[1] - c[1]) * f];
  // Rows become columns: the same shape, lying on its side
  const transposed = (points) => {
    const out = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) out.push([points[i * 4 + j][1], points[i * 4 + j][0]]);
    return out;
  };

  // A bent edge is an arc of a circle over |bend| × 180°, drawn as one Bézier curve: its two
  // middle points sit `a` of the edge in from its ends, and `d` of its length away from it.
  // `s` and `c`: the sine and cosine of half the arc.
  const arcOf = (bend) => {
    const angle = Math.abs(bend) * Math.PI;
    if (angle < 1e-9) return { a: 1 / 3, d: 0, s: 0, c: 1 };
    return { a: ((2 / 3) * Math.tan(angle / 4)) / Math.tan(angle / 2), d: (2 / 3) * Math.tan(angle / 4), s: Math.sin(angle / 2), c: Math.cos(angle / 2) };
  };

  // Arc, bent up: the bottom edge an arc resting on the bounds' bottom corners, each row above
  // the same arc further out, around the same centre. `k`: the bounds' width over their height.
  const fan = (bend, k) => {
    const { a, d, s, c } = arcOf(bend);
    if (!s) return grid();
    const radius = 1 / (2 * s);
    const centre = 1 + radius * c * k;
    const edge = [[0, 1], [a, 1 - d * k], [1 - a, 1 - d * k], [1, 1]];
    const out = [];
    for (let j = 0; j < 4; j++) {
      const grown = (radius + (1 - j / 3) / k) / radius;
      for (let i = 0; i < 4; i++) out.push([0.5 + (edge[i][0] - 0.5) * grown, centre + (edge[i][1] - centre) * grown]);
    }
    return out;
  };
  // Bent down, it is the same picture upside down
  const arc = (bend, k) => {
    if (bend >= 0) return fan(bend, k);
    const up = fan(-bend, k);
    const out = [];
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) out.push([up[(3 - j) * 4 + i][0], 1 - up[(3 - j) * 4 + i][1]]);
    return out;
  };

  // Bend alone, in the horizontal orientation. `bend` from -1 to 1.
  const bent = (style, bend, k) => {
    const g = grid();
    const at = (i, j) => g[j * 4 + i];
    const { a, d } = arcOf(bend);
    const lift = (bend < 0 ? -1 : 1) * d * k;
    // The two middle points of each row, in by `a` at `inward` (0 to 1) and moved down by `down`
    const row = (j, inward, down) => {
      at(1, j)[0] = 1 / 3 + (a - 1 / 3) * inward;
      at(2, j)[0] = 2 / 3 - (a - 1 / 3) * inward;
      at(1, j)[1] += down;
      at(2, j)[1] += down;
    };
    const corners = [[1, 1, -1, -1], [2, 1, 1, -1], [1, 2, -1, 1], [2, 2, 1, 1]];
    switch (style) {
      case "arc":
        return arc(bend, k);
      case "arcLower":
        for (let j = 0; j < 4; j++) row(j, j / 3, (lift * j) / 3);
        return g;
      case "arcUpper":
        for (let j = 0; j < 4; j++) row(j, 1 - j / 3, -lift * (1 - j / 3));
        return g;
      case "arch":
        for (let j = 0; j < 4; j++) row(j, 1, -lift);
        return g;
      case "bulge":
        for (let j = 0; j < 4; j++) row(j, 1, -lift * (1 - (2 * j) / 3));
        return g;
      case "shellLower": {
        // The bottom row and the ends of the one above it, as Arc bent the other way
        const from = arc(-bend, k);
        for (let i = 0; i < 4; i++) g[12 + i] = from[12 + i];
        g[8] = from[8];
        g[11] = from[11];
        return g;
      }
      case "shellUpper": {
        const from = arc(bend, k);
        for (let i = 0; i < 4; i++) g[i] = from[i];
        g[4] = from[4];
        g[7] = from[7];
        return g;
      }
      case "flag":
        for (let j = 0; j < 4; j++) {
          at(1, j)[1] -= 2 * bend;
          at(2, j)[1] += 2 * bend;
        }
        return g;
      case "wave":
        for (let j = 1; j < 3; j++) {
          at(1, j)[1] += (4 / 3) * bend;
          at(2, j)[1] -= (4 / 3) * bend;
        }
        return g;
      case "fish":
        for (let j = 0; j < 4; j++) {
          at(1, j)[1] -= 2 * bend * (1 - (2 * j) / 3);
          at(2, j)[1] += 2 * bend * (1 - (2 * j) / 3);
        }
        return g;
      case "rise":
        for (let j = 0; j < 4; j++) {
          at(0, j)[1] += 2 * bend;
          at(1, j)[1] += 2 * bend;
        }
        return g;
      case "fisheye":
        corners.forEach(([i, j, x, y]) => {
          at(i, j)[0] += x * (2 / 3) * bend;
          at(i, j)[1] += y * (2 / 3) * bend;
        });
        return g;
      case "inflate":
      case "squeeze": {
        // The top and bottom edges swell; the sides swell (Inflate) or cave in (Squeeze)
        const side = style === "inflate" ? 1 : -1;
        [1, 2].forEach((n) => {
          at(n, 0)[1] -= bend / 3;
          at(n, 3)[1] += bend / 3;
          at(0, n)[0] -= (side * bend) / 3;
          at(3, n)[0] += (side * bend) / 3;
        });
        corners.forEach(([i, j, x, y]) => {
          at(i, j)[0] += (side * x * bend) / 9;
          at(i, j)[1] += (y * bend) / 9;
        });
        return g;
      }
      case "twist":
        if (bend >= 0) {
          at(1, 1)[0] += bend;
          at(2, 1)[1] += bend;
          at(1, 2)[1] -= bend;
          at(2, 2)[0] -= bend;
        } else {
          at(1, 1)[1] -= bend;
          at(2, 1)[0] += bend;
          at(1, 2)[0] -= bend;
          at(2, 2)[1] += bend;
        }
        return g;
      default:
        return g;
    }
  };

  // Vertical Distortion: each row grows around the middle of its two ends, the top one by
  // 1 - v, the bottom one by 1 + v. `ruled`: only the top and bottom rows, the others laid
  // straight between them again.
  const growRows = (points, v, ruled) => {
    const out = points.map((p) => p.slice());
    (ruled ? [0, 3] : [0, 1, 2, 3]).forEach((j) => {
      const middle = lerp(points[j * 4], points[j * 4 + 3], 0.5);
      for (let i = 0; i < 4; i++) out[j * 4 + i] = about(middle, points[j * 4 + i], 1 + v * ((2 * j) / 3 - 1));
    });
    if (ruled) {
      for (let i = 0; i < 4; i++) {
        out[4 + i] = lerp(out[i], out[12 + i], 1 / 3);
        out[8 + i] = lerp(out[i], out[12 + i], 2 / 3);
      }
    }
    return out;
  };
  // Horizontal Distortion: the same for the columns, the left one by 1 - h, the right one by 1 + h
  const growColumns = (points, h, ruled) => {
    const out = points.map((p) => p.slice());
    (ruled ? [0, 3] : [0, 1, 2, 3]).forEach((i) => {
      const middle = lerp(points[i], points[12 + i], 0.5);
      for (let j = 0; j < 4; j++) out[j * 4 + i] = about(middle, points[j * 4 + i], 1 + h * ((2 * i) / 3 - 1));
    });
    if (ruled) {
      for (let j = 0; j < 4; j++) {
        out[j * 4 + 1] = lerp(out[j * 4], out[j * 4 + 3], 1 / 3);
        out[j * 4 + 2] = lerp(out[j * 4], out[j * 4 + 3], 2 / 3);
      }
    }
    return out;
  };

  // The 16 control points of a warp over bounds `width` × `height`: [across, down] in parts of
  // the bounds, row by row from the top
  const controlPoints = (warp, width, height) => {
    const style = warp.style;
    const bend = percent(warp.bend) / 100;
    const h = percent(warp.horizontal) / 100;
    const v = percent(warp.vertical) / 100;
    const vertical = warp.rotate === "vertical";
    const k = (width || 1) / (height || 1);
    // Vertical: the horizontal shape of bounds lying on their side. Twist turns the same way
    // in both.
    const shape = vertical ? transposed(bent(style, style === "twist" ? -bend : bend, 1 / k)) : bent(style, bend, k);
    const rest = grid();
    const column = (i) => 1 + h * ((2 * i) / 3 - 1);
    const line = (j) => 1 + v * ((2 * j) / 3 - 1);
    const nearColumn = (i) => 1 + h * (i < 2 ? -1 : 1);
    const nearLine = (j) => 1 + v * (j < 2 ? -1 : 1);
    if (style === "inflate" || style === "squeeze") {
      // A swollen edge swells as much as it is long, and the points inside follow the edges
      // nearest to them
      return rest.map((p, n) => {
        const i = n % 4;
        const j = (n - i) / 4;
        return [i / 3 + nearColumn(i) * ((line(j) - 1) * (i / 3 - 0.5) + shape[n][0] - p[0]), 0.5 + column(i) * (j / 3 - 0.5) + (shape[n][1] - p[1]) * nearLine(j)];
      });
    }
    if (style === "wave") {
      // The wave is as high as its column is (as wide as its row, when vertical)
      return rest.map((p, n) => {
        const i = n % 4;
        const j = (n - i) / 4;
        const down = 0.5 + column(i) * (j / 3 - 0.5);
        if (vertical) return [i / 3 + nearColumn(i) * (line(j) - 1) * (i / 3 - 0.5) + (shape[n][0] - p[0]) * line(j), down];
        return [i / 3 + column(i) * (line(j) - 1) * (i / 3 - 0.5), down + (shape[n][1] - p[1]) * column(i)];
      });
    }
    const ruled = RULED.has(style);
    return growColumns(growRows(shape, v, ruled && !vertical), h, ruled && vertical);
  };

  // Where the surface puts a point of the text: `box` ({ left, top, width, height }) is the
  // text's bounds, in the frame the point is given in
  const mapOf = (warp, box) => {
    const points = controlPoints(warp, box.width, box.height);
    const xs = new Float64Array(16);
    const ys = new Float64Array(16);
    points.forEach((p, n) => {
      xs[n] = box.left + p[0] * box.width;
      ys[n] = box.top + p[1] * box.height;
    });
    const w = box.width || 1;
    const h = box.height || 1;
    return (x, y) => {
      const u = (x - box.left) / w;
      const v = (y - box.top) / h;
      const mu = 1 - u;
      const mv = 1 - v;
      const bu0 = mu * mu * mu;
      const bu1 = 3 * u * mu * mu;
      const bu2 = 3 * u * u * mu;
      const bu3 = u * u * u;
      const bv = [mv * mv * mv, 3 * v * mv * mv, 3 * v * v * mv, v * v * v];
      let X = 0;
      let Y = 0;
      for (let j = 0; j < 4; j++) {
        const n = j * 4;
        X += bv[j] * (bu0 * xs[n] + bu1 * xs[n + 1] + bu2 * xs[n + 2] + bu3 * xs[n + 3]);
        Y += bv[j] * (bu0 * ys[n] + bu1 * ys[n + 1] + bu2 * ys[n + 2] + bu3 * ys[n + 3]);
      }
      return [X, Y];
    };
  };

  window.TypeRTextWarp = { STYLES, NAMES, GROUPS, clean, on, keyOf, controlPoints, mapOf };
})();
