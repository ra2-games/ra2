# Optional GPU AI upscaling

## Current entry points

Toolbar WebGL2 upscaling and the development-only model experiment are independent paths. The former uses built-in CNN/GAN shaders; the latter validates local ONNX tensor contracts and graph structure. Production builds contain neither ORT nor the model Worker.

The model dialog offers AnimeSharpV2 RealPLKSR 2× Soft/Sharp, NomosUni SPAN 2× FP32/FP16, APISR RRDB native 2×, and UltraSharpV2 Lite 4× FP32/FP16. Full-frame display supports UltraSharpV2 Lite 4× FP16 and NomosUni SPAN 2× FP32/FP16. Current models/defaults are defined in `src/ui/pages/game/experiments/modelProbe.ts` and `src/ui/pages/game/components/ModelProbeDialog.tsx`. Scope and verification entry points follow below. Profiles do not authenticate weights or their license: attribution describes the linked upstream release. Locally supplied variants must satisfy the tensor and operator contracts; inference also validates output scale and finite pixels.

## Usage

During play, the toolbar upscaling selector switches among modes including Off, Bicubic, CNN, and GAN-M without restarting the VM or changing game resolution. Paused frames redraw immediately for same-scene comparisons. URL parameters select only the initial mode; live choices are not persisted. Switching releases old model resources. First AI rendering compiles shaders and may pause briefly; the on-screen status indicates whether inference actually started.

- `?sr=ai`: pretrained Anime4K GAN-M 2×, prioritizing quality; disabled by default.
- `?sr=ai&sr-model=fast`: CNN S, prioritizing speed and useful for same-scene comparisons.
- `?sr=1`: anti-ringing bicubic interpolation for comparison, **not AI**.
- No `sr` or `?sr=0`: original display path.
- `?webgl=0`: Canvas 2D, with no GPU upscaling.

Append `&sr=ai` when parameters already exist. Start with 800×600 game resolution and enlarge the window or use fullscreen. AI activates only when actual canvas width and height both exceed 1.2× input dimensions; otherwise original pixels remain. Fixed models first reconstruct at 2×, then fit display dimensions. Further enlargement beyond 2× is not a second AI inference pass. Guest resolution, VM clock, and game settings are never reduced or changed automatically.

## Runtime path

Original RGB565 / RGBA / indexed frame → native-size GPU RGBA → GAN-M branched network → 2× RGB residual reconstruction → presentation at output size → independent cursor.

The WebGL2 path uses pretrained GLSL constants without additional model downloads, WASM inference loops, or server uploads. The default GAN-M has 23 convolution passes; fast mode uses a four-layer CNN. These models target animation. Upstream Anime4K documentation (source: `bloc97/Anime4K`) explicitly targets animated material. RA2 text, fences, and terrain textures may become oversmoothed or show artifacts; compare enabled/disabled output. See [Vendor records](../src/ui/pages/game/vendor/README.md) for sources, licenses, and fixed hashes.

Performance boundaries:

- Disabled by default creates no CNN GPU resources. Model source ships with the frontend but compiles only when enabled and actually enlarging.
- Convolution uses RGBA16F so negative activations are not clipped by RGBA8. Textures are reused after their final branch use. Integer native-size locations use texelFetch; final half-pixel positions use linear filtering to avoid checkerboard grain.
- Mouse movement/window changes reuse the existing 2× result for the same frame without rerunning inference. New frames do not queue CPU inference.
- Production uses no `readPixels` / `finish` or per-pixel JS/WASM inference.
- Missing floating-point render attachments or compilation/allocation failure warns and restores original pixels, without falsely reporting active AI.
- Input is limited to 1920×1080 pixels and 2× dimensions must fit GPU limits. Exceeding either falls back. Estimated GPU memory is `(20 + 8 × peak feature texture count) × input pixels`, capped at 128 MiB; exceeding the model budget also falls back. This excludes the original display path and driver overhead. Fast CNN uses 36 bytes/pixel.
- When requested, the top-of-frame status reports active, insufficient enlargement, or fallback reasons, including in fullscreen. It does not intercept mouse input and disappears when upscaling is off. `#screen`'s `data-upscale` is diagnostic; actual status/output, not URL parameters or renderer names, establish whether inference occurred.
- There is no silent CPU/WASM fallback that would compete with VM execution. This path improves enlargement quality at lower guest resolutions.

