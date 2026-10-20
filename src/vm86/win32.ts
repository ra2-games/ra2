import { dispatchProcessApi } from './shim/processApi';
import type { GuestProcessContext, GuestProcessRequest } from './processKernel';
/** Host network status; a live connection does not establish guest-game synchronization. */
export interface VmNetworkStatus {
  phase: 'connecting' | 'connected' | 'disconnected' | 'error';
  room: string;
  peers: number;
  detail: string;
  relayRttMs?: number;
}

import {
  makeConstantImportStub,
  makeFirstArgImportStub,
  makeImportStub,
  HYPERCALL_QPC_HIGH,
  HYPERCALL_QPC_LOW,
  HYPERCALL_LAST_ERROR,
  HYPERCALL_CURSOR_COUNT,
  HYPERCALL_CURSOR_X,
  HYPERCALL_CURSOR_Y,
  HYPERCALL_PEEK_BUDGET,
  HYPERCALL_THREAD_CURRENT,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_WINDOW_EXSTYLE,
  GUEST_WINDOW_EXTRA0,
  GUEST_WINDOW_HEIGHT,
  GUEST_WINDOW_ID,
  GUEST_WINDOW_PARENT,
  GUEST_WINDOW_STYLE,
  GUEST_WINDOW_OWNER,
  GUEST_WINDOW_TABLE,
  GUEST_WINDOW_TABLE_MAX,
  GUEST_WINDOW_USERDATA,
  GUEST_WINDOW_VALID,
  GUEST_WINDOW_WIDTH,
  GUEST_WINDOW_WNDPROC,
  GUEST_WINDOW_X,
  GUEST_WINDOW_Y,
  type ImportArgBytes,
  type ImportStubFactory,
  type PeImport,
} from './pe';
import { type PcmPlayOptions, type PcmWaveFormat } from './audio';
import type { DplayTransportFactory } from './shim/dplayTransport';
import type { GameShimProfile } from './shim/gameProfile';

/** Minimal v86 interface to guest physical memory. */
export interface GuestMemory {
  read_memory(offset: number, length: number): Uint8Array;
  write_memory(bytes: Uint8Array | number[], offset: number): void;
}

export interface Win32Result {
  createProcess?: GuestProcessRequest;
  debugWait?: { address: number; timeout: number };
  eax: number;
  edx?: number;
  /** Host suspension duration before waking the guest for APIs such as WaitMessage. */
  delayMs?: number;
  /** ExitProcess/ExitThread and similar calls may request host shutdown. */
  exit?: boolean;
  /** Terminate only the current guest thread; the scheduler resumes others. */
  threadExit?: boolean;
}

export interface Win32Call {
  imported: PeImport;
  stack: number;
  args: number[];
}

export interface VmFrame {
  width: number;
  height: number;
  /** Indexes for 8-bit palette mode; empty for RGB565. */
  pixels: Uint8Array;
  /** DirectDraw PALETTEENTRY: red/green/blue/flags per entry. */
  palette: Uint8Array;
  /** Browser-native RGBA converted from 16-bit RGB565 surfaces. */
  rgba?: Uint8Array;
  /** Compact RGB565 when host controls need no composition; no row padding, allowing direct integer-texture upload. */
  rgb565?: Uint16Array;
  /** Independent small Win32 cursor texture; the host moves it without retransmitting the full framebuffer. */
  cursor?: {
    handle: number;
    width: number;
    height: number;
    hotspotX: number;
    hotspotY: number;
    x: number;
    y: number;
    rgba: Uint8Array;
  };
}

export interface VmSurfaceSnapshot {
  object: number;
  width: number;
  height: number;
  pitch: number;
  bpp: number;
  pixels: Uint8Array;
}

export interface VmGdiDcSnapshot {
  surface: number;
  textColor: number;
  paletteIndex: number;
  paletteColor: [number, number, number];
}

export interface VmHeapState {
  liveAllocations: number;
  liveBytes: number;
  freeBlocks: number;
  freeBytes: number;
  nextAddress: number;
  peakAddress: number;
  /** VirtualAlloc reservations disjoint from the heap; MEM_DECOMMIT retains reservations. */
  virtualRegions: number;
  virtualBytes: number;
  /** Bytes returned by MEM_RELEASE and available for later VirtualAlloc reuse. */
  virtualFreeBytes: number;
}

export interface VmCallbackState {
  hwnd: number;
  message: number;
  callback: number;
  callStack: number;
  originalReturn: number;
  trampoline: number;
  depth: number;
}

export interface Win32ShimOptions {
  processContext?: GuestProcessContext;
  /** First dynamic COM hypercall ID after static PE imports. */
  firstDynamicId?: number;
  /** Main-module static IAT; temporarily connect frequent exports directly while native guest DLLs are active, avoiding serial IRQ round trips. */
  staticImports?: readonly PeImport[];
  onFrame?: (frame: VmFrame) => void;
  /** The guest completed one DirectDraw vertical-sync cycle, corresponding to a native main-loop frame. */
  onLogicFrame?: () => void;
  /** Coalesce frequent primary-surface updates into the next host drawing opportunity. */
  scheduleFrame?: (emit: () => void) => void;
  /** Workers snapshot only with mailbox send capacity; the main-thread path snapshots on emit. */
  deferFrameSnapshot?: boolean;
  /** When presentation supports RGB565, avoid expanding the entire frame to RGBA on the VM thread. */
  packedRgb565Frames?: boolean;
  /** Independent presentation-buffer pool; return exact sizes without sharing guest memory. */
  takeFrameBuffer?: (size: number) => ArrayBuffer;
  /** Explicit game compatibility capabilities; empty by default, enabling no game-specific addresses or patches. */
  gameProfile?: GameShimProfile;
  /** Synchronous guest files fetched from /game before startup. */
  files?: ReadonlyMap<string, Uint8Array>;
  /** Optional host PCM output; Node smoke tests without it retain complete DirectSound state. */
  audio?: Win32AudioSink;
  /** DirectPlay transport factory; browsers default to WebSocket, while Node regressions may inject BroadcastChannel explicitly. */
  dplayTransportFactory?: DplayTransportFactory;
  /** Synchronous browser font rasterizer; text ultimately writes to guest 8-bit DirectDraw surfaces. */
  textRasterizer?: Win32TextRasterizer;
  /** Notify the host to persist on writable-file close or explicit flush; bytes is an independent snapshot. */
  onFileWrite?: (path: string, bytes: Uint8Array) => void;
  /** Actual physical RAM bound for PE DLL placement; supplied by the VM owner. */
  guestMemoryBytes?: number;
  /** Actual executable name exposed by guest GetCommandLine/GetModuleFileName. */
  moduleName?: string;
  /** GetCommandLineA argument suffix, independent of the module path and never affecting GetModuleFileNameA. */
  commandLineArguments?: string;
  /** Virtual Win32 drive types; defaults to only the installation's fixed C: drive. */
  driveTypes?: Readonly<Record<string, number>>;
  /** Volume serial reported by GetVolumeInformationA; default 0x20010701, injected in Node through VM_SERIAL. */
  volumeSerial?: number;
  /** Enable fast guest _lread stubs: mirror files on open, demote on write, and return heap memory on close. */
  enableFastFileMirror?: boolean;
  /** Total mirror budget, default 48MB; with persistent regions, usually use their actual size. */
  fastFileMirrorLimit?: number;
  /** Persistent region for large read-only mirrors, cached by path and reused across handles outside the game heap. */
  fastFileMirrorBase?: number;
  fastFileMirrorTop?: number;
  /** When configured, only listed normalized paths enter the persistent mirror region. */
  fastFileMirrorFiles?: readonly string[];
  /** Upper bound for top-down VirtualAlloc(NULL) reservations; defaults to the heap limit. */
  virtualTop?: number;
  /** Lowest legal fixed VirtualAlloc address; default 0x4be000 after the original image. */
  virtualBase?: number;
  /**
   * Arena top for heap bumps and fixed-address VirtualAlloc, default 0x7e00000.
   * Separate from virtualTop: smoke tests lower virtualTop to 8MB to verify heap growth past reservations, while the heap must still reach the real arena top.
   */
  heapTop?: number;
  /** Shim heap start, default 0x700000; must follow the PE image and main-thread stack. */
  heapBase?: number;
  /** Static-import ABI lookup for dynamically loaded guest DLLs. */
  importArgBytes?: ImportArgBytes;
  /** Import-stub factory for dynamic guest DLLs; use the main PE's fast-path configuration. */
  dynamicImportStub?: ImportStubFactory;
}

