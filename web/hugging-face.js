// Hugging Face ZeroGPU uses the bearer token of the person running the fill.
(function () {
  "use strict";

  const HUB = "https://huggingface.co";
  const SDXL = "sdxl-inpainting-0.1";
  const CLEAN_TEXT_NEGATIVE = "text, lettering, words, numbers, watermarks, ghost lettering, leftover strokes, halos, visible seams, color banding, smudges, blur, noise, distorted lines";
  const models = {
    [SDXL]: {
      name: "SDXL Inpainting 0.1", space: "diffusers/stable-diffusion-xl-inpainting",
      origin: "https://diffusers-stable-diffusion-xl-inpainting.hf.space", endpoint: "predict",
    },
    "flux-1-fill-dev": {
      name: "FLUX.1 Fill [dev]", space: "black-forest-labs/FLUX.1-Fill-dev",
      origin: "https://black-forest-labs-flux-1-fill-dev.hf.space", endpoint: "infer",
    },
  };
  let connection;

  class HuggingFaceError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }

  const account = () => connection?.profile.expiresAt > Date.now() ? connection.profile : null;
  const disconnect = () => {
    connection?.controller.abort();
    connection = null;
  };
  const auth = (token) => ({ Authorization: "Bearer " + token });
  const fail = (status, message = "") => {
    message = message.replace(/\bhf_[\w-]+/g, "[redacted]");
    if (/pending credits|credits allocated to running tasks/i.test(message)) {
      return new HuggingFaceError("hfpending", message);
    }
    if (/larger than the maximum allowed|illegal duration/i.test(message)) {
      return new HuggingFaceError("hfduration", message);
    }
    if (/space app has reached its gpu limit/i.test(message)) {
      return new HuggingFaceError("hfspacequota", message);
    }
    if (/ZeroGPU runs? limit/i.test(message)) {
      return new HuggingFaceError("hfruns", "ZeroGPU rejected this request because the run limit was reached.");
    }
    if (status === 429 && !/zero\s*gpu|quota|credits|balance/i.test(message)) {
      return new HuggingFaceError("hfrate", message);
    }
    if (/quota|runs limit|out of credits|exhausted.*(?:balance|credits)/i.test(message) || status === 402 || status === 429) {
      return new HuggingFaceError("quota", message.split(/\s+(?:Subscribe|Upgrade) to Hugging Face/i)[0] || "Hugging Face ZeroGPU limit reached.");
    }
    if (status === 401 || status === 403) return new HuggingFaceError("key", "Hugging Face denied access.");
    return new HuggingFaceError("other", message || "Hugging Face request failed (" + status + ").");
  };
  const request = async (url, options = {}) => {
    try {
      return await fetch(url, { credentials: "omit", redirect: "error", ...options });
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new HuggingFaceError("network", "Hugging Face could not be reached.");
    }
  };
  const checked = async (url, options) => {
    const response = await request(url, options);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const detail = body?.error?.message || body?.error || body?.detail;
      throw fail(response.status, typeof detail === "string" ? detail.slice(0, 250) : "");
    }
    return response;
  };

  const connect = async (token, signal, expiresAt = Infinity) => {
    token = token.trim();
    if (!/^hf_[A-Za-z0-9_-]+$/.test(token)) throw new HuggingFaceError("key", "Enter a Hugging Face access token.");
    const endpoint = expiresAt === Infinity ? "/api/whoami-v2" : "/oauth/userinfo";
    const identity = await (await checked(HUB + endpoint, { headers: auth(token), signal, cache: "no-store" })).json();
    const name = identity.preferred_username || identity.name;
    if (!name) throw new HuggingFaceError("key", "Hugging Face returned no account.");
    signal?.throwIfAborted();
    disconnect();
    const profile = Object.freeze({ name, expiresAt });
    connection = { token, profile, controller: new AbortController() };
    return profile;
  };

  const oauth = async (path, data, signal) => {
    const response = await request(HUB + "/oauth/" + path, {
      method: "POST", body: new URLSearchParams(data), signal, cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok && !result.error) throw fail(response.status);
    return result;
  };
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
  const signIn = async (clientId, signal, showCode) => {
    const client_id = clientId.trim();
    const scope = "openid profile inference-api";
    const device = await oauth("device", { client_id, scope }, signal);
    const link = device.verification_uri_complete || device.verification_uri;
    if (!device.device_code || !device.user_code || !Number.isFinite(device.expires_in) || !link) {
      throw new HuggingFaceError("key", "Hugging Face could not start sign-in. Check the OAuth client ID and scopes.");
    }
    const verification = new URL(link, HUB);
    if (verification.origin !== HUB) throw new HuggingFaceError("key", "Invalid Hugging Face verification link.");
    showCode(device.user_code, verification.href);
    const deadline = Date.now() + device.expires_in * 1000;
    let interval = (device.interval || 5) * 1000;
    while (Date.now() + interval < deadline) {
      await delay(interval, signal);
      const result = await oauth("token", {
        client_id, device_code: device.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }, signal);
      if (result.access_token && result.expires_in > 0) {
        return connect(result.access_token, signal, Date.now() + result.expires_in * 1000);
      }
      if (result.error === "slow_down") interval += 5000;
      else if (result.error === "expired_token") break;
      else if (result.error !== "authorization_pending") {
        throw new HuggingFaceError("key", "Hugging Face sign-in was denied or could not be completed.");
      }
    }
    throw new HuggingFaceError("key", "The Hugging Face sign-in code expired.");
  };

  const png = async (canvas) => {
    const file = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!file) throw new HuggingFaceError("other", "The picture could not be encoded.");
    return file;
  };
  const whiteSelection = (mask) => {
    const canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "difference";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  };
  const sdxlInputs = (image, mask) => {
    // SDXL's VAE works in multiples of eight. Use the same dimensions for both inputs.
    const width = Math.max(8, Math.round(image.width / 8) * 8);
    const height = Math.max(8, Math.round(image.height / 8) * 8);
    const resized = document.createElement("canvas");
    resized.width = width;
    resized.height = height;
    resized.getContext("2d").drawImage(image, 0, 0, width, height);

    // This Space reads the mask layer's alpha channel. TypeR paints the hole black.
    const layer = document.createElement("canvas");
    layer.width = width;
    layer.height = height;
    const ctx = layer.getContext("2d");
    ctx.drawImage(mask, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i + 3] = 255 - pixels.data[i];
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    return [resized, layer];
  };
  const fileData = (path) => ({ path, meta: { _type: "gradio.FileData" } });

  // Gradio sends complete/error events separated by blank lines, across arbitrary network chunks.
  const resultOf = async (response, eventId) => {
    if (!response.body) throw new HuggingFaceError("noimage", "Hugging Face returned no result stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const frames = pending.split(/\r?\n\r?\n/);
        pending = done ? "" : frames.pop();
        for (const frame of frames) {
          const lines = frame.split(/\r?\n/);
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (eventId && data) {
            const update = JSON.parse(data);
            if (!update || (update.event_id && update.event_id !== eventId)) continue;
            if (update.msg === "process_completed" && update.success) return update.output?.data;
            if (["process_completed", "unexpected_error", "queue_full"].includes(update.msg)) {
              const message = update.output?.error || update.message;
              if (typeof message === "string" && message.trim()) throw fail(500, message.slice(0, 250));
              throw new HuggingFaceError("other", "The Hugging Face Space ended the job without reporting a reason.");
            }
            continue;
          }
          if (event !== "complete" && event !== "error") continue;
          if (event === "error") {
            let detail = data;
            try { detail = JSON.parse(data); } catch (error) { /* The Space can also return plain text. */ }
            const message = typeof detail === "string" ? detail : detail?.error || detail?.message;
            if (typeof message === "string" && message.trim()) throw fail(500, message.slice(0, 250));
            throw new HuggingFaceError("other", "The Hugging Face Space ended the job without reporting a reason.");
          }
          return JSON.parse(data);
        }
        if (done) break;
      }
      throw new HuggingFaceError("noimage", "The Space closed the result stream before finishing.");
    } finally {
      reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  // The named call endpoint can discard the error text. SDXL's Gradio queue also sends the output error.
  const runQueue = async (origin, endpoint, data, options) => {
    const config = await (await checked(origin + "/config", options)).json();
    const dependency = config.dependencies?.find((entry) => entry.api_name === endpoint);
    if (!Number.isInteger(dependency?.id)) throw new HuggingFaceError("other", "The Hugging Face Space changed its API.");
    const queue = origin + "/gradio_api/queue";
    const session_hash = globalThis.crypto.randomUUID();
    const { event_id } = await (await checked(queue + "/join", {
      ...options, method: "POST",
      headers: { ...options.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ data, fn_index: dependency.id, session_hash }),
    })).json();
    if (!event_id) throw new HuggingFaceError("other", "The Space did not queue the job.");
    return resultOf(await checked(queue + "/data?session_hash=" + session_hash, options), event_id);
  };
  const runCall = async (infer, data, options) => {
    const { event_id } = await (await checked(infer, {
      ...options, method: "POST",
      headers: { ...options.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    })).json();
    if (!event_id) throw new HuggingFaceError("other", "The Space did not queue the job.");
    return resultOf(await checked(infer + "/" + encodeURIComponent(event_id), options));
  };
  const run = async ({ model, profile, canvas, mask, prompt, cleanText, signal }) => {
    if (!profile || profile !== account()) throw new HuggingFaceError("key", "Connect your Hugging Face account.");
    const { origin, endpoint } = models[model];
    const api = origin + "/gradio_api";
    const infer = api + "/call/" + endpoint;
    if (!mask || mask.width !== canvas.width || mask.height !== canvas.height) {
      throw new HuggingFaceError("other", "The selection mask must match the image.");
    }
    const { token, controller } = connection;
    const job = new AbortController();
    const cancel = () => job.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    controller.signal.addEventListener("abort", cancel, { once: true });
    const options = { headers: auth(token), signal: job.signal, cache: "no-store" };
    try {
      signal?.throwIfAborted();
      const inputs = model === SDXL ? sdxlInputs(canvas, mask) : [canvas, whiteSelection(mask)];
      const [image, selection] = await Promise.all(inputs.map(png));
      const upload = new FormData();
      upload.append("files", image, "image.png");
      upload.append("files", selection, "mask.png");
      const paths = await (await checked(api + "/upload", { ...options, method: "POST", body: upload })).json();
      if (!Array.isArray(paths) || paths.length !== 2 || paths.some((path) => typeof path !== "string" || !path)) {
        throw new HuggingFaceError("other", "Hugging Face did not accept the image and mask.");
      }
      const edit = { background: fileData(paths[0]), layers: [fileData(paths[1])], composite: null };
      // Follow the visible context more closely for cleanup. Keep the Space defaults for prompted edits.
      const data = model === SDXL
        ? [edit, prompt, cleanText ? CLEAN_TEXT_NEGATIVE : "", cleanText ? 4.5 : 7.5,
          cleanText ? 24 : 20, cleanText ? 0.86 : 0.99, "EulerDiscreteScheduler"]
        : [edit, prompt, 0, true, canvas.width, canvas.height, 30, 28];
      const outputs = model === SDXL
        ? await runQueue(origin, endpoint, data, options)
        : await runCall(infer, data, options);
      const output = outputs?.[0];
      // The SDXL Space uses an ImageSlider, with the source before the generated image.
      const imageData = model === SDXL ? output?.[1] : output;
      const file = imageData?.url || (imageData?.path && api + "/file=" + encodeURI(imageData.path)) || imageData;
      if (typeof file !== "string" || !file) throw new HuggingFaceError("noimage", "The Space returned no image.");
      const url = new URL(file, origin);
      if (url.origin !== origin) throw new HuggingFaceError("noimage", "The Space returned an unexpected image URL.");
      return await (await checked(url.href, options)).blob();
    } catch (error) {
      job.signal.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", cancel);
    }
  };

  const spaceUrl = (id) => Object.hasOwn(models, id) ? HUB + "/spaces/" + models[id].space : null;
  window.TypeRHuggingFace = { SDXL, models: Object.entries(models).map(([id, model]) => [id, model.name]), spaceUrl, account, connect, disconnect, signIn, run };
})();
