// The library's files read away from the page (library.js asks, csp.js reads): Clip Studio
// Paint's brushes and materials, alone or in archives, each brush sent back with a stroke of it
// as its thumbnail, each material as a PNG.
//
//   { op: "import", id, files: [{ name, bytes }] }
//       → { id, type: "brush", name, group, file, index, size, notes, thumb }   (file: the .sut's
//          bytes, kept as they are: a brush's pictures are read from them when it is chosen)
//       → { id, type: "material", name, group, width, height, pageWidth, pageHeight, tiling,
//           png, thumb }   (pageWidth, pageHeight: the page the material was made on)
//       → { id, type: "progress", done, total, name }, { id, type: "skipped", name, why }
//       → { id, type: "done" }
//   { op: "load", id, file, index }
//       → { id, type: "loaded", brush: { settings, tips, texture, notes } }  or  { id, type: "error" }

"use strict";

importScripts("vendor/pako_inflate.min.js", "csp.js", "brush-engine.js");

const CSP = self.TypeRCSP;
const Engine = self.TypeRBrushEngine;

/* --------------------------------- PNG --------------------------------- */

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (parts) => {
  let c = 0xffffffff;
  parts.forEach((bytes) => {
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  });
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (value) => new Uint8Array([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
// zlib's deflate, by the browser when it can; else stored as it is, which a PNG allows
const deflate = async (bytes) => {
  if (typeof CompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const parts = [new Uint8Array([0x78, 0x01])];
  let a = 1;
  let b = 0;
  for (let o = 0; o < bytes.length || o === 0; o += 65535) {
    const piece = bytes.subarray(o, o + 65535);
    const last = o + 65535 >= bytes.length ? 1 : 0;
    parts.push(new Uint8Array([last, piece.length & 255, piece.length >>> 8, ~piece.length & 255, (~piece.length >>> 8) & 255]), piece);
    for (let i = 0; i < piece.length; i++) {
      a = (a + piece[i]) % 65521;
      b = (b + a) % 65521;
    }
    if (last) break;
  }
  parts.push(be32(((b << 16) | a) >>> 0));
  return new Uint8Array(await new Blob(parts).arrayBuffer());
};
const chunk = (type, data) => {
  const name = new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]);
  return [be32(data.length), name, data, be32(crc32([name, data]))];
};
// A PNG from its rows, already laid out with a zero before each: `depth` bits a sample, of
// `colorType` (3 a palette, 4 grey and alpha, 6 RGBA)
const pngOf = async (width, height, depth, colorType, raw, extra = []) => {
  const head = new Uint8Array(13);
  head.set(be32(width), 0);
  head.set(be32(height), 4);
  head[8] = depth;
  head[9] = colorType;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk("IHDR", head)];
  extra.forEach(([type, data]) => parts.push(...chunk(type, data)));
  parts.push(...chunk("IDAT", await deflate(raw)), ...chunk("IEND", new Uint8Array(0)));
  return new Blob(parts, { type: "image/png" });
};
// A picture as the smallest PNG that holds it: two bits a pixel when it is black, white and
// nothing, grey and alpha when it has no colours
const pngOfPicture = async (picture) => {
  const { width, height, alpha, gray, rgb } = picture;
  if (picture.bits) {
    const row = Math.ceil(width / 4) + 1;
    const raw = new Uint8Array(row * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const index = !alpha[i] ? 0 : gray && gray[i] ? 2 : 1;
        if (index) raw[y * row + 1 + (x >> 2)] |= index << (6 - (x & 3) * 2);
      }
    }
    return pngOf(width, height, 2, 3, raw, [["PLTE", new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255, 255])], ["tRNS", new Uint8Array([0, 255, 255])]]);
  }
  if (rgb) {
    const row = width * 4 + 1;
    const raw = new Uint8Array(row * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0, o = y * row + 1, i = y * width; x < width; x++, o += 4, i++) {
        raw[o] = rgb[i * 3];
        raw[o + 1] = rgb[i * 3 + 1];
        raw[o + 2] = rgb[i * 3 + 2];
        raw[o + 3] = alpha[i];
      }
    }
    return pngOf(width, height, 8, 6, raw);
  }
  const row = width * 2 + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0, o = y * row + 1, i = y * width; x < width; x++, o += 2, i++) {
      raw[o] = gray ? gray[i] : 0;
      raw[o + 1] = alpha[i];
    }
  }
  return pngOf(width, height, 8, 4, raw);
};
const pngOfRgba = (width, height, rgba) => {
  const row = width * 4 + 1;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * row + 1);
  return pngOf(width, height, 8, 6, raw);
};

