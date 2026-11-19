"""Standalone official MAT 512x512 inference worker for TypeR Studio.

JSON-lines on stdin/stdout; white mask pixels are removed, black pixels stay.
Uses only the original MAT repo plus PyTorch/Pillow/numpy, NOT IOPaint.
Only load trusted .pkl model files (Python pickle can run arbitrary code).
"""
import argparse
import base64
import io
import json
import os
import sys
import traceback


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_image(payload, mode):
    from PIL import Image
    return Image.open(io.BytesIO(base64.b64decode(payload))).convert(mode)


def model_loader(repo, weights):
    import numpy as np
    import torch
    # Avoid JIT compilation of CUDA extensions on end-user machines without
    # nvcc / Visual Studio Build Tools. Both ops have a pure PyTorch fallback.
    if os.environ.get("TYPER_MAT_FAST_OPS") != "1":
        import importlib
        for name in ("torch_utils.ops.bias_act", "torch_utils.ops.upfirdn2d"):
            op = importlib.import_module(name)
            op._init = lambda: False
    import dnnlib
    import legacy
    from networks.mat import Generator

    requested = os.environ.get("TYPER_MAT_DEVICE", "auto").strip().lower()
    if requested not in ("auto", "cpu", "cuda"):
        raise ValueError(f"Unknown MAT device mode: {requested}")
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA selected, but no supported NVIDIA GPU/driver was detected")
    device = torch.device("cuda" if requested != "cpu" and torch.cuda.is_available() else "cpu")
    print(f"MAT inference device: {device}", file=sys.stderr)
    with dnnlib.util.open_url(weights) as file:
        saved = legacy.load_network_pkl(file)["G_ema"].to(device).eval().requires_grad_(False)
    model = Generator(z_dim=512, c_dim=0, w_dim=512, img_resolution=512, img_channels=3).to(device).eval().requires_grad_(False)
    def named_params_and_buffers(module):
        return list(module.named_parameters()) + list(module.named_buffers())
    tensors = {name: tensor for name, tensor in named_params_and_buffers(saved)}
    with torch.no_grad():
        for name, tensor in named_params_and_buffers(model):
            if name not in tensors:
                raise RuntimeError(f"Checkpoint does not contain expected MAT parameter: {name}")
            tensor.copy_(tensors[name].detach()).requires_grad_(tensor.requires_grad)
    del saved
    return model, torch, np


