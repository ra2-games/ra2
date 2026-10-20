"""Independent CPU screening: compare real screenshots with local UltraSharpV2 Lite ONNX, outside the game rendering pipeline."""
import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("image", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--crop", type=int, nargs=3, default=[180, 200, 128], metavar=("X", "Y", "SIZE"))
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    x, y, size = args.crop
    source = Image.open(args.image).convert("RGB")
    if size < 16 or size > 256 or x < 0 or y < 0 or x + size > source.width or y + size > source.height:
        parser.error("裁剪必须位于图片内，尺寸限于 16～256，避免 CPU 初筛占满内存")
    if args.output.exists():
        parser.error("输出目录已存在，请选择新的目录，避免覆盖旧对比结果")
    args.output.mkdir(parents=True)
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(args.model), sess_options=options, providers=["CPUExecutionProvider"])
    input_info = session.get_inputs()[0]
    if input_info.type != "tensor(float)":
        parser.error("本初筛仅支持官方 FP32 ONNX")
    # Add 16 pixels of source context with reflected edge padding; remove borders for comparison to reduce tile-edge artifacts.
    pad = 16
    pixels = np.pad(np.asarray(source), ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
    tile = pixels[y:y + size + 2 * pad, x:x + size + 2 * pad]
    tensor = np.ascontiguousarray(tile.transpose(2, 0, 1)[None], dtype=np.float32) / 255
    timings = []
    for _ in range(3):
        start = time.perf_counter()
        output = session.run(None, {input_info.name: tensor})[0]
        timings.append((time.perf_counter() - start) * 1000)
    expected = (1, 3, (size + 2 * pad) * 4, (size + 2 * pad) * 4)
    if output.shape != expected or not np.isfinite(output).all():
        raise ValueError(f"模型输出异常：{output.shape}，预期 {expected}")
    enhanced = Image.fromarray(np.rint(np.clip(output[0].transpose(1, 2, 0), 0, 1) * 255).astype(np.uint8))
    enhanced = enhanced.crop((pad * 4, pad * 4, (pad + size) * 4, (pad + size) * 4))
    crop = source.crop((x, y, x + size, y + size))
    width = size * 4
    panels = [crop.resize((width, width), Image.Resampling.NEAREST), crop.resize((width, width), Image.Resampling.BICUBIC), enhanced]
    comparison = Image.new("RGB", (width * 3, width + 28), "#181818")
    labels = ["Nearest 4x", "Bicubic 4x", "UltraSharpV2 Lite 4x"]
    for index, (panel, label) in enumerate(zip(panels, labels)):
        comparison.paste(panel, (index * width, 28))
        ImageDraw.Draw(comparison).text((index * width + 8, 6), label, fill="white")
    crop.save(args.output / "input.png")
    enhanced.save(args.output / "ultrasharp.png")
    comparison.save(args.output / "comparison.png")
    result = {"model_sha256": hashlib.file_digest(args.model.open("rb"), "sha256").hexdigest(),
              "provider": session.get_providers(), "onnxruntime": ort.__version__, "threads": args.threads,
              "crop": args.crop, "input_shape": list(tensor.shape), "output_shape": list(output.shape),
              "milliseconds": timings, "note": "首轮冷推理，后两轮热推理；不是浏览器 GPU 或整帧性能，不代表时序稳定性"}
    (args.output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
