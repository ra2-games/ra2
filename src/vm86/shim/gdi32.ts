import type { GdiTextPixelChange, SurfaceState, VmGdiFont, Win32Result } from '../win32';
import { decodeAnsi } from './text';
import { withKernel32 } from './kernel32';
import type { Constructor } from './state';

type Kernel32Chain = InstanceType<ReturnType<typeof withKernel32>>;

/**
 * Per-run antialiased-pixel record limit, guarding only runaway strings well beyond normal UI sizes.
 * Over-limit runs fall back to solid-only remapping; blended edge pixels are no longer corrected after palette changes.
 */
const MAX_AA_CHANGES_PER_RUN = 1 << 18;

const DEFAULT_GDI_FONT: Readonly<VmGdiFont> = {
  height: -16,
  width: 0,
  weight: 400,
  italic: false,
  underline: false,
  strikeout: false,
  charset: 0x88,
  faceName: '細明體',
};

/** Gdi32 Win32 API cases extracted from Win32Shim.dispatch's main switch. */
export function withGdi32<TBase extends Constructor<Kernel32Chain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    dispatchGdi32(key: string, name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'GDI32.DLL!GetStockObject':
          return { eax: this.getStockObject(a[0] ?? 0) };
        case 'GDI32.DLL!CreateFontIndirectA':
          return { eax: this.createGdiFont(a[0] ?? 0) };
        case 'GDI32.DLL!CreateSolidBrush': {
          const handle = this.nextGdiObject++;
          this.gdiBrushes.set(handle, (a[0] ?? 0) & 0x00ff_ffff);
          return { eax: handle };
        }
        case 'GDI32.DLL!CreateCompatibleDC':
          return { eax: this.createGdiDc(0) };
        case 'GDI32.DLL!DeleteDC':
          return { eax: this.releaseGdiDc(a[0] ?? 0) ? 1 : 0 };
        case 'GDI32.DLL!CreateCompatibleBitmap': {
          const handle = this.nextGdiObject++;
          this.gdiBrushes.set(handle, null);
          return { eax: handle };
        }
        case 'GDI32.DLL!SetStretchBltMode':
          return { eax: 1 };
        case 'GDI32.DLL!StretchBlt':
          return { eax: 1 };
        case 'GDI32.DLL!GetDIBits':
          return { eax: a[3] ?? 0 };
        case 'GDI32.DLL!DeleteObject': {
          const handle = a[0] ?? 0;
          // Win32 forbids deleting stock objects or objects still selected into any DC.
          if (
            this.gdiStockObjects.has(handle) ||
            [...this.gdiDcs.values()].some((dc) => dc.selectedFont === handle || dc.selectedBrush === handle)
          )
            return { eax: 0 };
          return { eax: this.gdiFonts.delete(handle) || this.gdiBrushes.delete(handle) ? 1 : 0 };
        }
        case 'GDI32.DLL!TextOutA':
          return { eax: this.textOut(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0) ? 1 : 0 };
        case 'GDI32.DLL!SelectObject': {
          const dc = this.gdiDcs.get(a[0] ?? 0);
          if (!dc) return { eax: 0 };
          const object = a[1] ?? 0;
          if (this.gdiFonts.has(object)) {
            const previous = dc.selectedFont;
            dc.selectedFont = object;
            return { eax: previous };
          }
          if (this.gdiBrushes.has(object)) {
            const previous = dc.selectedBrush;
            dc.selectedBrush = object;
            return { eax: previous };
          }
          return { eax: 0 };
        }
        case 'GDI32.DLL!GetTextColor': {
          const dc = this.gdiDcs.get(a[0] ?? 0);
          return { eax: dc ? dc.textColor : 0xffff_ffff }; // CLR_INVALID
        }
        case 'GDI32.DLL!GetBkMode': {
          const dc = this.gdiDcs.get(a[0] ?? 0);
          return { eax: dc?.backgroundMode ?? 0 };
        }
        case 'GDI32.DLL!GetBkColor': {
          const dc = this.gdiDcs.get(a[0] ?? 0);
          return { eax: dc ? dc.backgroundColor : 0xffff_ffff }; // CLR_INVALID
        }
        case 'GDI32.DLL!SetTextColor': {
          const dc = this.gdiDcs.get(a[0] ?? 0);
          if (!dc) return { eax: 0xffff_ffff };
          const previous = dc.textColor;
          dc.textColor = (a[1] ?? 0) & 0x00ff_ffff;
          return { eax: previous };
        }
        case 'GDI32.DLL!SetBkMode': {
          const dc = this.gdiDcs.get(a[0] ?? 0);
          if (!dc) return { eax: 0 };
          const previous = dc.backgroundMode;
          dc.backgroundMode = a[1] ?? 0;
          return { eax: previous };
        }
        case 'GDI32.DLL!SetBkColor': {
          const dc = this.gdiDcs.get(a[0] ?? 0);
          if (!dc) return { eax: 0xffff_ffff };
          const previous = dc.backgroundColor;
          dc.backgroundColor = (a[1] ?? 0) & 0x00ff_ffff;
          return { eax: previous };
        }
        case 'GDI32.DLL!SetSystemPaletteUse':
          return { eax: 1 }; // SYSPAL_STATIC
        case 'GDI32.DLL!GetDeviceCaps':
          switch (a[1] ?? 0) {
            case 8:
              return { eax: this.displayWidth }; // HORZRES
            case 10:
              return { eax: this.displayHeight }; // VERTRES
            case 12:
              return { eax: this.displayBpp }; // BITSPIXEL
            case 14:
              return { eax: 1 }; // PLANES
            default:
              return { eax: 0 };
          }
        case 'GDI32.DLL!GetSystemPaletteEntries':
          return { eax: this.getSystemPaletteEntries(a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) };
        case 'GDI32.DLL!SetPixel':
          return { eax: this.setGdiPixel(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) };
        case 'GDI32.DLL!GetPixel':
          return { eax: this.getGdiPixel(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) };
        default:
          void name;
          return null;
      }
    }
    protected createGdiDc(surface: number, originX = 0, originY = 0): number {
      const handle = this.nextGdiDc++;
      this.gdiDcs.set(handle, {
        surface,
        originX,
        originY,
        selectedFont: this.getStockObject(13), // SYSTEM_FONT
        selectedBrush: this.getStockObject(0), // WHITE_BRUSH
        textColor: 0,
        backgroundMode: 2, // OPAQUE; the guest may explicitly choose TRANSPARENT.
        backgroundColor: 0,
      });
      return handle;
    }
    protected releaseGdiDc(handle: number, expectedSurface?: number): boolean {
      const dc = this.gdiDcs.get(handle);
      if (!dc || (expectedSurface !== undefined && dc.surface !== expectedSurface)) return false;
      this.gdiDcs.delete(handle);
      if (dc.surface === this.primarySurface) {
        const primary = this.surfaces.get(this.primarySurface);
        if (primary) primary.dirty = true; // The DC drew text, so pixels have changed by release time.
        this.emitPrimaryFrame();
      }
      return true;
    }
    protected getStockObject(index: number): number {
      const handle = 0x31_0000 + (index & 0xffff);
      if (index >= 0 && index <= 5 && !this.gdiBrushes.has(handle)) {
        const colors: Array<number | null> = [0x00ff_ffff, 0x00c0_c0c0, 0x0080_8080, 0x0040_4040, 0x0000_0000, null];
        this.gdiBrushes.set(handle, colors[index]!);
        this.gdiStockObjects.add(handle);
      }
      // OEM_FIXED_FONT .. DEFAULT_GUI_FONT.
      if (index >= 10 && index <= 17 && !this.gdiFonts.has(handle)) {
        this.gdiFonts.set(handle, {
          height: -16,
          width: 0,
          weight: 400,
          italic: false,
          underline: false,
          strikeout: false,
          charset: 0x88,
          faceName: '細明體',
        });
        this.gdiStockObjects.add(handle);
      }
      return handle;
    }
    protected createGdiFont(logFont: number): number {
      if (!logFont) return 0;
      const handle = this.nextGdiObject++;
      const faceBytes = this.memory.read_memory(logFont + 28, 32);
      const terminator = faceBytes.indexOf(0);
      this.gdiFonts.set(handle, {
        height: this.readU32(logFont) | 0,
        width: this.readU32(logFont + 4) | 0,
        weight: this.readU32(logFont + 16) | 0,
        italic: this.readU8(logFont + 20) !== 0,
        underline: this.readU8(logFont + 21) !== 0,
        strikeout: this.readU8(logFont + 22) !== 0,
        charset: this.readU8(logFont + 23),
        faceName: decodeAnsi(faceBytes.subarray(0, terminator < 0 ? faceBytes.length : terminator)),
      });
      return handle;
    }
    protected textOut(
      dcHandle: number,
      x: number,
      y: number,
      stringPtr: number,
      count: number,
      textOverride?: string,
    ): boolean {
      const dc = this.gdiDcs.get(dcHandle);
      if (!dc || !stringPtr || count < 0 || count > 0x10_0000) return false;
      // Screen DCs only query device capabilities; text rendering requires an actual surface.
      const surface = this.surfaces.get(dc.surface);
      if (!surface || !count) return true;
      const bytes = this.memory.read_memory(stringPtr, count);
      const text = textOverride ?? decodeAnsi(bytes);
      const font = this.gdiFonts.get(dc.selectedFont) ?? DEFAULT_GDI_FONT;
      const bitmap = this.options.textRasterizer?.rasterize(text, font);
      if (!bitmap || bitmap.width <= 0 || bitmap.height <= 0 || bitmap.alpha.length < bitmap.width * bitmap.height) {
        return true;
      }
      const palette = this.paletteForSurface(surface);
      const paletteIndex = this.nearestPaletteIndex(palette, dc.textColor);
      const originX = (x | 0) + dc.originX;
      const originY = (y | 0) + dc.originY;
      const left = Math.max(0, originX);
      const top = Math.max(0, originY);
      const right = Math.min(surface.width, originX + bitmap.width);
      const bottom = Math.min(surface.height, originY + bitmap.height);
      if (right <= left || bottom <= top) return true;
      if (surface.bpp === 16) {
        // RA2 DirectDraw uses RGB565. GDI text is not its primary rendering path, but error dialogs
        // and some compatibility UI still draw through surface DCs, so provide correct solid-glyph placement at minimum.
        const width = right - left;
        const height = bottom - top;
        const start = surface.pixels + top * surface.pitch + left * 2;
        const span = (height - 1) * surface.pitch + width * 2;
        const block = this.memory.read_memory(start, span).slice();
        const red = dc.textColor & 0xff;
        const green = (dc.textColor >>> 8) & 0xff;
        const blue = (dc.textColor >>> 16) & 0xff;
        const rgb565 = ((red >>> 3) << 11) | ((green >>> 2) << 5) | (blue >>> 3);
        const bias = 128 - (bitmap.threshold ?? 128);
        for (let targetY = top; targetY < bottom; targetY++) {
          const sourceY = targetY - originY;
          const targetRow = (targetY - top) * surface.pitch;
          for (let targetX = left; targetX < right; targetX++) {
            const sourceX = targetX - originX;
            if (bitmap.alpha[sourceY * bitmap.width + sourceX]! + bias < 128) continue;
            const offset = targetRow + (targetX - left) * 2;
            block[offset] = rgb565 & 0xff;
            block[offset + 1] = rgb565 >>> 8;
          }
        }
        this.memory.write_memory(block, start);
        return true;
      }
      this.invalidateGdiTextRuns(surface, left, top, right, bottom);
      const width = right - left;
      const height = bottom - top;
      const start = surface.pixels + top * surface.pitch + left;
      const span = (height - 1) * surface.pitch + width;
      const block = this.memory.read_memory(start, span).slice();
      // Coverage bias: 128 is neutral; lower values thicken and higher values thin strokes, matching the existing slider.
      const bias = 128 - (bitmap.threshold ?? 128);
      const changes: GdiTextPixelChange[] = [];
      let overflow = false;
      for (let targetY = top; targetY < bottom; targetY++) {
        const sourceY = targetY - originY;
        const targetRow = (targetY - top) * surface.pitch;
        for (let targetX = left; targetX < right; targetX++) {
          const sourceX = targetX - originX;
          const coverage = bitmap.alpha[sourceY * bitmap.width + sourceX]!;
          if (coverage <= 0) continue; // Bias must never create pixels from zero coverage, which would destroy transparent backgrounds.
          const alpha = coverage + bias;
          if (alpha <= 0) continue;
          const offset = targetRow + targetX - left;
          const original = block[offset]!;
          // Antialiasing: solid coverage writes the text index directly; edges blend text into the background by coverage,
          // then choose the nearest palette color. Background/blended colors are palette-independent; remap recomputes from records.
          // Do not blend color-key transparent backgrounds; retain native 1-bit solid-pixel behavior.
          const index = this.textPixelIndex(palette, surface, original, dc.textColor, alpha, paletteIndex);
          if (index === null || index === original) continue;
          block[offset] = index;
          if (changes.length < MAX_AA_CHANGES_PER_RUN) changes.push({ offset, original, written: index });
          else overflow = true;
        }
      }
      this.memory.write_memory(block, start);
      surface.textRuns.push({
        x: originX,
        y: originY,
        bitmap,
        colorRef: dc.textColor,
        paletteIndex,
        changed: overflow ? null : changes,
      });
      // The cap only guards runaway growth: evicted runs lose remapping protection during palette changes,
      // so set it far above the text count that one UI could display simultaneously.
      if (surface.textRuns.length > 1024) surface.textRuns.splice(0, surface.textRuns.length - 1024);
      return true;
    }
    protected remapGdiTextForPalette(paletteObject: number): void {
      const primaryPalette = this.surfaces.get(this.primarySurface)?.palette ?? 0;
      for (const surface of this.surfaces.values()) {
        if (surface.palette === paletteObject || (!surface.palette && primaryPalette === paletteObject)) {
          this.remapGdiTextRunColors(surface);
        }
      }
    }
    protected remapGdiTextRunColors(surface: SurfaceState): void {
      if (surface.bpp !== 8) return;
      if (!surface.textRuns.length) return;
      const palette = this.paletteForSurface(surface);
      for (const run of surface.textRuns) {
        const nextIndex = this.nearestPaletteIndex(palette, run.colorRef);
        const left = Math.max(0, run.x);
        const top = Math.max(0, run.y);
        const right = Math.min(surface.width, run.x + run.bitmap.width);
        const bottom = Math.min(surface.height, run.y + run.bitmap.height);
        if (right <= left || bottom <= top) {
          run.paletteIndex = nextIndex;
          continue;
        }
        const width = right - left;
        const height = bottom - top;
        const start = surface.pixels + top * surface.pitch + left;
        const span = (height - 1) * surface.pitch + width;
        const block = this.memory.read_memory(start, span).slice();
        const bias = 128 - (run.bitmap.threshold ?? 128);
        if (run.changed?.length) {
          // Antialiasing path: restore the original background and reblend with the new palette idempotently; abandon pixels overwritten by later drawing.
          const kept: GdiTextPixelChange[] = [];
          const pitch = surface.pitch;
          for (const change of run.changed) {
            // Never repaint old text over glyph pixels replaced by subsequent drawing.
            if (block[change.offset] !== change.written) continue;
            const sourceX = left + (change.offset % pitch) - run.x;
            const sourceY = top + ((change.offset / pitch) | 0) - run.y;
            const alpha = run.bitmap.alpha[sourceY * run.bitmap.width + sourceX]! + bias;
            const index =
              alpha <= 0
                ? change.original
                : (this.textPixelIndex(palette, surface, change.original, run.colorRef, alpha, nextIndex) ??
                  change.original);
            block[change.offset] = index;
            kept.push({ offset: change.offset, original: change.original, written: index });
          }
          this.memory.write_memory(block, start);
          run.changed = kept;
          run.paletteIndex = nextIndex;
          continue;
        }
        // Without antialiasing records, including over-limit fallback, correct only solid pixels.
        if (nextIndex === run.paletteIndex) continue;
        for (let targetY = top; targetY < bottom; targetY++) {
          const sourceY = targetY - run.y;
          const targetRow = (targetY - top) * surface.pitch;
          for (let targetX = left; targetX < right; targetX++) {
            const sourceX = targetX - run.x;
            if (run.bitmap.alpha[sourceY * run.bitmap.width + sourceX]! + bias <= 0) continue;
            const offset = targetRow + targetX - left;
            if (block[offset] === run.paletteIndex) block[offset] = nextIndex;
          }
        }
        this.memory.write_memory(block, start);
        run.paletteIndex = nextIndex;
      }
    }
    /**
     * After Blt/copyRect copies glyph pixels, translate source runs onto the destination too; otherwise destination text has no remapping records and turns white on palette changes.
     */
    protected transferGdiTextRuns(
      source: SurfaceState,
      sourceRect: number[],
      dest: SurfaceState,
      dx: number,
      dy: number,
      width: number,
      height: number,
      sourceKey: [number, number] | null,
    ): void {
      const sx = sourceRect[0]!;
      const sy = sourceRect[1]!;
      if (!source.textRuns.length) return;
      for (const run of source.textRuns) {
        if (
          run.x + run.bitmap.width <= sx ||
          run.x >= sx + width ||
          run.y + run.bitmap.height <= sy ||
          run.y >= sy + height
        )
          continue;
        // If color keying filters out glyph pixels, do not copy their runs either.
        if (sourceKey && run.paletteIndex >= sourceKey[0] && run.paletteIndex <= sourceKey[1]) continue;
        dest.textRuns.push({
          x: run.x + (dx - sx),
          y: run.y + (dy - sy),
          bitmap: run.bitmap,
          colorRef: run.colorRef,
          paletteIndex: run.paletteIndex,
          changed: run.changed,
        });
        if (dest.textRuns.length > 1024) dest.textRuns.splice(0, dest.textRuns.length - 1024);
      }
    }
    protected invalidateGdiTextRuns(
      surface: SurfaceState,
      left: number,
      top: number,
      right: number,
      bottom: number,
    ): void {
      // Every blit reaches here, about 180,000/sec in Tongyi Tianxia; when no text runs exist,
      // return directly instead of allocating a pointless filtered array.
      if (!surface.textRuns.length) return;
      surface.textRuns = surface.textRuns.filter(
        (run) =>
          run.x + run.bitmap.width <= left || run.x >= right || run.y + run.bitmap.height <= top || run.y >= bottom,
      );
    }
    /** Blend text COLORREF into background by coverage and return the nearest palette index; alpha is 0-255. */
    protected mixTextPixel(entries: Uint8Array, background: number, textRef: number, alpha: number): number {
      const mix = (shift: number): number => {
        const from = (background >>> shift) & 0xff;
        const to = (textRef >>> shift) & 0xff;
        return Math.round(from + ((to - from) * alpha) / 255) & 0xff;
      };
      const mixed = (mix(0) | (mix(8) << 8) | (mix(16) << 16)) >>> 0;
      return this.nearestPaletteIndex(entries, mixed);
    }
    /**
     * Destination text-pixel index; null preserves a transparent background. Treat source-color-key backgrounds as transparent without blending, which would create non-key colors copied as opaque by blits. Write solid text only above half effective coverage, matching native 1-bit behavior.
     */
    protected textPixelIndex(
      entries: Uint8Array,
      surface: SurfaceState,
      background: number,
      textRef: number,
      alpha: number,
      solidIndex: number,
    ): number | null {
      const key = surface.sourceColorKey;
      if (key && background >= key[0] && background <= key[1]) {
        return alpha >= 128 ? solidIndex : null;
      }
      if (alpha >= 255) return solidIndex;
      return this.mixTextPixel(entries, this.paletteColorRef(entries, background), textRef, alpha);
    }
    protected nearestPaletteIndex(entries: Uint8Array, colorRef: number): number {
      const red = colorRef & 0xff;
      const green = (colorRef >>> 8) & 0xff;
      const blue = (colorRef >>> 16) & 0xff;
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < 256; index++) {
        const offset = index * 4;
        const dr = (entries[offset] ?? 0) - red;
        const dg = (entries[offset + 1] ?? 0) - green;
        const db = (entries[offset + 2] ?? 0) - blue;
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
          if (!distance) break;
        }
      }
      return bestIndex;
    }
    protected getSystemPaletteEntries(start: number, count: number, output: number): number {
      const base = Math.min(256, start >>> 0);
      const clipped = Math.min(count >>> 0, 256 - base);
      const entries = new Uint8Array(256 * 4);
      const primary = this.surfaces.get(this.primarySurface);
      if (primary) entries.set(this.paletteForSurface(primary));
      entries.set([0, 0, 0, 0], 0);
      if (output && clipped) this.memory.write_memory(entries.subarray(base * 4, (base + clipped) * 4), output);
      return clipped;
    }
    protected setGdiPixel(dcHandle: number, x: number, y: number, colorRef: number): number {
      const surface = this.surfaces.get(this.gdiDcs.get(dcHandle)?.surface ?? 0);
      if (!surface || x < 0 || y < 0 || x >= surface.width || y >= surface.height) return 0xffff_ffff;
      if (surface.bpp === 16) {
        const red = colorRef & 0xff;
        const green = (colorRef >>> 8) & 0xff;
        const blue = (colorRef >>> 16) & 0xff;
        const rgb565 = ((red >>> 3) << 11) | ((green >>> 2) << 5) | (blue >>> 3);
        this.memory.write_memory([rgb565 & 0xff, rgb565 >>> 8], surface.pixels + y * surface.pitch + x * 2);
        return colorRef & 0x00ff_ffff;
      }
      const entries = this.paletteForSurface(surface);
      const index = this.nearestPaletteIndex(entries, colorRef);
      this.memory.write_memory([index], surface.pixels + y * surface.pitch + x);
      return this.paletteColorRef(entries, index);
    }
    protected getGdiPixel(dcHandle: number, x: number, y: number): number {
      const surface = this.surfaces.get(this.gdiDcs.get(dcHandle)?.surface ?? 0);
      if (!surface || x < 0 || y < 0 || x >= surface.width || y >= surface.height) return 0xffff_ffff;
      if (surface.bpp === 16) {
        const bytes = this.memory.read_memory(surface.pixels + y * surface.pitch + x * 2, 2);
        const rgb565 = bytes[0]! | (bytes[1]! << 8);
        const red = (rgb565 >>> 11) & 0x1f;
        const green = (rgb565 >>> 5) & 0x3f;
        const blue = rgb565 & 0x1f;
        return (
          ((red << 3) | (red >>> 2) | (((green << 2) | (green >>> 4)) << 8) | (((blue << 3) | (blue >>> 2)) << 16)) >>>
          0
        );
      }
      const index = this.readU8(surface.pixels + y * surface.pitch + x);
      return this.paletteColorRef(this.paletteForSurface(surface), index);
    }
    protected paletteColorRef(entries: Uint8Array, index: number): number {
      const offset = index * 4;
      return ((entries[offset] ?? 0) | ((entries[offset + 1] ?? 0) << 8) | ((entries[offset + 2] ?? 0) << 16)) >>> 0;
    }
  };
}