## Verification

With the development server running, these asset-free browser regressions verify shaders, bypasses, resource release, and display status:

```bash
pnpm run test:graphics
pnpm run test:graphics:upscale
pnpm run test:graphics:ai
pnpm run test:graphics:gan
```

## Development models

Development models neither replace default real-time upscaling nor bundle weights into releases. Every model is validated against a registered version and SHA-256. Weights, original screenshots, and results remain in ignored temporary directories.

### UltraSharpV2 Lite 4×

The registered `4x-UltraSharpV2_Lite_fp32_op17.onnx` is licensed CC BY-NC-SA 4.0. `scripts/experiments/probeUltraSharp.py` performs initial CPU ONNX compatibility checks outside game rendering, verifying finite output and 4× dimensions while recording the actual model hash.

```bash
python -m venv "$MODEL_ENV"
"$MODEL_ENV/bin/pip" install onnxruntime==1.30.0 pillow==12.3.0 numpy==2.5.3
"$MODEL_ENV/bin/python" scripts/experiments/probeUltraSharp.py \
  "$ULTRASHARP_MODEL" "$RA2_FRAME" "$SR_OUTPUT" \
  --crop 180 200 128
```

Outputs are `input.png`, `ultrasharp.png`, `comparison.png` (nearest / bicubic / model), and `result.json` (actual hash, input/output dimensions, and three timing runs). Set `MODEL_ENV`, `ULTRASHARP_MODEL`, `RA2_FRAME`, and `SR_OUTPUT` first. An existing output directory is rejected.

The browser GPU probe uses the same FP32 model:

```bash
RA2_PROBE_MODEL=/path/to/4x-UltraSharpV2_Lite_fp32_op17.onnx \
RA2_PROBE_MODEL_ID=ultra4x RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:graphics:model-probe
# Without hardware, explicitly add RA2_PROBE_SOFTWARE=1 for compatibility checks only.
```

### Browser GPU model entry

#### Shared loading rules

- ONNX Runtime Web is pinned to 1.29.0 and imported on demand only inside an independent Worker. Normal startup or merely opening the dialog downloads no ORT/WASM/weights. Players select local weights; they are neither uploaded nor automatically cached.
- Every registered model is checked by SHA-256 first. Output-metadata compatibility fixes perform equal-length renaming only in independent copies, preserving inputs, weights, operators, and disk files. Structural mismatch must reject loading.
- A WebGPU adapter is mandatory; absence produces an error. Some official nodes run through WASM according to compatibility configuration, and the UI reports the actual path. FP16 also requires `shader-f16`; unsupported adapters reject loading instead of falling back to FP32.
- Ordinary rendering modes include Off/Bicubic/CNN/GAN. Inference results never switch the model automatically.

#### Patch sampling rules

- The model experiment samples the center 128×128 pixels by default, adjustable from 32 to 256, with another 16 pixels of context on each edge. Original and model output appear side by side.
- Sampling synchronously copies a small patch without retaining recyclable VM buffers. Only one inference task runs at a time, with no queue or game-frame replacement. The native cursor stays in its existing pipeline and is excluded from samples. Closing the patch dialog, timing out, or changing models cancels work and releases the patch Worker.

#### Full-frame display rules

- Only wired models `ultra4x-fp16`, `nomos2x`, and `nomos2x-fp16` are available. Input is capped at 800×600; output scale comes from the selected model without changing screen or guest resolution.
- One-task backpressure takes the newest frame while idle and drops obsolete inputs while busy. Original pixels show before the first result, then the latest inferred frame is displayed. The cursor draws immediately from the newest original frame. Hidden pages submit no new tasks.
- Stopping, changing sources, selecting an ordinary upscaling mode, or exiting cancels tasks and releases the Worker. Failure or timeout restores original pixels.

#### Measurement boundaries

- Asset-free regressions/model probes verify loading, dimensions, Workers, WebGPU, resource release, and UI status without cross-hardware performance thresholds. Software WebGPU is for compatibility and rejection-path checks only.
- Quality, motion stability, full-frame FPS, end-to-end latency, and GPU memory require separate measurement with real game frames, fixed input, and target hardware. Probe timing includes input copying, Worker transfer, inference, conversion, and readback; it is not pure GPU kernel time or input latency.
- Test scripts use synthetic samples, which do not establish real-game image quality. Screenshots and JSON remain in local temporary output directories.

