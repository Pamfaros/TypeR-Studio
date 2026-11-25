// Keep model inference off the editor thread. A worker is reused until an active job is canceled.
(function () {
  "use strict";
  const workerUrl = new URL("nemesis-worker.js", document.currentScript.src);
  const abortError = () => new DOMException("Aborted", "AbortError");
  let worker;
  let queue = Promise.resolve();
  let serial = 0;

  function readSelection(mask, width, height) {
    const selection = new Uint8Array(width * height);
    if (!mask) return selection.fill(1);

    // A long webtoon page can exceed the WebView heap if read as one RGBA mask.
    const ctx = mask.getContext("2d");
    const rowsPerRead = Math.max(1, Math.floor(262144 / width)); // at most 1 MiB for typical page widths
    for (let y = 0; y < height; y += rowsPerRead) {
      const rows = Math.min(rowsPerRead, height - y);
      const pixels = ctx.getImageData(0, y, width, rows).data;
      const start = y * width;
      for (let at = 0; at < rows * width; at++) selection[start + at] = Number(pixels[at * 4] < 250);
    }
    return selection;
  }

  function run(canvas, mask, signal, progress) {
    const job = queue.then(() => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const { width, height } = canvas;
      const selection = readSelection(mask, width, height);
      const rgba = canvas.getContext("2d").getImageData(0, 0, width, height).data;
      worker ??= new Worker(workerUrl, { type: "module" });
      const id = ++serial;
      const cleanup = () => {
        signal?.removeEventListener("abort", cancel);
        worker.onmessage = worker.onerror = null;
      };
      const stop = (error) => {
        cleanup();
        worker.terminate();
        worker = null;
        reject(error);
      };
      const cancel = () => stop(abortError());
      signal?.addEventListener("abort", cancel, { once: true });
      worker.onerror = (event) => stop(new Error(event.message || "Nemesis worker failed to start."));
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.total) return progress?.({ phase: "inference", loaded: data.done, total: data.total });
        cleanup();
        if (data.error) return reject(new Error(data.error));
        resolve(createImageBitmap(new ImageData(data.rgba, width, height)).then((bitmap) => {
          if (!signal?.aborted) return bitmap;
          bitmap.close();
          throw abortError();
        }));
      };
      try {
        worker.postMessage({ id, rgba, selection, width, height, offline: Boolean(window.TypeRMobile) },
          [rgba.buffer, selection.buffer]);
      } catch (error) {
        stop(error);
      }
    }));
    queue = job.catch(() => {});
    return job;
  }
  if (window.Worker && window.WebAssembly && window.createImageBitmap) window.TypeRNemesis = { run };
})();
