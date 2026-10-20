import { t } from '../../shared/i18n/translate';
/*!
 * ScaleFX -- pixel-art edge-interpolation upscaling (3x).
 *
 * Ported from libretro/glsl-shaders scalefx/shaders/scalefx-pass0..4.glsl by Sp00kyFox, under the MIT license:
 *
 *   ScaleFX - Pass 0..4, by Sp00kyFox, 2017-03-01
 *   Copyright (c) 2016 Sp00kyFox - ScaleFX@web.de
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *   THE SOFTWARE.
 *
 * Official pipeline: pass0 color distance -> pass1 corner strength -> pass2 junction tags -> pass3 subpixel mapping, all at source resolution, then pass4 samples original colors for 3x output. Output contains only colors already in the source because pass4 only selects neighborhood colors.
 *
 * Adaptations, retaining filtering logic line by line:
 * - RetroArch uses vertex-preoffset t1..t4 coordinates for GL_ES sampling; this port uses integer texelFetch with identical per-texel offsets.
 * - FBO writes follow bottom-up gl_FragCoord, so every FBO-reading pass flips Y, matching FSR RCAS. pass0/pass4 do not flip original-texture reads.
 * - pass4 flips gl_FragCoord to image orientation before fp = 3*fract(src); otherwise each 3x3 block is vertically mirrored.
 * - After pass4 writes a 3x intermediate texture, one extra linear pass fits the canvas, whose target size is usually not 3x; official presets output integer scales directly.
 * - Inline official SFX_SAA/SFX_CLR/SFX_SCN defaults of 1.0/0.5/1.0 into the math.
 */

type FrameFormat = 'indexed' | 'rgba' | 'rgb565';

const VERTEX = `#version 300 es
in vec2 position;
in vec2 texturePosition;
out vec2 uv;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
  uv = texturePosition;
}
`;

/** Point decoding of original textures, matching readPixel in fsrUpscaleShader. */
function sourceRead(format: FrameFormat): { uniforms: string; body: string; sampler: string; texture: string } {
  const texture =
    format === 'indexed' ? 'scalefxSource' : format === 'rgba' ? 'scalefxSourceRgba' : 'scalefxSourceRgb565';
  const sampler = format === 'rgb565' ? 'highp usampler2D' : 'sampler2D';
  const uniforms = `uniform ${sampler} ${texture};${format === 'indexed' ? '\nuniform sampler2D scalefxPalette;' : ''}`;
  const body = `vec4 readSource(ivec2 p) {
    p = clamp(p, ivec2(0), textureSize(${texture}, 0) - 1);
    ${
      format === 'indexed'
        ? 'int index = int(texelFetch(scalefxSource, p, 0).r * 255.0 + 0.5); return vec4(texelFetch(scalefxPalette, ivec2(index, 0), 0).rgb, 1.0);'
        : format === 'rgba'
          ? 'return texelFetch(scalefxSourceRgba, p, 0);'
          : `uint bits = texelFetch(scalefxSourceRgb565, p, 0).r;
     uvec3 rgb = uvec3((bits >> 11u) & 31u, (bits >> 5u) & 63u, bits & 31u);
     rgb = (rgb << uvec3(3u, 2u, 3u)) | (rgb >> uvec3(2u, 4u, 2u));
     return vec4(vec3(rgb) / 255.0, 1.0);`
    }
  }`;
  return { uniforms, body, sampler, texture };
}

/** Integer coordinates for intermediate FBO textures, including Y reversal for bottom-up FBO rows. */
function fboRead(textureName: string, offset = 'p'): string {
  return `ivec2 ${offset} = ivec2(floor(uv * vec2(textureSize(${textureName}, 0)))); ${offset}.y = textureSize(${textureName}, 0).y - 1 - ${offset}.y;`;
}

// ---------------------------------------------------------------------------
// pass0: color-distance metric from the original texture.
// ---------------------------------------------------------------------------
function scalefxPass0(format: FrameFormat): string {
  const read = sourceRead(format);
  return `#version 300 es
precision highp float;
precision highp int;
${read.uniforms}
in vec2 uv;
out vec4 color;
${read.body}
float dist(vec3 A, vec3 B) {
  float r = 0.5 * (A.r + B.r);
  vec3 d = A - B;
  vec3 c = vec3(2. + r, 4., 3. - r);
  return sqrt(dot(c * d, d)) / 3.;
}
void main() {
  ivec2 p = ivec2(floor(uv * vec2(textureSize(${read.texture}, 0))));
  vec3 A = readSource(p + ivec2(-1, -1)).rgb;
  vec3 B = readSource(p + ivec2(0, -1)).rgb;
  vec3 C = readSource(p + ivec2(1, -1)).rgb;
  vec3 E = readSource(p).rgb;
  vec3 F = readSource(p + ivec2(1, 0)).rgb;
  color = vec4(dist(E, A), dist(E, B), dist(E, C), dist(E, F));
}
`;
}

