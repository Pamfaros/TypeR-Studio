import { SIDE, restoreTiles } from "./nemesis-tiles.js";

const packaged = new URL("./vendor/nemesis/", import.meta.url);
const cdn = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const model = new URL("./models/nemesis-manhwa.onnx", import.meta.url);
let sessionPromise;

async function loadSession(offline) {
  let base = packaged;
  let extension = ".js";
  let ort;
  try {
    ort = await import(new URL("ort.wasm.min" + extension, base));
  } catch (error) {
    if (offline) throw error;
    base = cdn;
    extension = ".mjs";
    ort = await import(new URL("ort.wasm.min" + extension, base));
  }
  // This is already a worker. One thread is supported by WebViews without cross-origin isolation.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = {
    mjs: new URL("ort-wasm-simd-threaded" + extension, base).href,
    wasm: new URL("ort-wasm-simd-threaded.wasm", base).href,
  };
  const session = await ort.InferenceSession.create(model.href, { executionProviders: ["wasm"] });
  return { ort, session };
}

self.onmessage = async ({ data: { id, rgba, selection, width, height, offline } }) => {
  try {
    const predict = async (rgb, mask) => {
      sessionPromise ??= loadSession(offline).catch((error) => { sessionPromise = null; throw error; });
      const { ort, session } = await sessionPromise;
      const { restored } = await session.run({
        image: new ort.Tensor("float32", rgb, [1, 3, SIDE, SIDE]),
        mask: new ort.Tensor("float32", mask, [1, 1, SIDE, SIDE]),
      });
      return restored.data;
    };
    await restoreTiles(rgba, selection, width, height, predict, (done, total) => self.postMessage({ id, done, total }));
    self.postMessage({ id, rgba }, [rgba.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  }
};