/** GetDriveTypeA drive type from the Win32 DRIVE_* values used here. */

export interface Win32AudioSink {
  createBuffer(id: number, byteLength: number, format: PcmWaveFormat): void;
  duplicateBuffer(sourceId: number, destinationId: number): boolean;
  setFormat(id: number, format: PcmWaveFormat): boolean;
  writeBuffer(id: number, offset: number, bytes: Uint8Array): number;
  play(id: number, options?: PcmPlayOptions): boolean;
  stop(id: number): boolean;
  setCurrentPosition(id: number, byteOffset: number): boolean;
  setVolume(id: number, volume: number): boolean;
  setPan(id: number, pan: number): boolean;
  setFrequency(id: number, frequency: number): boolean;
  getState(id: number): { positionBytes: number; writePositionBytes?: number; playing: boolean } | null;
  releaseBuffer(id: number): boolean;
}

export interface VmGdiFont {
  height: number;
  width: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  charset: number;
  faceName: string;
}

export interface VmTextBitmap {
  width: number;
  height: number;
  /** 0..255 glyph coverage, tightly packed by row. */
  alpha: Uint8Array;
  /**
   * Neutral coverage-bias point, default 128. The shim computes coverage + (128 - threshold); lower thresholds thicken and higher ones thin strokes.
   */
  threshold?: number;
  /** Actual CSS font family used for rasterization, for diagnostics. */
  family?: string;
}

export interface Win32TextRasterizer {
  rasterize(text: string, font: VmGdiFont): VmTextBitmap | null;
}

export interface SurfaceState {
  object: number;
  width: number;
  height: number;
  pitch: number;
  bpp: number;
  pixels: number;
  caps: number;
  palette: number;
  attached: number;
  sourceColorKey: [number, number] | null;
  destinationColorKey: [number, number] | null;
  /** GDI glyphs retain COLORREF so palette changes can remap them without changing color. */
  textRuns: GdiTextRun[];
  /** Global increasing sequence number of the latest Unlock/Blt/BltFast, selecting the newest layer among equal-sized work surfaces. */
  lastDrawSerial: number;
  /**
   * Whether pixels changed since the last emit, set by Blt/Lock/Flip/GDI/palette changes. Blt plus two vblanks can emit three times per game frame; duplicate unchanged snapshots waste three 480KB allocations plus cross-thread messages, causing periodic GC stalls at 60fps.
   */
  dirty: boolean;
}

export interface MciWindowState {
  parent: number;
  playing: boolean;
}

export interface PaletteState {
  object: number;
  caps: number;
  entries: Uint8Array;
}

export interface SoundBufferState {
  object: number;
  data: number;
  size: number;
  /** Host monotonic anchor corresponding to position, estimating playback cursors when Workers cannot synchronously read WebAudio. */
  startedAt: number;
  position: number;
  playing: boolean;
  looping: boolean;
  format: PcmWaveFormat;
  volume: number;
  pan: number;
  frequency: number;
}

export interface GdiDcState {
  surface: number;
  /** Window DC client origin relative to the DirectDraw primary surface; surface DCs use 0,0. */
  originX: number;
  originY: number;
  selectedFont: number;
  selectedBrush: number;
  textColor: number;
  backgroundMode: number;
  backgroundColor: number;
}

/**
 * Pixels changed by antialiased text: offset is relative to the run rectangle with surface-pitch rows; original stores the previous background index, written the blended index. On palette changes, restore background and reblend for idempotent remapping.
 */
export interface GdiTextPixelChange {
  offset: number;
  original: number;
  written: number;
}

export interface GdiTextRun {
  x: number;
  y: number;
  bitmap: VmTextBitmap;
  colorRef: number;
  paletteIndex: number;
  /** null means the record limit was exceeded; fall back to solid-only remapping without correcting blended edges after palette changes. */
  changed: GdiTextPixelChange[] | null;
}

export interface FileState {
  path: string;
  /** Capacity may exceed size to avoid copying entire files on small appends. */
  bytes: Uint8Array;
  size: number;
  position: number;
  writable: boolean;
  dirty: boolean;
  /** Guest mirror of a read-only file, copied directly by fast _lread stubs. */
  mirror?: number;
  /** Points into a separate persistent mirror region; never free it as an ordinary heap block on handle close. */
  sharedMirror?: boolean;
}

export interface MmioState {
  path: string;
  bytes: Uint8Array;
  position: number;
}

export interface TimerState {
  hwnd: number;
  id: number;
  interval: number;
  callback: number;
  next: number;
}

export interface MultimediaTimerState {
  id: number;
  interval: number;
  callback: number;
  user: number;
  periodic: boolean;
  next: number;
}

export interface MessageState {
  hwnd: number;
  message: number;
  wParam: number;
  lParam: number;
  time: number;
  x: number;
  y: number;
  /** Left/right Shift/Ctrl snapshot at mouse-message enqueue time, preserving physical-key timelines in asynchronous queues. */
  modifierKeyState?: number;
}

import {
  FAST_FILE_HANDLE_BASE,
  FAST_FILE_TABLE,
  FAST_FILE_TABLE_ENTRIES,
  FAST_TLS_ENTRIES,
  FAST_TLS_TABLE,
  ShimState,
  shimTraceEnabled,
} from './shim/state';
import { withShimFiles } from './shim/stateFiles';
import { withShimGuestDll } from './shim/stateGuestDll';
import { withShimSync } from './shim/stateSync';
import { withShimGraphics } from './shim/stateGraphics';
import { withKernel32 } from './shim/kernel32';
import { withMsvcrt } from './shim/msvcrt';
import { withUser32 } from './shim/user32';
import { withGdi32 } from './shim/gdi32';
import { withWinmm } from './shim/winmm';
import { withDirectx } from './shim/directx';
import { withDplayx } from './shim/dplayx';
import { withOle32 } from './shim/ole32';
export {
  decodeGuestNarrow,
  win32ModuleOf,
  WIN32_ADVAPI32,
  WIN32_DDRAW,
  WIN32_DDRAW_COM,
  WIN32_DPLAYX,
  WIN32_DPLAYX_COM,
  WIN32_DSOUND,
  WIN32_DSOUND_COM,
  WIN32_GDI32,
  WIN32_KERNEL32,
  WIN32_MSVFW32,
  WIN32_OLE32,
  WIN32_USER32,
  WIN32_WINMM,
  WIN32_WSOCK32,
} from './shim/text';
import {
  win32ModuleOf,
  WIN32_ADVAPI32,
  WIN32_DDRAW,
  WIN32_DDRAW_COM,
  WIN32_DPLAYX,
  WIN32_DPLAYX_COM,
  WIN32_DSOUND,
  WIN32_DSOUND_COM,
  WIN32_GDI32,
  WIN32_KERNEL32,
  WIN32_MSVFW32,
  WIN32_OLE32,
  WIN32_USER32,
  WIN32_WINMM,
  WIN32_WSOCK32,
} from './shim/text';
export { DRIVE_CDROM, DRIVE_FIXED, DRIVE_NO_ROOT_DIR } from './shim/state';
export type { PeImport } from './pe';

