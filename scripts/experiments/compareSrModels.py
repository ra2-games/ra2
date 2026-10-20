"""Offline SR image-quality comparison. Read local weights and real screenshots; output PNGs, a source manifest, and a preview page."""
import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw
import torch
import spandrel

MODELS = [
    ("apisr", "APISR RRDB 2x", "APISR2x.onnx", 2, "https://huggingface.co/Xenova/2x_APISR_RRDB_GAN_generator-onnx", "GPL-3.0"),
    ("anime-soft", "AnimeSharpV2 Soft 2x", "AnimeSharpV2-Soft.onnx", 2, "https://github.com/Kim2091/Kim2091-Models/releases/tag/2x-AnimeSharpV2_Set", "CC BY-NC-SA 4.0"),
    ("anime-sharp", "AnimeSharpV2 Sharp 2x", "AnimeSharpV2-Sharp.onnx", 2, "https://github.com/Kim2091/Kim2091-Models/releases/tag/2x-AnimeSharpV2_Set", "CC BY-NC-SA 4.0"),
    ("realesrgan", "Real-ESRGAN x2plus", "realesrgan2x.pth", 2, "https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.1", "BSD-3-Clause"),
    ("nomos", "NomosUni SPAN 2x", "nomos2x.safetensors", 2, "https://github.com/Phhofm/models/releases/tag/2xNomosUni_span_multijpg_ldl", "CC BY 4.0"),
    ("superscale", "SuperScale SPAN 1x", "superscale1x.safetensors", 1, "https://github.com/Kim2091/Kim2091-Models/releases/tag/1x-SuperScale", "CC BY-NC-SA 4.0"),
    ("ultrasharp", "UltraSharpV2 Lite 4x reference", "UltraSharpV2-Lite.onnx", 4, "https://huggingface.co/Kim2091/UltraSharpV2", "CC BY-NC-SA 4.0"),
]


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--weights-dir", type=Path, required=True, help="本地模型权重目录")
    parser.add_argument("--crop", action="append", required=True, help="名称:x:y:边长")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("输出目录已存在，请选择新目录")
    source = Image.open(args.image).convert("RGB")
    regions = []
    for spec in args.crop:
        name, x, y, size = spec.split(":")
        x, y, size = int(x), int(y), int(size)
        if size < 16 or size > 256 or x < 0 or y < 0 or x + size > source.width or y + size > source.height:
            parser.error("裁剪范围无效")
        regions.append({"name": name, "x": x, "y": y, "size": size})
    args.output.mkdir(parents=True)
    source.save(args.output / "source.png")
    overview = source.copy()
    draw = ImageDraw.Draw(overview)
    for i, r in enumerate(regions):
        draw.rectangle((r["x"], r["y"], r["x"] + r["size"], r["y"] + r["size"]), outline="red", width=2)
        draw.text((r["x"] + 3, r["y"] + 3), str(i + 1), fill="yellow")
    overview.save(args.output / "overview.png")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    report = {"source_sha256": sha(args.image), "source_size": list(source.size), "regions": regions,
              "models": [], "versions": {"torch": torch.__version__, "onnxruntime": ort.__version__},
              "note": "CPU FP32 离线画质对比；不是浏览器 GPU 性能。每块增加 32 像素上下文，输出后裁除。1x 仅修复，4x 仅参考。"}
    for ident, title, path, scale, url, license_name in MODELS:
        path = str(args.weights_dir / path)
        print("loading", title, flush=True)
        item = {"id": ident, "name": title, "scale": scale, "url": url, "license": license_name, "hash": sha(path), "results": []}
        if path.endswith(".onnx"):
            options = ort.SessionOptions()
            options.intra_op_num_threads = 2
            options.inter_op_num_threads = 1
            options.log_severity_level = 3
            session = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
            input_name = session.get_inputs()[0].name
            run = lambda array: session.run(None, {input_name: array})[0]
            item["backend"] = "ONNX Runtime CPU FP32"
        else:
            descriptor = spandrel.ModelLoader().load_from_file(path).eval().to("cpu")
            if descriptor.scale != scale:
                raise ValueError("权重原生倍率与登记不一致")
            def run(array):
                with torch.inference_mode():
                    return descriptor(torch.from_numpy(array)).cpu().numpy()
            item["backend"] = "PyTorch CPU FP32 / " + descriptor.architecture.id
        for index, region in enumerate(regions):
            x, y, size = region["x"], region["y"], region["size"]
            pad = 32
            pixels = np.pad(np.asarray(source), ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
            tile = pixels[y:y + size + pad * 2, x:x + size + pad * 2]
            tensor = np.ascontiguousarray(tile.transpose(2, 0, 1)[None], dtype=np.float32) / 255
            started = time.perf_counter()
            result = run(tensor)
            elapsed = (time.perf_counter() - started) * 1000
            expected = (1, 3, (size + pad * 2) * scale, (size + pad * 2) * scale)
            if result.shape != expected or not np.isfinite(result).all():
                raise ValueError(f"{title} 输出异常：{result.shape}, 预期 {expected}")
            output = Image.fromarray(np.rint(np.clip(result[0].transpose(1, 2, 0), 0, 1) * 255).astype(np.uint8))
            output = output.crop((pad * scale, pad * scale, (pad + size) * scale, (pad + size) * scale))
            filename = f"{index}-{ident}.png"
            output.save(args.output / filename)
            # Display comparison panels uniformly at 2x; retain native-scale PNGs separately so the display does not misrepresent native scale.
            display = output.resize((size * 2, size * 2), Image.Resampling.NEAREST if scale == 1 else Image.Resampling.LANCZOS)
            display.save(args.output / f"view-{filename}")
            item["results"].append({"file": filename, "ms_cpu": elapsed, "shape": list(result.shape)})
            print(title, region["name"], round(elapsed), "ms CPU", flush=True)
        report["models"].append(item)
        if path.endswith(".onnx"):
            del session
        else:
            del descriptor
    for index, r in enumerate(regions):
        crop = source.crop((r["x"], r["y"], r["x"] + r["size"], r["y"] + r["size"]))
        crop.save(args.output / f"{index}-original.png")
        for label, method in [("nearest", Image.Resampling.NEAREST), ("bicubic", Image.Resampling.BICUBIC)]:
            crop.resize((r["size"] * 2, r["size"] * 2), method).save(args.output / f"{index}-{label}.png")
        cells = [("Original nearest 2x", Image.open(args.output / f"{index}-nearest.png")),
                 ("Bicubic 2x", Image.open(args.output / f"{index}-bicubic.png"))]
        cells.extend((m["name"], Image.open(args.output / f"view-{index}-{m['id']}.png")) for m in report["models"])
        width = r["size"] * 2
        sheet = Image.new("RGB", (width * 3, (width + 32) * 3), "#15191e")
        draw = ImageDraw.Draw(sheet)
        for i, (label, image) in enumerate(cells):
            x, y = i % 3 * width, i // 3 * (width + 32)
            sheet.paste(image, (x, y + 32)); draw.text((x + 4, y + 8), label, fill="white")
        sheet.save(args.output / f"sheet-{index}.png")
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    shutil.copyfile(Path(__file__).with_name("srComparison.html"), args.output / "index.html")
    print("完成", args.output, flush=True)


if __name__ == "__main__":
    main()