#### AnimeSharpV2 RealPLKSR native 2×

Use the author's official release, source `Kim2091/Kim2091-Models/releases/tag/2x-AnimeSharpV2_Set`: `2x-AnimeSharpV2_RPLKSR_Soft_fp32.onnx` and `2x-AnimeSharpV2_RPLKSR_Sharp_fp32.onnx`. Each is 29,895,095 bytes, licensed CC BY-NC-SA 4.0. Weights are neither redistributed nor automatically downloaded.

Selected profiles require matching precision, RGB tensor layout, and output scale. Soft defaults to cleaner input; Sharp targets heavily degraded sources. Both are native 2× animation models.

Both graphs were checked: FP32 NCHW input/output, final CRD DepthToSpace with blocksize=2, and the same output/width/height symbol fix and final WASM compatibility path as UltraSharp. Dynamic output-channel symbols remain unchanged; actual results strictly validate RGB and 2× width/height.

```bash
RA2_PROBE_MODEL=/path/to/2x-AnimeSharpV2_RPLKSR_Soft_fp32.onnx \
RA2_PROBE_MODEL_ID=animesharp2x-soft pnpm run test:graphics:model-probe
# For Sharp, use animesharp2x-sharp and its file. RA2_PROBE_SOFTWARE=1 checks compatibility only.
```

#### UltraSharp Lite FP16 and full-frame display

The development model experiment offers official `4x-UltraSharpV2_Lite_fp16_op17.onnx`, 15,281,610 bytes. Weights, inputs, and outputs use FP16. RGB8 input converts to half precision; decoded output is checked for finite values. `shader-f16` is mandatory; unsupported adapters reject this model without FP32 fallback. FP32 comparison and UltraSharp output-metadata/Metal DepthToSpace compatibility remain available.

Full-frame input is at most 800×600, producing real 3200×2400 output at that size, or 4× for smaller inputs. FP16 execution requires a `shader-f16` adapter. Software WebGPU verifies only rejection paths, controller backpressure/cleanup, and cursor-coordinate regressions.

```bash
RA2_PROBE_MODEL=/path/to/4x-UltraSharpV2_Lite_fp16_op17.onnx \
RA2_PROBE_MODEL_ID=ultra4x-fp16 pnpm run test:graphics:model-probe
# For software-GPU rejection checks, also set RA2_PROBE_SOFTWARE=1 RA2_PROBE_EXPECT_NO_F16=1.
```

Metal compatibility: ORT DepthToSpace's `AppendPermFunction` takes an input-index type, but its call site passes output indices, preventing conversion from `perm(output_indices_t)` to `input_indices_t`. Source: `microsoft/onnxruntime/blob/main/onnxruntime/core/providers/webgpu/tensor/depth_to_space.cc`. The supported `forceCpuNodeNames` option routes only the official model's `/to_img/DepthToSpace` node to WASM, avoiding that Metal shader without intercepting browser compilation, changing convolution weights, or moving all inference to CPU. Node names come from validated models; missing/changed counts reject loading. Apple hardware is required for Metal acceptance; software WebGPU establishes compatibility checks only.

#### APISR RRDB native 2×

APISR RRDB 2× uses Xenova's ONNX release, source `Xenova/2x_APISR_RRDB_GAN_generator-onnx`, file `onnx/model.onnx` (FP32, 17,963,855 bytes). The model card declares GPL-3.0. Weights are excluded from the repository; users download through the model-dialog link and import locally. It is a native 2× animation model.

Output is independently validated at 2×, with context cropped at that scale. Model switching immediately terminates the old Worker and clears results. ONNX output `reconstruction` incorrectly reuses input H/W symbols and receives equal-length renaming under its own signature. The graph contains no DepthToSpace, so UltraSharp's CPU pixel-shuffle workaround is not applied.

```bash
RA2_PROBE_MODEL=/path/to/model.onnx RA2_PROBE_MODEL_ID=apisr2x \
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:graphics:model-probe
```

### NomosUni SPAN 2×

