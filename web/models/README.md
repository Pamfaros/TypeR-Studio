# Nemesis Manhwa

`nemesis-manhwa.onnx` is the TypeR Studio inference export of
[PaxOro/NemInp best.pt](https://huggingface.co/PaxOro/NemInp/blob/0ec376ba29cbe9f513c89707b3b38ed0b631d4b2/best.pt)
from the [Nemesis-Inpainting repository](https://github.com/Pamfaros/Nemesis-Inpainting).
The published checkpoint SHA-256 is `6b3295363cd4654e5f4d784f40856c5b13a531b9d7e36d3915f0dc6e3536d6d7`.
The model card lists MIT.

The ONNX export uses FP32 RGB and masks at 256×256. The input names are
`image` (1×3×256×256) and `mask` (1×1×256×256, with 1 inside the hole).
`restored` is the RGB output in the same range and layout as `image`.
The worker runs overlapping tiles at native pixel scale and blends predictions only
inside the mask. It pads small crops at the edge. The editor applies the result in an
undoable layer.

On the 165 held-out Manhwa crops, the largest absolute difference between ONNX
Runtime CPU and PyTorch was 0.000513 on the 0–1 scale. The ONNX output exactly
matched all source RGB values outside the masks.

To re-export the same checkpoint, run the following from the root of TypeR Studio
with PyTorch 2.5.1, NumPy, ONNX and ONNX Runtime installed.

```sh
python scripts/export-nemesis.py /path/to/Nemesis-Inpainting /path/to/best.pt
node --test scripts/test-nemesis.mjs
```

The mobile build includes the ONNX Runtime Web WASM files. Browser and desktop
builds can use those files when present under `web/vendor/nemesis/`. They load the
pinned runtime from jsDelivr otherwise. Inference runs in the editor's worker.
