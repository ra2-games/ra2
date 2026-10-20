# ReShade and game-specific plugin adaptation research

## Findings and evidence baseline

Research on 2026-09-14 found that the Toumao-modified ReShade package includes PNG animation sequences and game-specific texture inputs, making it relevant to high-resolution drawing research. A development single-pass rendering integration is implemented, with LaserBlit passthrough and diagnostic displacement verified on real RA2 frames. Plugin DLLs, game-data interfaces, and high-resolution animation rendering are not integrated; this does not establish full compatibility or image-quality/performance gains.

The research baseline is YRModdingBase commit `4af0dd002522845236088c433a5529a6803d60ea`:

- `README.md` explicitly describes integration of Toumao-modified ReShade with PNG animation sequences.
- `Resources/Renderers.ini` combines cnc-ddraw and `d3d9.dll` for ReShade.
- `reshade-shaders/Shaders/ReShadeK.fxh` declares game textures `TOPMASK`, `LIGHT`, `ZBUFFER`, `SHROUD`, and `WATER`; `show_water_depth.fx` additionally requires `WATERDEPTH`.
- Static DLL strings include `AnimClass_Draw_SetTexture`, `TechnoClass_RenderVxl_ReplaceMesh`, and `GScreenClass_Update_TransferBuffer`. This supports an inference of game-rendering hooks, but cannot replace validation of calling conventions, addresses, object lifecycles, or runtime behavior. The DLL was not executed.

Two similarly named projects must remain distinct: RA2YR Reshade is mainly a color/FakeHDR/FXAA/Tiltshift effect pack; CnC-RaVaGe's yrr-reshade is a ReShade fork for Yuri's Revenge Redux. The latter is not confirmed source for the Toumao plugin.

## Completed compilation experiment

The standalone compiler uses yrr-reshade commit `dc276eaebc3ade93853a333025c5d96363001b80`, building only the preprocessor, parser, and GLSL generator in `source/effect_*`, without building or loading injection DLLs. Experimental macros use 800×600, `__RESHADE__=50202`, and `__RENDERER__=0x10000`; other macro configurations, compiler versions, and rendering backends remain unverified.

| Effect                     | FX → GLSL         | WebGL2 compilation/linking               |
| -------------------------- | ----------------- | ---------------------------------------- |
| `LaserBlit.fx`             | Success, 1 pass   | Success after targeted syntax adaptation |
| `show_water_depth.fx`      | Success, 6 passes | Unverified                               |
| `NeoBloomIndexedFilter.fx` | Success, 9 passes | Unverified                               |

Original laser GLSL failed WebGL2 compilation. Adapting explicit bindings, cross-stage varyings, and vertex-index types, and declaring GLSL ES version/precision, allowed vertex/fragment compilation and program linking. The environment was Chromium WebGL2 / SwiftShader. Temporary Linux copies also needed header-filename case aliases. These targeted transformations are not a full FX compatibility layer. This compilation experiment did not verify drawn pixels, real-game effects, or FPS.

## Integration boundaries

`VmFrame` in `src/vm86/win32.ts` supplies final pixels and the cursor, without the auxiliary game textures above. Final frames alone cannot reproduce plugin water, occlusion, or layered high-resolution drawing.

Adaptation has three parts:

1. Identify and validate drawing entry points in game modules, extracting auxiliary textures or object draw commands. Handle RA2/YR versions, addresses, and ABI independently; game-specific hooks do not belong in generic vm86.
2. Let browser rendering own textures, FBOs, uniforms, and multipass scheduling. Cover both main-thread and Worker presentation and identify destruction ownership. Current entry points are `src/ui/pages/game/vmFrameRenderer.ts` and presentation scheduler `src/graphics/framePresenter.ts`.
3. High-resolution PNG animation must preserve original object position, frame sequence, occlusion, shadows, and team colors. Enlarging or overlaying images on final frames cannot establish correctness. UI protection requires real masks; the cursor remains independently presented.

First validate a real data bridge for one effect, then one unit's high-resolution animation. Each step needs an off path and comparison with original frames. Fabricated game textures cannot establish compatibility. FPS conclusions require same-scene measurements.

## Sources and distribution

