/*
 * TypeR Studio - Patch Engine
 *
 * Poisson gradient-domain blending for selection-based raster repairs.
 * The caller supplies matching source/target ImageData and a binary mask
 * within the same local region of interest (ROI).
 *
 * The engine does not modify input buffers or document history.
 * The output is a complete ImageData ROI, including unchanged pixels.
 *
 * Public API:
 *   window.TypeRPatchEngine.poissonBlend({
 *     width, height, source, target, mask, coverage, signal
 *   }) -> Promise<ImageData | null>
 *
 * Worker execution is attempted first. Where Blob Workers are blocked,
 * a time-sliced main-thread fallback retains cancellation support.
 */
(function () {
  "use strict";

  const MAX_PIXELS = 4_000_000;
  const DEFAULT_TOLERANCE = 0.10;
  const MIN_ITERATIONS = 350;
  const MAX_ITERATIONS = 1800;
  const SOR_OMEGA = 1.7;

  const waitForFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

  // This function must be self-contained because it also runs in a Blob Worker.
  async function solvePoisson(payload, checkpoint, cancelled) {
    const {
      width, height, source, target, mask, coverage,
      guidanceMode, tolerance, iterations, omega
    } = payload;

    const count = width * height;
    if (
      source.length !== count * 4 ||
      target.length !== count * 4 ||
      mask.length !== count ||
      coverage.length !== count
    ) {
      throw new Error("Invalid Patch Engine pixel buffers.");
    }

    // All calculations use source gradients but target boundary colors.
    const solution = new Float32Array(count * 3);
    const divergence = new Float32Array(count * 3);
    let selected = 0;

    for (let p = 0; p < count; p++) {
      const rgb = p * 3;
      const rgba = p * 4;
      for (let c = 0; c < 3; c++) {
        solution[rgb + c] = target[rgba + c];
      }
      if (!mask[p]) continue;

      selected++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        throw new Error(
          "Poisson Blend needs a one-pixel boundary around the selection. Use Normal near page edges."
        );
      }

      const neighbors = [p - 1, p + 1, p - width, p + width];
      for (const q of [p, ...neighbors]) {
        if (source[q * 4 + 3] < 254 || target[q * 4 + 3] < 254) {
          throw new Error(
            "Poisson Blend requires opaque source and target pixels. Use Normal on transparent layers."
          );
        }
      }

      for (let c = 0; c < 3; c++) {
        let sum = 0;
        const s = source[rgba + c];
        const t = target[rgba + c];
        for (const q of neighbors) {
          const sourceGradient = s - source[q * 4 + c];
          if (guidanceMode === "mixed") {
            const targetGradient = t - target[q * 4 + c];
            sum += Math.abs(sourceGradient) >= Math.abs(targetGradient)
              ? sourceGradient : targetGradient;
          } else {
            sum += sourceGradient;
          }
        }
        divergence[rgb + c] = sum;
      }
    }

    if (!selected) return new Uint8ClampedArray(target);

    // Red-black successive over-relaxation with fixed target boundary values.
    for (let iteration = 0; iteration < iterations; iteration++) {
      if (cancelled()) return null;
      let maxChange = 0;

      for (let parity = 0; parity < 2; parity++) {
        for (let y = 1; y < height - 1; y++) {
          for (let x = 1 + ((y + parity) & 1); x < width - 1; x += 2) {
            const p = y * width + x;
            if (!mask[p]) continue;
            const neighbors = [p - 1, p + 1, p - width, p + width];
            for (let c = 0; c < 3; c++) {
              let sum = divergence[p * 3 + c];
              for (const q of neighbors) {
                sum += mask[q] ? solution[q * 3 + c] : target[q * 4 + c];
              }
              const i = p * 3 + c;
              const delta = omega * (sum / 4 - solution[i]);
              solution[i] += delta;
              maxChange = Math.max(maxChange, Math.abs(delta));
            }
          }
        }
      }

      if (iteration >= 32 && maxChange < tolerance) break;
      if ((iteration & 3) === 3) await checkpoint();
    }

    if (cancelled()) return null;

    // Composite only inside the selected mask. Alpha remains unchanged.
    const result = new Uint8ClampedArray(target);
    for (let p = 0; p < count; p++) {
      if (!mask[p] || !coverage[p]) continue;
      const weight = coverage[p] / 255;
      for (let c = 0; c < 3; c++) {
        const i = p * 4 + c;
        const solved = Math.max(0, Math.min(255, solution[p * 3 + c]));
        result[i] = target[i] * (1 - weight) + solved * weight;
      }
    }
    return result;
  }

  function validateInput(options) {
    if (!options) throw new TypeError("Patch Engine options are required.");
    const { width, height, source, target, mask, coverage } = options;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width < 1 || height < 1 || width * height > MAX_PIXELS) {
      throw new RangeError("Invalid or excessively large Patch Engine ROI.");
    }
    if (!source || !target || !source.data || !target.data ||
        source.width !== width || source.height !== height ||
        target.width !== width || target.height !== height ||
        source.data.length !== width * height * 4 ||
        target.data.length !== width * height * 4 ||
        !mask || mask.length !== width * height ||
        !coverage || coverage.length !== width * height) {
      throw new TypeError("Patch Engine requires matching ImageData and pixel masks.");
    }
    if (options.guidance !== undefined &&
        options.guidance !== "source" && options.guidance !== "mixed") {
      throw new TypeError("Unsupported Poisson guidance mode.");
    }
  }

  function createPayload(options) {
    const count = options.width * options.height;
    const selected = options.mask.some((value) => value !== 0);
    const dynamicIterations = Math.min(
      MAX_ITERATIONS,
      Math.max(MIN_ITERATIONS, Math.round(Math.sqrt(count) * 2.8))
    );
    return {
      width: options.width,
      height: options.height,
      source: new Uint8ClampedArray(options.source.data),
      target: new Uint8ClampedArray(options.target.data),
      mask: new Uint8Array(options.mask),
      coverage: new Uint8Array(options.coverage),
      guidanceMode: options.guidance || "source",
      tolerance: Number.isFinite(options.tolerance)
        ? Math.max(0.001, Math.min(1, options.tolerance)) : DEFAULT_TOLERANCE,
      iterations: Number.isInteger(options.maxIterations)
        ? Math.max(1, Math.min(5000, options.maxIterations)) : dynamicIterations,
      omega: SOR_OMEGA,
      selected
    };
  }

  function asImageData(pixels, width, height) {
    return new ImageData(new Uint8ClampedArray(pixels), width, height);
  }

  async function solveFallback(payload, signal) {
    const pixels = await solvePoisson(
      payload,
      waitForFrame,
      () => Boolean(signal?.aborted)
    );
    return pixels && !signal?.aborted
      ? asImageData(pixels, payload.width, payload.height)
      : null;
  }

  function workerSource() {
    return `"use strict";\n` +
      `const solvePoisson = ${solvePoisson.toString()};\n` +
      `self.onmessage = async (event) => {\n` +
      `  try {\n` +
      `    const pixels = await solvePoisson(event.data, async () => {}, () => false);\n` +
      `    self.postMessage({ pixels }, pixels ? [pixels.buffer] : []);\n` +
      `  } catch (error) {\n` +
      `    self.postMessage({ error: String(error?.message || error) });\n` +
      `  }\n` +
      `};\n`;
  }

  async function poissonBlend(options) {
    validateInput(options);
    if (options.signal?.aborted) return null;
    const payload = createPayload(options);
    const { width, height } = payload;

    if (!payload.selected) {
      return asImageData(payload.target, width, height);
    }

    if (typeof Worker !== "function" || typeof Blob !== "function" ||
        typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return solveFallback(payload, options.signal);
    }

    let url;
    let worker;
    try {
      url = URL.createObjectURL(
        new Blob([workerSource()], { type: "text/javascript" })
      );
      worker = new Worker(url);
    } catch (_) {
      if (worker) worker.terminate();
      if (url) URL.revokeObjectURL(url);
      return solveFallback(payload, options.signal);
    }

    return new Promise((resolve, reject) => {
      let done = false;
      const signal = options.signal;
      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      const finish = (result, error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = () => finish(null);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      worker.onmessage = (event) => {
        if (signal?.aborted) return finish(null);
        if (event.data?.error) {
          finish(null, new Error(event.data.error));
        } else if (event.data?.pixels) {
          finish(asImageData(event.data.pixels, width, height));
        } else {
          finish(null);
        }
      };
      const fallback = () => {
        if (done) return;
        done = true;
        cleanup();
        solveFallback(payload, signal).then(resolve, reject);
      };
      worker.onerror = fallback;
      worker.onmessageerror = fallback;
      try {
        // Keep the original payload intact for the fallback path.
        const workerPayload = {
          ...payload,
          source: new Uint8ClampedArray(payload.source),
          target: new Uint8ClampedArray(payload.target),
          mask: new Uint8Array(payload.mask),
          coverage: new Uint8Array(payload.coverage)
        };
        worker.postMessage(workerPayload, [
          workerPayload.source.buffer,
          workerPayload.target.buffer,
          workerPayload.mask.buffer,
          workerPayload.coverage.buffer
        ]);
      } catch (_) {
        fallback();
      }
    });
  }

  window.TypeRPatchEngine = Object.freeze({ poissonBlend });
})();
