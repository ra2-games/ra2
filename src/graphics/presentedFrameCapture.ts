import type { VmFrame } from '../vm86/win32';
import { RGB565_TO_RGBA32 } from '../vm86/pixels';

export interface CapturedFrame {
  width: number;
  height: number;
  presentation: number;
  rgba: Uint8ClampedArray;
}

/** Copy only a presented image, before its pooled source buffers can be reused. */
export function copyFramePixels(frame: VmFrame): Uint8ClampedArray {
  const count = frame.width * frame.height;
  if (
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    count > 16_777_216
  )
    throw new Error('Invalid capture dimensions');
  const rgba = new Uint8ClampedArray(count * 4);
  if (frame.rgba) {
    if (frame.rgba.length !== rgba.length) throw new Error('Invalid RGBA frame');
    rgba.set(frame.rgba);
  } else if (frame.rgb565) {
    if (frame.rgb565.length !== count) throw new Error('Invalid RGB565 frame');
    for (let i = 0; i < count; i++) {
      const color = RGB565_TO_RGBA32[frame.rgb565[i]!]!;
      rgba[i * 4] = color & 255;
      rgba[i * 4 + 1] = (color >>> 8) & 255;
      rgba[i * 4 + 2] = (color >>> 16) & 255;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    if (frame.pixels.length !== count || frame.palette.length < 1024) throw new Error('Invalid indexed frame');
    for (let i = 0; i < count; i++) {
      const color = frame.pixels[i]! * 4;
      rgba[i * 4] = frame.palette[color]!;
      rgba[i * 4 + 1] = frame.palette[color + 1]!;
      rgba[i * 4 + 2] = frame.palette[color + 2]!;
      // PALETTEENTRY's fourth byte is flags, not alpha.
      rgba[i * 4 + 3] = 255;
    }
  }
  return rgba;
}

/** Presentation-owned, one-shot capture; idle frames allocate no image copies. */
export class PresentedFrameCapture {
  private dead = false;
  private presentation = 0;
  private pending?: {
    resolve(frame: CapturedFrame): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };

  request(timeoutMs = 3000): Promise<CapturedFrame> {
    if (this.dead) return Promise.reject(new Error('Frame capture disposed'));
    if (this.pending) return Promise.reject(new Error('Frame capture already pending'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.clear('No presented frame before capture timeout'), timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  present(frame: VmFrame): void {
    if (this.dead) return;
    this.presentation++;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    try {
      pending.resolve({
        width: frame.width,
        height: frame.height,
        presentation: this.presentation,
        rgba: copyFramePixels(frame),
      });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  clear(reason = 'Presentation cleared during capture'): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }

  destroy(): void {
    this.dead = true;
    this.clear('Frame capture disposed');
  }
}