/** Generic Win32 facade; games/win32Shim.ts composes game extensions outside it. */
const CommonWin32Shim = withOle32(
  withDplayx(
    withDirectx(
      withWinmm(
        withUser32(
          withGdi32(
            withMsvcrt(withKernel32(withShimGraphics(withShimSync(withShimGuestDll(withShimFiles(ShimState)))))),
          ),
        ),
      ),
    ),
  ),
);

export class Win32ShimBase extends CommonWin32Shim {
  synchronizeProcessMemory(): void {
    const context = this.options.processContext;
    if (context) context.kernel.synchronize(context.pid);
  }
  allocateProcessMemory(address: number, size: number): number {
    return this.virtualAlloc(address, size);
  }
  freeProcessMemory(address: number): boolean {
    return this.virtualFree(address, 0, 0x8000);
  }
  completeProcessCreation(pointer: number, values: readonly number[] | null, error = 0): void {
    this.lastError = error;
    if (values) values.forEach((value, index) => this.writeU32(pointer + index * 4, value));
  }
  dispatch(call: Win32Call): Win32Result | null {
    const context = this.options.processContext;
    if (context) {
      this.synchronizeProcessMemory();
      const result = dispatchProcessApi(
        context,
        {
          memory: this.memory,
          read: (p) => this.readU32(p),
          string: (p) => this.readCString(p),
          alloc: (size) => this.alloc(size, true),
          free: (p) => {
            this.freeAllocation(p);
          },
          error: (code) => {
            this.lastError = code;
          },
          localThread: this.readU32(HYPERCALL_THREAD_CURRENT),
        },
        call.imported.key,
        call.args,
      );
      if (result) return result;
    }
    if (call.imported.dll.toUpperCase() === 'MSVCRT.DLL') return this.dispatchMsvcrt(call);
    this.flushDestroyedWindows();
    const exclusive = this.dispatchExclusive(call);
    if (exclusive) return exclusive;
    const { key, name } = call.imported;
    const a = call.args;
    // Register game-specific successful short circuits in profiles; unknown games still stop at boundaries even with same-named DLL imports.
    if (key.startsWith('OLEAUT32.DLL!')) {
      switch (key) {
        case 'OLEAUT32.DLL!ord8': // VariantInit
          if (a[0]) this.zero(a[0], 16);
          return { eax: 0 };
        case 'OLEAUT32.DLL!ord9':
          return { eax: 0 }; // VariantClear
        case 'OLEAUT32.DLL!ord161': // LoadTypeLib: RA2 optional Automation metadata is absent.
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: 0x8002_9c4a }; // TYPE_E_CANTLOADLIBRARY
        case 'OLEAUT32.DLL!ord200': // GetErrorInfo
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: 1 }; // S_FALSE
        case 'OLEAUT32.DLL!ord201':
          return { eax: 0 }; // SetErrorInfo
        case 'OLEAUT32.DLL!ord33': // RegisterActiveObject
          if (a[3]) this.writeU32(a[3], 1);
          return { eax: 0 };
        case 'OLEAUT32.DLL!ord34':
          return { eax: 0 }; // RevokeActiveObject
        default:
          return { eax: 0x8000_4001 }; // E_NOTIMPL
      }
    }
    if (key === 'COMCTL32.DLL!DllGetVersion') {
      const info = a[0] ?? 0;
      if (!info || this.readU32(info) < 20) return { eax: 0x8000_4003 };
      this.writeU32(info + 4, 5);
      this.writeU32(info + 8, 81);
      this.writeU32(info + 12, 4916);
      this.writeU32(info + 16, 1); // DLLVER_PLATFORM_WINDOWS
      return { eax: 0 };
    }
    if (key.startsWith('COMCTL32.DLL!')) {
      switch (key) {
        case 'COMCTL32.DLL!ord17':
        case 'COMCTL32.DLL!ImageList_EndDrag':
          return { eax: 0 };
        case 'COMCTL32.DLL!ImageList_Destroy':
        case 'COMCTL32.DLL!ImageList_DragShowNolock':
        case 'COMCTL32.DLL!ImageList_DragMove':
        case 'COMCTL32.DLL!ImageList_DragEnter':
        case 'COMCTL32.DLL!ImageList_BeginDrag':
          return { eax: 1 };
      }
    }
    if (key.startsWith('IMM32.DLL!')) {
      switch (key) {
        // The shim creates no IME context; disabling window IME returns the previously empty HIMC.
        case 'IMM32.DLL!ImmAssociateContext':
        case 'IMM32.DLL!ImmGetContext':
          return { eax: 0 };
        case 'IMM32.DLL!ImmGetCompositionStringA':
          return { eax: 0xffff_ffff };
        case 'IMM32.DLL!ImmGetCandidateListA':
          return { eax: 0 };
        case 'IMM32.DLL!ImmSetOpenStatus':
        case 'IMM32.DLL!ImmNotifyIME':
          return { eax: 1 };
      }
    }
    // annotateWin32Modules precomputes numeric tags at load time; handcrafted smoke imports use string fallback.
    const module = call.imported.win32Module ?? win32ModuleOf(call.imported.dll);
    switch (module) {
      case WIN32_DDRAW_COM:
        return this.dispatchDirectDraw(call);
      case WIN32_DSOUND_COM:
        return this.dispatchDirectSound(call);
      case WIN32_KERNEL32:
        return this.dispatchKernel32(call, key, name, a);
      case WIN32_USER32:
        return this.dispatchUser32(call, key, name, a);
      case WIN32_GDI32:
        return this.dispatchGdi32(key, name, a);
      case WIN32_WINMM:
      case WIN32_ADVAPI32:
      case WIN32_MSVFW32:
        return this.dispatchWinmm(call, key, name, a);
      case WIN32_DDRAW:
      case WIN32_DSOUND:
        return this.dispatchDirectx(key, name, a);
      case WIN32_OLE32:
        return this.dispatchOle32(call, key, name, a);
      case WIN32_DPLAYX_COM:
        return this.dispatchDPlay(call);
      case WIN32_DPLAYX:
        return this.dispatchDplayx(key, name, a);
      case WIN32_WSOCK32: {
        if (name === 'inet_addr') {
          // Winsock accepts one to four decimal, octal, or hexadecimal parts.
          const parts = this.readCString(a[0] ?? 0)
            .trim()
            .split('.');
          const numbers = parts.map((part) => {
            if (/^0x[\da-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
            if (/^0[0-7]*$/.test(part)) return Number.parseInt(part || '0', 8);
            if (/^[1-9]\d*$/.test(part)) return Number(part);
            return NaN;
          });
          if (numbers.length < 1 || numbers.length > 4 || numbers.some((value) => !Number.isSafeInteger(value)))
            return { eax: 0xffffffff };
          let address = 0;
          for (let i = 0; i < numbers.length; i++) {
            const remaining = i === numbers.length - 1 ? 5 - numbers.length : 1;
            const value = numbers[i]!;
            if (value < 0 || value >= 256 ** remaining) return { eax: 0xffffffff };
            address = address * 256 ** remaining + value;
          }
          return {
            eax: ((address >>> 24) | ((address >>> 8) & 0xff00) | ((address << 8) & 0xff0000) | (address << 24)) >>> 0,
          };
        }
        if (shimTraceEnabled('VM_TRACE_WINSOCK')) {
          console.log(`🌐 ${key}(${a.map((v) => `0x${(v >>> 0).toString(16)}`).join(',')})`);
        }
        return this.dispatchGameWinsock(key, a);
      }
      default:
        return null;
    }
  }
  dispose(): void {
    this.registry.dispose();
    this.disposeDplayTransport();
    this.disposeGameNetwork();
    // The guest may still hold handles on page exit; submit dirty files once more.
    for (const file of this.fileHandles.values()) this.flushFile(file);
    this.disposed = true;
    this.frameScheduled = false;
  }
  /** Debug the actual 8-bit index selected for a COLORREF on the current offscreen surface. */
  inspectGdiDc(handle: number): VmGdiDcSnapshot | null {
    const dc = this.gdiDcs.get(handle);
    const surface = dc ? this.surfaces.get(dc.surface) : undefined;
    if (!dc || !surface) return null;
    const palette = this.paletteForSurface(surface);
    const paletteIndex = this.nearestPaletteIndex(palette, dc.textColor);
    const offset = paletteIndex * 4;
    return {
      surface: surface.object,
      textColor: dc.textColor,
      paletteIndex,
      paletteColor: [palette[offset] ?? 0, palette[offset + 1] ?? 0, palette[offset + 2] ?? 0],
    };
  }
}

