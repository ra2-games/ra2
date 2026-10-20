/*!
 * AMD FidelityFX Super Resolution 1.0 -- EASU (Edge-Adaptive Spatial Upsampling).
 *
 * Ported from GPUOpen-Effects/FidelityFX-FSR ffx_fsr1.h (FSR 1, v1.20210629), under the MIT license. See the copyright notice below and vendor/README.md:
 *
 *   FidelityFX Super Resolution Sample
 *   Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files(the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and / or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions :
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *   THE SOFTWARE.
 *
 * Adaptations from the official implementation, retaining the math line by line:
 * - Upstream uses gather4 for 12 taps and CPU-packed con0-con3 constants. This port uses texelFetch for indexed / RGBA / RGB565 guest frames. After simplifying the UV identity, output-to-input mapping matches upstream without packed constants.
 * - Fast reciprocal/square-root approximations (fsrRcp / fsrRsq) retain upstream bit operations, yielding finite large values for zero inputs so flat regions avoid NaNs from exact 1/x.
 * - Downscaling and 1:1 use original sampling unchanged, preserving native pixels as in the bicubic path.
 */

const FSr_COMMON = `
// ===== FSR EASU (ported from ffx_fsr1.h, MIT; see file header) =====
// Official APrxLoRcpF1 / APrxLoRsqF1 bitwise approximations: finite outputs keep flat-color regions stable.
float fsrRcp(float a) { return uintBitsToFloat(0x7ef07ebbu - floatBitsToUint(a)); }
float fsrRsq(float a) { return uintBitsToFloat(0x5f347d74u - (floatBitsToUint(a) >> 1u)); }
// Official minimal multichannel approximate luma: 0.5*R + G + 0.5*B (2 FMAs).
float fsrLuma(vec3 c) { return c.r * 0.5 + c.g + c.b * 0.5; }

// Accumulate direction and length (official FsrEasuSetF; callers derive bilinear weights from pp).
void fsrSet(
  vec2 pp, float w, float lA, float lB, float lC, float lD, float lE, inout vec2 dir, inout float len) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = fsrRcp(lenX);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = fsrRcp(lenY);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

// Single-tap filtering (official FsrEasuTapF: rotation, anisotropy, Lanczos2 approximation, negative lobes).
void fsrTap(
  inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v;
  v.x = off.x * dir.x + off.y * dir.y;
  v.y = off.x * (-dir.y) + off.y * dir.x;
  v *= len;
  float d2 = v.x * v.x + v.y * v.y;
  d2 = min(d2, clp);
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}
`;

/**
 * FSR 1.0 RCAS sharpening pass: read the EASU-upscaled intermediate RGBA texture and output in one pass.
 * Use official sharpness semantics: 0 is maximum sharpening; larger values soften it through internal 2^-sharpness scaling.
 */
