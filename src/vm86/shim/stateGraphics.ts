/**
 * DirectDraw/GDI graphics state and frame presentation, extracted from state.ts: surfaces, palettes, GDI objects, frame snapshots, and hardware cursor overlays. Apply after synchronization and before kernel32/gdi32 dispatch.
 */
import type {
  GdiDcState,
  PaletteState,
  SoundBufferState,
  SurfaceState,
  VmFrame,
  VmGdiFont,
  VmSurfaceSnapshot,
} from '../win32';
import { HYPERCALL_CURSOR_COUNT } from '../pe';
import { RGB565_TO_RGBA32 as rgb565Colors } from '../pixels';
import { DYNAMIC_STUB_BASE, shimTraceEnabled, type Constructor } from './state';
import type { ShimSyncChain } from './stateSync';

// Bind shared tables locally so development/test ESM live-binding getters stay out of pixel loops.
const RGB565_TO_RGBA32 = rgb565Colors;

const EMPTY_PALETTE = new Uint8Array(256 * 4);

export type ShimGraphicsChain = InstanceType<ReturnType<typeof withShimGraphics>>;

export function withShimGraphics<TBase extends Constructor<ShimSyncChain>>(Base: TBase) {
  return class extends Base {
    protected readonly surfaces = new Map<number, SurfaceState>();
    protected readonly palettes = new Map<number, PaletteState>();
    protected readonly soundBuffers = new Map<number, SoundBufferState>();
    protected readonly gdiDcs = new Map<number, GdiDcState>();
    protected readonly gdiFonts = new Map<number, VmGdiFont>();

    /** Live object counts for development diagnostics of long sessions; read-only. */
    inspectResourceCounts(): { soundBuffers: number; surfaces: number; dynamicStubBytes: number } {
      return {
        soundBuffers: this.soundBuffers.size,
        surfaces: this.surfaces.size,
        dynamicStubBytes: this.nextDynamicStub - DYNAMIC_STUB_BASE,
      };
    }
    /** HBRUSH to COLORREF; null denotes NULL/HOLLOW_BRUSH. */
    protected readonly gdiBrushes = new Map<number, number | null>();
    protected readonly gdiStockObjects = new Set<number>();
    protected nextGdiDc = 0x3000;
    protected nextGdiObject = 0x30_0000;

    /** Debug surface handles, geometry, and caps for composition-layer diagnostics. */
    inspectSurfaceObjects(): Array<{ object: number; width: number; height: number; bpp: number; caps: number }> {
      return [...this.surfaces.values()].map((s) => ({
        object: s.object,
        width: s.width,
        height: s.height,
        bpp: s.bpp,
        caps: s.caps,
      }));
    }

    inspectSurface(object: number): VmSurfaceSnapshot | null {
      const surface = this.surfaces.get(object);
      if (!surface) return null;
      return {
        object: surface.object,
        width: surface.width,
        height: surface.height,
        pitch: surface.pitch,
        bpp: surface.bpp,
        pixels: this.memory.read_memory(surface.pixels, surface.pitch * surface.height).slice(),
      };
    }

    protected paletteForSurface(surface: SurfaceState): Uint8Array {
      const direct = this.palettes.get(surface.palette)?.entries;
      if (direct) return direct;
      const primary = this.surfaces.get(this.primarySurface);
      const primaryEntries = primary ? this.palettes.get(primary.palette)?.entries : undefined;
      return primaryEntries ?? this.palettes.values().next().value?.entries ?? EMPTY_PALETTE;
    }

    protected emitPrimaryFrame(): void {
      const primary = this.surfaces.get(this.primarySurface);
      if (primary) this.emitFrame(primary);
    }

    /** USER32 mixins may overlay independent window controls on DirectDraw presentation. */
    protected compositeWindowControls(_rgba: Uint8Array, _width: number, _height: number): void {}
    /** Independent USER32 control overlays require the RGBA composition path. */
    protected requiresRgbaComposite(): boolean {
      return this.isShellVisible();
    }

    protected emitFrame(surface: SurfaceState): void {
      if (!this.options.onFrame || surface.object !== this.primarySurface) return;
      // Skip unchanged emissions: the game's Blt plus two vblanks can emit three times per frame, wasting
      // three 480KB snapshots and three cross-thread messages and causing periodic Worker GC stalls.
      if (!surface.dirty) return;
      // Keep dirty while a snapshot awaits presentation; queue the next snapshot afterward, avoiding repeated allocation
      // without permanently losing the final update made during the wait.
      if (this.frameScheduled) return;
      surface.dirty = false;
      if (this.options.scheduleFrame) {
        // Shell menus repaint in two stages, often erasing old highlights and drawing new ones in separate guest frames.
        // Backpressure can present both stages, exposing highlight flicker during selection.
        // Coalesce shell updates quietly: if the presentation callback sees continued drawing, wait one additional cycle at most
        // to combine erase/draw into the final state. Battlefield play has no shell page, so this does not apply.
        const settleShell = this.isShellVisible();
        const frame = !this.options.deferFrameSnapshot && !settleShell ? this.snapshotFrame(surface) : null;
        surface.dirty = false;
        const present = () => {
          this.frameScheduled = false;
          if (this.disposed) return;
          // While the Worker mailbox is occupied, retain only the callback, not an expensive pixel copy.
          // Snapshot the current surface when released to obtain the latest frame, avoiding 800x600 copies
          // on every guest frame at 4x speed. The main-thread path still snapshots immediately above.
          const presented = frame ?? this.snapshotFrame(surface);
          if (presented) this.options.onFrame!(presented);
          // Blt/Flip/ReleaseDC may modify the surface while scheduling waits; frameScheduled coalescing
          // must not swallow that update permanently. Workers send the newer snapshot after the previous ACK;
          // the main-thread path continues on its next rAF.
          if (this.options.deferFrameSnapshot) surface.dirty = false;
          if (surface.dirty && this.surfaces.has(surface.object)) this.emitFrame(surface);
        };
        const schedule = (): void => {
          this.frameScheduled = true;
          this.options.scheduleFrame!(present);
        };
        if (settleShell) {
          let postponed = false;
          const settle = (): void => {
            // Drawing continued during the wait; defer presentation of this intermediate state.
            if (!this.disposed && this.surfaces.has(surface.object) && surface.dirty && !postponed) {
              postponed = true;
              this.frameScheduled = true;
              surface.dirty = false;
              this.options.scheduleFrame!(settle);
              return;
            }
            present();
          };
          this.frameScheduled = true;
          this.options.scheduleFrame(settle);
          return;
        }
        schedule();
        return;
      }
      surface.dirty = false;
      this.captureFrame(surface);
    }

    /** Attach the hardware cursor as a separate small texture; movement redraws only the host overlay. */
    private attachCursor(frame: VmFrame): void {
      const showCount = this.readU32(HYPERCALL_CURSOR_COUNT) | 0;
      if (shimTraceEnabled('VM_TRACE_CURSOR')) {
        this.cursorDebugCount += 1;
        if (this.cursorDebugCount <= 8 || this.cursorDebugCount % 500 === 0) {
          console.log(
            `[cursor] #${this.cursorDebugCount} cur=0x${this.currentCursorHandle.toString(16)} class=0x${this.classCursor.toString(16)} showCount=${showCount} imgs=${this.cursorImages.size} rgba=${frame.rgba?.length ?? 0} pos=${this.cursorX},${this.cursorY}`,
          );
        }
      }
      if (showCount < 0) return;
      const handle = this.currentCursorHandle || this.classCursor;
      const img = this.cursorImages.get(handle);
      if (!img) return;
      frame.cursor = {
        handle,
        width: img.width,
        height: img.height,
        hotspotX: img.hotspotX,
        hotspotY: img.hotspotY,
        x: this.cursorX,
        y: this.cursorY,
        // Workers transfer buffers, so copy first; never detach the persistent cursorImages cache.
        rgba: img.rgba.slice(),
      };
    }

    /** Package pixels and palette synchronously at the presentation boundary for deferred display. */
    protected snapshotFrame(surface: SurfaceState): VmFrame | null {
      const frame = this.snapshotFrameRaw(surface);
      if (frame) {
        this.presentedWidth = frame.width;
        this.presentedHeight = frame.height;
        // RA2 1.006 reclamps mouse coordinates using GetClientRect in its own handler.
        // DirectDraw may already be 1440x900 while the top-level Win32 window retains its original
        // 800x600 size, letting host/shim cursors reach the corner but restricting game coordinates to 799x599.
        // The presented frame defines final display bounds; synchronize them into the window table so fast GetClientRect
        // and browser Pointer Lock share one coordinate space.
        const primaryRect = this.windowRects.get(this.primaryWindow);
        if (primaryRect && (primaryRect.width !== frame.width || primaryRect.height !== frame.height)) {
          this.windowRects.set(this.primaryWindow, {
            ...primaryRect,
            width: frame.width,
            height: frame.height,
          });
          this.syncWindowTreeToGuest(this.primaryWindow);
        }
        this.attachCursor(frame);
      }
      return frame;
    }

    private snapshotFrameRaw(surface: SurfaceState): VmFrame | null {
      if (!this.options.onFrame || surface.object !== this.primarySurface) return null;
      if (surface.bpp === 16) {
        if (this.options.packedRgb565Frames && !this.requiresRgbaComposite()) {
          // Only independent snapshots may transfer; never let the main thread detach v86 WASM memory.
          // Use one native copy for contiguous rows; skip DirectDraw pitch padding per row for odd widths.
          const size = surface.width * surface.height * 2;
          const rgb565 = new Uint16Array(this.options.takeFrameBuffer?.(size) ?? new ArrayBuffer(size));
          const target = new Uint8Array(rgb565.buffer);
          const source = this.memory.read_memory(surface.pixels, surface.pitch * surface.height);
          const rowBytes = surface.width * 2;
          if (rowBytes === surface.pitch) target.set(source);
          else
            for (let y = 0; y < surface.height; y++) {
              target.set(source.subarray(y * surface.pitch, y * surface.pitch + rowBytes), y * rowBytes);
            }
          return {
            width: surface.width,
            height: surface.height,
            pixels: new Uint8Array(0),
            palette: new Uint8Array(0),
            rgb565,
          };
        }
        const size = surface.width * surface.height * 4;
        const rgba = new Uint8Array(this.options.takeFrameBuffer?.(size) ?? new ArrayBuffer(size));
        const pixels = this.memory.read_memory(surface.pixels, surface.pitch * surface.height);
        // Read 16-bit sources through Uint16 views when aligned, avoiding two byte reads and shifts per pixel.
        const pixels16 =
          (pixels.byteOffset & 1) === 0 && (surface.pitch & 1) === 0
            ? new Uint16Array(pixels.buffer, pixels.byteOffset, (surface.pitch * surface.height) >>> 1)
            : null;
        // rgba is newly allocated with byteOffset=0, so write directly through a 32-bit view.
        const target32 = new Uint32Array(rgba.buffer);
        const pitch16 = surface.pitch >>> 1;
        // Move alignment checks outside the million-pixel loop; still skip row padding using pitch.
        if (pixels16) {
          let target = 0;
          for (let y = 0; y < surface.height; y++) {
            const end = y * pitch16 + surface.width;
            for (let source = y * pitch16; source < end; source++) {
              target32[target++] = RGB565_TO_RGBA32[pixels16[source]!]!;
            }
          }
        } else {
          let target = 0;
          for (let y = 0; y < surface.height; y++) {
            const sourceRow = y * surface.pitch;
            for (let x = 0; x < surface.width; x++) {
              const offset = sourceRow + x * 2;
              const rgb565 = pixels[offset]! | (pixels[offset + 1]! << 8);
              target32[target++] = RGB565_TO_RGBA32[rgb565]!;
            }
          }
        }
        // Store standard USER32 controls in an independent RGBA layer instead of writing them into
        // guest DirectDraw surfaces, but compose them onto the final snapshot. USER32 filters hidden controls,
        // so temporary Campaign-initialization ListBoxes leave no
        // placeholder red borders.
        this.compositeWindowControls(rgba, surface.width, surface.height);
        return {
          width: surface.width,
          height: surface.height,
          pixels: new Uint8Array(0),
          palette: new Uint8Array(0),
          rgba,
        };
      }
      const packed = new Uint8Array(surface.width * surface.height);
      const source = this.memory.read_memory(surface.pixels, surface.pitch * surface.height);
      if (surface.pitch === surface.width) {
        packed.set(source);
      } else {
        for (let y = 0; y < surface.height; y++) {
          packed.set(source.subarray(y * surface.pitch, y * surface.pitch + surface.width), y * surface.width);
        }
      }
      const palette = this.palettes.get(surface.palette)?.entries ?? new Uint8Array(256 * 4);
      return { width: surface.width, height: surface.height, pixels: packed, palette: palette.slice() };
    }

    protected captureFrame(surface: SurfaceState): void {
      const frame = this.snapshotFrame(surface);
      if (frame) this.options.onFrame!(frame);
    }
  };
}
