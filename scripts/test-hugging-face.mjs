import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = (file) => readFileSync(new URL("../web/" + file, import.meta.url), "utf8");
const HUB = "https://huggingface.co";
const API = "https://black-forest-labs-flux-1-fill-dev.hf.space/gradio_api";
const INFER = API + "/call/infer";
const TOKEN = "hf_test_token";

function setup(fetch) {
  const storage = new Map();
  const window = { localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  const mask = { width: 2, height: 1, values: [0, 255] };
  const canvas = { width: 2, height: 1, toBlob: (done) => done(new Blob(["page"])) };
  const document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        getContext() { return this; },
        drawImage(image) { this.values = image.values?.slice(); },
        fillRect() {
          assert.equal(this.globalCompositeOperation, "difference");
          assert.equal(this.fillStyle, "#fff");
          this.values = this.values.map((value) => 255 - value);
        },
        getImageData() {
          return { data: Uint8ClampedArray.from(this.values.flatMap((value) => [value, value, value, 255])) };
        },
        putImageData(pixels) { this.values = pixels.data; },
        toBlob(done) { done(new Blob([this.values ? Uint8Array.from(this.values) : `page ${this.width}x${this.height}`])); },
      };
    },
  };
  const context = { window, document, fetch, console, FormData, URL, URLSearchParams, AbortController, TextDecoder, setTimeout, clearTimeout, crypto: globalThis.crypto, createImageBitmap: async (blob) => blob };
  runInNewContext(source("hugging-face.js"), context);
  runInNewContext(source("generative.js"), context);
  const { TypeRHuggingFace: hf, TypeRGenerative: gen } = window;
  gen.save({ service: gen.HF_SERVICE, models: { [gen.HF_SERVICE]: "flux-1-fill-dev" } });
  return { hf, gen, storage, canvas, mask };
}

function eventStream(...parts) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  }));
}

