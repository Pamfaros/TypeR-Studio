# TypeR Studio

A workspace for typesetting and cleaning manga and comics. It works like Photoshop and has TypeR
built in, so you don't need Photoshop at all.

- Use it in your browser at [typer.hayasaku.fr](https://typer.hayasaku.fr), nothing to install.
- Or get the [desktop app](https://github.com/ScanR/TypeR-Studio/releases/latest) for Mac and Windows.

<img width="1785" height="939" alt="image" src="https://github.com/user-attachments/assets/a77485dc-ec33-4ed8-9ade-f055cf7e31d7" />


## Why not Photoshop?

Photoshop does a bit of everything. It's heavy, it's paid, and typesetting is only one of the many
things it's used for. TypeR Studio is built around typesetting, to make it as easy and as fast as
possible, with lots of quality-of-life touches along the way. It's made by a typesetter, for
typesetters.

It opens and saves PSD files that Photoshop reads back without trouble, and it keeps the shortcuts
and habits you already have (layers, selections, transforms). Everything a typesetter or cleaner
doesn't need is left out.

TypeR feels at home here. Pasting text into the bubbles and applying a style are about
**10x faster** than with TypeR in Photoshop.

## What it adds

All the tools typesetters and cleaners have always dreamed of, in one place.

**Cleaning**

- Detect Text finds all the text on the page, and Remove Text clears it in one click.
- Generative Fill works with Hugging Face ZeroGPU, fal.ai and Google, and with on-device models
  (Nemesis Manhwa, plus MAT and FLUX on desktop and [Android](#android-inpainting)).
- Bubble Cleaner, Spot Healing Brush, Magic Eraser, Content-Aware Fill, Color Range, Levels and
  Auto-Align Layers.

**Typesetting**

- The full TypeR panel, with the script, styles, Line Breaks and hyphenation.
- The SFX tool lays a sound effect along a path, and Gradient colours the letters of a text that
  stays editable.
- FontScanR and Font FindeR, missing fonts installed in one click, and favourite fonts.

**Chapters and files**

- A whole chapter in tabs, page by page.
- PSD files that open in Photoshop, InDesign documents (.idml, .indd), WebP export and Batch Save.
- Send your pages and script to TypeR for Photoshop, and bring them back.
- Works on tablets, and offline with the desktop app.

## Hugging Face ZeroGPU

In **Settings → Generative Fill**, select **Hugging Face ZeroGPU**. Use **Get a token** to create
a [personal Hugging Face token](https://huggingface.co/settings/tokens), enter it in TypeR Studio,
and select **Connect with a token**. Save the settings. Each teammate uses their own account's quota.
TypeR keeps the token in memory for the current app session.
Hugging Face applies a run-count limit to free accounts alongside the GPU-time quota shown in
Billing. TypeR sends nearby text masks in one request when they fit in the same crop.

For browser sign-in, register a public OAuth app (without a client secret) in
[Hugging Face OAuth settings](https://huggingface.co/settings/applications/new).
Allow the `openid`, `profile`, and `inference-api` scopes. Enter the public client ID under
**Sign in through Hugging Face**, get a code, and approve it in the browser. The public client ID
can be saved in the editor settings.

Choose **SDXL Inpainting 0.1** to restore a selection. Describe the art that should fill the hole,
or leave the prompt blank to continue the surrounding colors and lines. The editor sends the crop
and mask to the [Diffusers SDXL Space](https://huggingface.co/spaces/diffusers/stable-diffusion-xl-inpainting).
**FLUX.1 Fill [dev]** uses the [Black Forest Labs Space](https://huggingface.co/spaces/black-forest-labs/FLUX.1-Fill-dev).
See the [FLUX model license](https://bfl.ai/legal/non-commercial-license-terms) for permitted uses.

## Android inpainting

In **Settings → Generative Fill → On this device**, Nemesis Manhwa runs offline out of the box.
MAT and the FLUX Klein models use separately installed Termux runtimes on the same Android
device. After setup, they can work offline. TypeR sends only the crop and mask to
`127.0.0.1`. Hugging Face ZeroGPU still offers SDXL Inpainting 0.1 and FLUX.1 Fill [dev].

| Model | Runtime | Port | Weight files |
| --- | --- | --- | --- |
| MAT | PyTorch CPU in Termux PRoot | 7870 | About 660 MB |
| FLUX.2 Klein 4B | `sd-server` in Termux | 7868 | About 5.9 GB |
| FLUX 3 Klein | `sd-server` in Termux | 7869 | About 6.3 GB |

These are experimental setups for ARM64 devices. The weight sizes describe disk use.
Allow additional free RAM for generation and start one model runtime at a time.

### FLUX Klein in Termux

Install [Termux](https://github.com/termux/termux-app#installation). Then build the
[Android-compatible stable-diffusion.cpp server](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/build.md)
in Termux. The commands below build its CPU backend. For hardware acceleration, see the
upstream Vulkan and Android OpenCL instructions.

```sh
pkg install git cmake clang ninja
git clone --branch master-1060-0b3b98d --recursive https://github.com/leejet/stable-diffusion.cpp.git
cd stable-diffusion.cpp
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF
cmake --build build --target sd-server -j 2
mkdir -p models
```

Save the weights for the model you want to run in `models/` with their file names.
Both need [flux2-vae.safetensors](https://huggingface.co/unsloth/FLUX.2-VAE/resolve/bda21a63a9d498e7e718221c75f0a7fed443369f/split_files/vae/flux2-vae.safetensors).

- FLUX.2 Klein 4B uses [flux-2-klein-4b-Q5_K_M.gguf](https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF/resolve/a09d5bb51ac4000ccd9643d10e9db3ed14200508/flux-2-klein-4b-Q5_K_M.gguf) and [Qwen3-4B-Q4_K_M.gguf](https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/22c9fc8a8c7700b76a1789366280a6a1ad1120/Qwen3-4B-Q4_K_M.gguf).
- FLUX 3 Klein uses [flux3-image-klein-Q4_K.gguf](https://huggingface.co/leejet/flux-3-image-klein-GGUF/resolve/1c2ad2f9b9247ccca6506a23bdb033fdb0873321/flux3-image-klein-Q4_K.gguf) and [Qwen3VL-4B-Instruct-Q4_K_M.gguf](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf).

Start the corresponding server and leave the Termux session running while working in TypeR.

```sh
# FLUX.2 Klein 4B
./build/bin/sd-server --listen-ip 127.0.0.1 --listen-port 7868 \
  --diffusion-model models/flux-2-klein-4b-Q5_K_M.gguf \
  --llm models/Qwen3-4B-Q4_K_M.gguf --vae models/flux2-vae.safetensors

# FLUX 3 Klein
./build/bin/sd-server --listen-ip 127.0.0.1 --listen-port 7869 \
  --diffusion-model models/flux3-image-klein-Q4_K.gguf \
  --llm models/Qwen3VL-4B-Instruct-Q4_K_M.gguf --vae models/flux2-vae.safetensors
```

### MAT in Termux

Open a Debian ARM64 environment with [Termux PRoot-Distro](https://github.com/termux/proot-distro).

```sh
pkg install proot-distro
proot-distro install debian:trixie --name typer-mat
proot-distro login typer-mat
```

From inside Debian, install Python and get the TypeR code containing the Android MAT server.

```sh
apt update
apt install -y python3 python3-venv python3-torch python3-torchvision python3-opencv git curl build-essential python3-dev libpng-dev
git clone https://github.com/Pamfaros/TypeR-Studio.git
git clone https://github.com/fenglinglwb/MAT.git
python3 -m venv --system-site-packages mat-env
mat-env/bin/pip install easydict future matplotlib scikit-image scipy click requests tqdm pyspng ninja imageio-ffmpeg timm psutil scikit-learn
curl -fL -o Places_512_FullData.pkl https://huggingface.co/Icar/mat_places512_full/resolve/476b8ea5b3f82f1784cde1fa0578c710e4a323cd/Places_512_FullData.pkl
mat-env/bin/python TypeR-Studio/mobile/scripts/mat-server.py --repo MAT --weights Places_512_FullData.pkl
```

The server verifies the checkpoint before loading it. Once Termux reports that the model is
ready, choose MAT in TypeR. MAT uses the mask and surrounding artwork as input.

## Contributing

Contributions are welcome. Open a pull request, or an issue if you want to report a problem or
suggest an idea. You can also reach me on Discord: **sakushi**.

The web app's code is in [`web/`](web) and the desktop app's in [`desktop/`](desktop), which has
its own [README](desktop/README.md).