/** Constant imports that may return directly in the guest; this selects fast-stub behavior without registering game ABI. */
const FAST_CONSTANT_IMPORTS: Readonly<Record<string, number>> = {
  // These functions have no host side effects in the current shim and may return constants in the guest.
  'KERNEL32.DLL!DeleteCriticalSection': 0,
  'KERNEL32.DLL!GlobalUnlock': 1,
  // The host branches for these three always report valid pointers. RA2 battlefield loading repeats them
  // hundreds of times per second on the same object arrays; direct guest returns avoid pointless serial/IRQ crossings.
  'KERNEL32.DLL!IsBadCodePtr': 0,
  'KERNEL32.DLL!IsBadReadPtr': 0,
  'KERNEL32.DLL!IsBadWritePtr': 0,
  'USER32.DLL!TranslateMessage': 1,
  // No dialog-manager work is performed by this in-guest constant stub.
  // TRUE would tell the caller that the MSG was already dispatched and makes
  // RA2 swallow every shell WM_PAINT/WM_TIMER before DispatchMessageA.
  'USER32.DLL!IsDialogMessageA': 0,
  // DefWindowProcA cannot use a constant stub: WndProc delegates WM_CLOSE to it,
  // and the shim performs DestroyWindow -> WM_DESTROY -> PostQuitMessage.
  // Inlining ret 0 would prevent that exit chain and all other real DefWindowProc semantics.
  'DDRAW.COM!IDirectDraw.WaitForVerticalBlank': 0,
  'DDRAW.COM!IDirectDrawSurface.GetBltStatus': 0,
  'DDRAW.COM!IDirectDrawSurface.GetFlipStatus': 0,
  'DDRAW.COM!IDirectDrawSurface.IsLost': 0,
  'DDRAW.COM!IDirectDrawSurface.Restore': 0,
};

const FAST_FIRST_ARG_IMPORTS = new Set([
  'KERNEL32.DLL!GlobalHandle',
  'KERNEL32.DLL!GlobalLock',
  'USER32.DLL!SetCursor',
]);

/** Execute equivalent side-effect-free APIs in the guest to avoid tens of thousands of VM/JS round trips during map loading. */
export function makeWin32ImportStub(dll: string, name: string, id: number, argBytes: number): Uint8Array {
  const key = `${dll.toUpperCase()}!${name}`;
  if (key === 'KERNEL32.DLL!Sleep') return makeFastSleepStub(id, argBytes);
  if (key === 'USER32.DLL!PeekMessageA') return makeFastPeekMessageStub(id, argBytes);
  if (key === 'USER32.DLL!GetCursorPos') return makeFastGetCursorPosStub(argBytes);
  // Read-only window geometry/property queries use GUEST_WINDOW_TABLE mirrors; invalid/unknown entries fall back to hypercalls.
  if (key === 'USER32.DLL!GetClientRect') return makeFastGetClientRectStub(id, argBytes);
  if (key === 'USER32.DLL!GetWindowRect') return makeFastGetWindowRectStub(id, argBytes);
  if (key === 'USER32.DLL!ClientToScreen') return makeFastClientToScreenStub(id, argBytes);
  if (key === 'USER32.DLL!GetParent') return makeFastGetParentStub(id, argBytes);
  if (key === 'USER32.DLL!GetWindowLongA') return makeFastGetWindowLongStub(id, argBytes);
  return makeImportStub(id, argBytes);
}

/** Experimental fast _lread stub; disabled by default and requiring separate complete-level regressions. */
export function makeWin32ImportStubWithFastRead(dll: string, name: string, id: number, argBytes: number): Uint8Array {
  const key = `${dll.toUpperCase()}!${name}`;
  if (key === 'KERNEL32.DLL!Sleep') return makeFastSleepStub(id, argBytes);
  if (key === 'KERNEL32.DLL!_lread') return makeFastLegacyReadStub(id, argBytes);
  if (key === 'KERNEL32.DLL!ReadFile') return makeFastReadFileStub(id, argBytes);
  if (key === 'KERNEL32.DLL!SetFilePointer') return makeFastSetFilePointerStub(id, argBytes);
  if (key === 'KERNEL32.DLL!QueryPerformanceFrequency') return makeFastPerformanceFrequencyStub(argBytes);
  if (key === 'KERNEL32.DLL!QueryPerformanceCounter') return makeFastPerformanceCounterStub(argBytes);
  if (key === 'KERNEL32.DLL!GetLastError') return makeFastGetLastErrorStub(argBytes);
  if (key === 'KERNEL32.DLL!SetLastError') return makeFastSetLastErrorStub(argBytes);
  if (key === 'KERNEL32.DLL!TlsGetValue') return makeFastTlsGetValueStub(id, argBytes);
  if (
    key === 'KERNEL32.DLL!InitializeCriticalSection' ||
    key === 'KERNEL32.DLL!DeleteCriticalSection' ||
    key === 'KERNEL32.DLL!EnterCriticalSection' ||
    key === 'KERNEL32.DLL!LeaveCriticalSection'
  )
    return makeFastCriticalSectionStub(name, id, argBytes);
  if (key === 'USER32.DLL!ShowCursor') return makeFastShowCursorStub(argBytes);
  if (key === 'KERNEL32.DLL!InterlockedIncrement') return makeFastInterlockedStub(argBytes, 1);
  if (key === 'KERNEL32.DLL!InterlockedDecrement') return makeFastInterlockedStub(argBytes, -1);
  if (key === 'USER32.DLL!SetRect') return makeFastSetRectStub(argBytes);
  const constant = FAST_CONSTANT_IMPORTS[key];
  if (constant !== undefined) return makeConstantImportStub(constant, argBytes);
  if (FAST_FIRST_ARG_IMPORTS.has(key)) return makeFirstArgImportStub(argBytes);
  return makeWin32ImportStub(dll, name, id, argBytes);
}

/**
 * ShowCursor maintains the Win32 display count: increment on show, decrement on hide, and return the new value. A constant stub is invalid: RA2 loops while (ShowCursor(FALSE) >= 0); during loading, so constant 0 never reaches <0 and hangs at PLEASE STAND BY. Keep the counter on the shared guest page so frequent menu-hover calls need no JS crossing.
 */
function makeFastShowCursorStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const count = HYPERCALL_CURSOR_COUNT;
  const countBytes = () => emit32(count);
  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4]: show flag.
  code.push(0x85, 0xc0); // test eax, eax
  code.push(0x74, 0x0e); // jz hide
  code.push(0xff, 0x05);
  countBytes(); // inc dword [count]
  code.push(0xa1);
  countBytes(); // mov eax, [count]
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  // hide:
  code.push(0xff, 0x0d);
  countBytes(); // dec dword [count]
  code.push(0xa1);
  countBytes(); // mov eax, [count]
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  return new Uint8Array(code);
}

