# TypeR Studio + MAT (Mask-Aware Transformer)

> **Experimental integration for a personal fork of TypeR Studio (Windows).**
> This document consolidates `README-MAT.md`, `MAT_AUTO_INSTALL_README.md`, and `README-UK.md`. The primary workflow is **v3: a single Windows installer with automatic MAT setup and CUDA/CPU selection**. Earlier patch instructions and manual setup procedures are retained further below.
> **This is patch documentation, not evidence that the installer or CPU inference has passed full end-to-end testing.**

## 1. Purpose and current status

The integration adds a local **`MAT (Mask-Aware Transformer)`** model with the ID `mat-512` under **TypeR Studio → Settings → Generative Fill → On this device**.

- The image and mask are sent to a local Python/PyTorch worker using **JSON Lines (`stdin`/`stdout`)**. No IOPaint, HTTP server, or cloud API is required.
- MAT reconstructs a selected area using its surrounding image context; **MAT does not use text prompts**.
- The integration is intended to be an **optional backend**: existing FLUX models and the separate browser-based **LaMa Manga** should remain unchanged.
- **Selecting MAT for Generative Fill does not replace the independent Remove Text / LaMa Manga pipeline.** Separate changes are required to replace Remove Text.

### Integration history

| Version | Functionality | End-user requirements |
|---|---|---|
| **v1 — manual MAT backend** | Runs `mat_worker.py` with Python 3.10; source and weights are obtained manually | Python, Git, and a CUDA-compatible environment for the original implementation |
| **v2 — automatic installer in a development checkout** | Calls `localAI.install()`, creates `.venv`, installs dependencies, downloads weights, and verifies their hash | System Python 3.10 and Git where required |
| **v3 — Windows Setup.exe (primary)** | Bundles `uv.exe`, the worker, and MAT source; downloads managed Python, packages, and weights on first use; supports CUDA/CPU fallback | No system Python, Git, pip, or CUDA Toolkit required; **internet access is needed for the initial MAT installation** |

**Important:** v3 is a **patch applied on top of a working v2 fork**. If you only have the unmodified TypeR Studio source, this README alone is insufficient: the preceding integration files and applicable patches must be in place.

## 2. Integration layout

Expected files in the development repository:

```text
TypeR-Studio/
├── desktop/
│   ├── src/
│   │   ├── local-ai.js          # mat-512 registration, status, and dispatch
│   │   ├── mat-engine.js        # Python worker, lifecycle, IPC/JSONL
│   │   ├── mat-installer.js     # Python, dependencies, and checkpoint setup
│   │   ├── main.js             # existing local-ai-* IPC handlers
│   │   └── preload.js          # existing TypeRDesktop.localAI bridge
│   ├── mat/
│   │   ├── README.md           # THIS FILE
│   │   ├── mat_worker.py       # inference runner
│   │   ├── requirements-mat.txt
│   │   ├── MAT/                # original MAT source checkout
│   │   ├── pretrained/         # checkpoint for manual development mode
│   │   │   └── Places_512_FullData.pkl
│   │   ├── .venv/              # manual development environment
│   │   └── uv.exe              # optional on the build machine
│   └── scripts/
│       ├── prepare-mat-fork.js
│       └── build-mat-win.ps1
└── web/
    └── generative.js          # MAT model entry and Generative Fill routing
```

The basic integration does not require changes to `main.js` or `preload.js`: the existing bridge provides `TypeRDesktop.localAI.status`, `.install`, `.generate`, `.cancel`, `.remove`, and a progress handler. **Do not modify these files solely for MAT if the existing API meets the requirements.**

Use the **same model ID, `mat-512`**, in the frontend, `local-ai.js`, and MAT backend. Adding a menu entry without a separate dispatch path may accidentally route MAT requests to LaMa or FLUX.

## 3. Installation for end users (v3)

### Prerequisites

- Windows x64 and a built **TypeR Studio MAT Setup.exe**.
- An internet connection on the **first** use of MAT to obtain Python, PyTorch, and the checkpoint.
- **Several gigabytes** of available disk space for the environment and caches; the CUDA build may require more. An exact minimum has not been measured.
- CUDA execution requires an **NVIDIA GPU and a compatible driver**. A CPU fallback is provided when CUDA is unavailable, but its real-world performance and full compatibility **have not yet been confirmed**.

### User workflow

1. Install the built `TypeR-Studio-MAT-Setup-*.exe`.
2. Open the editor and select **Settings → Generative Fill → Service: On this device → Model: MAT (Mask-Aware Transformer)**.
3. Select an image region and click **Generate**.
4. On first use, TypeR should create a private environment, install PyTorch, download the checkpoint, and verify it. Subsequent runs reuse the cached components.

