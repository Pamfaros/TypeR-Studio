// Clip Studio Paint's files, read: brushes (.sut) and documents of materials (.clip), and the
// archives they come in (.zip, .7z). Nothing here touches the page: bytes in, plain objects out,
// so it runs in a worker (csp-worker.js) as well as in tests.
//
//   a .sut     one sub tool, kept as a SQLite database: its settings are a row of the table
//              Variant (some two hundred columns), its brush tips and paper texture are in the
//              table MaterialFile, each a tar holding a preview and the picture at full size.
//              readSut() gives { brushes: [{ name, settings, tips, texture, notes }] }, the
//              settings already in TypeR's own terms (see brushOf): brush-engine.js draws them.
//   a .clip    a document: a few named chunks, one a SQLite database (the layers), the others
//              the pixels, in 256 × 256 blocks. A document of materials holds one material a
//              layer. readClip() gives { materials: [{ name, group, width, height, rgba,
//              tiling }] }: an image material layer gives its picture as it was before being
//              placed, any other layer the pixels it shows.
//   a picture  { width, height, alpha, gray?, rgb? }: one byte a pixel in each plane. A tip with
//              alpha alone is painted in the colour chosen; with grey, black is that colour and
//              white the background colour; with rgb it keeps its own colours.
//
// The full-size picture of a brush tip sits in a database whose first pages are not readable:
// only the rest of it is read here, tables being found by what their rows hold. A tip that
// can't be read that way falls back on the preview kept beside it.

