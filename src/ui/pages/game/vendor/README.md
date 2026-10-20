# Upscaling model provenance

## ScaleFX 3× (pixel art)

Ported from libretro/glsl-shaders `scalefx/shaders/scalefx-pass0..4.glsl` (Sp00kyFox, 2017-03-01). The MIT notice remains in the header of `../scalefxUpscale.ts`.

Original pass SHA-256 values:

| Pass | SHA-256 |
| --- | --- |
| pass0 | `37e534d5e600b5bac5d66f05e78f8688cc4631432d7887502e58e106a15ca40c` |
| pass1 | `5e5f27731d7dc918f1cee610218aead459e62284dc33e22e22ab65f82f03e18c` |
| pass2 | `7899f17fb6c156075d02a2cbf84462c184191229a9e795c6abbc023d64b3600a` |
| pass3 | `0f7290476c4e8e4330ef81ba10a72a6547fc0f1ffa2d18c94cadcc8f1998b9ec` |
| pass4 | `b6ad74bc8211399149166e77264d03eea582772d7f08b2dea9fbc9440d3f84c5` |

- Adaptation: upstream RetroArch uses vertex-offset sampling in its GL_ES branch; this port consistently uses integer texelFetch. RGBA8 FBOs connect intermediate stages, with Y flipped in FBO-reading passes. After pass4 outputs 3×, an additional linear pass fits the canvas dimensions.
- Filtering mathematics remain line-for-line equivalent: distance metrics, corner strength, intersection majority votes, lvl1–6 edges, and subpixel mapping. SFX_SAA/SFX_CLR/SFX_SCN inline official defaults of 1.0/0.5/1.0.
- The algorithm's pass4 selects existing neighboring colors without creating new ones.
- Reconstruction is fixed integer 3×; final linear scaling handles target dimensions that do not match 3×. Enable through `?sr=scalefx` or the toolbar.

## FSR 1.0 (EASU)

Mathematics are ported from GPUOpen-Effects/FidelityFX-FSR `ffx-fsr/ffx_fsr1.h` (FSR 1, v1.20210629), with fast reciprocal/square-root approximations from adjacent `ffx_a.h`. Implementation is in `../fsrUpscale.ts`, retaining the MIT header.

- `ffx_fsr1.h` SHA-256: `93c3922362ea7fc99cbcc698ca30c98de4f8c246d1fbb0b09e015ddef38ce3a5`.
- `ffx_a.h` SHA-256: `f60e2722fcd13989523b9164d776ab382b3692791767f3bf8bb19967f763f3fb`.
- Adaptation: upstream uses gather4 and CPU-packed con0–con3 constants. This port reads 12 taps directly with texelFetch for indexed/RGBA/RGB565 guest frames. Algebraic simplification preserves the same mapping. Weights, negative lobes, anti-ringing clamps, and fast approximations are unchanged.
- Single-pass spatial upscaling leaves guest rendering resolution unchanged; enable `?sr=fsr` or use the toolbar.
- RCAS modes (`?sr=fsr-rcas` / `fsr-rcas-soft`, sharpness 0 / 1) first render EASU to an intermediate RGBA texture, then RCAS to canvas. Two intentional differences: `FSR_RCAS_DENOISE` remains disabled, following upstream advice to handle noise after sharpening; limiter denominators clamp with 1e-4 to avoid the upstream 0×∞ NaN edge case in solid white/black blocks, as commonly handled in community ports.

## Anime4K CNN fast mode

`Anime4K_Upscale_CNN_x2_S.glsl` is an unchanged copy of bloc97/Anime4K `glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl`.

- SHA-256: `4c53ec2e287908f7ee7bcb266b0170421626d663576468b7d7dafc62962649a4`.
- MIT license, with complete copyright/license notices in the original header.
- Anime4K v3.2 CNN x2 S, identified by the header's `//!DESC`.
- Weights, biases, and activations remain unchanged. `../aiUpscale.ts` adapts WebGL2 sampling, row orientation, FBOs, and depth-to-space. The final base image uses bilinear sampling; intermediate activations use RGBA16F.
- The model targets animation, not RA2 text/pixel assets, and cannot guarantee recovery of nonexistent detail.

Model updates must verify source, license, hash, and independent CPU/GPU numerical regressions together.

## Quality mode

Unchanged Anime4K_Upscale_GAN_x2_M.glsl comes from bloc97/Anime4K, retaining its MIT notice.

- SHA-256: `8a1d33fddc8939c1e0eb4d6ad6a7baf653dd420d6b713e385b7c73be90d9affe`.
- v4.1 GAN low-resolution model, 23 convolution passes, with final RGB residual reconstruction.
- `aiModelGraph.ts` preserves all weights/branches. Native-size integer sampling uses texelFetch; the final layer retains linear filtering for half-pixel samples. Texture reuse follows last feature use; simple double buffering is insufficient.
- CNN S remains fast mode. GAN is still not trained specifically for RA2 and does not guarantee better results on every asset.