This is a **single EXE installer, but not an offline distribution**. A fully offline installer would also need to bundle the Python runtime, all wheels, and the checkpoint, significantly increasing its size.

### Where the installed components live

In v3 the environment resides in a user-writable location, approximately:

```text
%APPDATA%\TypeR Studio MAT\local-mat\
```

The exact locations of `.venv`, models, and status files depend on the current `mat-installer.js`. **Do not use development paths such as `desktop/mat/.venv` or `desktop/mat/pretrained` for the installed EXE**: the Electron ASAR is not a writable storage location for these components.

v3 installation log:

```text
%APPDATA%\TypeR Studio MAT\local-mat\logs\mat-install.log
```

## 4. How v3 installs Python and selects a device

1. The TypeR package contains **`uv.exe`**, the dependency manifest, `mat_worker.py`, and a copy of the original MAT source.
2. `uv` downloads **managed Python 3.10**, creates an isolated environment, and installs the packages.
3. If an NVIDIA device is detected and the CUDA validation succeeds, the installer uses **PyTorch 2.1.2+cu118**. Without NVIDIA, or after failed CUDA validation, it falls back to **PyTorch 2.1.2+cpu**.
4. The **`Places_512_FullData.pkl`** checkpoint is downloaded and checked against its expected size and **SHA-256**; a temporary `.part` file supports resuming downloads when the server honors HTTP Range requests.
5. The Python/PyTorch environment is validated, and the model is launched as a local worker.

If `TYPER_MAT_DEVICE=cuda` is explicitly set, automatic CPU fallback may be disabled. To test CPU execution on an NVIDIA machine, set this before launching TypeR from PowerShell:

```powershell
$env:TYPER_MAT_DEVICE = "cpu"
# Launch TypeR Studio MAT from this session.
```

Switching execution modes may require the installer to replace the PyTorch wheels in its private environment. `nvidia-smi` alone **does not prove** that inference will run: `torch.cuda.is_available()` and a real-image inference test are still necessary.

> **CPU caveat:** v3 provides reference implementations of `bias_act` and `upfirdn2d` to avoid compiling custom CUDA extensions on end-user machines. These implementations may be substantially slower, and **complete CPU inpainting has not been verified on a clean, GPU-less PC**.

## 5. Building a custom Windows Setup.exe (v3)

This section is **for developers**, not end users.

### Build machine prerequisites

- Windows x64 with **Node.js 24 LTS** and npm.
- A working TypeR Studio source checkout with the **v2 MAT fork already applied**, followed by the v3 patch.
- The local `desktop/mat/MAT` directory containing the original MAT source for packaging; do not include its Git history or `.venv` in the distribution.
- The required files: `desktop/mat/mat_worker.py`, `desktop/mat/requirements-mat.txt`, `desktop/src/mat-installer.js`, `desktop/src/mat-engine.js`, `web/generative.js`, and the corresponding build scripts.
- Redistribution rights reviewed in advance: **do not publish a binary fork without the necessary permissions and applicable licenses**.

### Apply the patch and validate

Create a backup or Git commit before replacing files. Apply the ZIP patch from the **TypeR Studio repository root**, preserving the `desktop/` and `web/` directory structure.

```powershell
cd C:\Projects\TypeR-Studio

git status
node --check .\desktop\src\mat-installer.js
node --check .\desktop\src\mat-engine.js
node --check .\desktop\src\local-ai.js
node --check .\desktop\scripts\prepare-mat-fork.js
node --check .\web\generative.js
```

If Python 3.10 is installed on the build machine, you can also validate the worker's syntax (this is not required on an end-user PC):

```powershell
py -3.10 -m py_compile .\desktop\mat\mat_worker.py
```

### Build

```powershell
cd C:\Projects\TypeR-Studio\desktop
npm ci
powershell -ExecutionPolicy Bypass -File .\scripts\build-mat-win.ps1
```

According to the v3 patch documentation, the script downloads a pinned `uv.exe`, verifies the checksum of its official archive, prepares the MAT resources, builds the content, and invokes Windows packaging through the existing `electron-builder` / NSIS configuration. On the build machine, a **verified** `uv.exe` can be placed manually at `desktop/mat/uv.exe` if the automatic download is unavailable.

Expected output (the exact name depends on the application version and configuration):

```text
desktop/dist-mat/TypeR-Studio-MAT-Setup-<version>.exe
```

**These documents do not establish that a real NSIS installer has already been successfully built and run on Windows.**

