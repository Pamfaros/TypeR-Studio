import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const android = readFileSync(new URL("../web/android-inpainting.js", import.meta.url), "utf8");
const generative = readFileSync(new URL("../web/generative.js", import.meta.url), "utf8");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZtqkAAAAASUVORK5CYII=";
const capability = (stem) => ({ model: { stem }, features_by_mode: { img_gen: { mask_image: true } } });

function load({ platform = "android", available = true, request = async () => {} } = {}) {
  const window = {
    TypeRMobile: { platform },
    TypeRNemesis: {},
    Capacitor: { getPlatform: () => platform, isPluginAvailable: () => available, Plugins: { TypeRLocalAI: { request } } },
    localStorage: { getItem: () => null },
  };
  const runtime = vm.createContext({ window, DOMException, setTimeout });
  vm.runInContext(android, runtime);
  vm.runInContext(generative, runtime);
  return { app: window.TypeRGenerative, engine: window.TypeRAndroidInpainting };
}

test("Android lists the three optional runtimes while keeping Nemesis as the default", () => {
  const { app } = load();
  const settings = app.load();
  assert.equal(app.modelOf(settings), "nemesis-manhwa");
  assert.deepEqual(Array.from(app.modelsOf(settings), ([id]) => id), [
    "nemesis-manhwa", "mat-512", "flux2-klein-4b", "flux3-klein",
  ]);
  assert.equal(load({ platform: "ios" }).engine, undefined);
  assert.equal(load({ available: false }).engine, undefined);
});

test("FLUX requires the matching runtime and a mask-capable model before uploading anything", async () => {
  const actions = [];
  const { engine } = load({ request: async ({ action }) => {
    actions.push(action);
    return capability("flux3-image-klein-Q4_K");
  } });
  await assert.rejects(engine.run({ model: "flux2-klein-4b", image: png, mask: png }), {
    kind: "androidruntime", port: 7868,
  });
  assert.deepEqual(actions, ["check"]);
});

test("FLUX submits masked image generation with the expected model settings and uses the returned PNG", async () => {
  const actions = [];
  const { engine } = load({ request: async (message) => {
    actions.push(message);
    if (message.action === "check") return capability("flux3-image-klein-Q4_K");
    if (message.action === "submit") return { id: "job_123" };
    return { status: "completed", result: { images: [{ b64_json: png }] } };
  } });
  assert.equal(await engine.run({ model: "flux3-klein", image: png, mask: "mask", width: 384, height: 256, prompt: "prompt" }), png);
  assert.deepEqual(actions.map(({ model, action }) => [model, action]), [
    ["flux3-klein", "check"], ["flux3-klein", "submit"], ["flux3-klein", "poll"],
  ]);
  assert.equal(actions[1].body.init_image, png);
  assert.equal(actions[1].body.mask_image, "mask");
  assert.equal(actions[1].body.sample_params.sample_steps, 8);
  assert.equal(actions[1].body.width, 384);
});

test("MAT sends image and mask without prompt, and cancels a job if aborted during submission", async () => {
  const controller = new AbortController();
  const actions = [];
  const { engine } = load({ request: async (message) => {
    actions.push(message);
    if (message.action === "check") return { model: "mat-512", version: 1 };
    if (message.action === "submit") {
      controller.abort();
      return { id: "job_123" };
    }
  } });
  await assert.rejects(engine.run({ model: "mat-512", image: png, mask: "mask", prompt: "unused", signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(actions.map(({ action }) => action), ["check", "submit", "cancel"]);
  assert.deepEqual(Object.keys(actions[1].body), ["init_image", "mask_image"]);
  assert.equal(actions[2].id, "job_123");
});