/* --------------------------------- thumbnails --------------------------------- */

const THUMB = 96;
// A material small enough for the panel: all of it when it is one picture, a corner of it at
// a size its marks still show when it is a pattern
const thumbOfPicture = (picture, tiling) => {
  const side = tiling ? Math.min(picture.width, picture.height, THUMB * 4) : 0;
  const fromW = tiling ? side : picture.width;
  const fromH = tiling ? side : picture.height;
  const scale = Math.min(1, THUMB / Math.max(fromW, fromH));
  const w = Math.max(1, Math.round(fromW * scale));
  const h = Math.max(1, Math.round(fromH * scale));
  const out = new Uint8Array(w * h * 4);
  const { alpha, gray, rgb } = picture;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * fromH) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * fromH) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * fromW) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * fromW) / w));
      // A few pixels of each cell are enough for a thumbnail
      const stepY = Math.max(1, Math.floor((y1 - y0) / 6));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 6));
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += stepY) {
        for (let sx = x0; sx < x1; sx += stepX) {
          const i = sy * picture.width + sx;
          const pa = alpha[i];
          a += pa;
          if (rgb) {
            r += rgb[i * 3] * pa;
            g += rgb[i * 3 + 1] * pa;
            b += rgb[i * 3 + 2] * pa;
          } else if (gray) {
            r += gray[i] * pa;
            g += gray[i] * pa;
            b += gray[i] * pa;
          }
          n++;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  }
  return pngOfRgba(w, h, out);
};
// A brush's thumbnail: a stroke of it, pressed then let go, as the panel shows it
const STROKE_W = 216;
const STROKE_H = 48;
const thumbOfBrush = (brush) => {
  const s = brush.settings;
  const size = Math.max(3, Math.min(s.size, s.ribbon || brush.texture ? 30 : 22));
  const stroke = Engine.begin(brush, { color: [0, 0, 0], sub: [255, 255, 255], size, seed: 20261118 });
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stroke.add(16 + t * (STROKE_W - 32), STROKE_H / 2 + Math.sin(t * Math.PI * 2) * (STROKE_H / 2 - size / 2 - 3) * 0.55, 0.25 + 0.75 * Math.sin(t * Math.PI), i * 12);
  }
  stroke.end();
  const pixels = stroke.read(0, 0, STROKE_W, STROKE_H, new Float32Array(STROKE_W * STROKE_H * 4), true);
  const out = new Uint8Array(STROKE_W * STROKE_H * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = pixels[i];
    out[i + 1] = pixels[i + 1];
    out[i + 2] = pixels[i + 2];
    out[i + 3] = Math.round(pixels[i + 3] * 255);
  }
  return pngOfRgba(STROKE_W, STROKE_H, out);
};

/* --------------------------------- reading --------------------------------- */

// A brush as the engine takes it: its pictures beside its settings
const brushOf = (read) => {
  const tips = read.tips.map((tip) => tip.picture).filter(Boolean);
  const texture = read.texture && read.texture.picture ? Object.assign({}, read.texture, read.texture.picture, { picture: undefined, preview: undefined }) : null;
  const notes = read.notes.slice();
  if (read.tips.length > tips.length && !notes.includes("tip")) notes.push("tip");
  if (read.texture && !texture && !notes.includes("texture")) notes.push("texture");
  return { settings: read.settings, tips, texture, notes };
};
const baseName = (path) => path.replace(/^.*[\\/]/, "");
const folderOf = (path) => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : "";
};
const stem = (name) => baseName(name).replace(/\.[^.]+$/, "");