## 6. Model, mask, and inpainting behavior

- The model ID across the UI and backend is **`mat-512`**; its display name is **`MAT (Mask-Aware Transformer)`**.
- MAT **does not accept a text prompt**; any supplied prompt text is ignored.
- At the TypeR/JavaScript boundary, the mask convention is **white = repaint, black = preserve**. MAT internally expects **0 = repaint, 1 = preserve**. Incorrect polarity causes the wrong area to be filled.
- In the **original backend**, a square crop around the mask was resized to **512×512**, then only masked pixels were composited back. Large areas can lose detail. If your v2/v3 patch already implements adaptive crops or tiles, inspect and test the actual code: the older documentation describes the original approach.
- Pixels outside the mask should remain unchanged.
- The separate browser-based LaMa Manga implementation and the independent `Remove Text` pipeline are not replaced merely by selecting MAT under Generative Fill.
- The original backend kept the worker resident for approximately **five minutes** after the last job; cancellation terminated the worker, and a subsequent job reloaded the model. Inspect the actual restart logic in newer patches.

If mask polarity is reversed, an **early version** supported `TYPER_MAT_INVERT_MASK=1`. Check whether that switch exists and works in the actual `mat_worker.py` you are using.

### Checkpoint download

Checkpoint filename:

```text
Places_512_FullData.pkl
```

Authors' repository: <https://github.com/fenglinglwb/MAT>.

Manual path in a development checkout:

```text
C:\Projects\TypeR-Studio\desktop\mat\pretrained\Places_512_FullData.pkl
```

**Do not rename a `.pth` file to `.pkl`: they are different formats.** Deserializing a `.pkl` can execute arbitrary Python code, so use only trusted checkpoints. A SHA-256 hash published by a mirror verifies a particular file's identity, **but does not independently establish its authorship**.

In a distributed release, the checkpoint does not necessarily have to be included in the EXE: v3 downloads it after first use and should verify its hash.

## 7. Manual MAT testing without TypeR (development/debugging)

This workflow is useful for diagnosing Python or model issues, but **is not required for v3 end users**.

### Create a development environment

```powershell
cd C:\Projects\TypeR-Studio\desktop\mat

git clone https://github.com/fenglinglwb/MAT.git MAT
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip

# Example CUDA configuration used during development:
.\.venv\Scripts\python.exe -m pip install `
    torch==2.1.2 torchvision==0.16.2 `
    --index-url https://download.pytorch.org/whl/cu118
```

For other packages, use the `requirements-mat.txt` associated with your **specific patch version** and inspect dependency conflicts. An earlier workflow installed the original `MAT/requirements.txt`, but doing so may upgrade NumPy to 2.x and OpenCV to a release incompatible with the chosen PyTorch build. The experimental setup referenced `numpy==1.26.4` and `opencv-python==4.10.0.84`; older instructions also used `timm==0.6.13`. **Do not mix manifests from different revisions without checking compatibility and running `pip check`.**

```powershell
cd C:\Projects\TypeR-Studio\desktop
.\mat\.venv\Scripts\python.exe -m pip install -r .\mat\requirements-mat.txt
.\mat\.venv\Scripts\python.exe -m pip check
.\mat\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

The original MAT README targets **Python 3.7 / PyTorch 1.7.1 / CUDA 11.0**; Python 3.10 / PyTorch 2.1.2 is an adaptation used by this fork, **not an officially supported MAT configuration**.

### Test worker startup

```powershell
cd C:\Projects\TypeR-Studio\desktop
.\mat\.venv\Scripts\python.exe -u .\mat\mat_worker.py `
    --repo .\mat\MAT `
    --weights .\mat\pretrained\Places_512_FullData.pkl
