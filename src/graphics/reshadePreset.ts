/*!
The MIT License (MIT)

Copyright (c) 2014 CeeJayDK

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
import { ColorPostProcess } from './framePostProcess';

export type ReShadeMode = 'off' | 'enhance' | 'compare';

/**
 * GLSL ES port of SweetFX 16d1a422 Shaders/SweetFX/Vibrance.fx and LumaSharpen.fx.
 * Author: Christian Cann Schuldt Jensen (CeeJayDK); MIT license in vendor/sweetfx/LICENSE.
 * Preserve Vibrance formulas and LumaSharpen pattern 1; fix RGB balance=1 and offset_bias=1.
 * Process only final color; this does not imply compatibility with ReShade DLLs, arbitrary FX, or game-specific auxiliary textures.
 */
export function createReShadePreset(gl: WebGL2RenderingContext, compare = false): ColorPostProcess {
  return new ColorPostProcess(gl, {
    linear: true,
    colorSampler: 'image',
    vertex: `#version 300 es
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragment: `#version 300 es
      precision highp float;
      uniform sampler2D image;
      uniform bool compare;
      out vec4 result;
      void main() {
        vec2 size = vec2(textureSize(image, 0));
        vec2 uv = gl_FragCoord.xy / size;
        vec3 original = texture(image, uv).rgb;
        if (compare && uv.x < 0.5) { result = vec4(original, 1.0); return; }
        vec2 halfPixel = 0.5 / size;
        vec3 blurred = (texture(image, uv + halfPixel).rgb
          + texture(image, uv - halfPixel).rgb
          + texture(image, uv + vec2(halfPixel.x, -halfPixel.y)).rgb
          + texture(image, uv + vec2(-halfPixel.x, halfPixel.y)).rgb) * 0.25;
        float sharpening = clamp(dot(original-blurred, vec3(0.2126,0.7152,0.0722))*0.9, -0.045, 0.045);
        vec3 color = clamp(original + sharpening, 0.0, 1.0);
        float luma = dot(color, vec3(0.212656,0.715158,0.072186));
        float saturation = max(color.r,max(color.g,color.b))-min(color.r,min(color.g,color.b));
        color = mix(vec3(luma), color, 1.0 + 0.55 * (1.0-saturation));
        result = vec4(clamp(color,0.0,1.0),1.0);
      }`,
    bind(gl, program) {
      gl.uniform1i(gl.getUniformLocation(program, 'compare'), compare ? 1 : 0);
    },
  });
}