// ---------------------------------------------------------------------------
// pass1: corner strength from pass0 metrics.
// ---------------------------------------------------------------------------
const scalefxPass1 = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D scalefxMetric;
in vec2 uv;
out vec4 color;
float str(float d, vec2 a, vec2 b) {
  float diff = a.x - a.y;
  float wght1 = max(0.5 - d, 0.) / 0.5;
  float wght2 = clamp((1. - d) + (min(a.x, b.x) + a.x > min(a.y, b.y) + a.y ? diff : -diff), 0., 1.);
  return (2. * d < a.x + a.y) ? (wght1 * wght2) * (a.x * a.y) : 0.;
}
void main() {
  ${fboRead('scalefxMetric')}
  vec4 A = texelFetch(scalefxMetric, p + ivec2(-1, -1), 0);
  vec4 B = texelFetch(scalefxMetric, p + ivec2(0, -1), 0);
  vec4 D = texelFetch(scalefxMetric, p + ivec2(-1, 0), 0);
  vec4 E = texelFetch(scalefxMetric, p + ivec2(0, 0), 0);
  vec4 F = texelFetch(scalefxMetric, p + ivec2(1, 0), 0);
  vec4 G = texelFetch(scalefxMetric, p + ivec2(-1, 1), 0);
  vec4 H = texelFetch(scalefxMetric, p + ivec2(0, 1), 0);
  vec4 I = texelFetch(scalefxMetric, p + ivec2(1, 1), 0);
  vec4 res;
  res.x = str(D.z, vec2(D.w, E.y), vec2(A.w, D.y));
  res.y = str(F.x, vec2(E.w, E.y), vec2(B.w, F.y));
  res.z = str(H.z, vec2(E.w, H.y), vec2(H.w, I.y));
  res.w = str(H.x, vec2(D.w, H.y), vec2(G.w, G.y));
  color = res;
}
`;

// ---------------------------------------------------------------------------
// pass2: junction tags from pass0 metrics and pass1 strength.
// ---------------------------------------------------------------------------
const scalefxPass2 = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D scalefxMetric;
uniform sampler2D scalefxStrength;
in vec2 uv;
out vec4 color;
#define LE(x, y) (1. - step(y, x))
#define GE(x, y) (1. - step(x, y))
#define LEQ(x, y) step(x, y)
#define GEQ(x, y) step(y, x)
#define NOT(x) (1. - (x))
vec4 dom(vec3 x, vec3 y, vec3 z, vec3 w) {
  return 2. * vec4(x.y, y.y, z.y, w.y) - (vec4(x.x, y.x, z.x, w.x) + vec4(x.z, y.z, z.z, w.z));
}
float clear(vec2 crn, vec2 a, vec2 b) {
  return (crn.x >= max(min(a.x, a.y), min(b.x, b.y))) && (crn.y >= max(min(a.x, b.y), min(b.x, a.y))) ? 1. : 0.;
}
void main() {
  ${fboRead('scalefxMetric', 'pm')}
  ivec2 ps = ivec2(floor(uv * vec2(textureSize(scalefxStrength, 0)))); ps.y = textureSize(scalefxStrength, 0).y - 1 - ps.y;
  vec4 A = texelFetch(scalefxMetric, pm + ivec2(-1, -1), 0);
  vec4 B = texelFetch(scalefxMetric, pm + ivec2(0, -1), 0);
  vec4 D = texelFetch(scalefxMetric, pm + ivec2(-1, 0), 0);
  vec4 E = texelFetch(scalefxMetric, pm + ivec2(0, 0), 0);
  vec4 F = texelFetch(scalefxMetric, pm + ivec2(1, 0), 0);
  vec4 G = texelFetch(scalefxMetric, pm + ivec2(-1, 1), 0);
  vec4 H = texelFetch(scalefxMetric, pm + ivec2(0, 1), 0);
  vec4 I = texelFetch(scalefxMetric, pm + ivec2(1, 1), 0);
  vec4 As = texelFetch(scalefxStrength, ps + ivec2(-1, -1), 0);
  vec4 Bs = texelFetch(scalefxStrength, ps + ivec2(0, -1), 0);
  vec4 Cs = texelFetch(scalefxStrength, ps + ivec2(1, -1), 0);
  vec4 Ds = texelFetch(scalefxStrength, ps + ivec2(-1, 0), 0);
  vec4 Es = texelFetch(scalefxStrength, ps + ivec2(0, 0), 0);
  vec4 Fs = texelFetch(scalefxStrength, ps + ivec2(1, 0), 0);
  vec4 Gs = texelFetch(scalefxStrength, ps + ivec2(-1, 1), 0);
  vec4 Hs = texelFetch(scalefxStrength, ps + ivec2(0, 1), 0);
  vec4 Is = texelFetch(scalefxStrength, ps + ivec2(1, 1), 0);
  vec4 jSx = vec4(As.z, Bs.w, Es.x, Ds.y), jDx = dom(As.yzw, Bs.zwx, Es.wxy, Ds.xyz);
  vec4 jSy = vec4(Bs.z, Cs.w, Fs.x, Es.y), jDy = dom(Bs.yzw, Cs.zwx, Fs.wxy, Es.xyz);
  vec4 jSz = vec4(Es.z, Fs.w, Is.x, Hs.y), jDz = dom(Es.yzw, Fs.zwx, Is.wxy, Hs.xyz);
  vec4 jSw = vec4(Ds.z, Es.w, Hs.x, Gs.y), jDw = dom(Ds.yzw, Es.zwx, Hs.wxy, Gs.xyz);
  vec4 zero4 = vec4(0.);
  vec4 jx = min(GE(jDx, zero4) * (LEQ(jDx.yzwx, zero4) * LEQ(jDx.wxyz, zero4) + GE(jDx + jDx.zwxy, jDx.yzwx + jDx.wxyz)), 1.);
  vec4 jy = min(GE(jDy, zero4) * (LEQ(jDy.yzwx, zero4) * LEQ(jDy.wxyz, zero4) + GE(jDy + jDy.zwxy, jDy.yzwx + jDy.wxyz)), 1.);
  vec4 jz = min(GE(jDz, zero4) * (LEQ(jDz.yzwx, zero4) * LEQ(jDz.wxyz, zero4) + GE(jDz + jDz.zwxy, jDz.yzwx + jDz.wxyz)), 1.);
  vec4 jw = min(GE(jDw, zero4) * (LEQ(jDw.yzwx, zero4) * LEQ(jDw.wxyz, zero4) + GE(jDw + jDw.zwxy, jDw.yzwx + jDw.wxyz)), 1.);
  vec4 res;
  res.x = min(jx.z + NOT(jx.y) * NOT(jx.w) * GE(jSx.z, 0.) * (jx.x + GE(jSx.x + jSx.z, jSx.y + jSx.w)), 1.);
  res.y = min(jy.w + NOT(jy.z) * NOT(jy.x) * GE(jSy.w, 0.) * (jy.y + GE(jSy.y + jSy.w, jSy.x + jSy.z)), 1.);
  res.z = min(jz.x + NOT(jz.w) * NOT(jz.y) * GE(jSz.x, 0.) * (jz.z + GE(jSz.x + jSz.z, jSz.y + jSz.w)), 1.);
  res.w = min(jw.y + NOT(jw.x) * NOT(jw.z) * GE(jSw.y, 0.) * (jw.w + GE(jSw.y + jSw.w, jSw.x + jSw.z)), 1.);
  res = min(res * (vec4(jx.z, jy.w, jz.x, jw.y) + NOT(res.wxyz * res.yzwx)), 1.);
  vec4 clr;
  clr.x = clear(vec2(D.z, E.x), vec2(D.w, E.y), vec2(A.w, D.y));
  clr.y = clear(vec2(F.x, E.z), vec2(E.w, E.y), vec2(B.w, F.y));
  clr.z = clear(vec2(H.z, I.x), vec2(E.w, H.y), vec2(H.w, I.y));
  clr.w = clear(vec2(H.x, G.z), vec2(D.w, H.y), vec2(G.w, G.y));
  vec4 h = vec4(min(D.w, A.w), min(E.w, B.w), min(E.w, H.w), min(D.w, G.w));
  vec4 v = vec4(min(E.y, D.y), min(E.y, F.y), min(H.y, I.y), min(H.y, G.y));
  vec4 or = GE(h + vec4(D.w, E.w, E.w, D.w), v + vec4(E.y, E.y, H.y, H.y));
  vec4 hori = LE(h, v) * clr;
  vec4 vert = GE(h, v) * clr;
  color = (res + 2. * hori + 4. * vert + 8. * or) / 15.;
}
`;