def tiles_for_mask(remove, np):
    """Group neighboring glyphs, then split oversized selections into bounded cores.

    No whole-page downscale: every inference sees a local 512-768 px context.
    The full-height mask is used only to locate the affected regions.
    """
    import cv2

    # Dilation groups letters into words/sound-effects without merging distant panels.
    dilated = cv2.dilate(remove.astype(np.uint8),
                         cv2.getStructuringElement(cv2.MORPH_RECT, (61, 61)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(dilated, 8)
    cores = []
    core_size = 384
    for component in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[component])
        # Split components with large bounding boxes. All cores are disjoint,
        # so the original image dimensions and panel placements remain intact.
        for cy in range(y, y + h, core_size):
            for cx in range(x, x + w, core_size):
                x0, y0 = cx, cy
                x1, y1 = min(x + w, cx + core_size), min(y + h, cy + core_size)
                scoped = remove[y0:y1, x0:x1] & (labels[y0:y1, x0:x1] == component)
                if scoped.any():
                    cores.append((x0, y0, x1, y1, component))
    if len(cores) > 512:
        raise ValueError('Too many masked regions (more than 512 local MAT tiles). Split the selection into smaller batches.')
    return cores, labels


def infer(image, mask, model, torch, np, on_progress=None):
    from PIL import Image

    image = image.convert("RGB")
    mask = mask.convert("L")
    if mask.size != image.size:
        raise ValueError(f"Mask size {mask.size} != image size {image.size}")
    remove = np.asarray(mask, dtype=np.uint8) >= 128
    if os.environ.get("TYPER_MAT_INVERT_MASK") == "1":
        remove = ~remove
    if not remove.any():
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue()

    width, height = image.size
    cores, labels = tiles_for_mask(remove, np)
    resample = getattr(Image, 'Resampling', Image)
    out = image.copy()
    for index, (x0, y0, x1, y1, component) in enumerate(cores, 1):
        # Context is 512px for small groups; up to 768px for bigger ones.
        # Never resize the *entire* page to the MAT 512px input.
        core_span = max(x1 - x0, y1 - y0)
        side = max(512, min(768, int(round(core_span * 1.7))))
        left = int(round((x0 + x1 - side) / 2))
        top = int(round((y0 + y1 - side) / 2))
        ix0, iy0 = max(0, left), max(0, top)
        ix1, iy1 = min(width, left + side), min(height, top + side)
        context = Image.new('RGB', (side, side), 'white')
        source_mask = Image.new('L', (side, side), 0)
        # Include already reconstructed neighbors as context, but write only masked
        # pixels in this tile's core into the final result.
        context.paste(out.crop((ix0, iy0, ix1, iy1)), (ix0-left, iy0-top))
        local_hole = Image.fromarray(remove[iy0:iy1, ix0:ix1].astype(np.uint8)*255, 'L')
        source_mask.paste(local_hole, (ix0-left, iy0-top))

        small_image = context.resize((512,512), resample.LANCZOS)
        small_mask = source_mask.resize((512,512), resample.NEAREST)
        image_array = np.asarray(small_image, dtype=np.float32)
        keep_array = 1.0 - (np.asarray(small_mask, dtype=np.float32)>=128).astype(np.float32)
        device = next(model.parameters()).device
        x = torch.from_numpy(image_array.transpose(2,0,1).copy()).to(device)[None]/127.5-1.0
        keep = torch.from_numpy(keep_array.copy())[None,None].to(device)
        z = torch.randn((1, model.z_dim), device=device)
        label = torch.zeros((1, model.c_dim), device=device)
        with torch.no_grad():
            generated = model(x, keep, z, label, truncation_psi=1, noise_mode='const')
            generated = ((generated[0].permute(1,2,0)*127.5+127.5).round().clamp(0,255)
                         .to(torch.uint8).cpu().numpy())
        patch = Image.fromarray(generated, 'RGB').resize((side,side), resample.LANCZOS)
        # Paste only masked pixels inside this tile's non-overlapping core. This
        # guarantees untouched image pixels are identical to the input.
        sx0, sy0, sx1, sy1 = x0-left, y0-top, x1-left, y1-top
        core_mask = ((remove[y0:y1,x0:x1]) &
                     (labels[y0:y1,x0:x1] == component)).astype(np.uint8)*255
        out.paste(patch.crop((sx0,sy0,sx1,sy1)), (x0,y0), Image.fromarray(core_mask,'L'))
        del generated, x, keep, z, label
        if on_progress:
            on_progress(index, len(cores))
    result = io.BytesIO()
    out.save(result, format='PNG')
    return result.getvalue()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--weights", required=True)
    args = parser.parse_args()
    sys.path.insert(0, os.path.abspath(args.repo))
    try:
        model, torch, np = model_loader(args.repo, args.weights)
    except Exception as exc:
        print(traceback.format_exc(), file=sys.stderr)
        emit({"type": "fatal", "error": str(exc)})
        sys.exit(1)
    emit({"type": "ready", "device": str(next(model.parameters()).device)})
    for line in sys.stdin:
        job = None
        try:
            job = json.loads(line)
            image = read_image(job["image"], "RGB")
            mask = read_image(job["mask"], "L")
            output = infer(image, mask, model, torch, np,
                           on_progress=lambda done, total: emit({"id": job["id"],
                               "progress": {"phase": "tile", "step": done, "total": total}}))
            emit({"id": job["id"], "png": base64.b64encode(output).decode("ascii")})
        except Exception as exc:
            print(traceback.format_exc(), file=sys.stderr)
            oom = ("out of memory" in str(exc).lower() or
                   "cuda error" in str(exc).lower())
            if oom:
                import gc
                gc.collect()
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass
            emit({"id": job.get("id") if isinstance(job, dict) else None,
                  "error": str(exc), "code": "gpu" if oom else "inference"})


if __name__ == "__main__":
    main()