(function (root, factory) {
  const made = factory(root);
  if (typeof module === "object" && module.exports) module.exports = made;
  else root.TypeRCSP = made;
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  "use strict";

  const inflater = () => {
    const pako = root.pako || (typeof globalThis !== "undefined" && globalThis.pako);
    if (!pako) throw new Error("csp: no inflate");
    return pako;
  };
  const u8 = (value) => (value instanceof Uint8Array ? value : new Uint8Array(value));
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const le32 = (b, o) => ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;
  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const le16 = (b, o) => (b[o + 1] << 8) | b[o];
  const beF64 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0);
  const ascii = (b, o, n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
    return s;
  };
  const decoders = {};
  const decode = (bytes, encoding) => {
    if (!decoders[encoding]) decoders[encoding] = new TextDecoder(encoding);
    return decoders[encoding].decode(bytes);
  };
  const fail = (message) => {
    throw new Error(`csp: ${message}`);
  };

  /* --------------------------------- SQLite --------------------------------- */

  // Enough of SQLite's file format to read tables: their B-trees, the rows that overflow their
  // page, and the columns named by each table's CREATE TABLE. A `source` gives the pages:
  // { pageSize, usable, count, encoding, page(n) } (n from 1; null when it can't be read).
  const varint = (b, o) => {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const c = b[o + i];
      v = v * 128 + (c & 0x7f);
      if (c < 0x80) return [v, o + i + 1];
    }
    return [v * 256 + b[o + 8], o + 9];
  };
  const TEXT = { 1: "utf-8", 2: "utf-16le", 3: "utf-16be" };
  const MAX_PAGES = 4000000;
  const fileSource = (bytes) => {
    if (ascii(bytes, 0, 15) !== "SQLite format 3") fail("not a database");
    const pageSize = be16(bytes, 16) === 1 ? 65536 : be16(bytes, 16);
    if (pageSize < 512) fail("page size");
    return {
      pageSize,
      usable: pageSize - bytes[20],
      count: Math.floor(bytes.length / pageSize),
      encoding: TEXT[be32(bytes, 56)] || "utf-8",
      page: (n) => (n >= 1 && n * pageSize <= bytes.length ? bytes.subarray((n - 1) * pageSize, n * pageSize) : null),
    };
  };
  // A cell's payload, with what continues on overflow pages
  const payloadOf = (source, page, at, size) => {
    const U = source.usable;
    const X = U - 35;
    if (size <= X) return page.subarray(at, at + size);
    if (size > source.count * source.pageSize) fail("row size");
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (U - 4));
    const local = K <= X ? K : M;
    const out = new Uint8Array(size);
    out.set(page.subarray(at, at + local));
    let filled = local;
    let next = be32(page, at + local);
    let guard = 0;
    while (next && filled < size) {
      const over = source.page(next);
      if (!over || ++guard > MAX_PAGES) fail("overflow page");
      const n = Math.min(U - 4, size - filled);
      out.set(over.subarray(4, 4 + n), filled);
      filled += n;
      next = be32(over, 0);
    }
    if (filled < size) fail("short row");
    return out;
  };
  const INT_BYTES = [0, 1, 2, 3, 4, 6, 8];
  // A row's values; `wanted` (a set of positions) leaves the others undefined, unread
  const recordOf = (p, encoding, wanted) => {
    let [headerSize, o] = varint(p, 0);
    const types = [];
    while (o < headerSize) {
      const [type, next] = varint(p, o);
      types.push(type);
      o = next;
    }
    let at = headerSize;
    const out = new Array(types.length);
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      const size = t >= 12 ? (t - 12 - (t & 1)) / 2 : t === 7 ? 8 : t <= 6 ? INT_BYTES[t] : 0;
      if (!wanted || wanted.has(i)) {
        if (t === 0) out[i] = null;
        else if (t <= 6) {
          let v = p[at] & 0x80 ? -1 : 0;
          for (let k = 0; k < size; k++) v = v * 256 + p[at + k];
          out[i] = v;
        } else if (t === 7) out[i] = beF64(p, at);
        else if (t === 8) out[i] = 0;
        else if (t === 9) out[i] = 1;
        else if (t & 1) out[i] = decode(p.subarray(at, at + size), encoding);
        else out[i] = p.subarray(at, at + size);
      }
      at += size;
    }
    return out;
  };
  // The cells of a leaf page: [rowid, payload]
  const leafCells = (source, page, header) => {
    const count = be16(page, header + 3);
    const cells = [];
    for (let i = 0; i < count; i++) {
      const at = be16(page, header + 8 + i * 2);
      const [size, a] = varint(page, at);
      const [rowid, b] = varint(page, a);
      cells.push([rowid, payloadOf(source, page, b, size)]);
    }
    return cells;
  };
  // Every row of the table whose B-tree starts at `rootPage`, in order
  const walkTable = (source, rootPage, each) => {
    const seen = new Set();
    const visit = (n, depth) => {
      if (seen.has(n) || depth > 24) fail("table loop");
      seen.add(n);
      const page = source.page(n);
      if (!page) fail("page not readable");
      const header = n === 1 ? 100 : 0;
      const type = page[header];
      if (type === 13) {
        leafCells(source, page, header).forEach(([rowid, payload]) => each(rowid, payload));
        return;
      }
      if (type !== 5) fail("page type");
      const count = be16(page, header + 3);
      for (let i = 0; i < count; i++) visit(be32(page, be16(page, header + 12 + i * 2)), depth + 1);
      visit(be32(page, header + 8), depth + 1);
    };
    visit(rootPage, 0);
  };
  // The names of a table's columns, from its CREATE TABLE
  const columnsOf = (sql) => {
    const open = sql.indexOf("(");
    if (open < 0) return [];
    const names = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open; i < sql.length; i++) {
      const c = sql[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if ((c === "," && depth === 1) || (c === ")" && depth === 0)) {
        const name = sql.slice(start, i).trim().split(/\s+/)[0].replace(/^["'`\[]|["'`\]]$/g, "");
        if (name) names.push(name);
        start = i + 1;
        if (depth === 0) break;
      }
    }
    return names;
  };
  const openDb = (source) => {
    const tables = new Map();
    const addTable = (name, rootPage, sql) => {
      if (typeof name !== "string" || typeof sql !== "string" || !(rootPage > 0)) return;
      const known = tables.get(name);
      // Two tables of one name, found by scanning: neither can be trusted
      if (known && known.root !== rootPage) known.root = 0;
      else if (!known) tables.set(name, { root: rootPage, columns: columnsOf(sql) });
    };
    if (source.page(1)) walkTable(source, 1, (rowid, payload) => {
      const row = recordOf(payload, source.encoding);
      if (row[0] === "table") addTable(row[1], row[3], row[4]);
    });
    else {
      // The first pages can't be read: the rows of the list of tables are looked for in every
      // leaf page that can
      for (let n = 1; n <= source.count; n++) {
        const page = source.page(n);
        if (!page || page[0] !== 13) continue;
        let cells;
        try {
          cells = leafCells(source, page, 0);
        } catch (error) {
          continue;
        }
        for (const [, payload] of cells) {
          for (const encoding of ["utf-8", "utf-16le"]) {
            let row;
            try {
              row = recordOf(payload, encoding);
            } catch (error) {
              continue;
            }
            if (row.length === 5 && row[0] === "table" && typeof row[4] === "string" && /^CREATE TABLE/i.test(row[4])) {
              source.encoding = encoding;
              addTable(row[1], row[3], row[4]);
              break;
            }
          }
        }
      }
    }
    const db = {
      source,
      has: (name) => Boolean(tables.get(name) && tables.get(name).root),
      columns: (name) => (tables.get(name) ? tables.get(name).columns : []),
      // The rows of a table as objects; `only`: the columns to read
      rows(name, only) {
        const table = tables.get(name);
        if (!table || !table.root) return [];
        const wanted = only ? new Set(only.map((column) => table.columns.indexOf(column)).filter((i) => i >= 0)) : null;
        const out = [];
        walkTable(source, table.root, (rowid, payload) => {
          const values = recordOf(payload, source.encoding, wanted);
          const row = {};
          table.columns.forEach((column, i) => {
            if (wanted && !wanted.has(i)) return;
            // A column that is the row's own number is kept as nothing in the row
            row[column] = values[i] === null && i === 0 ? rowid : values[i] === undefined ? null : values[i];
          });
          out.push(row);
        });
        return out;
      },
    };
    return db;
  };

  /* --------------------------------- pixels --------------------------------- */

  // An Offscreen's Attribute: three named lists of numbers
  const attributeOf = (blob) => {
    if (!blob || blob.length < 16 || be32(blob, 0) !== 16) return null;
    const out = {};
    let o = 16;
    for (let s = 0; s < 3; s++) {
      const length = be32(blob, 4 + s * 4);
      const chars = be32(blob, o);
      const name = decode(blob.subarray(o + 4, o + 4 + chars * 2), "utf-16be");
      const values = [];
      for (let at = o + 4 + chars * 2; at + 4 <= o + length; at += 4) values.push(be32(blob, at));
      out[name] = values;
      o += length;
    }
    const p = out.Parameter;
    if (!p || p.length < 13) return null;
    return { width: p[0], height: p[1], across: p[2], down: p[3], order: p[4], planes: p[6], pixelBytes: p[7], imageAt: p[8], imageRow: p[10], alphaRow: p[12], init: out.InitColor || [] };
  };
  const BLOCK = 256;
  const BEGIN = "BlockDataBeginChunk";
  // The blocks of an Offscreen, row after row: each null (nothing kept) or its inflated bytes
  const blocksOf = (stream, count) => {
    const blocks = new Array(count).fill(null);
    let o = 0;
    const pako = inflater();
    while (o + 8 <= stream.length) {
      const length = be32(stream, o);
      const chars = be32(stream, o + 4);
      if (chars !== BEGIN.length || length < 104 || o + length > stream.length) break;
      const at = o + 8 + chars * 2;
      const index = be32(stream, at);
      const has = be32(stream, at + 16);
      if (has && index < count) {
        const n = le32(stream, at + 24);
        blocks[index] = pako.inflate(stream.subarray(at + 28, at + 28 + n));
      }
      o += length;
    }
    return blocks;
  };
  // The picture an Offscreen holds: { width, height, alpha, gray?, rgb? }, or null when it
  // holds nothing. `stream`: its blocks (see blocksOf).
  const pictureOf = (attribute, stream) => {
    const { width, height, across, down } = attribute;
    if (!(width > 0 && height > 0) || width * height > 120e6 || across * down > 1e6) return null;
    const blocks = blocksOf(stream, across * down);
    const color = attribute.planes === 4;
    const bits = attribute.alphaRow === 32;
    const grayed = attribute.planes === 1;
    const init = attribute.init;
    // Blocks never painted: all of the first value, or nothing
    const fill = init[1] ? 255 : 0;
    if (!fill && !blocks.some(Boolean)) return null;
    const alpha = new Uint8Array(width * height);
    if (fill) alpha.fill(fill);
    const gray = grayed ? new Uint8Array(width * height) : null;
    const rgb = color ? new Uint8Array(width * height * 3) : null;
    for (let by = 0; by < down; by++) {
      for (let bx = 0; bx < across; bx++) {
        const block = blocks[by * across + bx];
        if (!block) continue;
        const w = Math.min(BLOCK, width - bx * BLOCK);
        const h = Math.min(BLOCK, height - by * BLOCK);
        for (let y = 0; y < h; y++) {
          const to = (by * BLOCK + y) * width + bx * BLOCK;
          if (bits) {
            const a = y * 32;
            const g = attribute.imageAt + y * 32;
            for (let x = 0; x < w; x++) {
              const bit = 0x80 >> (x & 7);
              alpha[to + x] = block[a + (x >> 3)] & bit ? 255 : 0;
              if (gray) gray[to + x] = block[g + (x >> 3)] & bit ? 255 : 0;
            }
          } else {
            alpha.set(block.subarray(y * BLOCK, y * BLOCK + w), to);
            if (gray) gray.set(block.subarray(attribute.imageAt + y * BLOCK, attribute.imageAt + y * BLOCK + w), to);
            else if (rgb) {
              for (let x = 0, s = attribute.imageAt + y * attribute.imageRow, d = to * 3; x < w; x++, s += 4, d += 3) {
                rgb[d] = block[s + 2];
                rgb[d + 1] = block[s + 1];
                rgb[d + 2] = block[s];
              }
            }
          }
        }
      }
    }
    const picture = { width, height, alpha };
    if (gray) picture.gray = gray;
    if (rgb) picture.rgb = rgb;
    if (bits) picture.bits = true;
    return picture;
  };
  // Where a picture has something, as { left, top, right, bottom }, or null
  const inkBox = (picture) => {
    const { width, height, alpha } = picture;
    let top = -1;
    let bottom = -1;
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let x0 = 0;
      while (x0 < width && !alpha[row + x0]) x0++;
      if (x0 === width) continue;
      let x1 = width - 1;
      while (!alpha[row + x1]) x1--;
      if (top < 0) top = y;
      bottom = y;
      if (x0 < left) left = x0;
      if (x1 > right) right = x1;
    }
    return top < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 };
  };
  const cropPicture = (picture, box) => {
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    if (width === picture.width && height === picture.height) return picture;
    const out = { width, height };
    for (const [plane, n] of [["alpha", 1], ["gray", 1], ["rgb", 3]]) {
      if (!picture[plane]) continue;
      const to = (out[plane] = new Uint8Array(width * height * n));
      for (let y = 0; y < height; y++) {
        const from = ((box.top + y) * picture.width + box.left) * n;
        to.set(picture[plane].subarray(from, from + width * n), y * width * n);
      }
    }
    if (picture.bits) out.bits = true;
    return out;
  };
  // A picture as RGBA bytes. Grey and alone-alpha pictures come out black (or, `ink`: [r, g, b]
  // for black and `paper` for white).
  const rgbaOf = (picture, ink = [0, 0, 0], paper = [255, 255, 255]) => {
    const { width, height, alpha, gray, rgb } = picture;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
      if (rgb) {
        out[o] = rgb[i * 3];
        out[o + 1] = rgb[i * 3 + 1];
        out[o + 2] = rgb[i * 3 + 2];
      } else {
        const g = gray ? gray[i] / 255 : 0;
        out[o] = ink[0] + (paper[0] - ink[0]) * g;
        out[o + 1] = ink[1] + (paper[1] - ink[1]) * g;
        out[o + 2] = ink[2] + (paper[2] - ink[2]) * g;
      }
      out[o + 3] = alpha[i];
    }
    return out;
  };

  // From a layer to the pixels of one of its mipmaps, at full size: the Offscreen row
  const offscreenOf = (tables, mipmapId) => {
    const mipmap = tables.mipmaps.get(mipmapId);
    const info = mipmap && tables.infos.get(mipmap.BaseMipmapInfo);
    return (info && tables.offscreens.get(info.Offscreen)) || null;
  };
  const byMainId = (rows) => new Map(rows.map((row) => [row.MainId, row]));

  /* --------------------------------- vectors --------------------------------- */

  // A layer drawn as vectors keeps no pixels: Clip Studio draws it again from its shapes each
  // time it opens. So does this, well enough for what such layers are in a document of
  // materials: bubbles (their inside filled, their outline drawn) and the lines of a flash.
  // A line is drawn with a round pen, its width following the pressure kept at each point by
  // the line's own curve; the pictures a pen may have for a tip are left out.
  //   an object   { header, kind, flags, main, sub, opacity, style, radius, points }
  //   a point     { x, y, pressure, taper (1, or less where a line thins toward its end), corner,
  //               c1?, c2? }
  const beF32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0);
  const vectorObjects = (data) => {
    const objects = [];
    let o = be32(data, 0) === 0 ? 8 : 0;
    while (o + 72 <= data.length) {
      const header = be32(data, o);
      const pointSize = be32(data, o + 8);
      const count = be32(data, o + 16);
      if (header < 72 || header > 256 || pointSize < 88 || pointSize > 256 || o + header + count * pointSize > data.length) break;
      const colour = (at) => [data[o + at], data[o + at + 4], data[o + at + 8]];
      const object = { header, flags: be32(data, o + 20), main: colour(40), sub: colour(52), opacity: beF64(data, o + 64), kind: 0, style: 0, radius: 0, points: [] };
      if (header === 96) {
        object.kind = be32(data, o + 72);
        object.style = be32(data, o + 80) || be32(data, o + 76);
        object.radius = beF64(data, o + 84);
      } else if (header === 92) {
        object.style = be32(data, o + 76) || be32(data, o + 72);
        object.radius = beF64(data, o + 80);
      } else if (header === 88) {
        object.style = be32(data, o + 72);
        object.radius = beF64(data, o + 76);
      }
      for (let i = 0; i < count; i++) {
        const at = o + header + i * pointSize;
        const point = { x: beF64(data, at), y: beF64(data, at + 8), corner: Boolean(be32(data, at + 32) & 3), pressure: beF32(data, at + 36), taper: beF32(data, at + 52) };
        if (pointSize >= 104) point.c1 = [beF64(data, at + 88), beF64(data, at + 96)];
        if (pointSize >= 120) point.c2 = [beF64(data, at + 104), beF64(data, at + 112)];
        object.points.push(point);
      }
      objects.push(object);
      o += header + count * pointSize;
    }
    return objects;
  };
  // An object's outline as a run of short straight pieces: [x, y, pressure, taper] each. Its flags
  // say how its points join: straight, by curves kept with them, or by a curve through them.
  const outlineOf = (object, closed) => {
    const p = object.points;
    const n = p.length;
    if (!n) return [];
    const out = [];
    const curved = Boolean(object.flags & 0x80) || (object.header === 88 && !(object.flags & 0x70));
    const last = closed ? n : n - 1;
    const at = (i) => p[((i % n) + n) % n];
    // Through the points, each leaving along the line from the one before to the one after
    const lean = (i) => {
      const point = at(i);
      if (point.corner) return [0, 0];
      const open = !closed && (i === 0 || i === n - 1);
      const a = open && i === 0 ? point : at(i - 1);
      const b = open && i === n - 1 ? point : at(i + 1);
      const k = open ? 0.55 : 0.7;
      return [(b.x - a.x) * k, (b.y - a.y) * k];
    };
    for (let i = 0; i < last; i++) {
      const a = at(i);
      const b = at(i + 1);
      let c1 = null;
      let c2 = null;
      if (object.flags & 0x40 && a.c1 && a.c2) {
        c1 = a.c1;
        c2 = a.c2;
      } else if (object.flags & 0x20 && a.c1) {
        c1 = [a.x + ((a.c1[0] - a.x) * 2) / 3, a.y + ((a.c1[1] - a.y) * 2) / 3];
        c2 = [b.x + ((a.c1[0] - b.x) * 2) / 3, b.y + ((a.c1[1] - b.y) * 2) / 3];
      } else if (curved) {
        const ta = lean(i);
        const tb = lean(i + 1);
        c1 = [a.x + ta[0] / 3, a.y + ta[1] / 3];
        c2 = [b.x - tb[0] / 3, b.y - tb[1] / 3];
      }
      const steps = c1 ? Math.max(2, Math.min(64, Math.ceil((Math.hypot(c1[0] - a.x, c1[1] - a.y) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(b.x - c2[0], b.y - c2[1])) / 4))) : 1;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const u = 1 - t;
        const pressure = a.pressure + (b.pressure - a.pressure) * t;
        const taper = a.taper + (b.taper - a.taper) * t;
        if (!c1) out.push([a.x, a.y, pressure, taper]);
        else out.push([u * u * u * a.x + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.x, u * u * u * a.y + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.y, pressure, taper]);
      }
    }
    const end = at(last);
    out.push([end.x, end.y, end.pressure, end.taper]);
    return out;
  };
  // A pen's width along a line, a share of its size: by the pressure, through the pen's curve,
  // and by how the line thins toward its ends. What moves a pen's size is kept as a set of
  // flags, then what each one needs, in their order.
  const widthOf = (style, graphs) => {
    const blob = style && style.SizeEffector;
    const flags = blob && blob.length >= 4 ? be32(blob, 0) : 0;
    let o = 4;
    const pressed = Boolean(flags & 0x10) && blob.length >= o + 8;
    const min = pressed ? Math.max(0, Math.min(1, beF32(blob, o))) : 1;
    const graph = pressed ? graphs.get(be32(blob, o + 4)) : null;
    if (pressed) o += 8;
    if (flags & 0x40) o += 4;
    if (flags & 0x80) o += 4;
    const thins = Boolean(flags & 0x100) && blob.length >= o + 4;
    const least = thins ? Math.max(0, Math.min(1, beF32(blob, o))) : 1;
    if (!pressed && !thins) return () => 1;
    const points = [];
    if (graph && graph.ControlPoints) {
      for (let i = 0; i < (graph.ControlNumber || 0) && i * 16 + 16 <= graph.ControlPoints.length; i++) points.push([beF64(graph.ControlPoints, i * 16), beF64(graph.ControlPoints, i * 16 + 8)]);
    }
    // The curve's points pull it, the first and the last are reached
    const curve = (x) => {
      if (points.length < 2) return x;
      if (points.length === 2) return points[0][1] + ((points[1][1] - points[0][1]) * (x - points[0][0])) / (points[1][0] - points[0][0] || 1);
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      for (let i = 1; i < points.length - 1; i++) {
        const from = i === 1 ? points[0] : mid(points[i - 1], points[i]);
        const to = i === points.length - 2 ? points[i + 1] : mid(points[i], points[i + 1]);
        if (x > to[0] && i < points.length - 2) continue;
        // Where along this piece x falls: found by halving
        let low = 0;
        let high = 1;
        for (let k = 0; k < 20; k++) {
          const t = (low + high) / 2;
          const at = (1 - t) * (1 - t) * from[0] + 2 * (1 - t) * t * points[i][0] + t * t * to[0];
          if (at < x) low = t;
          else high = t;
        }
        const t = (low + high) / 2;
        return (1 - t) * (1 - t) * from[1] + 2 * (1 - t) * t * points[i][1] + t * t * to[1];
      }
      return x;
    };
    return (pressure, taper) => (pressed ? min + (1 - min) * Math.max(0, Math.min(1, curve(Math.max(0, Math.min(1, pressure))))) : 1) * (thins ? least + (1 - least) * Math.max(0, Math.min(1, taper)) : 1);
  };
  const MAX_VECTOR_SIDE = 12000;
  const grayOfColour = (c) => Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
  // The picture of a layer's vectors. `lists`: its shapes to fill, its bubbles, its lines, each
  // a list of objects or null.
  const vectorPicture = (lists, styles, graphs) => {
    const drawn = [];
    let previous = null;
    [["fills", true, false], ["balloons", true, true], ["strokes", false, true]].forEach(([name, filled, lined]) => {
      (lists[name] || []).forEach((object) => {
        if (object.points.length < (filled ? 3 : 1)) return;
        // A bubble's tail has no pen of its own: it takes the bubble's
        const tail = name === "balloons" && (object.kind === 0x111 || object.kind === 0x311);
        const pen = tail && previous ? previous : object;
        if (name === "balloons" && !tail) previous = object;
        const closed = filled || Boolean(object.flags & 0x1000);
        const line = outlineOf(object, closed);
        const style = styles.get(pen.style);
        drawn.push({ object, line, filled, lined: lined && pen.radius > 0, radius: pen.radius, width: widthOf(style, graphs), hard: !style || !style.AntiAlias, union: name === "balloons", fill: name === "balloons" ? object.sub : object.main, ink: pen.main });
      });
    });
    if (!drawn.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    drawn.forEach((item) => item.line.forEach(([x, y]) => {
      const r = item.radius + 2;
      if (x - r < left) left = x - r;
      if (y - r < top) top = y - r;
      if (x + r > right) right = x + r;
      if (y + r > bottom) bottom = y + r;
    }));
    left = Math.floor(left);
    top = Math.floor(top);
    const width = Math.ceil(right) - left;
    const height = Math.ceil(bottom) - top;
    if (!(width > 0 && height > 0) || width > MAX_VECTOR_SIDE || height > MAX_VECTOR_SIDE) return null;
    const alpha = new Uint8Array(width * height);
    const gray = new Uint8Array(width * height);
    // How many bubbles a pixel is inside: an outline shows only where it is inside no other
    const inside = new Uint8Array(width * height);
    const own = new Uint8Array(width * height);
    const cover = new Uint8Array(width * height);
    // The pixels inside a closed outline (by its winding), handed to `each` a run at a time:
    // from index `from` up to `to`, left out
    const fillOutline = (line, each) => {
      const edges = [];
      for (let i = 0; i < line.length; i++) {
        const a = line[i];
        const b = line[(i + 1) % line.length];
        if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a[0] - left, a[1] - top, b[0] - left, b[1] - top, 1] : [b[0] - left, b[1] - top, a[0] - left, a[1] - top, -1]);
      }
      if (!edges.length) return;
      edges.sort((a, b) => a[1] - b[1]);
      const y0 = Math.max(0, Math.floor(edges[0][1]));
      const y1 = Math.min(height - 1, Math.ceil(edges.reduce((max, edge) => Math.max(max, edge[3]), 0)));
      let from = 0;
      const live = [];
      for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5;
        while (from < edges.length && edges[from][1] <= cy) live.push(edges[from++]);
        const hits = [];
        for (let i = live.length - 1; i >= 0; i--) {
          const edge = live[i];
          if (edge[3] <= cy) {
            live.splice(i, 1);
            continue;
          }
          hits.push([edge[0] + ((edge[2] - edge[0]) * (cy - edge[1])) / (edge[3] - edge[1]), edge[4]]);
        }
        hits.sort((a, b) => a[0] - b[0]);
        let winding = 0;
        for (let i = 0; i < hits.length - 1; i++) {
          winding += hits[i][1];
          if (!winding) continue;
          const x0 = Math.max(0, Math.ceil(hits[i][0] - 0.5));
          const x1 = Math.min(width - 1, Math.ceil(hits[i + 1][0] - 0.5) - 1);
          if (x1 >= x0) each(y * width + x0, y * width + x1 + 1);
        }
      }
    };
    drawn.forEach((item) => {
      if (!item.filled) return;
      const value = grayOfColour(item.fill);
      fillOutline(item.line, (from, to) => {
        alpha.fill(255, from, to);
        gray.fill(value, from, to);
        if (item.union) for (let i = from; i < to; i++) inside[i]++;
      });
    });
    drawn.forEach((item) => {
      if (!item.lined) return;
      const ink = grayOfColour(item.ink);
      const box = { left: width, top: height, right: 0, bottom: 0 };
      // The pen along the line: discs close enough to read as one stroke
      const disc = (cx, cy, r) => {
        if (!(r > 0.05)) return;
        const x0 = Math.max(0, Math.floor(cx - r - 1));
        const x1 = Math.min(width - 1, Math.ceil(cx + r + 1));
        const y0 = Math.max(0, Math.floor(cy - r - 1));
        const y1 = Math.min(height - 1, Math.ceil(cy + r + 1));
        for (let y = y0; y <= y1; y++) {
          const dy = y + 0.5 - cy;
          for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - cx;
            const d = Math.sqrt(dx * dx + dy * dy);
            const c = item.hard ? (d <= r ? 255 : 0) : Math.max(0, Math.min(1, r - d + 0.5)) * 255;
            if (c > cover[y * width + x]) cover[y * width + x] = c;
          }
        }
        if (x0 < box.left) box.left = x0;
        if (y0 < box.top) box.top = y0;
        if (x1 > box.right) box.right = x1;
        if (y1 > box.bottom) box.bottom = y1;
      };
      const line = item.line.slice();
      if (item.filled) line.push(line[0]);
      for (let i = 0; i < line.length; i++) {
        const a = line[i];
        const ra = item.radius * item.width(a[2], a[3]);
        if (i === line.length - 1) {
          disc(a[0] - left, a[1] - top, ra);
          break;
        }
        const b = line[i + 1];
        const rb = item.radius * item.width(b[2], b[3]);
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const steps = Math.max(1, Math.ceil(length / Math.max(0.5, Math.min(ra, rb) / 3 || 0.5)));
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          disc(a[0] + (b[0] - a[0]) * t - left, a[1] + (b[1] - a[1]) * t - top, ra + (rb - ra) * t);
        }
      }
      if (box.right < box.left) return;
      if (item.union) fillOutline(item.line, (from, to) => own.fill(1, from, to));
      const strength = Math.max(0, Math.min(1, item.object.opacity || 1));
      for (let y = box.top; y <= box.bottom; y++) {
        for (let x = box.left; x <= box.right; x++) {
          const i = y * width + x;
          let c = cover[i];
          cover[i] = 0;
          if (!c || (item.union && inside[i] - own[i] > 0)) continue;
          c = (c / 255) * strength;
          const a = alpha[i] / 255;
          const total = c + a * (1 - c);
          gray[i] = Math.round((ink * c + gray[i] * a * (1 - c)) / total);
          alpha[i] = Math.round(total * 255);
        }
      }
      if (item.union) fillOutline(item.line, (from, to) => own.fill(0, from, to));
    });
    // Lines without anti-aliasing in black and white: a picture of two bits a pixel
    const bits = drawn.every((item) => (!item.lined || item.hard) && [item.fill, item.ink].every((c) => grayOfColour(c) === 0 || grayOfColour(c) === 255) && (item.object.opacity === undefined || item.object.opacity >= 1));
    const picture = { width, height, alpha, gray };
    if (bits) picture.bits = true;
    return picture;
  };

  /* --------------------------------- .clip --------------------------------- */

  const CLIP_MAGIC = "CSFCHUNK";
  const clipChunks = (bytes) => {
    if (ascii(bytes, 0, 8) !== CLIP_MAGIC) fail("not a .clip");
    const chunks = [];
    let o = 24;
    while (o + 16 <= bytes.length) {
      const type = ascii(bytes, o, 8);
      const length = be32(bytes, o + 8) * 4294967296 + be32(bytes, o + 12);
      chunks.push({ type, at: o + 16, length });
      o += 16 + length;
    }
    return chunks;
  };
  // An image material layer's placement: only whether it tiles is read. Its two numbers after
  // the first four are 1 and 3 on the patterns that tile across and down.
  const tilingOf = (info) => Boolean(info && info.length >= 24 && be32(info, 16) === 1);
  const readClip = (data) => {
    const bytes = u8(data);
    const chunks = clipChunks(bytes);
    const sql = chunks.find((chunk) => chunk.type === "CHNKSQLi");
    if (!sql) fail("no layers");
    const db = openDb(fileSource(bytes.subarray(sql.at, sql.at + sql.length)));
    // The pixels are kept outside the database, each lot under a name
    const external = new Map();
    chunks.filter((chunk) => chunk.type === "CHNKExta").forEach((chunk) => {
      const n = be32(bytes, chunk.at) * 4294967296 + be32(bytes, chunk.at + 4);
      const id = ascii(bytes, chunk.at + 8, n);
      const length = be32(bytes, chunk.at + 8 + n) * 4294967296 + be32(bytes, chunk.at + 12 + n);
      external.set(id, bytes.subarray(chunk.at + 16 + n, chunk.at + 16 + n + length));
    });
    const tables = {
      mipmaps: byMainId(db.rows("Mipmap", ["MainId", "BaseMipmapInfo"])),
      infos: byMainId(db.rows("MipmapInfo", ["MainId", "Offscreen"])),
      offscreens: byMainId(db.rows("Offscreen", ["MainId", "Attribute", "BlockData"])),
    };
    const pictureAt = (mipmapId) => {
      const row = offscreenOf(tables, mipmapId);
      const attribute = row && attributeOf(row.Attribute);
      const stream = row && row.BlockData && external.get(ascii(row.BlockData, 0, row.BlockData.length));
      return attribute && stream ? pictureOf(attribute, stream) : null;
    };
    const canvas = db.rows("Canvas", ["MainId", "CanvasWidth", "CanvasHeight", "CanvasResolution", "CanvasRootFolder"])[0] || {};
    const layerColumns = ["MainId", "LayerName", "LayerType", "LayerFolder", "LayerNextIndex", "LayerFirstChildIndex", "LayerRenderMipmap", "LayerOffsetX", "LayerOffsetY", "LayerRenderOffscrOffsetX", "LayerRenderOffscrOffsetY", "LayerVisibility", "LayerOpacity", "ResizableImageInfo", "ResizableOriginalMipmap", "LayerColorTypeIndex", "TextLayerString", "VectorNormalStrokeIndex", "VectorNormalFillIndex", "VectorNormalBalloonIndex"];
    // The shapes of the layers drawn as vectors, read when one is asked for
    let vectors = null;
    const vectorsOf = (layer) => {
      if (!vectors) {
        vectors = {
          lists: db.has("VectorObjectList") ? byMainId(db.rows("VectorObjectList", ["MainId", "LayerId", "VectorData"])) : new Map(),
          styles: db.has("BrushStyle") ? byMainId(db.rows("BrushStyle", ["MainId", "SizeEffector", "AntiAlias"])) : new Map(),
          graphs: db.has("BrushEffectorGraphData") ? byMainId(db.rows("BrushEffectorGraphData", ["MainId", "ControlNumber", "ControlPoints"])) : new Map(),
        };
      }
      const list = (id) => {
        const row = id ? vectors.lists.get(id) : null;
        const data = row && row.VectorData ? external.get(ascii(row.VectorData, 0, row.VectorData.length)) : null;
        return data ? vectorObjects(data) : null;
      };
      const lists = { fills: list(layer.VectorNormalFillIndex), balloons: list(layer.VectorNormalBalloonIndex), strokes: list(layer.VectorNormalStrokeIndex) };
      return lists.fills || lists.balloons || lists.strokes ? vectorPicture(lists, vectors.styles, vectors.graphs) : null;
    };
    const layers = byMainId(db.rows("Layer", layerColumns.filter((column) => db.columns("Layer").includes(column))));
    const materials = [];
    const seen = new Set();
    // The layers from the top of the stack down, as the Layers panel lists them; a folder
    // names the group of what is in it
    const visit = (id, group) => {
      const siblings = [];
      for (let at = id; at && layers.has(at) && !seen.has(at); at = layers.get(at).LayerNextIndex) {
        seen.add(at);
        siblings.push(layers.get(at));
      }
      siblings.reverse().forEach((layer) => {
        const name = layer.LayerName || "";
        if (layer.LayerFolder & 1) {
          visit(layer.LayerFirstChildIndex, layer.LayerType === 256 ? group : group ? `${group} / ${name}` : name);
          return;
        }
        // The paper, the story's information
        if (layer.LayerType === 1584 || layer.LayerType === 800) return;
        materials.push({ name, group, layer });
      });
    };
    visit(canvas.CanvasRootFolder || 0, "");
    layers.forEach((layer) => {
      if (!seen.has(layer.MainId) && !(layer.LayerFolder & 1) && layer.LayerType !== 1584 && layer.LayerType !== 800 && layer.LayerType !== 256) materials.push({ name: layer.LayerName || "", group: "", layer });
    });
    // A material's picture, read when asked for: a document can hold hundreds
    const load = ({ layer }) => {
      const original = layer.ResizableOriginalMipmap ? pictureAt(layer.ResizableOriginalMipmap) : null;
      if (original) return { picture: original, tiling: tilingOf(layer.ResizableImageInfo) };
      const shown = layer.LayerRenderMipmap ? pictureAt(layer.LayerRenderMipmap) : null;
      const box = shown && inkBox(shown);
      if (box) return { picture: cropPicture(shown, box), tiling: false };
      const traced = vectorsOf(layer);
      const inked = traced && inkBox(traced);
      return inked ? { picture: cropPicture(traced, inked), tiling: false } : null;
    };
    return {
      width: Math.round(canvas.CanvasWidth) || 0,
      height: Math.round(canvas.CanvasHeight) || 0,
      resolution: canvas.CanvasResolution || 0,
      materials: materials.map((item) => ({ name: item.name, group: item.group, load: () => load(item) })),
    };
  };

  /* --------------------------------- archives --------------------------------- */

  // A tar's files: [{ name, bytes }]
  const untar = (bytes) => {
    const files = [];
    let o = 0;
    while (o + 512 <= bytes.length) {
      let end = o;
      while (end < o + 100 && bytes[end]) end++;
      if (end === o) break;
      const name = decode(bytes.subarray(o, end), "utf-8");
      const size = parseInt(ascii(bytes, o + 124, 11).trim() || "0", 8) || 0;
      files.push({ name, bytes: bytes.subarray(o + 512, o + 512 + size) });
      o += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
  };
  // A zip's files: [{ name, bytes() }], the bytes inflated when asked for. Names not marked as
  // Unicode are read as UTF-8 when they are, else as Shift JIS, as Japanese archives are.
  const zipName = (raw, unicode) => {
    if (!unicode) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch (error) {
        try {
          return new TextDecoder("shift_jis", { fatal: true }).decode(raw);
        } catch (other) {
          return ascii(raw, 0, raw.length);
        }
      }
    }
    return decode(raw, "utf-8");
  };
  const unzip = (data) => {
    const bytes = u8(data);
    let end = bytes.length - 22;
    while (end >= 0 && le32(bytes, end) !== 0x06054b50) end--;
    if (end < 0) fail("not a zip");
    const count = le16(bytes, end + 10);
    let o = le32(bytes, end + 16);
    const files = [];
    for (let i = 0; i < count && o + 46 <= bytes.length && le32(bytes, o) === 0x02014b50; i++) {
      const flags = le16(bytes, o + 8);
      const method = le16(bytes, o + 10);
      const packed = le32(bytes, o + 20);
      const size = le32(bytes, o + 24);
      const nameLength = le16(bytes, o + 28);
      const local = le32(bytes, o + 42);
      const name = zipName(bytes.subarray(o + 46, o + 46 + nameLength), Boolean(flags & 0x800));
      o += 46 + nameLength + le16(bytes, o + 30) + le16(bytes, o + 32);
      if (name.endsWith("/")) continue;
      files.push({
        name,
        size,
        bytes() {
          const at = local + 30 + le16(bytes, local + 26) + le16(bytes, local + 28);
          const body = bytes.subarray(at, at + packed);
          if (method === 0) return body;
          if (method !== 8) fail("zip method");
          return inflater().inflateRaw(body);
        },
      });
    }
    return files;
  };

  /* ---- 7z ---- */

  // LZMA, as 7z archives are packed: bytes out of a range coder, each bit weighed by what the
  // bits before it were. What is unpacked is its own dictionary: a match is copied from
  // further back in `out`.
  const lzma = () => {
    let lc = 3;
    let lp = 0;
    let pb = 2;
    let probs = null;
    let state = 0;
    let rep0 = 0;
    let rep1 = 0;
    let rep2 = 0;
    let rep3 = 0;
    // Where each set of weights starts in `probs`
    const IS_MATCH = 0;
    const IS_REP = IS_MATCH + 192;
    const IS_REP_G0 = IS_REP + 12;
    const IS_REP_G1 = IS_REP_G0 + 12;
    const IS_REP_G2 = IS_REP_G1 + 12;
    const IS_REP0_LONG = IS_REP_G2 + 12;
    const POS_SLOT = IS_REP0_LONG + 192;
    const POS = POS_SLOT + 256;
    const ALIGN = POS + 115;
    const LEN = ALIGN + 16;
    const REP_LEN = LEN + 514;
    const LITERAL = REP_LEN + 514;
    let buf = null;
    let pos = 0;
    let range = 0;
    let code = 0;
    const setProps = (byte) => {
      if (byte >= 225) fail("7z properties");
      lc = byte % 9;
      lp = Math.floor(byte / 9) % 5;
      pb = Math.floor(byte / 45);
      probs = new Uint16Array(LITERAL + (0x300 << (lc + lp)));
      resetState();
    };
    const resetState = () => {
      probs.fill(1024);
      state = 0;
      rep0 = rep1 = rep2 = rep3 = 0;
    };
    const bit = (i) => {
      const p = probs[i];
      const bound = (range >>> 11) * p;
      let out;
      if (code < bound) {
        range = bound;
        probs[i] = p + ((2048 - p) >>> 5);
        out = 0;
      } else {
        range -= bound;
        code -= bound;
        probs[i] = p - (p >>> 5);
        out = 1;
      }
      if (range < 16777216) {
        range = (range << 8) >>> 0;
        code = ((code << 8) | buf[pos++]) >>> 0;
      }
      return out;
    };
    const direct = (count) => {
      let out = 0;
      for (let i = 0; i < count; i++) {
        range >>>= 1;
        let b = 1;
        if (code >= range) code -= range;
        else b = 0;
        if (range < 16777216) {
          range = (range << 8) >>> 0;
          code = ((code << 8) | buf[pos++]) >>> 0;
        }
        out = out * 2 + b;
      }
      return out;
    };
    const tree = (at, bits) => {
      let m = 1;
      for (let i = 0; i < bits; i++) m = (m << 1) | bit(at + m);
      return m - (1 << bits);
    };
    const reverse = (at, bits) => {
      let m = 1;
      let out = 0;
      for (let i = 0; i < bits; i++) {
        const b = bit(at + m);
        m = (m << 1) | b;
        out |= b << i;
      }
      return out;
    };
    const length = (at, posState) => {
      if (!bit(at)) return tree(at + 2 + (posState << 3), 3);
      if (!bit(at + 1)) return 8 + tree(at + 130 + (posState << 3), 3);
      return 16 + tree(at + 258, 8);
    };
    // Unpack `size` bytes into `out` from `at`, reading `input` from `from`: where it stopped
    const run = (input, from, out, at, size) => {
      buf = input;
      pos = from + 1;
      range = 0xffffffff;
      code = 0;
      for (let i = 0; i < 4; i++) code = ((code << 8) | buf[pos++]) >>> 0;
      const end = at + size;
      const posMask = (1 << pb) - 1;
      const lpMask = (1 << lp) - 1;
      let o = at;
      while (o < end) {
        const posState = o & posMask;
        if (!bit(IS_MATCH + (state << 4) + posState)) {
          const previous = o > 0 ? out[o - 1] : 0;
          const lit = LITERAL + 0x300 * (((o & lpMask) << lc) + (previous >> (8 - lc)));
          let symbol = 1;
          if (state >= 7) {
            let match = out[o - rep0 - 1];
            do {
              const matchBit = (match >> 7) & 1;
              match <<= 1;
              const b = bit(lit + ((1 + matchBit) << 8) + symbol);
              symbol = (symbol << 1) | b;
              if (matchBit !== b) break;
            } while (symbol < 0x100);
          }
          while (symbol < 0x100) symbol = (symbol << 1) | bit(lit + symbol);
          out[o++] = symbol & 255;
          state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
          continue;
        }
        let len;
        if (bit(IS_REP + state)) {
          if (!bit(IS_REP_G0 + state)) {
            if (!bit(IS_REP0_LONG + (state << 4) + posState)) {
              state = state < 7 ? 9 : 11;
              out[o] = out[o - rep0 - 1];
              o++;
              continue;
            }
          } else {
            let distance;
            if (!bit(IS_REP_G1 + state)) distance = rep1;
            else {
              if (!bit(IS_REP_G2 + state)) distance = rep2;
              else {
                distance = rep3;
                rep3 = rep2;
              }
              rep2 = rep1;
            }
            rep1 = rep0;
            rep0 = distance;
          }
          len = length(REP_LEN, posState);
          state = state < 7 ? 8 : 11;
        } else {
          rep3 = rep2;
          rep2 = rep1;
          rep1 = rep0;
          len = length(LEN, posState);
          state = state < 7 ? 7 : 10;
          const slot = tree(POS_SLOT + ((len < 4 ? len : 3) << 6), 6);
          if (slot < 4) rep0 = slot;
          else {
            const more = (slot >> 1) - 1;
            const base = (2 | (slot & 1)) * Math.pow(2, more);
            if (slot < 14) rep0 = base + reverse(POS + base - slot, more);
            else rep0 = base + direct(more - 4) * 16 + reverse(ALIGN, 4);
          }
          // The mark that ends a stream packed without its size
          if (rep0 === 0xffffffff) break;
        }
        len += 2;
        if (rep0 >= o) fail("7z data");
        if (o + len > end) len = end - o;
        for (let i = 0; i < len; i++, o++) out[o] = out[o - rep0 - 1];
      }
      return pos;
    };
    return { setProps, resetState, run };
  };
  // LZMA2: LZMA in pieces, some kept as they were, each saying what starts afresh with it
  const unlzma2 = (input, size) => {
    const out = new Uint8Array(size);
    const coder = lzma();
    let pos = 0;
    let o = 0;
    let ready = false;
    while (pos < input.length && o < size) {
      const control = input[pos++];
      if (control === 0) break;
      if (control < 0x80) {
        if (control > 2) fail("7z data");
        const n = be16(input, pos) + 1;
        out.set(input.subarray(pos + 2, pos + 2 + n), o);
        pos += 2 + n;
        o += n;
        continue;
      }
      const unpacked = ((control & 0x1f) << 16) + be16(input, pos) + 1;
      const packed = be16(input, pos + 2) + 1;
      pos += 4;
      const reset = (control >> 5) & 3;
      if (reset >= 2) {
        coder.setProps(input[pos++]);
        ready = true;
      } else if (reset === 1) coder.resetState();
      if (!ready) fail("7z data");
      coder.run(input, pos, out, o, Math.min(unpacked, size - o));
      pos += packed;
      o += unpacked;
    }
    return out;
  };
  const unlzma = (input, props, size) => {
    const out = new Uint8Array(size);
    const coder = lzma();
    coder.setProps(props[0]);
    coder.run(input, 0, out, 0, size);
    return out;
  };
  const SEVEN_ZIP = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
  // A 7z archive's files: [{ name, size, bytes() }]. Each lot of files packed together is
  // unpacked once, when one of its files is asked for. Only what 7-Zip packs with by default
  // (LZMA, LZMA2) is read.
  const un7z = (data) => {
    const bytes = u8(data);
    if (!SEVEN_ZIP.every((value, i) => bytes[i] === value)) fail("not a 7z");
    const u64 = (b, o) => le32(b, o) + le32(b, o + 4) * 4294967296;
    const reader = (b) => {
      let o = 0;
      const r = {
        byte: () => b[o++],
        number() {
          const first = b[o++];
          let mask = 0x80;
          let value = 0;
          for (let i = 0; i < 8; i++) {
            if (!(first & mask)) return value + (first & (mask - 1)) * Math.pow(256, i);
            value += b[o++] * Math.pow(256, i);
            mask >>= 1;
          }
          return value;
        },
        take(n) {
          o += n;
          return b.subarray(o - n, o);
        },
        // A flag for each of `count` things, or all of them set
        flags(count, mayBeAll) {
          if (mayBeAll && r.byte()) return new Array(count).fill(true);
          const out = [];
          let mask = 0;
          let value = 0;
          for (let i = 0; i < count; i++) {
            if (!mask) {
              value = r.byte();
              mask = 0x80;
            }
            out.push(Boolean(value & mask));
            mask >>= 1;
          }
          return out;
        },
        done: () => o >= b.length,
      };
      return r;
    };
    // The packed lots: where each is, how it unpacks, and how its files divide it
    const streamsInfo = (r) => {
      const info = { packPos: 0, packSizes: [], folders: [], counts: null, sizes: null };
      for (let id = r.byte(); id !== 0; id = r.byte()) {
        if (id === 6) {
          info.packPos = r.number();
          const count = r.number();
          for (let prop = r.byte(); prop !== 0; prop = r.byte()) {
            if (prop === 9) for (let i = 0; i < count; i++) info.packSizes.push(r.number());
            else if (prop === 10) r.flags(count, true).forEach((on) => on && r.take(4));
            else fail("7z header");
          }
        } else if (id === 7) {
          if (r.byte() !== 11) fail("7z header");
          const count = r.number();
          if (r.byte()) fail("7z header");
          for (let f = 0; f < count; f++) {
            const coders = [];
            const coderCount = r.number();
            let ins = 0;
            let outs = 0;
            for (let c = 0; c < coderCount; c++) {
              const flag = r.byte();
              const coder = { id: Array.from(r.take(flag & 15)).map((value) => value.toString(16).padStart(2, "0")).join(""), props: null };
              let coderIns = 1;
              let coderOuts = 1;
              if (flag & 0x10) {
                coderIns = r.number();
                coderOuts = r.number();
              }
              if (flag & 0x20) coder.props = r.take(r.number());
              ins += coderIns;
              outs += coderOuts;
              coders.push(coder);
            }
            for (let i = 0; i < outs - 1; i++) {
              r.number();
              r.number();
            }
            const packed = ins - (outs - 1);
            if (packed > 1) for (let i = 0; i < packed; i++) r.number();
            info.folders.push({ coders, outs, packed, sizes: [], hasCrc: false });
          }
          for (let prop = r.byte(); prop !== 0; prop = r.byte()) {
            if (prop === 12) info.folders.forEach((folder) => {
              for (let i = 0; i < folder.outs; i++) folder.sizes.push(r.number());
            });
            else if (prop === 10) r.flags(count, true).forEach((on, i) => {
              info.folders[i].hasCrc = on;
              if (on) r.take(4);
            });
            else fail("7z header");
          }
        } else if (id === 8) {
          info.counts = info.folders.map(() => 1);
          for (let prop = r.byte(); prop !== 0; prop = r.byte()) {
            if (prop === 13) info.counts = info.folders.map(() => r.number());
            else if (prop === 9) {
              info.sizes = info.folders.map((folder, f) => {
                const sizes = [];
                let rest = folder.sizes[folder.sizes.length - 1];
                for (let i = 0; i < info.counts[f] - 1; i++) {
                  sizes.push(r.number());
                  rest -= sizes[i];
                }
                if (info.counts[f]) sizes.push(rest);
                return sizes;
              });
            } else if (prop === 10) {
              const count = info.folders.reduce((sum, folder, f) => sum + (info.counts[f] === 1 && folder.hasCrc ? 0 : info.counts[f]), 0);
              r.flags(count, true).forEach((on) => on && r.take(4));
            } else fail("7z header");
          }
        } else fail("7z header");
      }
      if (!info.counts) info.counts = info.folders.map(() => 1);
      if (!info.sizes) info.sizes = info.folders.map((folder, f) => (info.counts[f] ? [folder.sizes[folder.sizes.length - 1]] : []));
      return info;
    };
    const unpacked = new Map();
    const unpack = (info, f) => {
      if (unpacked.has(info.folders[f])) return unpacked.get(info.folders[f]);
      const folder = info.folders[f];
      if (folder.coders.length !== 1 || folder.packed !== 1) fail("7z method");
      let at = 32 + info.packPos;
      let stream = 0;
      for (let i = 0; i < f; i++) {
        for (let k = 0; k < info.folders[i].packed; k++) at += info.packSizes[stream++];
      }
      const input = bytes.subarray(at, at + info.packSizes[stream]);
      const size = folder.sizes[folder.sizes.length - 1];
      if (!(size >= 0) || size > 1.5e9) fail("7z size");
      const coder = folder.coders[0];
      const out = coder.id === "00" ? input : coder.id === "030101" ? unlzma(input, coder.props, size) : coder.id === "21" ? unlzma2(input, size) : fail("7z method");
      unpacked.set(folder, out);
      return out;
    };
    const next = u64(bytes, 12);
    let header = bytes.subarray(32 + next, 32 + next + u64(bytes, 20));
    if (!header.length) return [];
    // The list of files is itself packed, as a rule
    if (header[0] === 0x17) {
      const info = streamsInfo(reader(header.subarray(1)));
      header = unpack(info, 0);
    }
    const r = reader(header);
    if (r.byte() !== 1) fail("7z header");
    let info = null;
    let names = [];
    let empty = null;
    let count = 0;
    for (let id = r.byte(); id !== 0 && id !== undefined; id = r.byte()) {
      if (id === 2) {
        for (let prop = r.byte(); prop !== 0; prop = r.byte()) r.take(r.number());
      } else if (id === 4) info = streamsInfo(r);
      else if (id === 5) {
        count = r.number();
        for (let prop = r.byte(); prop !== 0; prop = r.byte()) {
          const body = r.take(r.number());
          if (prop === 14) empty = reader(body).flags(count, false);
          else if (prop === 17) {
            let o = 1;
            for (let i = 0; i < count; i++) {
              let end = o;
              while (end + 1 < body.length && (body[end] || body[end + 1])) end += 2;
              names.push(decode(body.subarray(o, end), "utf-16le"));
              o = end + 2;
            }
          }
        }
      } else fail("7z header");
    }
    const files = [];
    if (!info) return files;
    let folder = 0;
    let inFolder = 0;
    let offset = 0;
    for (let i = 0; i < count; i++) {
      if (empty && empty[i]) continue;
      while (folder < info.folders.length && inFolder >= info.counts[folder]) {
        folder++;
        inFolder = 0;
        offset = 0;
      }
      if (folder >= info.folders.length) break;
      const size = info.sizes[folder][inFolder];
      const at = offset;
      const f = folder;
      files.push({ name: (names[i] || "").replace(/\\/g, "/"), size, bytes: () => unpack(info, f).subarray(at, at + size) });
      offset += size;
      inFolder++;
    }
    return files;
  };

  /* --------------------------------- brush tips --------------------------------- */

  const C2F_MAGIC = [0x89, 0x43, 0x32, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
  // What comes before the readable part of a material's database: a part that isn't, eight
  // bytes longer than what it stands for
  const HIDDEN_EXTRA = 8;
  const PAGE_SIZES = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  // The database of a material, as much of it as can be read. Its start is among what can't,
  // and its page size with it: the size kept is the one that makes the most pages of tables,
  // their rows packed toward the end of the page as SQLite packs them.
  const materialSource = (bytes) => {
    if (!C2F_MAGIC.every((value, i) => bytes[i] === value)) return null;
    const parts = [];
    let end = 0;
    let o = 8;
    while (o + 12 <= bytes.length) {
      const length = le32(bytes, o);
      const type = ascii(bytes, o + 4, 4);
      if (type === "dATA" && length >= 2) {
        const body = bytes.subarray(o + 10, o + 8 + length);
        if (le16(bytes, o + 8) === 0) {
          parts.push({ at: end, bytes: body });
          end += body.length;
        } else end += Math.max(0, body.length - HIDDEN_EXTRA);
      }
      o += 12 + length;
      if (type === "TAIL") break;
    }
    if (!parts.length) return null;
    const pageOf = (size) => (n) => {
      const at = (n - 1) * size;
      const part = parts.find((item) => at >= item.at && at + size <= item.at + item.bytes.length);
      return part ? part.bytes.subarray(at - part.at, at - part.at + size) : null;
    };
    let best = 0;
    let pageSize = 1024;
    PAGE_SIZES.forEach((size) => {
      const page = pageOf(size);
      let score = 0;
      for (let n = 1; n * size <= end; n++) {
        const p = page(n);
        if (!p || (p[0] !== 13 && p[0] !== 5)) continue;
        const count = be16(p, 3);
        const first = p[0] === 13 ? 8 : 12;
        if (!count || first + count * 2 > size) continue;
        let high = false;
        let ok = true;
        for (let i = 0; i < count && ok; i++) {
          const cell = be16(p, first + i * 2);
          if (cell < first + count * 2 || cell >= size) ok = false;
          else if (cell >= size / 2) high = true;
        }
        if (ok && high) score++;
      }
      if (score > best) {
        best = score;
        pageSize = size;
      }
    });
    if (!best) return null;
    return { pageSize, usable: pageSize, count: Math.floor(end / pageSize), encoding: "utf-8", page: pageOf(pageSize) };
  };
  // A material's picture at full size. Its tables are followed from the layer when they can
  // be; else the largest picture kept in it is taken: the one the material was made from.
  const materialPicture = (bytes) => {
    const source = materialSource(bytes);
    if (!source) return null;
    const db = openDb(source);
    const stream = (row) => (row && row.BlockData && row.BlockData.length > 40 ? row.BlockData : null);
    const read = (row) => {
      const attribute = row && attributeOf(row.Attribute);
      return attribute && stream(row) ? pictureOf(attribute, stream(row)) : null;
    };
    let offscreens = [];
    try {
      offscreens = db.rows("Offscreen", ["MainId", "Attribute", "BlockData"]);
    } catch (error) {
      offscreens = [];
    }
    try {
      if (offscreens.length && db.has("Layer") && db.has("Mipmap") && db.has("MipmapInfo")) {
        const tables = { mipmaps: byMainId(db.rows("Mipmap", ["MainId", "BaseMipmapInfo"])), infos: byMainId(db.rows("MipmapInfo", ["MainId", "Offscreen"])), offscreens: byMainId(offscreens) };
        const layers = db.rows("Layer", ["MainId", "LayerFolder", "LayerRenderMipmap", "ResizableOriginalMipmap"].filter((column) => db.columns("Layer").includes(column))).filter((layer) => !(layer.LayerFolder & 1));
        for (const layer of layers) {
          const picture = read(offscreenOf(tables, layer.ResizableOriginalMipmap)) || read(offscreenOf(tables, layer.LayerRenderMipmap));
          if (picture) return picture;
        }
      }
    } catch (error) {
      // Fall through to what the rows themselves say
    }
    if (!offscreens.length) offscreens = strayOffscreens(source);
    let best = null;
    offscreens.forEach((row) => {
      const attribute = attributeOf(row.Attribute);
      if (!attribute || !stream(row) || (best && attribute.width * attribute.height <= best.attribute.width * best.attribute.height)) return;
      best = { attribute, row };
    });
    for (let tries = 0; best && tries < 4; tries++) {
      const picture = pictureOf(best.attribute, stream(best.row));
      if (picture) return picture;
      const area = best.attribute.width * best.attribute.height;
      best = null;
      offscreens.forEach((row) => {
        const attribute = attributeOf(row.Attribute);
        const size = attribute ? attribute.width * attribute.height : 0;
        if (!attribute || !stream(row) || size >= area || (best && size <= best.attribute.width * best.attribute.height)) return;
        best = { attribute, row };
      });
    }
    return null;
  };
  // The rows of pictures found without knowing their table: a row with an Attribute and the
  // blocks that go with it
  const strayOffscreens = (source) => {
    const rows = [];
    for (let n = 1; n <= source.count; n++) {
      const page = source.page(n);
      if (!page || page[0] !== 13) continue;
      let cells;
      try {
        cells = leafCells(source, page, 0);
      } catch (error) {
        continue;
      }
      cells.forEach(([, payload]) => {
        let values;
        try {
          values = recordOf(payload, "utf-8");
        } catch (error) {
          return;
        }
        const blobs = values.filter((value) => value instanceof Uint8Array);
        const attribute = blobs.find((blob) => attributeOf(blob));
        const blocks = blobs.find((blob) => blob.length > 46 && be32(blob, 4) === BEGIN.length && decode(blob.subarray(8, 8 + BEGIN.length * 2), "utf-16be") === BEGIN);
        if (attribute && blocks) rows.push({ Attribute: attribute, BlockData: blocks });
      });
    }
    return rows;
  };

  /* --------------------------------- .sut --------------------------------- */

  // What moves a setting along a stroke: { pressure, tilt, velocity, random }, each absent or
  // { min (0 to 1, or -1 to 1), curve: [[x, y]…] }, and tiltMax
  const effectorOf = (blob) => {
    if (!blob || blob.length < 40) return null;
    const header = be32(blob, 0);
    if (header < 40 || header > blob.length) return null;
    const used = be32(blob, 8);
    const word = (i) => (i * 4 + 4 <= header ? be32(blob, i * 4) | 0 : 0);
    const sizes = [word(8), word(9), header >= 48 ? word(11) : 0];
    let o = header;
    const curves = sizes.map((size) => {
      if (!size || o + size > blob.length || be32(blob, o) !== 12) return null;
      const count = be32(blob, o + 4);
      const points = [];
      for (let i = 0; i < count && o + 12 + i * 16 + 16 <= blob.length; i++) points.push([beF64(blob, o + 12 + i * 16), beF64(blob, o + 20 + i * 16)]);
      o += size;
      return points.length >= 2 ? points : null;
    });
    const input = (bit, at, curve) => (used & bit ? { min: Math.max(-1, Math.min(1, word(at) / 100)), curve } : undefined);
    const out = { pressure: input(0x10, 3, curves[0]), tilt: input(0x20, 4, curves[1]), velocity: input(0x40, 5, curves[2]), random: input(0x80, 6, null) };
    if (out.tilt) out.tiltMax = header >= 44 && word(10) >= 100 ? word(10) / 100 : 1;
    return out.pressure || out.tilt || out.velocity || out.random ? out : null;
  };
  // The materials a setting names: [{ path, name }]
  const referencesOf = (blob) => {
    const out = [];
    if (!blob || blob.length < 8 || be32(blob, 0) !== 8) return out;
    const count = be32(blob, 4);
    let o = 8;
    for (let i = 0; i < count && o + 8 <= blob.length; i++) {
      const size = be32(blob, o);
      const pathLength = be32(blob, o + 4);
      if (size < 8 || o + 8 + pathLength > blob.length) break;
      const path = decode(blob.subarray(o + 8, o + 8 + pathLength), "utf-16le").replace(/\0+$/, "");
      const at = o + 8 + pathLength;
      const nameLength = at + 8 <= blob.length ? be32(blob, at + 4) : 0;
      const name = nameLength && at + 8 + nameLength <= blob.length ? decode(blob.subarray(at + 8, at + 8 + nameLength), "utf-16le").replace(/\0+$/, "") : "";
      out.push({ path, name });
      o += size;
    }
    return out;
  };
  // Where the start and the end of a stroke taper: the settings ticked, { id: min (0 to 1) }
  const taperTargets = (blob) => {
    const out = {};
    if (!blob || blob.length < 12 || be32(blob, 0) !== 12) return out;
    const count = be32(blob, 4);
    const size = be32(blob, 8);
    for (let i = 0; i < count && 12 + i * size + 12 <= blob.length; i++) {
      const o = 12 + i * size;
      if (be32(blob, o + 4)) out[be32(blob, o)] = Math.max(0, Math.min(1, be32(blob, o + 8) / 100));
    }
    return out;
  };

  // The blending modes a brush can paint with, by Clip Studio's number: those of its layers
  const BLENDS = { 0: "normal", 1: "darken", 2: "multiply", 3: "color burn", 4: "linear burn", 5: "subtract", 6: "darker color", 7: "lighten", 8: "screen", 9: "color dodge", 10: "color dodge", 11: "linear dodge", 12: "linear dodge", 13: "lighter color", 14: "overlay", 15: "soft light", 16: "hard light", 17: "vivid light", 18: "linear light", 19: "pin light", 20: "hard mix", 21: "difference", 22: "exclusion", 23: "hue", 24: "saturation", 25: "color", 26: "luminosity", 36: "divide" };
  // Those only tools have: the eraser's, the one that keeps the denser of what is there and
  // what is painted (strokes of a screentone brush don't build up where they cross), and the
  // one that puts the stroke in place of what is there (a marker)
  const TOOL_BLENDS = { 27: "erase", 28: "erase", 29: "compare", 34: "replace" };
  const GAPS = { 1: 0.12, 2: 0.08, 3: 0.04 };
  const TEXTURE_MODES = ["normal", "multiply", "subtract", "compare", "outline", "overlay", "color dodge", "color burn", "hard mix", "height"];
  const TAPER_IDS = { 1001: "size", 1021: "flow", 1041: "gap", 1051: "thickness", 112: "texture", 1132: "spraySize", 1134: "sprayDensity" };

  // A length kept with its unit: pixels, or tenths of what Clip Studio shows
  const lengthOf = (value, unit) => (Number(value) || 0) * (unit === 2 ? 10 : 1);
  const percent = (value, fallback) => (typeof value === "number" ? value / 100 : fallback);

  // A sub tool's settings in TypeR's terms. Nothing is kept by Clip Studio's names: what
  // brush-engine.js draws is all here.
  //   size (px), opacity, flow, hardness (0 to 1), antialias (0 to 3)
  //   gap            a share of the size between two dabs; flowByGap
  //   thickness      0 to 1 and over, across the stroke unless thicknessAlong
  //   angle (degrees), angleBy { pen, twist, line, random (0 to 1) }
  //   tipOrder       0 repeat, 1 back and forth, 2 last one kept, 3 random, 4 and 5 once
  //   flipH, flipV   0 no, 1 yes, 2 at random, 3 on the way back
  //   ribbon, darken, spray { size, linked, density, bias, angle, angleBy }
  //   texture        { density, scale, rotate, invert, emphasize, mode, perDab } (its picture apart)
  //   edge           { width, opacity, darkness, blur }: Clip Studio's watercolor edge
  //   taper          { type, in, out, inRatio, outRatio, bySpeed, targets }
  //   blend          a blending mode's name, or "erase", "compare", "replace" (see TOOL_BLENDS)
  //   dyn            { size, opacity, flow, gap, thickness, texture, spraySize, sprayDensity }
  //   stabilize      0 to 100
  const brushOf = (v) => {
    const notes = [];
    const s = {
      size: Math.max(0.5, Math.min(5000, lengthOf(v.BrushSize, v.BrushSizeUnit) || 10)),
      opacity: Math.max(0, Math.min(1, percent(v.Opacity, 1))),
      flow: Math.max(0, Math.min(1, percent(v.BrushFlow, 1))),
      hardness: Math.max(0, Math.min(1, percent(v.BrushHardness, 1))),
      antialias: Math.max(0, Math.min(3, v.AntiAlias | 0)),
      gap: v.BrushAutoIntervalType in GAPS ? GAPS[v.BrushAutoIntervalType] : Math.max(0.01, Math.min(20, (Number(v.BrushInterval) || 10) / 100)),
      flowByGap: Boolean(v.BrushAdjustFlowByInterval),
      thickness: Math.max(0.01, Math.min(10, percent(v.BrushThickness, 1))),
      thicknessAlong: v.BrushVerticalThicknes === 0,
      angle: Number(v.BrushRotation) || 0,
      angleBy: {},
      tipOrder: v.BrushPatternOrderType | 0,
      flipH: v.BrushPatternReverseHorizontal | 0,
      flipV: v.BrushPatternReverseVertical | 0,
      ribbon: Boolean(v.BrushRibbon),
      darken: Boolean(v.BrushBlendPatternByDarken),
      continuous: Boolean(v.BrushContinuousPlot),
      atLeast1: Boolean(v.BrushAtLeast1Pixel),
      stabilize: Math.max(0, Math.min(100, v.FlickerReduction | 0)),
      dyn: {},
    };
    const turn = v.BrushRotationEffector | 0;
    if (turn & 0x10) s.angleBy.pen = true;
    if (turn & 0x20) s.angleBy.twist = true;
    if (turn & 0x40) s.angleBy.line = true;
    if (turn & 0x80) s.angleBy.random = Math.max(0, Math.min(1, percent(v.BrushRotationRandomScale, 1)));
    const dyn = (name, blob) => {
      const effector = effectorOf(blob);
      if (effector) s.dyn[name] = effector;
    };
    dyn("size", v.BrushSizeEffector);
    dyn("opacity", v.BrushOpacityEffector);
    dyn("flow", v.BrushFlowEffector);
    dyn("gap", v.BrushIntervalEffector);
    dyn("thickness", v.BrushThicknessEffector);
    if (v.BrushUseSpray) {
      const by = v.BrushRotationEffectorInSpray | 0;
      s.spray = {
        size: Math.max(0.5, lengthOf(v.BrushSpraySize, v.BrushSpraySizeUnit) || 2),
        linked: Boolean(v.BrushSpraySizeSyncBrushSize),
        density: Math.max(1, Math.min(100, v.BrushSprayDensity | 0)),
        bias: Math.max(-1, Math.min(1, percent(v.BrushSprayBias, 0))),
        angle: Number(v.BrushRotationInSpray) || 0,
        angleBy: { line: Boolean(by & 0x40), random: by & 0x80 ? Math.max(0, Math.min(1, percent(v.BrushRotationRandomInSpray, 1))) : 0, spray: Boolean(by & 0x100), center: Boolean(by & 0x200) },
      };
      dyn("spraySize", v.BrushSpraySizeEffector);
      dyn("sprayDensity", v.BrushSprayDensityEffector);
    }
    const mode = v.CompositeMode | 0;
    if (TOOL_BLENDS[mode]) s.blend = TOOL_BLENDS[mode];
    else if (BLENDS[mode]) s.blend = BLENDS[mode];
    else {
      s.blend = "normal";
      notes.push("blend");
    }
    if (v.BrushUseWaterEdge) {
      s.edge = {
        width: Math.max(0.1, Math.min(40, lengthOf(v.BrushWaterEdgeRadius, v.BrushWaterEdgeRadiusUnit) || 1)),
        opacity: Math.max(0, Math.min(1, percent(v.BrushWaterEdgeAlphaPower, 0.2))),
        darkness: Math.max(0, Math.min(1, percent(v.BrushWaterEdgeValuePower, 0))),
        blur: Math.max(0, Math.min(40, lengthOf(v.BrushWaterEdgeBlur, v.BrushWaterEdgeBlurUnit))),
      };
    }
    if (v.BrushUseIn || v.BrushUseOut) {
      const ticked = taperTargets(v.BrushInOutTarget);
      const targets = {};
      Object.keys(ticked).forEach((id) => {
        if (TAPER_IDS[id]) targets[TAPER_IDS[id]] = ticked[id];
      });
      if (Object.keys(targets).length) {
        s.taper = {
          type: v.BrushInOutType | 0,
          in: v.BrushUseIn ? lengthOf(v.BrushInLength, v.BrushInLengthUnit) : 0,
          out: v.BrushUseOut ? lengthOf(v.BrushOutLength, v.BrushOutLengthUnit) : 0,
          inRatio: v.BrushUseIn ? Math.max(0, Math.min(1, (Number(v.BrushInRatio) || 0) / 100)) : 0,
          outRatio: v.BrushUseOut ? Math.max(0, Math.min(1, (Number(v.BrushOutRatio) || 0) / 100)) : 0,
          bySpeed: Boolean(v.BrushInOutBySpeed),
          targets,
        };
      }
    }
    if (v.BrushUseWaterColor || v.BrushUseWaterColor2) notes.push("mixing");
    if (v.UseDualBrush) notes.push("dual");
    return { settings: s, notes };
  };
  // A paper texture's settings, beside its picture
  const textureOf = (v) => ({
    density: Math.max(0, Math.min(1, percent(v.TextureDensity, 1))),
    scale: Math.max(0.01, Math.min(100, (Number(v.TextureScale2) || Number(v.TextureScale) || 100) / 100)),
    rotate: Number(v.TextureRotate) || 0,
    invert: Boolean(v.TextureReverseDensity),
    emphasize: Boolean(v.TextureStressDensity),
    mode: TEXTURE_MODES[v.TextureCompositeMode | 0] || "multiply",
    perDab: Boolean(v.TextureForPlot),
    brightness: Math.max(-1, Math.min(1, percent(v.TextureBrightness, 0))),
    contrast: Math.max(-1, Math.min(1, percent(v.TextureContrast, 0))),
  });

  const WANTED = ["VariantID", "Opacity", "AntiAlias", "CompositeMode", "FlickerReduction", "TextureImage", "TextureCompositeMode", "TextureReverseDensity", "TextureStressDensity", "TextureScale", "TextureScale2", "TextureRotate", "TextureBrightness", "TextureContrast", "TextureForPlot", "TextureDensity", "TextureDensityEffector", "BrushSize", "BrushSizeUnit", "BrushSizeEffector", "BrushAtLeast1Pixel", "BrushOpacityEffector", "BrushFlow", "BrushFlowEffector", "BrushAdjustFlowByInterval", "BrushHardness", "BrushInterval", "BrushIntervalEffector", "BrushAutoIntervalType", "BrushContinuousPlot", "BrushThickness", "BrushThicknessEffector", "BrushVerticalThicknes", "BrushRotation", "BrushRotationEffector", "BrushRotationRandomScale", "BrushRotationInSpray", "BrushRotationEffectorInSpray", "BrushRotationRandomInSpray", "BrushUsePatternImage", "BrushPatternImageArray", "BrushPatternOrderType", "BrushPatternReverseHorizontal", "BrushPatternReverseVertical", "BrushUseWaterColor", "BrushUseWaterColor2", "BrushRibbon", "BrushBlendPatternByDarken", "BrushUseSpray", "BrushSpraySize", "BrushSpraySizeUnit", "BrushSpraySizeEffector", "BrushSpraySizeSyncBrushSize", "BrushSprayDensity", "BrushSprayDensityEffector", "BrushSprayBias", "BrushInOutTarget", "BrushInOutType", "BrushInOutBySpeed", "BrushUseIn", "BrushInLength", "BrushInLengthUnit", "BrushInRatio", "BrushUseOut", "BrushOutLength", "BrushOutLengthUnit", "BrushOutRatio", "BrushUseWaterEdge", "BrushWaterEdgeRadius", "BrushWaterEdgeRadiusUnit", "BrushWaterEdgeAlphaPower", "BrushWaterEdgeValuePower", "BrushWaterEdgeBlur", "BrushWaterEdgeBlurUnit", "UseDualBrush"];

  // A material's tar: its full-size picture (or null), its preview (a PNG's bytes) and whether
  // it is a paper texture
  const materialOf = (data) => {
    const files = untar(data);
    const layer = files.find((file) => /\.layer$/i.test(file.name));
    const preview = files.find((file) => /thumbnail\.png$/i.test(file.name));
    const info = files.find((file) => /layerData\.xml$/i.test(file.name));
    let picture = null;
    try {
      picture = layer ? materialPicture(layer.bytes) : null;
    } catch (error) {
      picture = null;
    }
    return { picture, preview: preview ? preview.bytes : null, paper: Boolean(info && /PaperTexture/.test(decode(info.bytes, "utf-8"))) };
  };
  const readSut = (data, fileName = "") => {
    const db = openDb(fileSource(u8(data)));
    if (!db.has("Node") || !db.has("Variant")) fail("not a sub tool");
    const variants = new Map(db.rows("Variant", WANTED.filter((column) => db.columns("Variant").includes(column))).map((row) => [row.VariantID, row]));
    // The pictures, each read once, by the path the settings name them with
    const materials = new Map();
    if (db.has("MaterialFile")) {
      db.rows("MaterialFile", ["OriginalPath", "CatalogPath", "FileData"]).forEach((row) => {
        if (!row.FileData) return;
        let material = null;
        const entry = { get: () => material || (material = materialOf(row.FileData)) };
        if (row.OriginalPath) materials.set(row.OriginalPath, entry);
        if (row.CatalogPath && !materials.has(row.CatalogPath)) materials.set(row.CatalogPath, entry);
      });
    }
    const find = (reference) => {
      const entry = materials.get(reference.path) || Array.from(materials.entries()).filter(([path]) => reference.path && (path.startsWith(reference.path) || reference.path.startsWith(path))).map(([, value]) => value)[0];
      return entry ? entry.get() : null;
    };
    const brushes = [];
    db.rows("Node", ["NodeName", "NodeVariantID", "NodeInitVariantID"]).forEach((node) => {
      const v = variants.get(node.NodeVariantID) || variants.get(node.NodeInitVariantID);
      if (!v) return;
      const { settings, notes } = brushOf(v);
      const brush = { name: node.NodeName || "", settings, tips: [], texture: null, notes };
      if (v.BrushUsePatternImage) {
        referencesOf(v.BrushPatternImageArray).forEach((reference) => {
          const material = find(reference);
          if (material && (material.picture || material.preview)) brush.tips.push(material.picture ? { picture: material.picture } : { preview: material.preview });
          else if (!notes.includes("tip")) notes.push("tip");
        });
      }
      const paper = referencesOf(v.TextureImage)[0];
      if (paper) {
        const material = find(paper);
        if (material && (material.picture || material.preview)) {
          brush.texture = Object.assign(material.picture ? { picture: material.picture } : { preview: material.preview }, textureOf(v));
          const effector = effectorOf(v.TextureDensityEffector);
          if (effector) settings.dyn.texture = effector;
        } else notes.push("texture");
      }
      brushes.push(brush);
    });
    // Clip Studio names a sub tool it imports after its file: so does this, when the file
    // holds one
    const named = fileName.replace(/^.*[\\/]/, "").replace(/\.sut$/i, "").trim();
    if (brushes.length === 1 && named) brushes[0].name = named;
    return { brushes };
  };

  /* --------------------------------- which file --------------------------------- */

  const kindOf = (data) => {
    const b = u8(data);
    if (b.length < 16) return null;
    if (ascii(b, 0, 15) === "SQLite format 3") return "sut";
    if (ascii(b, 0, 8) === CLIP_MAGIC) return "clip";
    if (le32(b, 0) === 0x04034b50) return "zip";
    if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) return "7z";
    return null;
  };

  return { kindOf, readSut, readClip, unzip, un7z, untar, rgbaOf, inkBox, cropPicture, materialPicture, effectorOf, openDb, fileSource };
});
