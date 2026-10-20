import type { VmFrame } from '../../../../vm86/win32';
import { RGB565_TO_RGBA32 as rgb565Colors } from '../../../../vm86/pixels';
const RGB565_TO_RGBA32 = rgb565Colors;

/**
 * Low-cost debug/E2E frame probe reading VM frames directly, avoiding repeated Playwright WebGL ReadPixels. Prolonged screenshots with headless SwiftShader can cause substantial pauses or renderer crashes.
 */
export function measureRa2BattlefieldFrame(frame: VmFrame): { rightEdgeRatio: number; fieldRatio: number } {
  let rightEdgeLit = 0;
  let fieldLit = 0;
  const isLit = (sampleX: number, sampleY: number): boolean => {
    const x = Math.min(frame.width - 1, Math.floor((sampleX * frame.width) / 144));
    const y = Math.min(frame.height - 1, Math.floor((sampleY * frame.height) / 90));
    if (frame.rgba) {
      const offset = (y * frame.width + x) * 4;
      return frame.rgba[offset]! + frame.rgba[offset + 1]! + frame.rgba[offset + 2]! >= 36;
    }
    if (frame.rgb565) {
      const color = RGB565_TO_RGBA32[frame.rgb565[y * frame.width + x]!]!;
      return (color & 255) + ((color >>> 8) & 255) + ((color >>> 16) & 255) >= 36;
    }
    const paletteOffset = (frame.pixels[y * frame.width + x] ?? 0) * 4;
    return frame.palette[paletteOffset]! + frame.palette[paletteOffset + 1]! + frame.palette[paletteOffset + 2]! >= 36;
  };
  let rightEdgeSamples = 0;
  let fieldSamples = 0;
  for (let y = 0; y < 90; y += 2) {
    for (let x = 130; x < 144; x += 2) {
      if (isLit(x, y)) rightEdgeLit++;
      rightEdgeSamples++;
    }
  }
  for (let y = 0; y < 78; y += 2) {
    for (let x = 0; x < 125; x += 2) {
      if (isLit(x, y)) fieldLit++;
      fieldSamples++;
    }
  }
  return {
    rightEdgeRatio: rightEdgeLit / rightEdgeSamples,
    fieldRatio: fieldLit / fieldSamples,
  };
}

/**
 * Low-cost debug/E2E visual-change probe: hash 48x36 sampled colors with FNV-1a, enough to detect campaign-faction logo hover animation. Avoid both readPixels and Playwright waiting for a continuously redrawn WebGL canvas to stabilize for screenshots.
 */
export function sampleVmFrameHash(frame: VmFrame): string {
  let hash = 0x811c_9dc5;
  const absorb = (value: number) => {
    hash ^= value & 0xff;
    hash = Math.imul(hash, 0x0100_0193);
  };
  for (let sampleY = 0; sampleY < 36; sampleY++) {
    const y = Math.min(frame.height - 1, Math.floor(((sampleY + 0.5) * frame.height) / 36));
    for (let sampleX = 0; sampleX < 48; sampleX++) {
      const x = Math.min(frame.width - 1, Math.floor(((sampleX + 0.5) * frame.width) / 48));
      if (frame.rgba) {
        const offset = (y * frame.width + x) * 4;
        absorb(frame.rgba[offset]!);
        absorb(frame.rgba[offset + 1]!);
        absorb(frame.rgba[offset + 2]!);
      } else if (frame.rgb565) {
        const color = RGB565_TO_RGBA32[frame.rgb565[y * frame.width + x]!]!;
        absorb(color);
        absorb(color >>> 8);
        absorb(color >>> 16);
      } else {
        const paletteOffset = (frame.pixels[y * frame.width + x] ?? 0) * 4;
        absorb(frame.palette[paletteOffset]!);
        absorb(frame.palette[paletteOffset + 1]!);
        absorb(frame.palette[paletteOffset + 2]!);
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