test("Generative Fill signs in per user, uploads only the crop and inverted mask, and returns the FLUX image", async () => {
  const paths = [];
  const { hf, gen, storage, canvas, mask } = setup(async (url, options) => {
    paths.push(url);
    assert.equal(options.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    if (url === HUB + "/api/whoami-v2") return Response.json({ name: "member" });
    if (url === API + "/upload") {
      const files = options.body.getAll("files");
      assert.deepEqual(files.map((file) => file.name), ["image.png", "mask.png"]);
      assert.equal(await files[0].text(), "page");
      assert.deepEqual(Array.from(new Uint8Array(await files[1].arrayBuffer())), [255, 0]);
      return Response.json(["/tmp/image.png", "/tmp/mask.png"]);
    }
    if (url === INFER) {
      const { data } = JSON.parse(options.body);
      const [selection, prompt] = data;
      assert.deepEqual(selection, {
        background: { path: "/tmp/image.png", meta: { _type: "gradio.FileData" } },
        layers: [{ path: "/tmp/mask.png", meta: { _type: "gradio.FileData" } }],
        composite: null,
      });
      assert.match(prompt, /Unlettered background matching the surrounding image/);
      return Response.json({ event_id: "job" });
    }
    if (url === INFER + "/job") return eventStream("event: heartbeat\r\ndata: null\r\n\r", "\nevent: comp", "lete\r\ndata: [{\"url\":\"" + API + "/file=result.png\"},1]\r\n\r\n");
    assert.equal(url, API + "/file=result.png");
    return new Response(new Blob(["filled"]));
  });
  assert.equal(gen.ready(gen.load()), false);
  assert.equal((await hf.connect(TOKEN)).name, "member");
  const settings = gen.load();
  assert.equal(gen.ready(settings), true);
  assert.equal(await (await gen.generate({ settings, canvas, mask })).text(), "filled");
  assert.equal(paths.length, 5);
  gen.save(settings);
  assert.doesNotMatch(Array.from(storage.values()).join(), /hf_test_token|member/);
  hf.disconnect();
  await assert.rejects(gen.generate({ settings, canvas, mask }), { kind: "key" });
  assert.equal(paths.length, 5);
});

test("ZeroGPU quota errors surface without retries and result URLs cannot send a token elsewhere", async () => {
  let event = 'event: error\ndata: "You have exceeded your ZeroGPU runs limit. Subscribe to Hugging Face PRO."\n\n';
  const { hf, gen, canvas, mask } = setup(async (url) => {
    if (url === HUB + "/api/whoami-v2") return Response.json({ name: "member" });
    if (url === API + "/upload") return Response.json(["/tmp/image", "/tmp/mask"]);
    if (url === INFER) return Response.json({ event_id: "job" });
    assert.equal(url, INFER + "/job");
    return eventStream(event);
  });
  await hf.connect(TOKEN);
  const settings = gen.load();
  await assert.rejects(gen.generate({ settings, canvas, mask }), { kind: "hfruns", rate: false });
  for (const [message, kind] of [
    ["You have exceeded your ZeroGPU quota (60s requested vs. 15s left).", "quota"],
    ["You have too many ZeroGPU credits allocated to running tasks.", "hfpending"],
    ["The requested GPU duration (270s) is larger than the maximum allowed.", "hfduration"],
    ["Space app has reached its GPU limit.", "hfspacequota"],
  ]) {
    event = "event: error\ndata: " + JSON.stringify(message) + "\n\n";
    await assert.rejects(gen.generate({ settings, canvas, mask }), { kind });
  }
  event = "event: error\ndata: null\n\n";
  await assert.rejects(gen.generate({ settings, canvas, mask }), { kind: "other", message: /without reporting a reason/ });
  event = 'event: complete\ndata: [{"url":"https://example.com/result.png"},1]\n\n';
  await assert.rejects(gen.generate({ settings, canvas, mask }), { kind: "noimage" });
});

test("OAuth device code signs in to the account that approved the request", async () => {
  const { hf } = setup(async (url, options) => {
    if (url === HUB + "/oauth/device") {
      assert.equal(options.body.get("client_id"), "public-client");
      assert.equal(options.body.has("client_secret"), false);
      return Response.json({
        device_code: "private-device-code", user_code: "PUBLIC-CODE", verification_uri: HUB + "/oauth/device",
        expires_in: 60, interval: 0.001,
      });
    }
    if (url === HUB + "/oauth/token") {
      assert.equal(options.body.get("device_code"), "private-device-code");
      return Response.json({ access_token: "hf_oauth_test", expires_in: 60 });
    }
    assert.equal(url, HUB + "/oauth/userinfo");
    assert.equal(options.headers.Authorization, "Bearer hf_oauth_test");
    return Response.json({ preferred_username: "oauth-member" });
  });
  const signedIn = await hf.signIn("public-client", new AbortController().signal, (code, url) => {
    assert.equal(code, "PUBLIC-CODE");
    assert.equal(url, HUB + "/oauth/device");
  });
  assert.equal(hf.account().name, "oauth-member");
  assert.equal(hf.account(), signedIn);
});

test("SDXL uses an alpha mask, the expected Gradio arguments, and the generated image", async () => {
  let customPrompt = "";
  const api = "https://diffusers-stable-diffusion-xl-inpainting.hf.space/gradio_api";
  const queue = api + "/queue";
  let session;
  let failure = false;
  const { hf, gen, canvas, mask } = setup(async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer " + TOKEN);
    if (url === HUB + "/api/whoami-v2") return Response.json({ name: "member" });
    if (url === api + "/upload") {
      const [image, mask] = options.body.getAll("files");
      assert.equal(await image.text(), "page 8x8");
      const rgba = new Uint8Array(await mask.arrayBuffer());
      assert.deepEqual(Array.from(rgba), [255, 255, 255, 255, 255, 255, 255, 0]);
      return Response.json(["/tmp/source.png", "/tmp/mask.png"]);
    }
    if (url === api.replace("/gradio_api", "/config")) return Response.json({ dependencies: [{ id: 3, api_name: "predict" }] });
    if (url === queue + "/join") {
      const request = JSON.parse(options.body);
      assert.equal(request.fn_index, 3);
      session = request.session_hash;
      const [edit, prompt, ...parameters] = request.data;
      assert.equal(edit.background.path, "/tmp/source.png");
      assert.equal(edit.layers[0].path, "/tmp/mask.png");
      if (customPrompt) {
        assert.equal(prompt, customPrompt);
        assert.equal(parameters[0], "");
      } else {
        assert.match(prompt, /Unlettered background matching the surrounding image/);
        assert.match(prompt, /Continue the existing lines, color gradients, and textures/);
        assert.match(parameters[0], /ghost lettering.*visible seams/);
      }
      assert.deepEqual(parameters.slice(1), customPrompt
        ? [7.5, 20, 0.99, "EulerDiscreteScheduler"]
        : [4.5, 24, 0.86, "EulerDiscreteScheduler"]);
      return Response.json({ event_id: "sdxl" });
    }
    if (url === queue + "/data?session_hash=" + session) {
      return failure
        ? eventStream('data: {"msg":"process_completed","event_id":"sdxl","success":false,"output":{"error":"You have exceeded your ZeroGPU runs limit."}}\n\n')
        : eventStream('data: {"msg":"process_completed","event_id":"sdxl","success":true,"output":{"data":[[{"path":"/tmp/source.png"},{"path":"/tmp/restored.webp"}]]}}\n\n');
    }
    assert.equal(url, api + "/file=/tmp/restored.webp");
    return new Response("restored");
  });
  await hf.connect(TOKEN);
  gen.save({ service: gen.HF_SERVICE });
  const settings = gen.load();
  assert.equal(gen.modelOf(settings), "sdxl-inpainting-0.1");
  assert.equal(gen.takesPrompt(settings), true);
  assert.equal(await (await gen.generate({ settings, canvas, mask, prompt: "   " })).text(), "restored");
  customPrompt = "A blue street sign with white letters";
  assert.equal(await (await gen.generate({ settings, canvas, mask, prompt: customPrompt })).text(), "restored");
  failure = true;
  await assert.rejects(gen.generate({ settings, canvas, mask, prompt: customPrompt }), { kind: "hfruns" });
});

test("nearby text masks share a ZeroGPU crop without masking the artwork between them", () => {
  const window = {};
  runInNewContext(source("textmask.js"), { window });
  const area = (left, top, values) => ({ left, top, width: values.length, height: 1, data: Uint8Array.from(values) });
  const first = area(2, 0, [1, 0, 1]);
  const second = area(4, 0, [0, 0, 1]);
  const third = area(8, 0, [1]);
  const distant = area(8, 19000, [1]);
  const groups = window.TypeRTextMask.mergeNearby([distant, second, first, third], 6, 2);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].left, 2);
  assert.equal(groups[0].width, 5);
  assert.deepEqual(Array.from(groups[0].data), [1, 0, 1, 0, 1]);
  assert.equal(groups[1], third);
  assert.equal(groups[2], distant);
});