// ---------------------------------------------------------------------------
// pass3: subpixel mapping from pass2 tags.
// ---------------------------------------------------------------------------
const scalefxPass3 = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D scalefxTags;
in vec2 uv;
out vec4 color;
bvec4 loadCorn(vec4 x) { return bvec4(floor(mod(x * 15. + 0.5, 2.))); }
bvec4 loadHori(vec4 x) { return bvec4(floor(mod(x * 7.5 + 0.25, 2.))); }
bvec4 loadVert(vec4 x) { return bvec4(floor(mod(x * 3.75 + 0.125, 2.))); }
bvec4 loadOr(vec4 x) { return bvec4(floor(mod(x * 1.875 + 0.0625, 2.))); }
void main() {
  ${fboRead('scalefxTags')}
  vec4 E = texelFetch(scalefxTags, p + ivec2(0, 0), 0);
  vec4 D = texelFetch(scalefxTags, p + ivec2(-1, 0), 0);
  vec4 D0 = texelFetch(scalefxTags, p + ivec2(-2, 0), 0);
  vec4 D1 = texelFetch(scalefxTags, p + ivec2(-3, 0), 0);
  vec4 F = texelFetch(scalefxTags, p + ivec2(1, 0), 0);
  vec4 F0 = texelFetch(scalefxTags, p + ivec2(2, 0), 0);
  vec4 F1 = texelFetch(scalefxTags, p + ivec2(3, 0), 0);
  vec4 B = texelFetch(scalefxTags, p + ivec2(0, -1), 0);
  vec4 B0 = texelFetch(scalefxTags, p + ivec2(0, -2), 0);
  vec4 B1 = texelFetch(scalefxTags, p + ivec2(0, -3), 0);
  vec4 H = texelFetch(scalefxTags, p + ivec2(0, 1), 0);
  vec4 H0 = texelFetch(scalefxTags, p + ivec2(0, 2), 0);
  vec4 H1 = texelFetch(scalefxTags, p + ivec2(0, 3), 0);
  bvec4 Ec = loadCorn(E), Eh = loadHori(E), Ev = loadVert(E), Eo = loadOr(E);
  bvec4 Dc = loadCorn(D), Dh = loadHori(D), Do = loadOr(D), D0c = loadCorn(D0), D0h = loadHori(D0), D1h = loadHori(D1);
  bvec4 Fc = loadCorn(F), Fh = loadHori(F), Fo = loadOr(F), F0c = loadCorn(F0), F0h = loadHori(F0), F1h = loadHori(F1);
  bvec4 Bc = loadCorn(B), Bv = loadVert(B), Bo = loadOr(B), B0c = loadCorn(B0), B0v = loadVert(B0), B1v = loadVert(B1);
  bvec4 Hc = loadCorn(H), Hv = loadVert(H), Ho = loadOr(H), H0c = loadCorn(H0), H0v = loadVert(H0), H1v = loadVert(H1);
  bool lvl1x = Ec.x && (Dc.z || Bc.z);
  bool lvl1y = Ec.y && (Fc.w || Bc.w);
  bool lvl1z = Ec.z && (Fc.x || Hc.x);
  bool lvl1w = Ec.w && (Dc.y || Hc.y);
  bvec2 lvl2x = bvec2((Ec.x && Eh.y) && Dc.z, (Ec.y && Eh.x) && Fc.w);
  bvec2 lvl2y = bvec2((Ec.y && Ev.z) && Bc.w, (Ec.z && Ev.y) && Hc.x);
  bvec2 lvl2z = bvec2((Ec.w && Eh.z) && Dc.y, (Ec.z && Eh.w) && Fc.x);
  bvec2 lvl2w = bvec2((Ec.x && Ev.w) && Bc.z, (Ec.w && Ev.x) && Hc.y);
  bvec2 lvl3x = bvec2(lvl2x.y && (Dh.y && Dh.x) && Fh.z, lvl2w.y && (Bv.w && Bv.x) && Hv.z);
  bvec2 lvl3y = bvec2(lvl2x.x && (Fh.x && Fh.y) && Dh.w, lvl2y.y && (Bv.z && Bv.y) && Hv.w);
  bvec2 lvl3z = bvec2(lvl2z.x && (Fh.w && Fh.z) && Dh.x, lvl2y.x && (Hv.y && Hv.z) && Bv.x);
  bvec2 lvl3w = bvec2(lvl2z.y && (Dh.z && Dh.w) && Fh.y, lvl2w.x && (Hv.x && Hv.w) && Bv.y);
  bvec2 lvl4x = bvec2((Dc.x && Dh.y && Eh.x && Eh.y && Fh.x && Fh.y) && (D0c.z && D0h.w), (Bc.x && Bv.w && Ev.x && Ev.w && Hv.x && Hv.w) && (B0c.z && B0v.y));
  bvec2 lvl4y = bvec2((Fc.y && Fh.x && Eh.y && Eh.x && Dh.y && Dh.x) && (F0c.w && F0h.z), (Bc.y && Bv.z && Ev.y && Ev.z && Hv.y && Hv.z) && (B0c.w && B0v.x));
  bvec2 lvl4z = bvec2((Fc.z && Fh.w && Eh.z && Eh.w && Dh.z && Dh.w) && (F0c.x && F0h.y), (Hc.z && Hv.y && Ev.z && Ev.y && Bv.z && Bv.y) && (H0c.x && H0v.w));
  bvec2 lvl4w = bvec2((Dc.w && Dh.z && Eh.w && Eh.z && Fh.w && Fh.z) && (D0c.y && D0h.x), (Hc.w && Hv.x && Ev.w && Ev.x && Bv.w && Bv.x) && (H0c.y && H0v.z));
  bvec2 lvl5x = bvec2(lvl4x.x && (F0h.x && F0h.y) && (D1h.z && D1h.w), lvl4y.x && (D0h.y && D0h.x) && (F1h.w && F1h.z));
  bvec2 lvl5y = bvec2(lvl4y.y && (H0v.y && H0v.z) && (B1v.w && B1v.x), lvl4z.y && (B0v.z && B0v.y) && (H1v.x && H1v.w));
  bvec2 lvl5z = bvec2(lvl4w.x && (F0h.w && F0h.z) && (D1h.y && D1h.x), lvl4z.x && (D0h.z && D0h.w) && (F1h.x && F1h.y));
  bvec2 lvl5w = bvec2(lvl4x.y && (H0v.x && H0v.w) && (B1v.z && B1v.y), lvl4w.y && (B0v.w && B0v.x) && (H1v.y && H1v.z));
  bvec2 lvl6x = bvec2(lvl5x.y && (D1h.y && D1h.x), lvl5w.y && (B1v.w && B1v.x));
  bvec2 lvl6y = bvec2(lvl5x.x && (F1h.x && F1h.y), lvl5y.y && (B1v.z && B1v.y));
  bvec2 lvl6z = bvec2(lvl5z.x && (F1h.w && F1h.z), lvl5y.x && (H1v.y && H1v.z));
  bvec2 lvl6w = bvec2(lvl5z.y && (D1h.z && D1h.w), lvl5w.x && (H1v.x && H1v.w));
  vec4 crn;
  crn.x = (lvl1x && Eo.x || lvl3x.x && Eo.y || lvl4x.x && Do.x || lvl6x.x && Fo.y) ? 5. : (lvl1x || lvl3x.y && !Eo.w || lvl4x.y && !Bo.x || lvl6x.y && !Ho.w) ? 1. : lvl3x.x ? 3. : lvl3x.y ? 7. : lvl4x.x ? 2. : lvl4x.y ? 6. : lvl6x.x ? 4. : lvl6x.y ? 8. : 0.;
  crn.y = (lvl1y && Eo.y || lvl3y.x && Eo.x || lvl4y.x && Fo.y || lvl6y.x && Do.x) ? 5. : (lvl1y || lvl3y.y && !Eo.z || lvl4y.y && !Bo.y || lvl6y.y && !Ho.z) ? 3. : lvl3y.x ? 1. : lvl3y.y ? 7. : lvl4y.x ? 4. : lvl4y.y ? 6. : lvl6y.x ? 2. : lvl6y.y ? 8. : 0.;
  crn.z = (lvl1z && Eo.z || lvl3z.x && Eo.w || lvl4z.x && Fo.z || lvl6z.x && Do.w) ? 7. : (lvl1z || lvl3z.y && !Eo.y || lvl4z.y && !Ho.z || lvl6z.y && !Bo.y) ? 3. : lvl3z.x ? 1. : lvl3z.y ? 5. : lvl4z.x ? 4. : lvl4z.y ? 8. : lvl6z.x ? 2. : lvl6z.y ? 6. : 0.;
  crn.w = (lvl1w && Eo.w || lvl3w.x && Eo.z || lvl4w.x && Do.w || lvl6w.x && Fo.z) ? 7. : (lvl1w || lvl3w.y && !Eo.x || lvl4w.y && !Ho.w || lvl6w.y && !Bo.x) ? 1. : lvl3w.x ? 3. : lvl3w.y ? 5. : lvl4w.x ? 2. : lvl4w.y ? 8. : lvl6w.x ? 4. : lvl6w.y ? 6. : 0.;
  vec4 mid;
  mid.x = (lvl2x.x && Eo.x || lvl2x.y && Eo.y || lvl5x.x && Do.x || lvl5x.y && Fo.y) ? 5. : lvl2x.x ? 1. : lvl2x.y ? 3. : lvl5x.x ? 2. : lvl5x.y ? 4. : (Ec.x && Dc.z && Ec.y && Fc.w) ? (Eo.x ? Eo.y ? 5. : 3. : 1.) : 0.;
  mid.y = (lvl2y.x && !Eo.y || lvl2y.y && !Eo.z || lvl5y.x && !Bo.y || lvl5y.y && !Ho.z) ? 3. : lvl2y.x ? 5. : lvl2y.y ? 7. : lvl5y.x ? 6. : lvl5y.y ? 8. : (Ec.y && Bc.w && Ec.z && Hc.x) ? (!Eo.y ? !Eo.z ? 3. : 7. : 5.) : 0.;
  mid.z = (lvl2z.x && Eo.w || lvl2z.y && Eo.z || lvl5z.x && Do.w || lvl5z.y && Fo.z) ? 7. : lvl2z.x ? 1. : lvl2z.y ? 3. : lvl5z.x ? 2. : lvl5z.y ? 4. : (Ec.z && Fc.x && Ec.w && Dc.y) ? (Eo.z ? Eo.w ? 7. : 1. : 3.) : 0.;
  mid.w = (lvl2w.x && !Eo.x || lvl2w.y && !Eo.w || lvl5w.x && !Bo.x || lvl5w.y && !Ho.w) ? 1. : lvl2w.x ? 5. : lvl2w.y ? 7. : lvl5w.x ? 6. : lvl5w.y ? 8. : (Ec.w && Hc.y && Ec.x && Bc.z) ? (!Eo.w ? !Eo.x ? 1. : 5. : 7.) : 0.;
  color = (crn + 9. * mid) / 80.;
}
`;

// ---------------------------------------------------------------------------
// pass4: sample original colors through subpixel mapping for 3x output.
// ---------------------------------------------------------------------------
function scalefxPass4(format: FrameFormat): string {
  const read = sourceRead(format);
  return `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D scalefxSubpix;