const importFiles = async (id, files) => {
  // Archives are opened as they are met: what they hold joins the list
  const queue = files.map((file) => ({ name: file.name, bytes: new Uint8Array(file.bytes), group: "" }));
  let done = 0;
  const send = (message, transfer) => self.postMessage(Object.assign({ id }, message), transfer || []);
  while (queue.length) {
    const entry = queue.shift();
    const name = baseName(entry.name);
    const kind = CSP.kindOf(entry.bytes);
    send({ type: "progress", done, total: done + queue.length + 1, name });
    try {
      if ((kind === "zip" && /\.zip$/i.test(name)) || kind === "7z") {
        // A pack: each folder of it is a group; a set of brushes in an archive of its own, one too
        const inside = (kind === "7z" ? CSP.un7z(entry.bytes) : CSP.unzip(entry.bytes)).filter((file) => /\.(sut|clip|zip|7z)$/i.test(file.name) && !/(^|\/)(__MACOSX|\.)/.test(file.name));
        if (!inside.length) send({ type: "skipped", name, why: "empty" });
        inside.forEach((file) => queue.push({ name: file.name, bytes: file.bytes(), group: folderOf(file.name) || entry.group || stem(name) }));
      } else if (kind === "sut") {
        const read = CSP.readSut(entry.bytes, name);
        if (!read.brushes.length) send({ type: "skipped", name, why: "unread" });
        // The file's own bytes, apart from the archive they came in
        const file = entry.bytes.slice().buffer;
        for (let index = 0; index < read.brushes.length; index++) {
          const brush = brushOf(read.brushes[index]);
          let thumb = null;
          try {
            thumb = await thumbOfBrush(brush);
          } catch (error) {
            thumb = null;
          }
          send({ type: "brush", name: read.brushes[index].name || stem(name), group: entry.group || folderOf(entry.name), file: index === 0 ? file : null, shared: index > 0, index, count: read.brushes.length, size: brush.settings.size, erase: brush.settings.blend === "erase", textured: Boolean(brush.texture), notes: brush.notes, thumb });
        }
      } else if (kind === "clip") {
        const doc = CSP.readClip(entry.bytes);
        let read = 0;
        for (const material of doc.materials) {
          let loaded = null;
          try {
            loaded = material.load();
          } catch (error) {
            loaded = null;
          }
          if (!loaded) continue;
          read++;
          const { picture, tiling } = loaded;
          const set = entry.group || stem(name);
          send({ type: "material", name: material.name || stem(name), group: material.group ? `${set} / ${material.group}` : set, width: picture.width, height: picture.height, pageWidth: doc.width, pageHeight: doc.height, tiling, png: await pngOfPicture(picture), thumb: await thumbOfPicture(picture, tiling) });
        }
        if (read < doc.materials.length) send({ type: "skipped", name, why: "layers", count: doc.materials.length - read });
        else if (!read) send({ type: "skipped", name, why: "unread" });
      } else send({ type: "skipped", name, why: "kind" });
    } catch (error) {
      send({ type: "skipped", name, why: "unread", detail: String(error && error.message) });
    }
    done++;
  }
  send({ type: "done" });
};

const loadBrush = (id, file, index) => {
  try {
    const read = CSP.readSut(new Uint8Array(file), "");
    const brush = brushOf(read.brushes[index] || read.brushes[0]);
    const buffers = new Set();
    brush.tips.concat(brush.texture ? [brush.texture] : []).forEach((picture) => {
      ["alpha", "gray", "rgb"].forEach((plane) => {
        if (picture[plane]) buffers.add(picture[plane].buffer);
      });
    });
    self.postMessage({ id, type: "loaded", brush }, Array.from(buffers));
  } catch (error) {
    self.postMessage({ id, type: "error", detail: String(error && error.message) });
  }
};

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.op === "import") importFiles(message.id, message.files);
  else if (message.op === "load") loadBrush(message.id, message.file, message.index);
};