export function fsrRcasShader(sharpness: number): string {
  // Official FsrRcasCon setting conversion: stops to linear.
  const scale = Math.pow(2, -sharpness).toFixed(9);
  return `#version 300 es
    precision highp float;
    precision highp int;
    uniform sampler2D easuFrame;
    in vec2 uv;
    out vec4 color;
    // ===== FSR RCAS (ported from ffx_fsr1.h, MIT; see file header) =====
    // Official APrxMedRcpF1 medium-precision reciprocal approximation avoids visible tone steps.
    float rcasMedRcp(float a) { float b = uintBitsToFloat(0x7ef19fffu - floatBitsToUint(a)); return b * (-b * a + 2.0); }
    // FSR_RCAS_DENOISE is disabled; upstream recommends separate denoising after sharpening, so omit the noise-detection branch.
    vec4 rcasLoad(ivec2 p) {
      p = clamp(p, ivec2(0), textureSize(easuFrame, 0) - 1);
      return texelFetch(easuFrame, p, 0);
    }
    void main() {
      // Upstream samples a 3x3 cross around integer output pixel sp; uv represents output position, so sp = uv*size.
      // FBO writes follow bottom-up gl_FragCoord, while sampling follows top-down screen UVs.
      // Flip Y or the entire EASU -> RCAS chain becomes vertically inverted, as previously observed.
      ivec2 sp = ivec2(floor(uv * vec2(textureSize(easuFrame, 0))));
      sp.y = textureSize(easuFrame, 0).y - 1 - sp.y;
      vec3 b = rcasLoad(sp + ivec2(0, -1)).rgb;
      vec3 d = rcasLoad(sp + ivec2(-1, 0)).rgb;
      vec3 e = rcasLoad(sp).rgb;
      vec3 f = rcasLoad(sp + ivec2(1, 0)).rgb;
      vec3 h = rcasLoad(sp + ivec2(0, 1)).rgb;
      // Per-channel min/max of the cross neighbors (up/down/left/right).
      vec3 mn4 = min(min(b, d), min(f, h));
      vec3 mx4 = max(max(b, d), max(f, h));
      // Official limiter with high-precision reciprocals. Clamp denominators slightly: upstream 0 x infinity
      // produces NaN in pure-white/black blocks; common community ports clamp this, affecting only pathological inputs.
      vec3 hitMin = min(mn4, e) * (1.0 / max(4.0 * mx4, 1e-4));
      vec3 hitMax = (vec3(1.0) - max(mx4, e)) * (1.0 / max(4.0 * mn4 - 4.0, 1e-4));
      vec3 lobe3 = max(-hitMin, hitMax);
      float lobe = max(-(0.25 - (1.0 / 16.0)), min(max(lobe3.x, max(lobe3.y, lobe3.z)), 0.0)) * ${scale};
      float rcpL = rcasMedRcp(4.0 * lobe + 1.0);
      color = vec4((lobe * (b + d + h + f) + e) * rcpL, 1.0);
    }
  `;
}