${read.uniforms}
uniform vec2 outputSize;
in vec2 uv;
out vec4 color;
${read.body}
vec4 loadCrn(vec4 x) { return floor(mod(x * 80. + 0.5, 9.)); }
vec4 loadMid(vec4 x) { return floor(mod(x * 8.888888 + 0.055555, 9.)); }
void main() {
  // Output pixels in the 3x viewport -> source positions; flip Y to image orientation so the 3x3 subpixel
  // grid retains upstream's x y / w z layout instead of being vertically mirrored.
  vec2 src = floor(gl_FragCoord.xy);
  src.y = outputSize.y - 1.0 - src.y;
  src = src / 3.0;
  vec2 fp = floor(3.0 * fract(src));
  ivec2 e = ivec2(floor(src));
  ivec2 mp = e;
  mp.y = textureSize(scalefxSubpix, 0).y - 1 - mp.y;
  vec4 E = texelFetch(scalefxSubpix, mp, 0);
  vec4 crn = loadCrn(E);
  vec4 mid = loadMid(E);
  float sp = fp.y == 0. ? (fp.x == 0. ? crn.x : fp.x == 1. ? mid.x : crn.y)
           : (fp.y == 1. ? (fp.x == 0. ? mid.w : fp.x == 1. ? 0. : mid.y)
                         : (fp.x == 0. ? crn.w : fp.x == 1. ? mid.z : crn.z));
  vec2 res = sp == 0. ? vec2(0., 0.) : sp == 1. ? vec2(-1., 0.) : sp == 2. ? vec2(-2., 0.)
           : sp == 3. ? vec2(1., 0.) : sp == 4. ? vec2(2., 0.) : sp == 5. ? vec2(0., -1.)
           : sp == 6. ? vec2(0., -2.) : sp == 7. ? vec2(0., 1.) : vec2(0., 2.);
  color = readSource(e + ivec2(res));
}
`;
}

// ---------------------------------------------------------------------------
// Final fit: 3x intermediate texture to target canvas size with linear sampling and FBO Y reversal.
// ---------------------------------------------------------------------------
const scalefxDownscale = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D scalefxOut;
in vec2 uv;
out vec4 color;
void main() {
  color = texture(scalefxOut, vec2(uv.x, 1.0 - uv.y));
}
`;