```

Successful initialization should emit:

```json
{"type":"ready"}
```

The worker then waits for JSON requests on `stdin` and remains running when idle. Stopping it with `Ctrl+C` may produce `KeyboardInterrupt`—this does not mean that loading failed. **`ready` confirms initialization, not successful inference or CPU compatibility.**

## 8. Testing before use or release

On a clean **Windows Sandbox** or a separate Windows PC without Python and Git, verify the following:

1. Only `TypeR-Studio-MAT-Setup-*.exe` is installed; `uv` deploys Python without a system Python installation.
2. `MAT (Mask-Aware Transformer)` appears under Generative Fill; installation completes and inpainting on a small test mask actually works.
3. On a machine without NVIDIA, `runtime.json` reports `device: "cpu"` and `torch.version.cuda` is `None`; verify actual output, RAM use, and execution time. **CPU inference may be unacceptably slow.**
4. With NVIDIA, CUDA is selected and inference succeeds. Also explicitly test CPU with `TYPER_MAT_DEVICE=cpu`.
5. Disconnecting the network mid-checkpoint-download does not leave a broken model marked as installed; retrying resumes the download and verifies SHA-256.
6. Installation errors are written to `mat-install.log`, rather than being lost in a truncated UI message.
7. The resulting image preserves **every pixel outside the mask**, and large selections do not distort page proportions.
8. Cancelling jobs, crashing the worker, and restarting the app do not leave orphan GPU or CPU processes.

**Not yet verified in the source READMEs:** a complete NSIS build and clean-Windows installation; full CPU inference without NVIDIA; and `.pkl` inference using reference PyTorch operators without the MSVC/CUDA Toolkit.

## 9. Troubleshooting

| Symptom | What to check |
|---|---|
| `MAT not installed` | Installer status, private runtime or development `.venv`, `mat_worker.py`, `MAT/legacy.py`, and `.pkl` location |
| `No module named ...` | Whether the app runs the **same Python environment** into which packages were installed; the installation log and dependency manifest |
| `CUDA unavailable` | NVIDIA driver, `torch.cuda.is_available()`, device selection, and CPU fallback |
| `subprocess-exited-with-error` during pip | Full `mat-install.log`, availability of binary wheels, compatible NumPy/OpenCV versions; do not rely on truncated UI output |
| Model key or tensor shape error | Whether the checkpoint is an original MAT `.pkl`, rather than a `.pth` or different model; source/checkpoint version compatibility |
| White area unchanged / background missing | PNG mask polarity and grayscale values; avoid double inversion |
| MAT missing from the model picker | `web/generative.js`: `mat-512` must be in the list **and** have a MAT-specific dispatcher distinct from LaMa |
| Works in development but not in the EXE | ASAR / `extraResources`, writable runtime under `%APPDATA%`, bundled `uv.exe` / worker / MAT source, installation log |
| MAT disappears after an update | Fork update configuration: an official TypeR update may replace your customized frontend |

## 10. Git, security, and licensing

### Files not to commit

Add the following to the **TypeR Studio repository root** `.gitignore`:

```gitignore
# Generated Python environment and original third-party checkout
desktop/mat/.venv/
desktop/mat/MAT/
desktop/mat/pretrained/

# Local build helpers and caches (if generated)
desktop/mat/uv.exe
__pycache__/
*.py[cod]
```

Commit your own integration code instead: `mat_worker.py`, `requirements-mat.txt`, `mat-installer.js`, `mat-engine.js`, `local-ai.js`, `generative.js`, the build scripts, and this README.

### Supply-chain safety

- Pin the original MAT source to a **reviewed commit SHA**, rather than floating `main` (`git -C desktop/mat/MAT rev-parse HEAD`).
- Verify the origin and SHA-256 of a `.pkl` checkpoint before loading it. Python pickle deserialization can execute arbitrary code.
- Prefer hash-locked Python requirements or a verified wheelhouse when possible: simple version constraints do not guarantee immutable transitive dependencies.
- Cancelling `pip`, `git`, or a download on Windows may leave partial files; inspect `.part`, the logs, and environment readiness after recovery.
- In the installed Electron app, use a **user-writable data directory**, not paths inside the ASAR archive.

### Legal status

- `ScanR/TypeR-Studio`: its reviewed `desktop/package.json` declared **`"license": "UNLICENSED"`**; a publicly visible repository does not automatically authorize redistribution of a custom EXE.
- `fenglinglwb/MAT`: the project uses **CC BY-NC 4.0**, and its authors describe the code/weights as **research only**; MAT also contains NVIDIA-derived code with separate conditions.
- For personal testing, and **especially for any public release**, review licenses, credits, checkpoint rights, and obtain necessary permissions. Do not include unverified checkpoint mirrors in the distribution.

## 11. Rollback and recovery

Before changing code, preserve a working state:

```powershell
cd C:\Projects\TypeR-Studio
git status
# Create a separate commit on feature/mat-inpainting if needed.
```

If a patch fails, restore the previous Git commit or backups of `desktop/src/mat-engine.js`, `desktop/src/local-ai.js`, `desktop/src/mat-installer.js`, and `web/generative.js`. **Do not delete the Python environment or checkpoint unnecessarily.** In the earlier v2 patch, the manual **Remove** operation intentionally did not delete manually supplied weights.

---

**This document consolidates the three supplied READMEs.** v1/v2 material is preserved for maintenance and debugging. v3 is the current Windows workflow, but real CPU/CUDA tests, installer testing, and a licensing review are required before redistribution.