/**
 * Throttled PeekMessageA fast path for empty queues. The host clears the shared budget when messages arrive, timers exist, or the budget expires. Other calls decrement it and return FALSE, periodically revisiting the host to avoid state starvation.
 */
function makeFastPeekMessageStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  code.push(0xa1);
  emit32(HYPERCALL_PEEK_BUDGET); // mov eax, [budget]
  code.push(0x85, 0xc0); // test eax, eax
  code.push(0x0f, 0x84, 0, 0, 0, 0); // jz fallback
  const fallbackPatch = code.length - 4;
  code.push(0x48); // dec eax
  code.push(0xa3);
  emit32(HYPERCALL_PEEK_BUDGET); // mov [budget], eax
  code.push(0x31, 0xc0); // xor eax, eax（FALSE）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  const relative = fallback - (fallbackPatch + 4);
  code[fallbackPatch] = relative & 0xff;
  code[fallbackPatch + 1] = (relative >>> 8) & 0xff;
  code[fallbackPatch + 2] = (relative >>> 16) & 0xff;
  code[fallbackPatch + 3] = (relative >>> 24) & 0xff;
  return new Uint8Array(code);
}

/** GetCursorPos directly reads the shared coordinate mirror updated by the host. */
function makeFastGetCursorPosStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（POINT*）
  code.push(0x85, 0xc9); // test ecx, ecx
  const nullJump = code.length;
  code.push(0x74, 0x00); // jz success (preserve existing shim semantics)
  code.push(0xa1);
  emit32(HYPERCALL_CURSOR_X); // mov eax, [cursorX]
  code.push(0x89, 0x01); // mov [ecx], eax
  code.push(0xa1);
  emit32(HYPERCALL_CURSOR_Y); // mov eax, [cursorY]
  code.push(0x89, 0x41, 0x04); // mov [ecx + 4], eax
  const success = code.length;
  code[nullJump + 1] = (success - (nullJump + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, TRUE
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  return new Uint8Array(code);
}

/**
 * COM reference counting calls InterlockedIncrement/Decrement frequently in the battle rendering loop.
 * A single lock xadd performs read-modify-write atomically for a single-CPU guest (PIT cannot preempt an instruction). EAX receives the old value; adding/subtracting 1 yields the return value, matching host semantics without crossing into JS.
 */
function makeFastInterlockedStub(argBytes: number, delta: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（ptr）
  code.push(0xb8);
  emit32(delta >>> 0); // mov eax, delta
  code.push(0xf0, 0x0f, 0xc1, 0x01); // lock xadd [ecx], eax (eax = old value, [ecx] += delta)
  code.push(delta > 0 ? 0x40 : 0x48); // inc/dec eax -> new value
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  return new Uint8Array(code);
}

/**
 * SetRect is frequently called during layout and hit testing. It writes four integers to the guest RECT and has no host state.
 */
function makeFastSetRectStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（rect）
  code.push(0x85, 0xc9); // test ecx, ecx
  code.push(0x74, 0x1b); // jz done (skip writes when rect == 0; offset spans the 27-byte write sequence)
  code.push(0x8b, 0x44, 0x24, 0x08); // mov eax, [esp + 8]（left）
  code.push(0x89, 0x01); // mov [ecx], eax
  code.push(0x8b, 0x44, 0x24, 0x0c); // mov eax, [esp + 0xc]（top）
  code.push(0x89, 0x41, 0x04); // mov [ecx + 4], eax
  code.push(0x8b, 0x44, 0x24, 0x10); // mov eax, [esp + 0x10]（right）
  code.push(0x89, 0x41, 0x08); // mov [ecx + 8], eax
  code.push(0x8b, 0x44, 0x24, 0x14); // mov eax, [esp + 0x14]（bottom）
  code.push(0x89, 0x41, 0x0c); // mov [ecx + 0xc], eax
  // done:
  code.push(0xb8, 0x01, 0x00, 0x00, 0x00); // mov eax, 1（TRUE）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  return new Uint8Array(code);
}

// ===== Guest fast stubs for read-only window geometry/property queries =====
// GetClientRect/GetWindowRect/ClientToScreen/GetParent/GetWindowLongA are each called tens of thousands
// of times in RA2 menus and battle loops, making VM-to-JS crossings costly. The shim mirrors window
// geometry (absolute screen coordinates) and common properties into GUEST_WINDOW_TABLE for direct reads.
// Out-of-range, unsynchronized, or unknown indices fall back to the full hypercall (makeImportStub) to preserve semantics.

/** Convert hwnd at [esp+4] to a table-entry address in ECX; jump to fallback if invalid (return patch positions). */
function emitWindowEntryPreamble(code: number[]): number[] {
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const patches: number[] = [];
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（hwnd）
  code.push(0x8b, 0xc1); // mov eax, ecx（保留 hwnd 供属主校验）
  code.push(0x81, 0xe9);
  emit32(0x2000); // sub ecx, 0x2000
  code.push(0x81, 0xe1);
  emit32(GUEST_WINDOW_TABLE_MAX - 1); // and ecx, MAX-1（表按 2 的幂环绕）
  code.push(0xc1, 0xe1, 0x06); // shl ecx, 6（×GUEST_WINDOW_ENTRY_BYTES=64）
  code.push(0x81, 0xc1);
  emit32(GUEST_WINDOW_TABLE); // add ecx, TABLE
  code.push(0x83, 0x79, GUEST_WINDOW_VALID, 0x00); // cmp dword [ecx + VALID], 0
  code.push(0x0f, 0x84);
  patches.push(code.length);
  emit32(0); // je fallback
  code.push(0x39, 0x41, GUEST_WINDOW_OWNER); // cmp [ecx + OWNER], eax
  code.push(0x0f, 0x85);
  patches.push(code.length);
  emit32(0); // jne fallback（环绕碰撞时回退到完整 hypercall）
  return patches;
}

/** Patch all rel32 fallback jumps to the fallback address. */
function patchWindowFallbackJumps(code: number[], patches: number[], fallback: number): void {
  for (const at of patches) {
    const relative = fallback - (at + 4);
    code[at] = relative & 0xff;
    code[at + 1] = (relative >>> 8) & 0xff;
    code[at + 2] = (relative >>> 16) & 0xff;
    code[at + 3] = (relative >>> 24) & 0xff;
  }
}

