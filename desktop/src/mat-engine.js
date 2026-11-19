"use strict";

// Local MAT process supervisor: at most one request at once, automatic worker
// restart on crash/GPU fault (one retry), idle VRAM release and stall watchdog.
const fs = require("fs");
const { spawn } = require("child_process");
const installer = require("./mat-installer");

const MAT_ID = "mat-512";
const IDLE_MS = 5 * 60_000;
// CPU can take many minutes to load and run a single MAT tile.
const START_TIMEOUT_MS = () => installer.runtimeDevice() === "cpu" ? 20 * 60_000 : 3 * 60_000;
const JOB_STALL_MS = () => installer.runtimeDevice() === "cpu" ? 30 * 60_000 : 4 * 60_000; // reset whenever a tile finishes
const MAX_STDOUT_LINE = 128 * 1024 * 1024;

class MatError extends Error {
  constructor(kind, message) {
    super(message || kind);
    this.kind = kind;
    this.name = "MatError";
  }
}

const status = () => installer.status();
const install = async (signal, progress = () => {}) => { await installer.install(signal, progress); return status(); };
let current = null;
let starting = null;
let idle = null;
let sequence = 0;
let queue = Promise.resolve();

function clearPending(worker, reason) {
  if (!worker) return;
  for (const [id, job] of worker.jobs) {
    clearTimeout(job.watchdog);
    job.signal?.removeEventListener("abort", job.abort);
    job.reject(reason);
    worker.jobs.delete(id);
  }
}

function terminate(worker, reason = new MatError("cancelled", "MAT worker stopped.")) {
  if (!worker || worker.closed) return;
  worker.closed = true;
  if (worker === current) current = null;
  clearTimeout(idle);
  clearTimeout(worker.startTimeout);
  clearPending(worker, reason);
  if (worker.proc && worker.proc.exitCode === null) {
    // stdio close helps Python exit naturally; force-kill if it is stuck in CUDA.
    try { worker.proc.stdin.destroy(); } catch (_) {}
    try { worker.proc.kill(); } catch (_) {}
    if (process.platform === "win32" && worker.proc.pid) {
      const killer = spawn("taskkill", ["/PID", String(worker.proc.pid), "/T", "/F"], {
        windowsHide: true, stdio: "ignore",
      });
      killer.on("error", () => {});
    }
  }
}
function stop() { if (current) terminate(current); }
function scheduleIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => { if (current && current.jobs.size === 0) stop(); }, IDLE_MS);
  idle.unref?.();
}
function ensureWorker() {
  if (current && !current.closed && current.ready && current.proc.exitCode === null) return Promise.resolve(current);
  if (starting) return starting;
  const p = installer.paths();
  const entry = status().models[MAT_ID];
  if (!entry || !entry.installed) return Promise.reject(new MatError("notinstalled", "MAT must be installed first."));

  starting = new Promise((resolve, reject) => {
    const proc = spawn(p.python, ["-u", p.script, "--repo", p.repo, "--weights", p.weights], {
      cwd: p.repo, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", TYPER_MAT_DEVICE: installer.runtimeDevice() },
    });
    const worker = { proc, ready: false, closed: false, logs: "", buffer: "", jobs: new Map() };
    current = worker;
    let startSettled = false;
    const settled = (err) => {
      if (startSettled) return;
      startSettled = true;
      clearTimeout(worker.startTimeout);
      err ? reject(err) : resolve(worker);
    };
    worker.startTimeout = setTimeout(() => {
      const err = new MatError("timeout", "MAT did not initialize before the timeout.");
      settled(err); terminate(worker, err);
    }, START_TIMEOUT_MS());
    worker.startTimeout.unref?.();
    proc.stderr.on("data", bytes => { worker.logs = (worker.logs + String(bytes)).slice(-4000); });
    proc.stdout.on("data", bytes => {
      if (worker.closed) return;
      worker.buffer += String(bytes);
      if (worker.buffer.length > MAX_STDOUT_LINE) {
        const err = new MatError("crash", "MAT response exceeded the protocol size limit.");
        settled(err); terminate(worker, err); return;
      }
      let newline;
      while ((newline = worker.buffer.indexOf("\n")) >= 0) {
        const line = worker.buffer.slice(0, newline);
        worker.buffer = worker.buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        if (message.type === "ready") { worker.ready = true; settled(); continue; }
        if (message.type === "fatal") {
          const err = new MatError("local", message.error || "MAT initialization failed.");
          settled(err); terminate(worker, err); return;
        }
        if (message.id === undefined || message.id === null) continue;
        const key = String(message.id);
        const job = worker.jobs.get(key);
        if (!job) continue;
        if (message.progress) {
          clearTimeout(job.watchdog);
          job.watchdog = setTimeout(() => {
            const err = new MatError("timeout", "MAT stopped responding during inpainting.");
            terminate(worker, err);
          }, JOB_STALL_MS());
          job.watchdog.unref?.();
          try { job.onProgress(message.progress); } catch (_) {}
          continue;
        }
        worker.jobs.delete(key);
        clearTimeout(job.watchdog);
        job.signal?.removeEventListener("abort", job.abort);
        if (message.error) {
          const kind = message.code === "gpu" ? "gpu" : "inference";
          job.reject(new MatError(kind, String(message.error)));
          if (kind === "gpu") terminate(worker, new MatError("gpu", "GPU context was reset."));
        } else if (typeof message.png === "string") {
          job.resolve(Buffer.from(message.png, "base64"));
        } else job.reject(new MatError("inference", "MAT returned no PNG."));
      }
    });
    const unexpected = (desc) => {
      const err = new MatError("crash", `MAT Python process stopped: ${desc}. ${worker.logs.slice(-700)}`);
      settled(err); terminate(worker, err);
    };
    proc.once("error", err => unexpected(err.message));
    proc.once("exit", (code, signal) => { if (!worker.closed) unexpected(signal || String(code)); });
  }).finally(() => { starting = null; });
  return starting;
}

