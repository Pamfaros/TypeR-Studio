"use strict";

// Portable one-click MAT installer: packaged uv.exe provisions an isolated Python 3.10
// under app userData. MAT source is bundled in the app resources. No system Python
// or Git required on the end-user machine. Requires internet on first install.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { app } = require("electron");

const ID = "mat-512";
const SHA256 = "d960c4e6b3266b6b9fa74ee4458a9482160d54c06d7738696bc9a9e2b34c66dc";
const SIZE = 661420475;
const SOURCES = [
  "https://huggingface.co/spaces/Rothfeld/stable-diffusion-mat-outpainting-primer/resolve/79d8595183cc7fec9f74c508921403515b463f18/models/Places_512_FullData.pkl",
  "https://huggingface.co/Icar/mat_places512_full/resolve/476b8ea5b3f82f1784cde1fa0578c710e4a323cd/Places_512_FullData.pkl",
];

class SetupError extends Error {
  constructor(kind, message) {
    super(message || kind);
    this.name = "MatSetupError";
    this.kind = kind;
  }
}

function paths() {
  // An installed app is read-only (ASAR/Program Files). Runtime state belongs in
  // userData, while the audited worker and dependency manifest ship as resources.
  const packaged = Boolean(app && app.isPackaged);
  const resources = packaged ? path.join(process.resourcesPath, "mat") : path.join(__dirname, "..", "mat");
  const base = path.resolve(process.env.TYPER_MAT_DIR ||
    (packaged ? path.join(app.getPath("userData"), "local-mat") : resources));
  return {
    base,
    script: path.join(resources, "mat_worker.py"),
    venv: path.join(base, ".venv"),
    uv: process.env.TYPER_MAT_UV || path.join(resources, "uv.exe"),
    uvPythonDir: path.join(base, "managed-python"),
    uvCache: path.join(base, "uv-cache"),
    log: path.join(base, "logs", "mat-install.log"),
    runtimeStamp: path.join(base, "runtime.json"),
    python: process.env.TYPER_MAT_PYTHON || path.join(base, ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"),
    repo: process.env.TYPER_MAT_REPO || path.join(resources, "MAT"),
    weights: process.env.TYPER_MAT_WEIGHTS || path.join(base, "pretrained", "Places_512_FullData.pkl"),
    requirements: path.join(resources, "requirements-mat.txt"),
    stamp: path.join(base, "pretrained", "Places_512_FullData.verified.json"),
  };
}


function runtimeValidated(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p.runtimeStamp, "utf8"));
    return obj.schema === 3 && obj.python === "3.10" &&
      obj.torch === "2.1.2" && ["cpu", "cuda"].includes(obj.device);
  } catch { return false; }
}
function runtimeDevice(p = paths()) {
  try {
    const state = JSON.parse(fs.readFileSync(p.runtimeStamp, "utf8"));
    if (state.schema === 3 && ["cpu", "cuda"].includes(state.device)) return state.device;
  } catch {}
  return "auto";
}
let deviceCache = null;
function preferredDevice() {
  const forced = String(process.env.TYPER_MAT_DEVICE || "auto").toLowerCase();
  if (forced === "cpu" || forced === "cuda") return forced;
  if (deviceCache !== null) return deviceCache;
  // No NVIDIA driver: do not download multi-gigabyte CUDA wheels.
  try {
    const probe = spawnSync("nvidia-smi", ["-L"], {
      windowsHide: true, encoding: "utf8", timeout: 6000,
    });
    deviceCache = probe.status === 0 && /GPU\s+\d+:/i.test(probe.stdout || "") ? "cuda" : "cpu";
    return deviceCache;
  } catch { deviceCache = "cpu"; return "cpu"; }
}
const uvEnv = (p) => ({
  ...process.env, UV_PYTHON_INSTALL_DIR: p.uvPythonDir,
  UV_CACHE_DIR: p.uvCache, UV_NO_MODIFY_PATH: "1", UV_PYTHON_PREFERENCE: "only-managed",
  UV_NO_CONFIG: "1", UV_NATIVE_TLS: "1",
});
function record(p, phase, command, args) {
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  fs.appendFileSync(p.log, `\n[${new Date().toISOString()}] ${phase}: ${path.basename(command)} ${args.join(" ")}\n`);
}