The development dialog offers NomosUni SPAN 2×. The author's release, Phhofm/models/releases/tag/2xNomosUni_span_multijpg_ldl, supplies only PTH / safetensors. We export FP32 ONNX from official safetensors under CC BY 4.0. After warmup, the exporter fuses SPAN reparameterized convolutions, producing 1,656,582 bytes; this is neither quantization nor a different model. Weights and ONNX files are not committed or placed in public/dist.

#### FP32 export and verification

```bash
# Install these pinned versions in a separate Python environment to reproduce the export procedure.
pip install torch==2.14.0 spandrel==0.4.2 onnx onnxruntime==1.30.0 numpy
mkdir -p .tmp-models
export NOMOS_WEIGHTS="$PWD/.tmp-models/nomosuni-span-2x.safetensors"
curl -fL "${NOMOS_MODEL_URL:?Set the registered model version URL}" -o "$NOMOS_WEIGHTS"
python scripts/experiments/exportNomosOnnx.py "$NOMOS_WEIGHTS" .tmp-models/nomosuni-span-2x-fp32.onnx
```

The exporter checks native 2× dimensions, raw values, and display-clamped results for 64×64 and 48×80 inputs. Input/output dimension symbols are already independent, so no UltraSharp metadata patch applies. Final DepthToSpace retains the Metal/WASM compatibility path.

FP32 patch probe:

```bash
RA2_PROBE_MODEL="$PWD/.tmp-models/nomosuni-span-2x-fp32.onnx" RA2_PROBE_MODEL_ID=nomos2x \
  RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:graphics:model-probe
```

The FP32 full-frame smoke test reads `.tmp-models/nomosuni-span-2x-fp32.onnx` and loads `nomos2x`:

```bash
pnpm exec tsx tests/experimental/browser/nomosLiveBrowserSmoke.mts
```

#### FP16 conversion and verification

```bash
pip install onnxconverter-common==1.16.0
python scripts/experiments/convertNomosFp16.py .tmp-models/nomosuni-span-2x-fp32.onnx .tmp-models/nomosuni-span-2x-fp16.onnx
```

The FP16 file is 841,058 bytes. Conversion follows ONNX Runtime's recommended half-precision approach, not INT8 quantization. Inputs, outputs, and convolutions use FP16; Cast nodes retain FP32 DepthToSpace for Metal/WASM compatibility.

FP16 patch probes require a WebGPU adapter supporting `shader-f16`:

```bash
RA2_PROBE_MODEL="$PWD/.tmp-models/nomosuni-span-2x-fp16.onnx" \
RA2_PROBE_MODEL_ID=nomos2x-fp16 RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 \
pnpm run test:graphics:model-probe
```

Adapters without `shader-f16` must reject explicitly. The following verifies rejection only and does not count as successful FP16 inference:

```bash
RA2_PROBE_SOFTWARE=1 RA2_PROBE_EXPECT_NO_F16=1 \
RA2_PROBE_MODEL="$PWD/.tmp-models/nomosuni-span-2x-fp16.onnx" \
RA2_PROBE_MODEL_ID=nomos2x-fp16 RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 \
pnpm run test:graphics:model-probe
```

Both Nomos FP32 and FP16 support full-frame processing, at most 800×600 input and native 1600×1200 output. Select the desired precision in the model experiment and enable full-frame display to verify it.

### Optional offline batch script

`scripts/experiments/compareSrModels.py` runs local official weights on identical screenshot regions: APISR 2×, AnimeSharpV2 Soft/Sharp 2×, Real-ESRGAN x2plus, NomosUni SPAN 2×, SuperScale SPAN 1×, plus UltraSharpV2 Lite 4× as a reference. Dependencies are Pillow, NumPy, ONNX Runtime, PyTorch, and Spandrel; model paths and sources are defined in the script's `MODELS`.

```bash
python scripts/experiments/compareSrModels.py "$RA2_FRAME" "$SR_OUTPUT" --weights-dir "$SR_WEIGHTS" \
  --crop 'infantry:180:200:128' --crop 'terrain:310:150:128'
python -m http.server 15176 --bind 127.0.0.1 --directory "$SR_OUTPUT"
```

The output directory must not exist. Outputs include the original frame, crop locations, native-scale PNGs, normalized 2× presentations, a nine-panel grid, and `report.json` recording sources, weight hashes, and CPU timings. Weights are never copied or redistributed. The tool only reads local models/screenshots and must write to a temporary output directory.