async function once({ image, mask }, signal, onProgress) {
  if (signal?.aborted) throw new MatError("cancelled");
  clearTimeout(idle);
  const worker = await ensureWorker();
  if (signal?.aborted) throw new MatError("cancelled");
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const abort = () => terminate(worker, new MatError("cancelled", "MAT operation cancelled."));
    const job = { resolve, reject, signal, abort, onProgress, watchdog: null };
    job.watchdog = setTimeout(() => terminate(worker,
      new MatError("timeout", "MAT inference timed out (no progress).")), JOB_STALL_MS());
    job.watchdog.unref?.();
    worker.jobs.set(id, job);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      worker.proc.stdin.write(JSON.stringify({ id,
        image: Buffer.from(image).toString("base64"),
        mask: Buffer.from(mask).toString("base64"),
      }) + "\n", "utf8", err => {
        if (err && worker.jobs.has(id)) terminate(worker, new MatError("crash", `MAT input pipe failed: ${err.message}`));
      });
    } catch (err) { terminate(worker, new MatError("crash", err.message)); }
  });
}

function generate(request, signal, onProgress = () => {}) {
  // Even standalone calls are serialized: two jobs cannot contend for CUDA VRAM.
  const task = queue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new MatError("cancelled");
      try {
        onProgress({ phase: attempt ? "restart" : "start", attempt });
        const result = await once(request, signal, onProgress);
        return result;
      } catch (err) {
        if (signal?.aborted) throw new MatError("cancelled");
        // Retry once only for process death, inactivity or an unsafe CUDA state.
        if (attempt !== 0 || !["crash", "timeout", "gpu"].includes(err?.kind)) throw err;
        stop();
        onProgress({ phase: "restart", message: "Restarting MAT after GPU/process failure" });
      }
    }
  }).finally(scheduleIdle);
  queue = task.catch(() => {});
  return task;
}
async function remove() {
  stop();
  throw new MatError("other", "Automatic MAT removal is not available. Existing weights are preserved.");
}
module.exports = { MAT_ID, status, install, remove, generate, stop, MatError };
