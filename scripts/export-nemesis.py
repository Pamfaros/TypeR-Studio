"""Export the published Nemesis Manhwa checkpoint as a 256px ONNX tile model."""
import argparse
import hashlib
from pathlib import Path
import sys
from unittest.mock import patch

import numpy as np
import onnxruntime as ort
import torch
from torch.nn import functional as F

CHECKPOINT = "6b3295363cd4654e5f4d784f40856c5b13a531b9d7e36d3915f0dc6e3536d6d7"
SIDE = 256


def visible_gradients(rgb, mask):
    # The legacy ONNX exporter handles subtraction and slicing, but not Tensor.diff.
    dx = (rgb[..., 1:] - rgb[..., :-1]).masked_fill(mask[..., 1:] | mask[..., :-1], 0)
    dy = (rgb[..., 1:, :] - rgb[..., :-1, :]).masked_fill(mask[..., 1:, :] | mask[..., :-1, :], 0)
    return F.pad(dx, (1, 0)), F.pad(dy, (0, 0, 1, 0))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Nemesis-Inpainting repository")
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("--output", type=Path, default=Path("web/models/nemesis-manhwa.onnx"))
    args = parser.parse_args()
    if hashlib.sha256(args.checkpoint.read_bytes()).hexdigest() != CHECKPOINT:
        parser.error("Checkpoint SHA-256 differs from the published Manhwa weights")
    sys.path.insert(0, str(args.source.resolve()))
    from model.registry import load_model

    torch.set_num_threads(2)
    net = load_model(args.checkpoint, "cpu")
    generator = torch.Generator().manual_seed(27)
    rgb = torch.rand((1, 3, SIDE, SIDE), generator=generator)
    mask = torch.zeros((1, 1, SIDE, SIDE))
    mask[:, :, 35:139, 8:181] = 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp = args.output.with_suffix(".tmp")
    try:
        with torch.inference_mode():
            with patch("model.model_baseline.visible_gradients", visible_gradients):
                torch.onnx.export(net, (rgb, mask), str(temp), opset_version=17,
                                  input_names=["image", "mask"], output_names=["restored"])
            session = ort.InferenceSession(str(temp), providers=["CPUExecutionProvider"])
            # Fully masked tiles start from a constant, which magnifies small GroupNorm differences.
            for case, tolerance in ((mask, 3e-5), (torch.zeros_like(mask), 0), (torch.ones_like(mask), 1e-3)):
                expected = net(rgb, case).numpy()
                actual, = session.run(None, {"image": rgb.numpy(), "mask": case.numpy()})
                np.testing.assert_allclose(actual, expected, atol=tolerance, rtol=0)
                print(f"max error {np.abs(actual - expected).max():.8f}")
        temp.replace(args.output)
    finally:
        temp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