/** GetClientRect(hwnd, rect*): rect = (0, 0, width, height); always returns TRUE. */
function makeFastGetClientRectStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（rect）
  code.push(0x85, 0xd2); // test edx, edx
  const jzRet = code.length;
  code.push(0x74, 0x00); // jz ret1 (only return when rect == 0)
  code.push(0xc7, 0x02, 0, 0, 0, 0); // mov dword [edx], 0（left）
  code.push(0xc7, 0x42, 0x04, 0, 0, 0, 0); // mov dword [edx + 4], 0（top）
  code.push(0x8b, 0x41, GUEST_WINDOW_WIDTH); // mov eax, [ecx + WIDTH]
  code.push(0x89, 0x42, 0x08); // mov [edx + 8], eax（right）
  code.push(0x8b, 0x41, GUEST_WINDOW_HEIGHT); // mov eax, [ecx + HEIGHT]
  code.push(0x89, 0x42, 0x0c); // mov [edx + 12], eax（bottom）
  const ret1 = code.length;
  code[jzRet + 1] = (ret1 - (jzRet + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, 1
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/** GetWindowRect(hwnd, rect*): rect = (x, y, x+width, y+height) in absolute screen coordinates; returns TRUE. */
function makeFastGetWindowRectStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（rect）
  code.push(0x85, 0xd2); // test edx, edx
  const jzRet = code.length;
  code.push(0x74, 0x00); // jz ret1
  code.push(0x8b, 0x41, GUEST_WINDOW_X); // mov eax, [ecx + X]
  code.push(0x89, 0x02); // mov [edx], eax（left）
  code.push(0x8b, 0x41, GUEST_WINDOW_Y); // mov eax, [ecx + Y]
  code.push(0x89, 0x42, 0x04); // mov [edx + 4], eax（top）
  code.push(0x8b, 0x41, GUEST_WINDOW_X); // mov eax, [ecx + X]
  code.push(0x03, 0x41, GUEST_WINDOW_WIDTH); // add eax, [ecx + WIDTH]
  code.push(0x89, 0x42, 0x08); // mov [edx + 8], eax（right）
  code.push(0x8b, 0x41, GUEST_WINDOW_Y); // mov eax, [ecx + Y]
  code.push(0x03, 0x41, GUEST_WINDOW_HEIGHT); // add eax, [ecx + HEIGHT]
  code.push(0x89, 0x42, 0x0c); // mov [edx + 12], eax（bottom）
  const ret1 = code.length;
  code[jzRet + 1] = (ret1 - (jzRet + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, 1
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/** ClientToScreen(hwnd, point*): add the window's absolute screen origin to point; return TRUE. */
function makeFastClientToScreenStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（point）
  code.push(0x85, 0xd2); // test edx, edx
  const jzRet = code.length;
  code.push(0x74, 0x00); // jz ret1
  code.push(0x8b, 0x41, GUEST_WINDOW_X); // mov eax, [ecx + X]
  code.push(0x01, 0x02); // add [edx], eax（point.x += x）
  code.push(0x8b, 0x41, GUEST_WINDOW_Y); // mov eax, [ecx + Y]
  code.push(0x01, 0x42, 0x04); // add [edx + 4], eax（point.y += y）
  const ret1 = code.length;
  code[jzRet + 1] = (ret1 - (jzRet + 2)) & 0xff;
  code.push(0xb8, 1, 0, 0, 0); // mov eax, 1
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/** GetParent(hwnd): return the mirrored parent hwnd. */
function makeFastGetParentStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  code.push(0x8b, 0x41, GUEST_WINDOW_PARENT); // mov eax, [ecx + PARENT]
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff); // ret argBytes
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/**
 * GetWindowLongA(hwnd, index): mirror common indices: extra bytes 0/4/8/12, GWL_ID(-12), GWL_STYLE(-16), GWL_EXSTYLE(-20), GWL_WNDPROC(-4), and GWL_USERDATA(-21); fall back for all others.
 */
function makeFastGetWindowLongStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const patches = emitWindowEntryPreamble(code);
  const ret = () => code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  code.push(0x8b, 0x44, 0x24, 0x08); // mov eax, [esp + 8]（index）
  // Recognize negative GWL_* indices individually (each mismatch skips a 6-byte load+ret).
  const negatives: Array<[number, number]> = [
    [0xfffffff4, GUEST_WINDOW_ID], // -12 GWL_ID
    [0xfffffff0, GUEST_WINDOW_STYLE], // -16 GWL_STYLE
    [0xffffffec, GUEST_WINDOW_EXSTYLE], // -20 GWL_EXSTYLE
    [0xfffffffc, GUEST_WINDOW_WNDPROC], // -4  GWL_WNDPROC
    [0xffffffeb, GUEST_WINDOW_USERDATA], // -21 GWL_USERDATA
  ];
  for (const [index, offset] of negatives) {
    code.push(0x83, 0xf8, index & 0xff); // cmp eax, imm8 (sign-extended)
    code.push(0x75, 0x06); // jne skips the following 6 bytes
    code.push(0x8b, 0x41, offset); // mov eax, [ecx + offset]
    ret();
  }
  // Nonnegative extra-window-byte indices 0/4/8/12: offset = EXTRA0 + index
  code.push(0x83, 0xf8, 0x0c); // cmp eax, 12
  code.push(0x0f, 0x87);
  patches.push(code.length);
  code.push(0, 0, 0, 0); // ja fallback
  code.push(0xa8, 0x03); // test al, 3
  code.push(0x0f, 0x85);
  patches.push(code.length);
  code.push(0, 0, 0, 0); // jnz fallback
  code.push(0x8b, 0x44, 0x01, GUEST_WINDOW_EXTRA0); // mov eax, [ecx + eax + EXTRA0]
  ret();
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchWindowFallbackJumps(code, patches, fallback);
  return new Uint8Array(code);
}

/**
 * Zero-duration Sleep uses firmware INT 0x30 to rotate ready threads immediately without waiting for PIT.
 * It shares context saving with timed preemption; it does not advance time, wake threads early, or bypass locks.
 * Nonzero Sleep still uses the full Win32 deadline path.
 */
function makeFastSleepStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  code.push(0x83, 0x7c, 0x24, 0x04, 0x00); // cmp dword [esp + 4], 0
  code.push(0x0f, 0x85, 0, 0, 0, 0); // jne fallback
  const fallbackPatch = code.length - 4;
  // Briefly enable hardware interrupts when yielding while holding a lock so due PIT ticks can update sleeping threads;
  // otherwise Sleep(0) busy-waiting with IF=0 freezes wake counters forever. Restore IF according to lock depth afterward.
  code.push(0xfb, 0xcd, 0x30, 0xfa); // sti; int 0x30; cli
  code.push(0xa1);
  emit32(HYPERCALL_THREAD_CURRENT); // eax=current id
  code.push(0x83, 0x3c, 0x85);
  emit32(GUEST_THREAD_CRITICAL_DEPTH);
  code.push(0x00);
  code.push(0x75, 0x01); // jne immediate
  code.push(0xfb); // sti when no lock is held
  code.push(0x31, 0xc0); // immediate: xor eax,eax
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  const relative = fallback - (fallbackPatch + 4);
  code[fallbackPatch] = relative & 0xff;
  code[fallbackPatch + 1] = (relative >>> 8) & 0xff;
  code[fallbackPatch + 2] = (relative >>> 16) & 0xff;
  code[fallbackPatch + 3] = (relative >>> 24) & 0xff;
  return new Uint8Array(code);
}

function makeFastGetLastErrorStub(argBytes: number): Uint8Array {
  return new Uint8Array([
    0xa1,
    HYPERCALL_LAST_ERROR & 0xff,
    (HYPERCALL_LAST_ERROR >>> 8) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 16) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 24) & 0xff,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

function makeFastSetLastErrorStub(argBytes: number): Uint8Array {
  return new Uint8Array([
    0x8b,
    0x44,
    0x24,
    0x04, // mov eax, [esp + 4]
    0xa3,
    HYPERCALL_LAST_ERROR & 0xff,
    (HYPERCALL_LAST_ERROR >>> 8) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 16) & 0xff,
    (HYPERCALL_LAST_ERROR >>> 24) & 0xff,
    0x31,
    0xc0,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

function makeFastTlsGetValueStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [
    0x8b,
    0x44,
    0x24,
    0x04, // mov eax, [esp + 4]
    0x3d,
    FAST_TLS_ENTRIES & 0xff,
    (FAST_TLS_ENTRIES >>> 8) & 0xff,
    (FAST_TLS_ENTRIES >>> 16) & 0xff,
    (FAST_TLS_ENTRIES >>> 24) & 0xff,
    0x73,
    0x13, // jae fallback
    0x8b,
    0x0d,
    0x68,
    0x00,
    0x06,
    0x00, // mov ecx,[current thread]
    0xc1,
    0xe1,
    0x08, // shl ecx,8 (64 DWORDs per thread)
    0x8b,
    0x84,
    0x81,
    FAST_TLS_TABLE & 0xff,
    (FAST_TLS_TABLE >>> 8) & 0xff,
    (FAST_TLS_TABLE >>> 16) & 0xff,
    (FAST_TLS_TABLE >>> 24) & 0xff,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ];
  code.push(...makeImportStub(id, argBytes));
  return new Uint8Array(code);
}

/**
 * During startup, RA2 repeatedly measures RDTSC using QPC, with up to twenty one-second busy waits.
 * Crossing into JS for every query makes the browser spend tens of seconds handling millions of synchronous calls.
 * The 100 Hz PIT advances the shared counter by 10 ms per tick. This stub only reads it; query count must never advance time.
 */
function makeFastPerformanceCounterStub(argBytes: number): Uint8Array {
  const code: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]
  code.push(0x85, 0xc9); // test ecx, ecx
  code.push(0x74, 0x18); // je failure
  code.push(0xa1);
  emit32(HYPERCALL_QPC_LOW); // mov eax, [counter.low]
  code.push(0x8b, 0x15);
  emit32(HYPERCALL_QPC_HIGH); // mov edx, [counter.high]
  code.push(0x89, 0x01); // mov [ecx], eax
  code.push(0x89, 0x51, 0x04); // mov [ecx + 4], edx
  code.push(0xb8);
  emit32(1);
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  code.push(0x31, 0xc0); // failure: xor eax, eax
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  return new Uint8Array(code);
}

function makeFastPerformanceFrequencyStub(argBytes: number): Uint8Array {
  return new Uint8Array([
    0x8b,
    0x4c,
    0x24,
    0x04, // mov ecx, [esp + 4]
    0xc7,
    0x01,
    0xe8,
    0x03,
    0x00,
    0x00, // mov dword [ecx], 1000
    0xc7,
    0x41,
    0x04,
    0x00,
    0x00,
    0x00,
    0x00, // mov dword [ecx + 4], 0
    0xb8,
    0x01,
    0x00,
    0x00,
    0x00,
    0xc2,
    argBytes & 0xff,
    (argBytes >>> 8) & 0xff,
  ]);
}

/** Synchronous read-only fast path for ReadFile(handle, buffer, count, outCount, overlapped). */
function makeFastReadFileStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackBranches: number[] = [];
  const eofBranches: number[] = [];
  const readyBranches: number[] = [];
  const noCountBranches: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchBranches = (patches: number[], target: number) => {
    for (const displacement of patches) {
      const relative = target - (displacement + 4);
      code[displacement] = relative & 0xff;
      code[displacement + 1] = (relative >>> 8) & 0xff;
      code[displacement + 2] = (relative >>> 16) & 0xff;
      code[displacement + 3] = (relative >>> 24) & 0xff;
    }
  };

  // Leave asynchronous OVERLAPPED reads to the host; RA2/Blowfish use the synchronous path.
  code.push(0x83, 0x7c, 0x24, 0x14, 0x00); // cmp dword [esp + 20], 0
  branch(0x85, fallbackBranches); // jne fallback
  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4] (handle)
  code.push(0x2d);
  emit32(FAST_FILE_HANDLE_BASE);
  code.push(0x3d);
  emit32(FAST_FILE_TABLE_ENTRIES);
  branch(0x83, fallbackBranches); // jae fallback
  code.push(0xc1, 0xe0, 0x04); // shl eax, 4
  code.push(0x05);
  emit32(FAST_FILE_TABLE);
  code.push(0x83, 0x78, 0x0c, 0x01); // cmp dword [eax + 12], 1
  branch(0x85, fallbackBranches); // jne fallback
  code.push(0x8b, 0x50, 0x08); // mov edx, [eax + 8] (position)
  code.push(0x3b, 0x50, 0x04); // cmp edx, [eax + 4] (length)
  branch(0x83, eofBranches); // jae eof
  code.push(0x8b, 0x48, 0x04); // mov ecx, [eax + 4]
  code.push(0x29, 0xd1); // sub ecx, edx
  code.push(0x3b, 0x4c, 0x24, 0x0c); // cmp ecx, [esp + 12]
  branch(0x86, readyBranches); // jbe countReady
  code.push(0x8b, 0x4c, 0x24, 0x0c); // mov ecx, [esp + 12]
  const countReady = code.length;
  code.push(0x56, 0x57); // push esi; push edi
  code.push(0x8b, 0x30); // mov esi, [eax]
  code.push(0x01, 0xd6); // add esi, edx
  code.push(0x8b, 0x7c, 0x24, 0x10); // mov edi, [esp + 16] (original buffer)
  code.push(0x01, 0xca); // add edx, ecx
  code.push(0x89, 0x50, 0x08); // mov [eax + 8], edx
  code.push(0x8b, 0x54, 0x24, 0x18); // mov edx, [esp + 24] (original outCount)
  code.push(0x85, 0xd2); // test edx, edx
  branch(0x84, noCountBranches); // je copy
  code.push(0x89, 0x0a); // mov [edx], ecx
  const copy = code.length;
  code.push(0xfc, 0xf3, 0xa4); // cld; rep movsb
  code.push(0x5f, 0x5e); // pop edi; pop esi
  code.push(0xb8);
  emit32(1); // TRUE
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const eof = code.length;
  code.push(0x8b, 0x54, 0x24, 0x10); // mov edx, [esp + 16] (outCount)
  code.push(0x85, 0xd2); // test edx, edx
  const eofNoCountBranches: number[] = [];
  branch(0x84, eofNoCountBranches); // je eofReturn
  code.push(0xc7, 0x02);
  emit32(0); // mov dword [edx], 0
  const eofReturn = code.length;
  code.push(0xb8);
  emit32(1);
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchBranches(readyBranches, countReady);
  patchBranches(noCountBranches, copy);
  patchBranches(eofBranches, eof);
  patchBranches(eofNoCountBranches, eofReturn);
  patchBranches(fallbackBranches, fallback);
  return new Uint8Array(code);
}

