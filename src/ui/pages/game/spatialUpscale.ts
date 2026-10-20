import type { FsrMode } from './vmFrameRenderer';

/** Experimental spatial reconstruction switch; neither AI nor temporal upscaling, and does not change guest rendering resolution. */
export function spatialUpscaleEnabled(search: string): boolean {
  return new URLSearchParams(search).get('sr') === '1';
}

/** FSR 1.0 (AMD FidelityFX) spatial upsampling; ?sr=fsr / fsr-rcas / fsr-rcas-soft enables it at startup. */
export function fsrUpscaleMode(search: string): FsrMode | null {
  const value = new URLSearchParams(search).get('sr');
  return value === 'fsr' || value === 'fsr-rcas' || value === 'fsr-rcas-soft' ? value : null;
}

/** ScaleFX 3x pixel-art edge interpolation; ?sr=scalefx enables it at startup. */
export function scalefxUpscaleEnabled(search: string): boolean {
  return new URLSearchParams(search).get('sr') === 'scalefx';
}

export function aiUpscaleEnabled(search: string): boolean {
  return new URLSearchParams(search).get('sr') === 'ai';
}

/** Single-pass anti-ringing Catmull-Rom reconstruction reads original textures directly, without CPU expansion or intermediate frames. */
export function spatialUpscaleShader(format: 'indexed' | 'rgba' | 'rgb565'): string {
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
  return `#version 300 es
    precision highp float;
    precision highp int;
    uniform ${format === 'rgb565' ? 'highp usampler2D' : 'sampler2D'} ${texture};
    ${format === 'indexed' ? 'uniform sampler2D palette;' : ''}
    uniform bool upscale;
    uniform vec2 outputSize;
    in vec2 uv;
    out vec4 color;
    vec4 readPixel(ivec2 p) {
      p = clamp(p, ivec2(0), textureSize(${texture}, 0) - 1);
      ${sample}
    }
    int floorDiv(int n, int d) {
      return n >= 0 ? n / d : -((d - 1 - n) / d);
    }
    vec4 weights(float t) {
      float t2 = t * t, t3 = t2 * t;
      return vec4(-0.5*t + t2 - 0.5*t3, 1.0 - 2.5*t2 + 1.5*t3,
                  0.5*t + 2.0*t2 - 1.5*t3, -0.5*t2 + 0.5*t3);
    }
    void main() {
      vec2 size = vec2(textureSize(${texture}, 0));
      // Preserve original sampling at 1:1 or while downscaling so experimental switches cannot change native pixels.
      if (!upscale) { color = readPixel(ivec2(floor(uv * size))); return; }
      // Locate the source pixel with exact integer arithmetic: image row r maps to (2r+1)*size/(2*output) - 1/2.
      // At ratios where that lands exactly on a pixel boundary, float division (interpolated uv or GPU reciprocal)
      // can round to just below the integer, so floor() selects the neighbouring base and the anti-ringing clamp below
      // uses a different 2x2 window: a discontinuity observed as 10/255 on AMD radeonsi/RADV, 0 on SwiftShader.
      // The viewport starts at the origin and FBO rows are bottom-up, so image rows flip relative to gl_FragCoord.
      ivec2 sourceSize = textureSize(${texture}, 0), targetSize = ivec2(outputSize);
      ivec2 pixel = ivec2(gl_FragCoord.xy);
      pixel.y = targetSize.y - 1 - pixel.y;
      ivec2 numerator = (2 * pixel + 1) * sourceSize - targetSize, denominator = 2 * targetSize;
      ivec2 base = ivec2(floorDiv(numerator.x, denominator.x), floorDiv(numerator.y, denominator.y));
      vec2 offset = vec2(numerator - base * denominator) / vec2(denominator);
      vec4 wx = weights(offset.x), wy = weights(offset.y);
      vec4 sum = vec4(0.0), low = vec4(1.0), high = vec4(0.0);
      for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
          vec4 value = readPixel(base + ivec2(x - 1, y - 1));
          sum += value * wx[x] * wy[y];
          // The central 2x2 color range limits negative-lobe overshoot, reducing halos around text and high-contrast edges.
          if (x >= 1 && x <= 2 && y >= 1 && y <= 2) {
            low = min(low, value); high = max(high, value);
          }
        }
      }
      color = clamp(sum, low, high);
    }
  `;
}