Verify ReShade core licensing separately from effects, game plugins, and assets. The YRModdingBase bundle declares a custom noncommercial license; do not infer that all included components may ship with this project. Complete public source and independent licensing for Toumao's modifications were not found and confirmed; access to the original forum release was also restricted. Research copies, compiled output, and screenshots stay outside the repository.

## Development rendering entry

`VmFrameRenderer.setPostProcess()` accepts a GPU effect factory and releases effects on disable, replacement, and destruction. `ColorPostProcess` in `src/graphics/framePostProcess.ts` executes one pass after final color and before the independent cursor. GPU color copying integrates with presentation without guest-memory reads or CPU pixel readback. The extra color copy and GL state queries are not yet optimized and do not establish performance conclusions.

`src/graphics/experimental/reshadeLaser.ts` accepts externally compiled LaserBlit GLSL and adapts GLSL ES and framebuffer vertical coordinates. Without auxiliary data, it explicitly disables game effects and passes color through. Default textures must not be mistaken for real game masks. No production entry imports the module, and it embeds no third-party shader. Compilation macros must retain the 800×600 baseline above; arbitrary FX and automatic recompilation are unsupported.

Start the development server and supply game resources and the compiled output:

```bash
pnpm run dev --host 127.0.0.1 --port 15185
# In another terminal, set the actual compiled output path:
RA2_LASER_GLSL="$LASER_GLSL_PATH" pnpm exec tsx scripts/experiments/probeReshadeRender.mts
# Asset-free pixel regression:
pnpm exec tsx tests/basic/browser/postProcessBrowserSmoke.mts
```

The probe creates ignored `.tmp-reshade-render` by default and rejects existing directories; use `RA2_POST_OUTPUT` for a new location. Development request interception exposes the renderer and a read-only VM reference without changing production pages or original assets. One browser task produces original, passthrough, and diagnostic-displacement screenshots from the same real frame, verifies byte-for-byte passthrough/restoration after disabling, and checks native unit creation and advancing simulation frames. Constant displacement is diagnostic input, not evidence of real plugin lasers, correct occlusion, or high-resolution gains. Real-game acceptance currently covers only RA2 main-thread mode; YR, Worker, and multipass water/Bloom remain unverified.

Asset-free pixel regressions cover RGBA, RGB565, indexed color, resizing, repeated redraw, toggling, cursor behavior, and backend changes. The first real-game probe failed because a test-script function-name helper variable was missing; a rerun passed after fixing the script. The initial failure remains a failure.

## Effects available during play

The toolbar's **ReShade** selector offers Off, Color + sharpen, and Side-by-side comparison, defaulting to Off. Open the top-left menu if controls are collapsed. Enabled status reports color and sharpening; comparison places original pixels on the left and enhanced pixels on the right. Toggling redraws the current frame immediately without restarting the VM or requiring external shader files. Canvas 2D reports that WebGL2 is required and remains off. The current frame renderer owns GPU resources.

`src/graphics/reshadePreset.ts` ports SweetFX Vibrance and LumaSharpen pattern 1, based on commit `16d1a42247cb5baaf660120ee35c9a33bb94649c`, `Shaders/SweetFX/Vibrance.fx` and `Shaders/SweetFX/LumaSharpen.fx`. MIT licensing remains in `src/graphics/vendor/sweetfx/LICENSE` and output license comments. Current fixed values are vibrance 0.55, sharpening 0.9, and sharpening limit 0.045. There is no Bloom or arbitrary FX loader. Effects cover the whole final color frame, including the native sidebar, followed by the independent cursor. This is a browser port of actual effect algorithms, not support for ReShade DLLs or Toumao's game-rendering extensions.

Asset-free pixel tests additionally verify actual color changes and that comparison halves match original/full-enhanced output respectively. This real RA2 main-thread probe changes modes through the toolbar, saves same-frame comparisons, and verifies restoration after disabling:

```bash
pnpm exec tsx scripts/experiments/probeReShadeUi.mts
```

Default output is `.tmp-reshade-ui`; use `RA2_POST_OUTPUT` for a new directory when it already exists. The first UI probe timed out because its dropdown-button locator used the wrong name. Failure screenshots were retained; the corrected locator was rerun in a separate directory.
