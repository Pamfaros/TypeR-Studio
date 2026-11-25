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
  (Nemesis Manhwa, plus MAT and FLUX in the desktop app).
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

## Contributing

Contributions are welcome. Open a pull request, or an issue if you want to report a problem or
suggest an idea. You can also reach me on Discord: **sakushi**.

The web app's code is in [`web/`](web) and the desktop app's in [`desktop/`](desktop), which has
its own [README](desktop/README.md).