interface ScalefxTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

/** ScaleFX 3x pipeline: combine format-independent passes with pass0/pass4 variants for three original-frame formats. */
export class ScalefxUpscale {
  private readonly pass0 = new Map<FrameFormat, WebGLProgram>();
  private readonly pass4 = new Map<FrameFormat, WebGLProgram>();
  private readonly pass1: WebGLProgram;
  private readonly pass2: WebGLProgram;
  private readonly pass3: WebGLProgram;
  private readonly downscale: WebGLProgram;
  private metric: ScalefxTarget;
  private strength: ScalefxTarget;
  private tags: ScalefxTarget;
  private subpix: ScalefxTarget;
  private out3x: ScalefxTarget;
  private frameWidth = 0;
  private frameHeight = 0;
  private readonly outputSizeLocations = new Map<WebGLProgram, WebGLUniformLocation | null>();
  private destroyed = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    for (const format of ['indexed', 'rgba', 'rgb565'] as const) {
      this.pass0.set(format, linkScalefxProgram(gl, scalefxPass0(format)));
      this.pass4.set(format, linkScalefxProgram(gl, scalefxPass4(format)));
    }
    this.pass1 = linkScalefxProgram(gl, scalefxPass1);
    this.pass2 = linkScalefxProgram(gl, scalefxPass2);
    this.pass3 = linkScalefxProgram(gl, scalefxPass3);
    this.downscale = linkScalefxProgram(gl, scalefxDownscale);
    gl.useProgram(this.pass1);
    gl.uniform1i(gl.getUniformLocation(this.pass1, 'scalefxMetric'), 0);
    gl.useProgram(this.pass2);
    gl.uniform1i(gl.getUniformLocation(this.pass2, 'scalefxMetric'), 0);
    gl.uniform1i(gl.getUniformLocation(this.pass2, 'scalefxStrength'), 1);
    gl.useProgram(this.pass3);
    gl.uniform1i(gl.getUniformLocation(this.pass3, 'scalefxTags'), 0);
    gl.useProgram(this.downscale);
    gl.uniform1i(gl.getUniformLocation(this.downscale, 'scalefxOut'), 0);
    for (const format of ['indexed', 'rgba', 'rgb565'] as const) {
      gl.useProgram(this.pass0.get(format)!);
      gl.uniform1i(gl.getUniformLocation(this.pass0.get(format)!, 'scalefxSource'), 0);
      gl.uniform1i(gl.getUniformLocation(this.pass0.get(format)!, 'scalefxSourceRgba'), 0);
      gl.uniform1i(gl.getUniformLocation(this.pass0.get(format)!, 'scalefxSourceRgb565'), 0);
      gl.uniform1i(gl.getUniformLocation(this.pass0.get(format)!, 'scalefxPalette'), 1);
      gl.useProgram(this.pass4.get(format)!);
      gl.uniform1i(gl.getUniformLocation(this.pass4.get(format)!, 'scalefxSubpix'), 0);
      gl.uniform1i(gl.getUniformLocation(this.pass4.get(format)!, 'scalefxSource'), 1);
      gl.uniform1i(gl.getUniformLocation(this.pass4.get(format)!, 'scalefxSourceRgba'), 1);
      gl.uniform1i(gl.getUniformLocation(this.pass4.get(format)!, 'scalefxSourceRgb565'), 1);
      gl.uniform1i(gl.getUniformLocation(this.pass4.get(format)!, 'scalefxPalette'), 2);
    }
    for (const format of ['indexed', 'rgba', 'rgb565'] as const) {
      this.outputSizeLocations.set(
        this.pass4.get(format)!,
        gl.getUniformLocation(this.pass4.get(format)!, 'outputSize'),
      );
    }
    this.metric = createScalefxTarget(gl, 1, 1, false);
    this.strength = createScalefxTarget(gl, 1, 1, false);
    this.tags = createScalefxTarget(gl, 1, 1, false);
    this.subpix = createScalefxTarget(gl, 1, 1, false);
    this.out3x = createScalefxTarget(gl, 1, 1, true);
  }

  /** Reallocate intermediate textures on frame-size changes: four source-resolution textures plus 3x output. */
  resize(frameWidth: number, frameHeight: number): void {
    if (this.frameWidth === frameWidth && this.frameHeight === frameHeight) return;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;
    const { gl } = this;
    for (const target of [this.metric, this.strength, this.tags, this.subpix, this.out3x]) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    this.metric = createScalefxTarget(gl, frameWidth, frameHeight, false);
    this.strength = createScalefxTarget(gl, frameWidth, frameHeight, false);
    this.tags = createScalefxTarget(gl, frameWidth, frameHeight, false);
    this.subpix = createScalefxTarget(gl, frameWidth, frameHeight, false);
    this.out3x = createScalefxTarget(gl, frameWidth * 3, frameHeight * 3, true);
  }

  /**
   * Run the full five-pass chain; the caller already uploaded original textures and the palette for indexed frames.
   * The canvas is the final target; the caller draws the cursor pass after return.
   */
  draw(
    source: WebGLTexture,
    format: FrameFormat,
    palette: WebGLTexture | null,
    targetWidth: number,
    targetHeight: number,
  ): void {
    if (this.destroyed) return;
    const { gl } = this;
    const w = this.frameWidth;
    const h = this.frameHeight;
    const pass0 = this.pass0.get(format)!;
    const pass4 = this.pass4.get(format)!;
    // 0: metric, original texture -> metric.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.metric.framebuffer);
    gl.viewport(0, 0, w, h);
    gl.useProgram(pass0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    if (palette) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, palette);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // 1: corner strength.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.strength.framebuffer);
    gl.useProgram(this.pass1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.metric.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // 2: junction tags.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.tags.framebuffer);
    gl.useProgram(this.pass2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.metric.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.strength.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // 3: subpixel mapping.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.subpix.framebuffer);
    gl.useProgram(this.pass3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tags.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // 4: 3x output.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.out3x.framebuffer);
    gl.viewport(0, 0, w * 3, h * 3);
    gl.useProgram(pass4);
    gl.uniform2f(this.outputSizeLocations.get(pass4) ?? null, w * 3, h * 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.subpix.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source);
    if (palette) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, palette);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Final fit: 3x to canvas target with linear sampling.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, targetWidth, targetHeight);
    gl.useProgram(this.downscale);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.out3x.texture);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Reclaim all GPU objects; the caller, createVmFrameRenderer, owns and releases the context. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const { gl } = this;
    for (const program of [
      ...this.pass0.values(),
      this.pass1,
      this.pass2,
      this.pass3,
      this.downscale,
      ...this.pass4.values(),
    ]) {
      gl.deleteProgram(program);
    }
    for (const target of [this.metric, this.strength, this.tags, this.subpix, this.out3x]) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
  }
}

function linkScalefxProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  if (!program) throw new Error(t('WebGL program 创建失败'));
  try {
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error(t('WebGL shader 创建失败'));
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(t('ScaleFX shader 编译失败：{0}', gl.getShaderInfoLog(shader) ?? t('未知错误')));
      }
      shaders.push(shader);
      return shader;
    };
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(t('ScaleFX program 链接失败：{0}', gl.getProgramInfoLog(program) ?? t('未知错误')));
    }
  } catch (error) {
    gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    throw error;
  }
  for (const shader of shaders) gl.deleteShader(shader);
  return program;
}

function createScalefxTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  linear: boolean,
): ScalefxTarget {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) throw new Error(t('ScaleFX 纹理/帧缓冲分配失败'));
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    throw new Error(t('ScaleFX 帧缓冲不可用'));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer };
}