/** Single-pass FSR 1.0 EASU fragment shader; all three guest-frame formats share the same filtering math. */
export function fsrUpscaleShader(format: 'indexed' | 'rgba' | 'rgb565'): string {
  const texture = format === 'indexed' ? 'indexedFrame' : format === 'rgba' ? 'rgbaFrame' : 'packedFrame';
  const sample =
    format === 'indexed'
      ? 'int index = int(texelFetch(indexedFrame, p, 0).r * 255.0 + 0.5); return vec4(texelFetch(palette, ivec2(index, 0), 0).rgb, 1.0);'
      : format === 'rgba'
        ? 'return texelFetch(rgbaFrame, p, 0);'
        : `uint bits = texelFetch(packedFrame, p, 0).r;
         uvec3 rgb = uvec3((bits >> 11u) & 31u, (bits >> 5u) & 63u, bits & 31u);
         rgb = (rgb << uvec3(3u, 2u, 3u)) | (rgb >> uvec3(2u, 4u, 2u));
         return vec4(vec3(rgb) / 255.0, 1.0);`;
  const taps = (() => {
    const letters = ['b', 'c', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'n', 'o'] as const;
    const offsets: Record<(typeof letters)[number], string> = {
      b: 'vec2(-1.0, -1.0)',
      c: 'vec2(0.0, -1.0)',
      e: 'vec2(-1.0, 0.0)',
      f: 'vec2(0.0, 0.0)',
      g: 'vec2(1.0, 0.0)',
      h: 'vec2(2.0, 0.0)',
      i: 'vec2(-1.0, 1.0)',
      j: 'vec2(0.0, 1.0)',
      k: 'vec2(1.0, 1.0)',
      l: 'vec2(2.0, 1.0)',
      n: 'vec2(0.0, 2.0)',
      o: 'vec2(1.0, 2.0)',
    };
    return letters.map((l) => `  vec3 ${l}C = readPixel(ivec2(fp + ${offsets[l]})).rgb;`).join('\n');
  })();
  // Four bilinear corner regions of the official 12-tap kernel, matching FsrEasuSetF call order and weights in FsrEasuF.
  const sets = `
  fsrSet(pp, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL, dir, len);
  fsrSet(pp, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL, dir, len);
  fsrSet(pp, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL, dir, len);
  fsrSet(pp, pp.x * pp.y, gL, jL, kL, lL, oL, dir, len);`;
  // Official order of the 12 taps and their offsets relative to 'f'.
  const tapCalls = `
  fsrTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, bC); // b
  fsrTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, cC); // c
  fsrTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, iC); // i
  fsrTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, jC); // j
  fsrTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, fC); // f
  fsrTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, eC); // e
  fsrTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, kC); // k
  fsrTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, lC); // l
  fsrTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, hC); // h
  fsrTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, gC); // g
  fsrTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, oC); // o
  fsrTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, nC); // n`;
  return `#version 300 es
    precision highp float;
    precision highp int;
    uniform ${format === 'rgb565' ? 'highp usampler2D' : 'sampler2D'} ${texture};
    ${format === 'indexed' ? 'uniform sampler2D palette;' : ''}
    uniform bool upscale;
    in vec2 uv;
    out vec4 color;
    vec4 readPixel(ivec2 p) {
      p = clamp(p, ivec2(0), textureSize(${texture}, 0) - 1);
      ${sample}
    }
    ${FSr_COMMON}
    void main() {
      vec2 size = vec2(textureSize(${texture}, 0));
      // Preserve original sampling at 1:1 or while downscaling, leaving native pixels unchanged.
      if (!upscale) { color = readPixel(ivec2(floor(uv * size))); return; }
      // Upstream maps integer output pixel ip to input coordinates: pp = ip*scale + 0.5*scale - 0.5.
      // Fullscreen-quad UVs land at output pixel centers (ip = uv*outputSize - 0.5). Substitution
      // simplifies exactly to uv*size - 0.5, matching the bicubic convention. Direct UV use also avoids
      // Y-axis differences between WebGL gl_FragCoord and upstream Vulkan examples that previously inverted the image.
      vec2 pp = uv * size - 0.5;
      vec2 fp = floor(pp);
      pp -= fp;
${taps}
      float bL = fsrLuma(bC), cL = fsrLuma(cC), eL = fsrLuma(eC), fL = fsrLuma(fC);
      float gL = fsrLuma(gC), hL = fsrLuma(hC), iL = fsrLuma(iC), jL = fsrLuma(jC);
      float kL = fsrLuma(kC), lL = fsrLuma(lC), nL = fsrLuma(nC), oL = fsrLuma(oC);
      vec2 dir = vec2(0.0);
      float len = 0.0;${sets}
      // Normalize with the upstream approximation, falling back to a horizontal direction near zero.
      vec2 dir2 = dir * dir;
      float dirR = dir2.x + dir2.y;
      bool zro = dirR < (1.0 / 32768.0);
      dirR = fsrRsq(dirR);
      dirR = zro ? 1.0 : dirR;
      dir.x = zro ? 1.0 : dir.x;
      dir *= dirR;
      len = len * 0.5;
      len *= len;
      float stretch = (dir.x * dir.x + dir.y * dir.y) * fsrRcp(max(abs(dir.x), abs(dir.y)));
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 + (-0.5) * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = fsrRcp(lob);
      // Clamp against the nearest four neighbors' (f/g/j/k) color range to suppress ringing.
      vec3 min4 = min(min(fC, gC), min(jC, kC));
      vec3 max4 = max(max(fC, gC), max(jC, kC));
      vec3 aC = vec3(0.0);
      float aW = 0.0;${tapCalls}
      vec3 pix = min(max4, max(min4, aC * (1.0 / aW)));
      color = vec4(pix, 1.0);
    }
  `;
}