/** 32-bit synchronous SetFilePointer fast path; large offsets and invalid modes still go to the host. */
function makeFastSetFilePointerStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackBranches: number[] = [];
  const beginBranches: number[] = [];
  const currentBranches: number[] = [];
  const endBranches: number[] = [];
  const commitBranches: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const jump = (patches: number[]) => {
    code.push(0xe9, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchBranches = (patches: number[], target: number) => {
    for (const displacement of patches) {
      const relative = target - (displacement + 4);
      code[displacement] = relative & 0xff;
      code[displacement + 1] = (relative >>> 8) & 0xff;
      code[displacement + 2] = (relative >>> 16) & 0xff;
      code[displacement + 3] = (relative >>> 24) & 0xff;
    }
  };

  code.push(0x83, 0x7c, 0x24, 0x0c, 0x00); // cmp dword [esp + 12], 0 (high ptr)
  branch(0x85, fallbackBranches);
  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4]
  code.push(0x2d);
  emit32(FAST_FILE_HANDLE_BASE);
  code.push(0x3d);
  emit32(FAST_FILE_TABLE_ENTRIES);
  branch(0x83, fallbackBranches);
  code.push(0xc1, 0xe0, 0x04);
  code.push(0x05);
  emit32(FAST_FILE_TABLE);
  code.push(0x83, 0x78, 0x0c, 0x01);
  branch(0x85, fallbackBranches);
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8] (signed distance)
  code.push(0x83, 0x7c, 0x24, 0x10, 0x00); // cmp method, FILE_BEGIN
  branch(0x84, beginBranches);
  code.push(0x83, 0x7c, 0x24, 0x10, 0x01); // cmp method, FILE_CURRENT
  branch(0x84, currentBranches);
  code.push(0x83, 0x7c, 0x24, 0x10, 0x02); // cmp method, FILE_END
  branch(0x84, endBranches);
  jump(fallbackBranches);

  const begin = code.length;
  code.push(0x85, 0xd2); // test edx, edx
  branch(0x88, fallbackBranches); // js fallback
  jump(commitBranches);

  const current = code.length;
  code.push(0x03, 0x50, 0x08); // add edx, [eax + 8]
  code.push(0x85, 0xd2);
  branch(0x88, fallbackBranches);
  jump(commitBranches);

  const end = code.length;
  code.push(0x03, 0x50, 0x04); // add edx, [eax + 4]
  code.push(0x85, 0xd2);
  branch(0x88, fallbackBranches);
  jump(commitBranches);

  const commit = code.length;
  code.push(0x89, 0x50, 0x08); // mov [eax + 8], edx
  code.push(0x89, 0xd0); // mov eax, edx
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));

  patchBranches(beginBranches, begin);
  patchBranches(currentBranches, current);
  patchBranches(endBranches, end);
  patchBranches(commitBranches, commit);
  patchBranches(fallbackBranches, fallback);
  return new Uint8Array(code);
}

