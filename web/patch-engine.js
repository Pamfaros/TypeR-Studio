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

  /*
   * Adaptive texture healing.
   *
   * Reconstruct the smooth target color field from pixels OUTSIDE the mask.
   * Preserve high-frequency detail from the source, and use clean pixels
   * around the mask to align texture and close the seam. The damaged target
   * pixels never participate in the final mix.
   *
   * This implementation is independent of the Poisson solver above. Keep it
   * self-contained so the same code can run inside a Blob Worker.
   */
  async function solveAdaptive(payload, checkpoint, cancelled) {
    const { width, height, source, target, mask, feather, preview, maxShift } = payload;
    const count = width * height;
    if (source.length !== count * 4 || target.length !== count * 4 ||
        mask.length !== count) {
      throw new Error("Invalid Adaptive Heal input buffers.");
    }

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const smooth = (t) => {
      const v = clamp(t, 0, 1);
      return v * v * (3 - 2 * v);
    };
    const rgb = (p) => p * 3;
    const rgba = (p) => p * 4;
    const sample = (field, x, y, channel) => field[(y * width + x) * 3 + channel];

    // Require defined RGB values for gradients and texture reconstruction.
    let selected = 0;
    for (let p = 0; p < count; p++) {
      if (!mask[p]) continue;
      selected++;
      if (source[rgba(p) + 3] < 254 || target[rgba(p) + 3] < 254) {
        throw new Error(
          "Adaptive Heal requires opaque source and target pixels. Use Normal on transparent layers."
        );
      }
    }
    if (!selected) return new Uint8ClampedArray(target);
    if (cancelled()) return null;

    // Approximate a Gaussian low-pass using a separable box filter.
    // The high-pass residual preserves the original colored dot pattern.
    const radius = clamp(Math.round(5 + feather * 0.65), 5, 12);
    const widthOfKernel = radius * 2 + 1;
    const horizontal = new Float32Array(count * 3);
    const lowSource = new Float32Array(count * 3);
    for (let y = 0; y < height; y++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += source[rgba(y * width + clamp(k, 0, width - 1)) + c];
        }
        for (let x = 0; x < width; x++) {
          horizontal[rgb(y * width + x) + c] = sum / widthOfKernel;
          sum += source[rgba(y * width + clamp(x + radius + 1, 0, width - 1)) + c] -
            source[rgba(y * width + clamp(x - radius, 0, width - 1)) + c];
        }
      }
      if ((y & 31) === 31 && cancelled()) return null;
    }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          sum += horizontal[rgb(clamp(k, 0, height - 1) * width + x) + c];
        }
        for (let y = 0; y < height; y++) {
          lowSource[rgb(y * width + x) + c] = sum / widthOfKernel;
          sum += horizontal[rgb(clamp(y + radius + 1, 0, height - 1) * width + x) + c] -
            horizontal[rgb(clamp(y - radius, 0, height - 1) * width + x) + c];
        }
      }
    }
    if (cancelled()) return null;
    await checkpoint();

    // Coarse harmonic inpainting estimates only the background color gradient.
    // Masked pixels are intentionally excluded from the low-frequency fit.
    // Keep the harmonic grid bounded on large webtoon regions.
    const gridBudget = preview ? 6000 : 24000;
    const step = Math.max(preview ? 9 : 6, Math.ceil(Math.sqrt(count / gridBudget)));
    const gridWidth = Math.ceil(width / step);
    const gridHeight = Math.ceil(height / step);
    const gridCount = gridWidth * gridHeight;
    const grid = new Float32Array(gridCount * 3);
    const known = new Uint8Array(gridCount);
    const weights = new Uint32Array(gridCount);
    let totalKnown = 0;
    const average = [0, 0, 0];
    for (let y = 0; y < height; y++) {
      const gy = (y / step) | 0;
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (mask[p] || target[rgba(p) + 3] < 254) continue;
        const g = gy * gridWidth + ((x / step) | 0);
        weights[g]++;
        for (let c = 0; c < 3; c++) {
          grid[rgb(g) + c] += target[rgba(p) + c];
          average[c] += target[rgba(p) + c];
        }
        totalKnown++;
      }
    }
    if (!totalKnown) {
      throw new Error("Adaptive Heal needs clean pixels around the selected region.");
    }
    for (let c = 0; c < 3; c++) average[c] /= totalKnown;
    for (let g = 0; g < gridCount; g++) {
      known[g] = weights[g] > 0 ? 1 : 0;
      for (let c = 0; c < 3; c++) {
        grid[rgb(g) + c] = known[g] ? grid[rgb(g) + c] / weights[g] : average[c];
      }
    }
    // The low-resolution Laplace equation is solved using red-black SOR.
    const iterations = preview ? 120 : Math.min(850, Math.max(160,
      Math.round(Math.max(gridWidth, gridHeight) * 3.0)));
    for (let iter = 0; iter < iterations; iter++) {
      if (cancelled()) return null;
      let maxChange = 0;
      for (let parity = 0; parity < 2; parity++) {
        for (let gy = 0; gy < gridHeight; gy++) {
          for (let gx = (gy + parity) & 1; gx < gridWidth; gx += 2) {
            const g = gy * gridWidth + gx;
            if (known[g]) continue;
            const neighbors = [];
            if (gx > 0) neighbors.push(g - 1);
            if (gx + 1 < gridWidth) neighbors.push(g + 1);
            if (gy > 0) neighbors.push(g - gridWidth);
            if (gy + 1 < gridHeight) neighbors.push(g + gridWidth);
            for (let c = 0; c < 3; c++) {
              let sum = 0;
              for (const n of neighbors) sum += grid[rgb(n) + c];
              const i = rgb(g) + c;
              const delta = 1.58 * (sum / neighbors.length - grid[i]);
              grid[i] += delta;
              if (Math.abs(delta) > maxChange) maxChange = Math.abs(delta);
            }
          }
        }
      }
      if (iter > 30 && maxChange < (preview ? 0.18 : 0.025)) break;
      if ((iter & 15) === 15) await checkpoint();
    }
    if (cancelled()) return null;

    // Bilinear sampling in the coarse target background field.
    const targetLowAt = (x, y, c) => {
      const fx = clamp((x + 0.5) / step - 0.5, 0, gridWidth - 1);
      const fy = clamp((y + 0.5) / step - 0.5, 0, gridHeight - 1);
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(gridWidth - 1, x0 + 1);
      const y1 = Math.min(gridHeight - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const a = grid[rgb(y0 * gridWidth + x0) + c] * (1 - tx) +
        grid[rgb(y0 * gridWidth + x1) + c] * tx;
      const b = grid[rgb(y1 * gridWidth + x0) + c] * (1 - tx) +
        grid[rgb(y1 * gridWidth + x1) + c] * tx;
      return a * (1 - ty) + b * ty;
    };

    // Align the source's high-frequency pattern to clean target pixels
    // immediately outside the selected boundary, without reading damage.
    const boundaries = [];
    const owner = new Int32Array(count);
    const distance = new Uint8Array(count);
    const queue = new Int32Array(selected);
    let tail = 0;
    const blendWidth = clamp(Math.round(2 + feather), 2, 9);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!mask[p]) continue;
        const adjacent = [
          x > 0 ? p - 1 : -1,
          x + 1 < width ? p + 1 : -1,
          y > 0 ? p - width : -1,
          y + 1 < height ? p + width : -1
        ];
        for (const q of adjacent) {
          if (q < 0 || mask[q] || target[rgba(q) + 3] < 254) continue;
          if (!distance[p]) {
            distance[p] = 1;
            owner[p] = q;
            queue[tail++] = p;
          }
          if (boundaries.length < 8000) boundaries.push([p, q]);
          break;
        }
      }
    }
    if (!boundaries.length) {
      throw new Error("Adaptive Heal needs an unselected boundary around the patch.");
    }
    for (let head = 0; head < tail; head++) {
      const p = queue[head], d = distance[p];
      if (d >= blendWidth) continue;
      const x = p % width, y = (p / width) | 0;
      const neighbors = [
        x > 0 ? p - 1 : -1,
        x + 1 < width ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y + 1 < height ? p + width : -1
      ];
      for (const q of neighbors) {
        if (q < 0 || !mask[q] || distance[q]) continue;
        distance[q] = d + 1;
        owner[q] = owner[p];
        queue[tail++] = q;
      }
    }
    if (cancelled()) return null;

    let bestDx = 0, bestDy = 0;
    const search = clamp(maxShift, 0, preview ? 3 : 6);
    if (search && boundaries.length >= 8) {
      let bestCost = Infinity;
      const stride = Math.max(1, Math.floor(boundaries.length / 850));
      const minSamples = Math.max(5, Math.floor((boundaries.length / stride) * 0.75));
      for (let dy = -search; dy <= search; dy++) {
        for (let dx = -search; dx <= search; dx++) {
          let cost = 0, samples = 0;
          for (let bi = 0; bi < boundaries.length; bi += stride) {
            const [p, q] = boundaries[bi];
            const x = p % width, y = (p / width) | 0;
            const sx = x + dx, sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            const sp = sy * width + sx;
            if (source[rgba(sp) + 3] < 254) continue;
            const qx = q % width, qy = (q / width) | 0;
            let error = 0;
            for (let c = 0; c < 3; c++) {
              const sd = source[rgba(sp) + c] - lowSource[rgb(sp) + c];
              const td = target[rgba(q) + c] - targetLowAt(qx, qy, c);
              const difference = clamp(sd - td, -75, 75);
              error += difference * difference;
            }
            cost += error;
            samples++;
          }
          if (samples < minSamples) continue;
          const scored = cost / samples + (dx * dx + dy * dy) * 3.5;
          if (scored < bestCost) {
            bestCost = scored;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }
    }
    if (cancelled()) return null;

    const result = new Uint8ClampedArray(target);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!mask[p]) continue;
        const sx = x + bestDx, sy = y + bestDy;
        const hasShiftedSource = sx >= 0 && sy >= 0 && sx < width && sy < height &&
          source[rgba(sy * width + sx) + 3] >= 254;
        const sp = hasShiftedSource ? sy * width + sx : p;
        const borderDistance = distance[p];
        const detailRatio = borderDistance
          ? smooth((borderDistance - 0.3) / blendWidth)
          : 1;
        const neighbor = borderDistance ? owner[p] : -1;
        for (let c = 0; c < 3; c++) {
          const sourceDetail = source[rgba(sp) + c] - lowSource[rgb(sp) + c];
          let detail = sourceDetail;
          if (neighbor >= 0 && borderDistance <= blendWidth) {
            const qx = neighbor % width, qy = (neighbor / width) | 0;
            const outsideDetail = target[rgba(neighbor) + c] -
              targetLowAt(qx, qy, c);
            detail = outsideDetail * (1 - detailRatio) + sourceDetail * detailRatio;
          }
          result[rgba(p) + c] = clamp(targetLowAt(x, y, c) + detail, 0, 255);
        }
      }
      if ((y & 31) === 31 && cancelled()) return null;
    }
    return cancelled() ? null : result;
  }

  function validateAdaptive(options) {
    validateInput(options);
    if (options.maxShift !== undefined &&
        (!Number.isInteger(options.maxShift) || options.maxShift < 0 || options.maxShift > 6)) {
      throw new TypeError("Adaptive Heal maxShift must be an integer between 0 and 6.");
    }
  }

  function adaptiveWorkerSource() {
    return `"use strict";\n` +
      `const solveAdaptive = ${solveAdaptive.toString()};\n` +
      `self.onmessage = async (event) => {\n` +
      `  try {\n` +
      `    const pixels = await solveAdaptive(event.data, async () => {}, () => false);\n` +
      `    self.postMessage({ pixels }, pixels ? [pixels.buffer] : []);\n` +
      `  } catch (error) {\n` +
      `    self.postMessage({ error: String(error?.message || error) });\n` +
      `  }\n` +
      `};\n`;
  }

  async function adaptiveBlend(options) {
    validateAdaptive(options);
    if (options.signal?.aborted) return null;
    const payload = {
      width: options.width,
      height: options.height,
      source: new Uint8ClampedArray(options.source.data),
      target: new Uint8ClampedArray(options.target.data),
      mask: new Uint8Array(options.mask),
      feather: Math.max(0, Math.min(32, Math.round(Number(options.feather) || 0))),
      maxShift: options.maxShift === undefined ? 5 : options.maxShift,
      preview: Boolean(options.preview)
    };
    const signal = options.signal;
    const fallback = async () => {
      const pixels = await solveAdaptive(payload, waitForFrame, () => Boolean(signal?.aborted));
      return pixels && !signal?.aborted ? asImageData(pixels, payload.width, payload.height) : null;
    };
    if (typeof Worker !== "function" || typeof Blob !== "function" ||
        typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return fallback();
    }
    let worker, url;
    try {
      url = URL.createObjectURL(new Blob([adaptiveWorkerSource()], { type: "text/javascript" }));
      worker = new Worker(url);
    } catch (_) {
      if (worker) worker.terminate();
      if (url) URL.revokeObjectURL(url);
      return fallback();
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      const finish = (value, error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => finish(null);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      worker.onmessage = (event) => {
        if (event.data?.error) return finish(null, new Error(event.data.error));
        if (signal?.aborted || !event.data?.pixels) return finish(null);
        return finish(asImageData(event.data.pixels, payload.width, payload.height));
      };
      const onError = () => {
        if (done) return;
        done = true;
        cleanup();
        fallback().then(resolve, reject);
      };
      worker.onerror = onError;
      worker.onmessageerror = onError;
      try {
        const transfer = {
          ...payload,
          source: new Uint8ClampedArray(payload.source),
          target: new Uint8ClampedArray(payload.target),
          mask: new Uint8Array(payload.mask)
        };
        worker.postMessage(transfer, [
          transfer.source.buffer, transfer.target.buffer, transfer.mask.buffer
        ]);
      } catch (_) {
        onError();
      }
    });
  }

  // Independently implemented selection-based healing. The domain follows a
  // thresholded selection; only source gradients between domain pixels are
  // retained. Target pixels outside the domain anchor the reconstructed color.
  // This is intentionally separate from the legacy Poisson and Adaptive modes.
  async function solveHealing(payload, checkpoint, cancelled) {
    const { width, height, source, target, mask, coverage, threshold,
      omega, tolerance, maxIterations, maxDurationMs } = payload;
    const count = width * height;
    const domain = new Uint8Array(count);
    let selected = 0;
    for (let p = 0; p < count; p++) {
      if (!mask[p] || coverage[p] < threshold) continue;
      const rgba = p * 4;
      if (source[rgba + 3] < 254 || target[rgba + 3] < 254) {
        throw new Error(
          "Healing requires an opaque source and target. Use a fully opaque raster layer or Normal mode."
        );
      }
      domain[p] = 1;
      selected++;
    }
    if (!selected) return new Uint8ClampedArray(target);

    // Keep one set of pixel coordinates for all channels. Boundary pixels are
    // fixed, so pixels beyond the selected domain are never modified.
    const indices = new Int32Array(selected);
    const rowOf = new Int32Array(count);
    rowOf.fill(-1);
    for (let p = 0, next = 0; p < count; p++) {
      if (domain[p]) {
        indices[next] = p;
        rowOf[p] = next++;
      }
    }
    const degree = new Uint8Array(selected);
    const rhs = new Float64Array(selected * 3);
    const values = new Float64Array(selected * 3);
    let boundaryLinks = 0;

    for (let row = 0; row < selected; row++) {
      const p = indices[row];
      const x = p % width;
      const y = (p / width) | 0;
      const adjacent = [
        y > 0 ? p - width : -1,
        x > 0 ? p - 1 : -1,
        x + 1 < width ? p + 1 : -1,
        y + 1 < height ? p + width : -1
      ];
      const pi = p * 4;
      const ri = row * 3;
      for (let channel = 0; channel < 3; channel++) {
        values[ri + channel] = source[pi + channel];
      }
      for (const q of adjacent) {
        if (q < 0) continue;
        const qi = q * 4;
        if (!domain[q] && target[qi + 3] < 200) continue;
        degree[row]++;
        if (domain[q]) {
          for (let channel = 0; channel < 3; channel++) {
            rhs[ri + channel] += source[pi + channel] - source[qi + channel];
          }
        } else {
          boundaryLinks++;
          for (let channel = 0; channel < 3; channel++) {
            rhs[ri + channel] += target[qi + channel];
          }
        }
      }
      if (!degree[row]) {
        throw new Error("Healing needs valid neighboring pixels around the selection.");
      }
    }
    if (!boundaryLinks) {
      throw new Error("Healing needs an unselected boundary around the patch.");
    }

    // A forward Gauss-Seidel SOR sweep, with configurable convergence limits.
    // Values are kept as floats until the final composite to avoid rounding
    // artifacts and accumulation of 8-bit quantization errors.
    const started = Date.now();
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (cancelled()) return null;
      let squaredChange = 0;
      for (let row = 0; row < selected; row++) {
        const p = indices[row];
        const x = p % width;
        const y = (p / width) | 0;
        const adjacent = [
          y > 0 ? p - width : -1,
          x > 0 ? p - 1 : -1,
          x + 1 < width ? p + 1 : -1,
          y + 1 < height ? p + width : -1
        ];
        const ri = row * 3;
        let r = rhs[ri];
        let g = rhs[ri + 1];
        let b = rhs[ri + 2];
        for (const q of adjacent) {
          if (q < 0 || !domain[q]) continue;
          const qi = rowOf[q] * 3;
          r += values[qi];
          g += values[qi + 1];
          b += values[qi + 2];
        }
        const scale = omega / degree[row];
        const dr = (r - degree[row] * values[ri]) * scale;
        const dg = (g - degree[row] * values[ri + 1]) * scale;
        const db = (b - degree[row] * values[ri + 2]) * scale;
        values[ri] += dr;
        values[ri + 1] += dg;
        values[ri + 2] += db;
        squaredChange += 0.4 * dr * dr + 0.5 * dg * dg + 0.1 * db * db;
      }
      if (!Number.isFinite(squaredChange)) {
        throw new Error("Healing solver became unstable.");
      }
      if (iteration >= 24 && squaredChange / selected < tolerance) break;
      if ((iteration & 7) === 7) {
        await checkpoint();
        if (Date.now() - started >= maxDurationMs) break;
      }
    }
    if (cancelled()) return null;

    const output = new Uint8ClampedArray(target);
    for (let row = 0; row < selected; row++) {
      const p = indices[row];
      const at = p * 4;
      const rgb = row * 3;
      const blend = coverage[p] / 255;
      for (let channel = 0; channel < 3; channel++) {
        const value = Math.max(0, Math.min(255, values[rgb + channel]));
        output[at + channel] = target[at + channel] * (1 - blend) + value * blend;
      }
    }
    return output;
  }

  function validateHealing(options) {
    validateInput(options);
    if (options.maskThreshold !== undefined &&
        (!Number.isFinite(options.maskThreshold) || options.maskThreshold < 0 || options.maskThreshold > 1)) {
      throw new TypeError("Healing maskThreshold must be between 0 and 1.");
    }
  }

  function healingWorkerSource() {
    return `"use strict";\n` +
      `const solveHealing = ${solveHealing.toString()};\n` +
      `self.onmessage = async (event) => {\n` +
      `  try {\n` +
      `    const pixels = await solveHealing(event.data, async () => {}, () => false);\n` +
      `    self.postMessage({ pixels }, pixels ? [pixels.buffer] : []);\n` +
      `  } catch (error) {\n` +
      `    self.postMessage({ error: String(error?.message || error) });\n` +
      `  }\n` +
      `};\n`;
  }

  async function healingBlend(options) {
    validateHealing(options);
    if (options.signal?.aborted) return null;
    const pixelCount = options.width * options.height;
    const payload = {
      width: options.width,
      height: options.height,
      source: new Uint8ClampedArray(options.source.data),
      target: new Uint8ClampedArray(options.target.data),
      mask: new Uint8Array(options.mask),
      coverage: new Uint8Array(options.coverage),
      threshold: Math.max(1, Math.round(255 * (options.maskThreshold ?? 0.10))),
      omega: options.omega ?? 1.96,
      tolerance: options.tolerance ?? 0.00005,
      maxIterations: options.maxIterations ?? Math.min(6500, Math.max(450, Math.round(Math.sqrt(pixelCount) * 15))),
      maxDurationMs: options.maxDurationMs ?? 10000
    };
    if (!Number.isFinite(payload.omega) || payload.omega <= 0 || payload.omega >= 2 ||
        !Number.isFinite(payload.tolerance) || payload.tolerance <= 0 ||
        !Number.isSafeInteger(payload.maxIterations) || payload.maxIterations < 1 || payload.maxIterations > 20000 ||
        !Number.isFinite(payload.maxDurationMs) || payload.maxDurationMs <= 0 || payload.maxDurationMs > 120000) {
      throw new TypeError("Invalid Healing solver parameters.");
    }

    const signal = options.signal;
    const fallback = async () => {
      const pixels = await solveHealing(payload, waitForFrame, () => Boolean(signal?.aborted));
      return pixels && !signal?.aborted
        ? asImageData(pixels, payload.width, payload.height) : null;
    };
    if (typeof Worker !== "function" || typeof Blob !== "function" ||
        typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      return fallback();
    }
    let worker;
    let url;
    try {
      url = URL.createObjectURL(new Blob([healingWorkerSource()], { type: "text/javascript" }));
      worker = new Worker(url);
    } catch (_) {
      if (worker) worker.terminate();
      if (url) URL.revokeObjectURL(url);
      return fallback();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => finish(null);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      worker.onmessage = (event) => {
        if (event.data?.error) return finish(null, new Error(event.data.error));
        if (signal?.aborted || !event.data?.pixels) return finish(null);
        return finish(asImageData(event.data.pixels, payload.width, payload.height));
      };
      const onWorkerError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        fallback().then(resolve, reject);
      };
      worker.onerror = onWorkerError;
      worker.onmessageerror = onWorkerError;
      try {
        const transfer = {
          ...payload,
          source: new Uint8ClampedArray(payload.source),
          target: new Uint8ClampedArray(payload.target),
          mask: new Uint8Array(payload.mask),
          coverage: new Uint8Array(payload.coverage)
        };
        worker.postMessage(transfer, [
          transfer.source.buffer, transfer.target.buffer,
          transfer.mask.buffer, transfer.coverage.buffer
        ]);
      } catch (_) {
        onWorkerError();
      }
    });
  }

  window.TypeRPatchEngine = Object.freeze({ poissonBlend, adaptiveBlend, healingBlend });
})();
