import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { SIDE, restoreTiles } from "../web/nemesis-tiles.js";

const plane = SIDE * SIDE;

function sample(width, height) {
  const rgba = Uint8ClampedArray.from({ length: width * height * 4 }, (_, at) => (at * 23) % 256);
  const mask = new Uint8Array(width * height);
  return [rgba, mask];
}

test("empty mask returns the source without running inference", async () => {
  const [rgba, mask] = sample(4, 4);
  const result = await restoreTiles(rgba, mask, 4, 4, () => assert.fail("unexpected model call"));
  assert.equal(result, rgba);
});

test("narrow native crop uses edge padding and no mask in padded pixels", async () => {
  const [rgba, mask] = sample(9, 7);
  mask[6 * 9 + 8] = 1;
  const before = rgba.slice();
  await restoreTiles(rgba, mask, 9, 7, (image, holes) => {
    assert.equal(image.length, plane * 3);
    assert.equal(holes[6 * SIDE + 8], 1);
    assert.equal(holes[6 * SIDE + 9], 0);
    assert.equal(holes[7 * SIDE + 8], 0);
    assert.equal(image[6 * SIDE + 8], image[7 * SIDE + 9]);
    return new Float32Array(plane * 3).fill(.5);
  });
  assert.deepEqual(rgba.slice(0, -4), before.slice(0, -4));
  assert.deepEqual(rgba.slice(-4), Uint8ClampedArray.of(128, 128, 128, before.at(-1)));
});

test("overlapping tiles cover a tall selection without seams or outside edits", async () => {
  const width = 342, height = 671;
  const [rgba, mask] = sample(width, height);
  for (let y = 9; y < height - 14; y++) {
    for (let x = 18; x < width - 12; x++) mask[y * width + x] = 1;
  }
  const before = rgba.slice();
  const visits = [];
  await restoreTiles(rgba, mask, width, height, () => new Float32Array(plane * 3).fill(0.6),
    (...progress) => visits.push(progress));
  assert.ok(visits.length > 4);
  assert.deepEqual(visits.at(-1), [visits.length, visits.length]);
  for (let k = 0; k < rgba.length; k++) {
    assert.equal(rgba[k], k % 4 === 3 || !mask[Math.floor(k / 4)] ? before[k] : 153);
  }
});

test("mobile generative fill defaults to the installed local model and forwards the selection", async () => {
  const marker = {};
  const canvas = {}, mask = {}, signal = {};
  const window = {
    TypeRMobile: { platform: "android" },
    TypeRNemesis: { run: async (...parameters) => {
      assert.deepEqual(parameters.slice(0, 3), [canvas, mask, signal]);
      return marker;
    } },
    localStorage: { getItem: () => null },
  };
  runInNewContext(readFileSync(new URL("../web/generative.js", import.meta.url), "utf8"), { window, console });
  const gen = window.TypeRGenerative;
  const settings = gen.load();
  assert.equal(gen.modelOf(settings), gen.NEMESIS_ID);
  assert.equal(gen.takesPrompt(settings), false);
  assert.equal(await gen.generate({ settings, canvas, mask, signal }), marker);
});

test("native Android tablet keeps the touch interface when a mouse is connected", () => {
  const media = { matches: false, addEventListener() {} };
  const root = { dataset: {}, style: { setProperty() {} }, classList: { toggle() {} } };
  const window = {
    location: { search: "" }, localStorage: { getItem: () => null }, addEventListener() {},
    innerWidth: 744, innerHeight: 1080, screen: { width: 744, height: 1080 },
    matchMedia: () => media, Capacitor: { isNativePlatform: () => true },
  };
  runInNewContext(readFileSync(new URL("../web/shell.js", import.meta.url), "utf8"),
    { window, document: { documentElement: root }, URLSearchParams, console });
  assert.equal(window.TypeRShell.kind, "tablet");
  assert.equal(root.dataset.shell, "tablet");
});

test("Patch Tool acts on the touch selection mode, and desktop still uses modifiers", () => {
  const app = { doc: { width: 120, height: 120, state: { selection: {} } }, selectionMode: "subtract" };
  const window = {
    TypeRShell: { touch: true },
    TypeRPhotoshop: { app, ops: { selectionContains: () => true } },
    TypeRApp: { activeLayer: () => ({ kind: "raster", id: 7 }) },
  };
  runInNewContext(readFileSync(new URL("../web/patch-tool.js", import.meta.url), "utf8"), {
    window, document: { getElementById: () => null }, localStorage: { getItem: () => null },
  });
  const tool = window.TypeRPatchTool;
  const tap = { button: 0, clientX: 11, clientY: 12 };
  assert.equal(tool.down(tap, [11, 12], {}).selectionMode, "subtract");
  assert.equal(tool.down({ ...tap, shiftKey: true }, [11, 12], {}).selectionMode, "add");
  window.TypeRShell.touch = false;
  assert.equal(tool.down(tap, [11, 12], {}).phase, "dragging");
});

test("the mobile worker receives a compact binary selection and enforces bundled inference", async () => {
  const width = 512, height = 1025;
  const reads = [];
  class Worker {
    postMessage(request, transfer) {
      assert.equal(transfer[1].byteLength, width * height);
      assert.equal(request.selection.reduce((sum, bit) => sum + bit, 0), reads.length);
      for (const { y } of reads) assert.equal(request.selection[y * width], 1);
      assert.equal(request.offline, true);
      this.onmessage({ data: { id: request.id, rgba: request.rgba } });
    }
  }
  const window = { Worker, WebAssembly, createImageBitmap: true, TypeRMobile: { platform: "android" } };
  const url = "https://app.test/web/nemesis.js";
  const source = readFileSync(new URL("../web/nemesis.js", import.meta.url), "utf8");
  runInNewContext(source, {
    window, document: { currentScript: { src: url } }, URL, Worker,
    ImageData: class { constructor(data) { this.data = data; } },
    createImageBitmap: async (image) => image,
  });
  const canvas = { width, height, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }) }) };
  const mask = { getContext: () => ({ getImageData(x, y, w, rows) {
    assert.equal(x, 0);
    assert.equal(w, width);
    reads.push({ y, rows });
    const data = new Uint8ClampedArray(w * rows * 4).fill(250);
    data[0] = 249;
    return { data };
  } }) };
  const result = await window.TypeRNemesis.run(canvas, mask);
  assert.deepEqual(reads, [{ y: 0, rows: 512 }, { y: 512, rows: 512 }, { y: 1024, rows: 1 }]);
  assert.equal(result.data.length, width * height * 4);
});