const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const report = (cb, data) => { if (typeof cb === "function") cb(data); };
const abortIf = (signal) => { if (signal?.aborted) throw new SetupError("cancelled", "MAT installation cancelled."); };

function checked(p = paths()) {
  try {
    const stat = fs.statSync(p.weights);
    const mark = JSON.parse(fs.readFileSync(p.stamp, "utf8"));
    return stat.size === SIZE && mark.sha256 === SHA256 &&
      mark.size === stat.size && mark.mtimeMs === stat.mtimeMs;
  } catch { return false; }
}

function status() {
  const p = paths();
  const installed = exists(p.script) && exists(p.python) &&
    exists(path.join(p.repo, "legacy.py")) && checked(p) && runtimeValidated(p) &&
    runtimeDevice(p) === preferredDevice();
  return {
    available: process.platform === "win32", // initial installer targets Windows
    models: {
      [ID]: { installed, download: installed ? 0 : (checked(p) ? 1 : SIZE), size: SIZE, device: runtimeDevice(p) },
    },
  };
}

// Spawn only fixed commands and fixed arguments, no shell interpolation.
function run(command, args, { cwd, signal, onProgress, phase, env, logfile } = {}) {
  abortIf(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    let tail = "";
    let child;
    const finish = (err) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", cancel);
      err ? reject(err) : resolve(tail);
    };
    const cancel = () => { if (child && child.exitCode === null) child.kill(); };
    try {
      child = spawn(command, args, { cwd, windowsHide: true, shell: false,
        stdio: ["ignore", "pipe", "pipe"], env: env || { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" } });
    } catch (err) { finish(new SetupError("local", err.message)); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => {
      const output = chunk.toString();
      if (logfile) { try { fs.appendFileSync(logfile, output); } catch {} }
      tail = (tail + output).slice(-15000);
      const last = tail.trim().split(/[\r\n]+/).pop();
      if (last) report(onProgress, { phase, message: last.slice(0, 240) });
    });
    child.once("error", err => finish(new SetupError("local", `${command}: ${err.message}`)));
    child.once("close", code => {
      if (signal?.aborted) return finish(new SetupError("cancelled", "MAT installation cancelled."));
      if (code !== 0) return finish(new SetupError("local", `${path.basename(command)} exited with ${code}: ${tail.slice(-2200)}`));
      finish(null);
    });
  });
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("data", chunk => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verify(file) {
  try {
    if ((await fs.promises.stat(file)).size !== SIZE) return false;
    return (await sha256(file)) === SHA256;
  } catch { return false; }
}

async function markVerified(p) {
  const stat = await fs.promises.stat(p.weights);
  const mark = JSON.stringify({ sha256: SHA256, size: stat.size, mtimeMs: stat.mtimeMs });
  const tmp = p.stamp + ".part";
  await fs.promises.mkdir(path.dirname(p.stamp), { recursive: true });
  await fs.promises.writeFile(tmp, mark, "utf8");
  await fs.promises.rename(tmp, p.stamp);
}

// Supports HTTP Range to continue interrupted downloads. No unverified file is
// ever moved to the final checkpoint path.
async function download(url, target, signal, onProgress) {
  const part = target + ".part";
  let offset = (await fs.promises.stat(part).catch(() => ({ size: 0 }))).size;
  if (offset > SIZE) { await fs.promises.rm(part, { force: true }); offset = 0; }
  abortIf(signal);
  let response = await fetch(url, { redirect: "follow", signal,
    headers: offset ? { Range: `bytes=${offset}-` } : {} });
  if (offset && response.status === 200) {
    await response.body?.cancel();
    await fs.promises.rm(part, { force: true });
    offset = 0;
    response = await fetch(url, { redirect: "follow", signal });
  }
  if (!response.ok || !(response.status === 200 || response.status === 206) || !response.body)
    throw new SetupError("download", `Checkpoint download returned HTTP ${response.status}.`);
  if (offset && !String(response.headers.get("content-range") || "").startsWith(`bytes ${offset}-`))
    throw new SetupError("download", "The server returned an unexpected download range.");
  const output = await fs.promises.open(part, offset ? "a" : "w");
  let written = offset;
  let reported = -2 * 1024 * 1024;
  try {
    for await (const chunk of response.body) {
      abortIf(signal);
      written += chunk.length;
      if (written > SIZE) throw new SetupError("download", "Checkpoint exceeds expected size.");
      await output.writeFile(chunk);
      if (written - reported >= 2 * 1024 * 1024 || written === SIZE) {
        reported = written;
        report(onProgress, { phase: "download", loaded: written, total: SIZE });
      }
    }
  } finally {
    await output.close();
  }
  if (written !== SIZE) throw new SetupError("download", `Incomplete checkpoint: ${written}/${SIZE} bytes.`);
  if (!(await verify(part))) {
    await fs.promises.rm(part, { force: true });
    throw new SetupError("download", "Checkpoint SHA-256 mismatch; file was rejected.");
  }
  await fs.promises.rename(part, target);
}

async function ensureRepo(p) {
  // MAT source is INCLUDED in the Windows installer, never cloned on user's PC.
  if (!exists(path.join(p.repo, "legacy.py")) || !exists(path.join(p.repo, "networks", "mat.py")))
    throw new SetupError("notinstalled", "MAT source missing from packaged resources. Rebuild installer with desktop/mat/MAT present.");
}

async function ensurePython(p, signal, onProgress) {
  if (exists(p.python)) return;
  if (process.env.TYPER_MAT_PYTHON)
    throw new SetupError("notinstalled", "TYPER_MAT_PYTHON points to a missing Python executable.");
  if (!exists(p.uv))
    throw new SetupError("notinstalled", "Bundled uv.exe not found. Rebuild Windows installer with scripts/build-mat-win.ps1.");
  report(onProgress, { phase: "python", message: "Preparing isolated Python 3.10 (no global installation)" });
  await run(p.uv, ["venv", "--python", "3.10", "--python-preference", "only-managed", p.venv], {
    signal, onProgress, phase: "python", env: uvEnv(p), logfile: p.log,
  });
  if (!exists(p.python)) throw new SetupError("notinstalled", "Portable Python environment not created.");
}

function testCode(device) {
  // This intentionally imports modules but does not execute the actual inpainting model.
  const test = "import sys,torch,torchvision,numpy,cv2,click,timm,scipy,PIL; " +
    "assert sys.version_info[:2] == (3,10); " +
    "assert torch.__version__.startswith('2.1.2'); " +
    "assert torchvision.__version__.startswith('0.16.2'); " +
    "assert numpy.__version__ == '1.26.4'; " +
    "assert cv2.__version__.startswith('4.10.'); ";
  return test + (device === "cuda" ? "assert torch.cuda.is_available()" : "assert not torch.version.cuda");
}
async function probe(p, device, signal) {
  try {
    await run(p.python, ["-c", testCode(device)], {
      signal, env: uvEnv(p), logfile: p.log, phase: "verify",
    });
    return true;
  } catch { return false; }
}

async function installTorch(p, device, signal, onProgress) {
  const suffix = device === "cuda" ? "+cu118" : "+cpu";
  const index = device === "cuda" ? "https://download.pytorch.org/whl/cu118" :
    "https://download.pytorch.org/whl/cpu";
  report(onProgress, { phase: "dependencies", message: `Installing PyTorch ${device.toUpperCase()} wheels` });
  const args = ["pip", "install", "--python", p.python, "--no-build", "--no-deps",
    `torch==2.1.2${suffix}`, `torchvision==0.16.2${suffix}`, "--index", index];
  record(p, "torch", p.uv, args);
  await run(p.uv, args, { signal, onProgress, phase: "dependencies", env: uvEnv(p), logfile: p.log });
}

async function installCommon(p, signal, onProgress) {
  report(onProgress, { phase: "dependencies", message: "Installing pinned MAT wheels (binary only)" });
  // The CPU/CUDA build has already been installed; avoid installing PyTorch from PyPI.
  const args = ["pip", "install", "--python", p.python, "--no-build",
    "--index", "https://pypi.org/simple", "-r", p.requirements];
  record(p, "requirements", p.uv, args);
  await run(p.uv, args, { signal, onProgress, phase: "dependencies", env: uvEnv(p), logfile: p.log });
  await run(p.uv, ["pip", "check", "--python", p.python],
    { signal, onProgress, phase: "verify", env: uvEnv(p), logfile: p.log });
}

async function saveRuntimeStamp(p, device) {
  const data = { schema: 3, python: "3.10", torch: "2.1.2", device, validatedAt: new Date().toISOString() };
  const temp = `${p.runtimeStamp}.part`;
  await fs.promises.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(temp, p.runtimeStamp);
}

async function ensurePackages(p, signal, onProgress) {
  if (!exists(p.requirements)) throw new SetupError("local", `Missing requirements: ${p.requirements}`);
  let device = preferredDevice();
  // A previous validated environment can be retained across app upgrades.
  const old = runtimeDevice(p);
  if (old !== "auto" && await probe(p, old, signal)) {
    if (old === "cuda" && device === "cpu") {
      // GPU removed or forced CPU: reinstall with CPU wheel below.
    } else if (old === "cpu" && device === "cuda") {
      // NVIDIA was added: CUDA upgrade below.
    } else return old;
  }
  if (!exists(p.uv)) {
    // Development-only compatible venv, but the shipped EXE always includes uv.
    throw new SetupError("notinstalled", "Bundled uv.exe is missing from MAT installation resources.");
  }
  const attempt = async (target) => {
    await installTorch(p, target, signal, onProgress);
    await installCommon(p, signal, onProgress);
    if (!(await probe(p, target, signal)))
      throw new SetupError("local", `${target.toUpperCase()} PyTorch validation failed. See ${p.log}`);
    await saveRuntimeStamp(p, target);
    return target;
  };
  try { return await attempt(device); }
  catch (err) {
    if (signal?.aborted) throw err;
    if (device !== "cuda" || process.env.TYPER_MAT_DEVICE === "cuda") throw err;
    report(onProgress, { phase: "dependencies", message: "CUDA unavailable; falling back to CPU wheels" });
    // uv replaces the existing CUDA wheels with the CPU variants using --reinstall-package.
    return await attempt("cpu");
  }
}

let installing = null;
function install(signal, onProgress = () => {}) {
  if (installing) return installing;
  installing = (async () => {
    if (process.platform !== "win32") throw new SetupError("unsupported", "MAT installer currently targets Windows.");
    abortIf(signal);
    const p = paths();
    if (!exists(p.script)) throw new SetupError("notinstalled", `Missing MAT worker: ${p.script}`);
    await fs.promises.mkdir(p.base, { recursive: true });
    await fs.promises.mkdir(path.dirname(p.log), { recursive: true });
    await ensureRepo(p);
    await ensurePython(p, signal, onProgress);
    await ensurePackages(p, signal, onProgress);
    await fs.promises.mkdir(path.dirname(p.weights), { recursive: true });
    report(onProgress, { phase: "verify", message: "Verifying MAT checkpoint SHA-256" });
    if (!(await verify(p.weights))) {
      // Never delete a manually supplied checkpoint: retain it under a backup name.
      if (exists(p.weights)) {
        const backup = `${p.weights}.unverified-${Date.now()}`;
        await fs.promises.rename(p.weights, backup);
        report(onProgress, { phase: "verify", message: `Unverified checkpoint preserved: ${path.basename(backup)}` });
      }
      let failure;
      for (const url of SOURCES) {
        try { await download(url, p.weights, signal, onProgress); failure = null; break; }
        catch (err) { failure = err; if (signal?.aborted) break; }
      }
      if (failure) throw signal?.aborted ? new SetupError("cancelled", "Installation cancelled.") : failure;
    }
    abortIf(signal);
    await markVerified(p);
    return status();
  })().finally(() => { installing = null; });
  return installing;
}

module.exports = { ID, SIZE, SHA256, paths, status, install, runtimeDevice, preferredDevice, SetupError };