/**
 * _lread is one of the largest static boundaries during map loading: the original game reads 1/2/4-byte fields tens of thousands of times.
 * Mirrored read-only files use guest rep movsb; other handles jump back to the original hypercall stub.
 */
function makeFastLegacyReadStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackBranches: number[] = [];
  const eofBranches: number[] = [];
  const readyBranches: number[] = [];
  const emit32 = (value: number) => {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchBranches = (patches: number[], target: number) => {
    for (const displacement of patches) {
      const relative = target - (displacement + 4);
      code[displacement] = relative & 0xff;
      code[displacement + 1] = (relative >>> 8) & 0xff;
      code[displacement + 2] = (relative >>> 16) & 0xff;
      code[displacement + 3] = (relative >>> 24) & 0xff;
    }
  };

  code.push(0x8b, 0x44, 0x24, 0x04); // mov eax, [esp + 4] (handle)
  code.push(0x2d);
  emit32(FAST_FILE_HANDLE_BASE); // sub eax, handle base
  code.push(0x3d);
  emit32(FAST_FILE_TABLE_ENTRIES); // cmp eax, entry count
  branch(0x83, fallbackBranches); // jae fallback
  code.push(0xc1, 0xe0, 0x04); // shl eax, 4
  code.push(0x05);
  emit32(FAST_FILE_TABLE); // add eax, table
  code.push(0x83, 0x78, 0x0c, 0x01); // cmp dword [eax + 12], 1
  branch(0x85, fallbackBranches); // jne fallback
  code.push(0x8b, 0x50, 0x08); // mov edx, [eax + 8] (position)
  code.push(0x3b, 0x50, 0x04); // cmp edx, [eax + 4] (length)
  branch(0x83, eofBranches); // jae eof
  code.push(0x8b, 0x48, 0x04); // mov ecx, [eax + 4]
  code.push(0x29, 0xd1); // sub ecx, edx (remaining)
  code.push(0x3b, 0x4c, 0x24, 0x0c); // cmp ecx, [esp + 12] (requested)
  branch(0x86, readyBranches); // jbe countReady
  code.push(0x8b, 0x4c, 0x24, 0x0c); // mov ecx, [esp + 12]
  const countReady = code.length;
  code.push(0x56, 0x57); // push esi; push edi
  code.push(0x8b, 0x30); // mov esi, [eax]
  code.push(0x01, 0xd6); // add esi, edx
  code.push(0x8b, 0x7c, 0x24, 0x10); // mov edi, [esp + 16] (buffer after push esi/edi)
  code.push(0x01, 0xca); // add edx, ecx
  code.push(0x89, 0x50, 0x08); // mov [eax + 8], edx
  code.push(0x89, 0xc8); // mov eax, ecx (return count before rep consumes ecx)
  code.push(0xfc, 0xf3, 0xa4); // cld; rep movsb
  code.push(0x5f, 0x5e); // pop edi; pop esi
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const eof = code.length;
  code.push(0x31, 0xc0); // xor eax, eax
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchBranches(readyBranches, countReady);
  patchBranches(eofBranches, eof);
  patchBranches(fallbackBranches, fallback);
  return new Uint8Array(code);
}

/** Uncontended critical sections use CLI only while updating their structure; contention or waiters require host scheduling. */
function makeFastCriticalSectionStub(name: string, id: number, argBytes: number): Uint8Array {
  if (name === 'DeleteCriticalSection') return makeImportStub(id, argBytes);
  const code: number[] = [];
  const emit32 = (value: number) => code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const store = (offset: number, value: number) => {
    code.push(0xc7, 0x40, offset);
    emit32(value);
  };
  const branches: number[] = [];
  const fallbackIf = (condition: number) => {
    code.push(0x0f, condition);
    branches.push(code.length);
    emit32(0);
  };
  code.push(0x8b, 0x44, 0x24, 0x04, 0x85, 0xc0); // mov eax,[esp+4]; test eax,eax
  fallbackIf(0x84);
  code.push(0xfa); // cli protects only the structure update
  if (name === 'InitializeCriticalSection') {
    for (const offset of [0, 4, 8, 12, 16, 20]) store(offset, offset === 4 ? 0xffff_ffff : 0);
  } else {
    code.push(0x8b, 0x0d);
    emit32(HYPERCALL_THREAD_CURRENT);
    code.push(0x41); // ecx = Win32 thread id
    if (name === 'EnterCriticalSection') {
      code.push(0x83, 0x78, 0x0c, 0x00, 0x74, 0x09); // Skip the owner comparison when owner == 0
      code.push(0x39, 0x48, 0x0c); // cmp [eax+12],ecx
      fallbackIf(0x85);
      code.push(0x89, 0x48, 0x0c, 0xff, 0x40, 0x08, 0xff, 0x40, 0x04);
    } else {
      code.push(0x39, 0x48, 0x0c);
      fallbackIf(0x85); // Only the owner may Leave
      code.push(0x83, 0x78, 0x10, 0);
      fallbackIf(0x85); // Let the host wake any waiters
      code.push(0x83, 0x78, 0x08, 0);
      fallbackIf(0x84);
      code.push(0xff, 0x48, 0x04, 0xff, 0x48, 0x08, 0x75, 0x07); // dec lock; dec recursion; jnz done
      store(12, 0);
    }
  }
  code.push(0x31, 0xc0); // Deterministic return value for a void API
  code.push(0x8b, 0x0d);
  emit32(HYPERCALL_THREAD_CURRENT);
  code.push(0x83, 0x3c, 0x8d);
  emit32(GUEST_THREAD_CRITICAL_DEPTH);
  code.push(0);
  code.push(0x75, 0x01, 0xfb, 0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  for (const at of branches) {
    const relative = fallback - (at + 4);
    for (let i = 0; i < 4; i++) code[at + i] = (relative >>> (i * 8)) & 0xff;
  }
  return new Uint8Array(code);
}

/**
 * First-stage Win32 compatibility layer: enough for MSVC CRT initialization, with a precise pause at the first unimplemented API.
 * Do not guess return values for unimplemented APIs: errors would surface thousands of instructions later.
 */
export function readStackArgs(memory: GuestMemory, stack: number, argBytes: number): number[] {
  const count = argBytes >>> 2;
  if (count === 0) return [];
  const b = memory.read_memory(stack + 4, count * 4); // [esp] holds the import stub's return address
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    out.push((b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0);
  }
  return out;
}

/** Precompute numeric DLL tags for each import after PE loading so dispatch does not parse strings. */
export function annotateWin32Modules(importList: PeImport[]): void {
  for (const imported of importList) imported.win32Module = win32ModuleOf(imported.dll);
}
