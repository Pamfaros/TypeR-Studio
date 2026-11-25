(function () {
  "use strict";

  const capacitor = window.Capacitor;
  if (capacitor?.getPlatform?.() !== "android" || !capacitor.isPluginAvailable?.("TypeRLocalAI")) return;
  const native = capacitor.Plugins.TypeRLocalAI;
  const models = {
    "mat-512": { port: 7870 },
    "flux2-klein-4b": { port: 7868, stem: "flux-2-klein-4b-", steps: 4 },
    "flux3-klein": { port: 7869, stem: "flux3-image-klein-", steps: 8 },
  };
  const portFor = (model) => Object.hasOwn(models, model) ? models[model].port : null;
  const request = (model, action, options) => native.request({ model, action, ...options });

  const check = async (model) => {
    try {
      const value = await request(model, "check");
      if (model === "mat-512") return value.model === model && value.version === 1;
      const features = value.features_by_mode?.img_gen || value.features;
      return Boolean(value.model?.stem?.toLowerCase().startsWith(models[model].stem) && features?.mask_image);
    } catch (error) {
      return false;
    }
  };

  const run = async ({ model, image, mask, prompt, width, height, signal, onProgress }) => {
    signal?.throwIfAborted();
    if (!await check(model)) {
      signal?.throwIfAborted();
      const error = new Error("Android runtime unavailable");
      error.kind = "androidruntime";
      error.port = portFor(model);
      throw error;
    }
    signal?.throwIfAborted();
    onProgress?.({ phase: "start" });
    const body = { init_image: image, mask_image: mask };
    const { steps } = models[model];
    if (steps) Object.assign(body, {
      prompt: String(prompt || "").slice(0, 4000), width, height, strength: 1, seed: -1,
      ref_images: [image],
      sample_params: { sample_method: "euler", sample_steps: steps, guidance: { txt_cfg: 1, img_cfg: 1 } },
      preview: "proj", preview_interval: 1, output_format: "png",
    });
    // Keep the submit response on abort so the engine's job ID remains available to cancel.
    const { id } = await request(model, "submit", { body });
    if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) throw new Error("The local runtime returned an invalid job ID.");
    const cancel = () => { void request(model, "cancel", { id }).catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      for (;;) {
        signal?.throwIfAborted();
        const job = await request(model, "poll", { id });
        signal?.throwIfAborted();
        if (job.status === "completed") {
          const png = job.result?.images?.[0]?.b64_json;
          if (typeof png !== "string" || !png.startsWith("iVBORw0KGgo")) throw new Error("The local runtime did not return a PNG.");
          return png;
        }
        if (job.status === "cancelled") throw new DOMException("Aborted", "AbortError");
        if (job.status === "failed") throw new Error(job.error?.message || "The local runtime failed.");
        if (!["queued", "generating", "running"].includes(job.status)) throw new Error("The local runtime returned an unknown job status.");
        if (job.progress) onProgress?.(job.progress);
        else if (job.preview?.total_steps) onProgress?.({ phase: "step", step: job.preview.step, total: job.preview.total_steps });
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };

  window.TypeRAndroidInpainting = { portFor, check, run };
})();
