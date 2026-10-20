import type { PaletteState, SoundBufferState, SurfaceState, Win32Call, Win32Result } from '../win32';
import { DEFAULT_PCM_FORMAT, parsePcmWaveFormatEx, type PcmWaveFormat } from '../audio';
import {
  GUEST_SCHEDULER_TICKS,
  HYPERCALL_ACTIVE_SHELL_SURFACE,
  makeConstantImportStub,
  makeImportStub,
  type PeImport,
} from '../pe';
import { win32ModuleOf } from './text';
import { withWinmm } from './winmm';
import type { Constructor } from './state';

type WinmmChain = InstanceType<ReturnType<typeof withWinmm>>;

export const DDRAW_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['Compact', 4],
  ['CreateClipper', 16],
  ['CreatePalette', 20],
  ['CreateSurface', 16],
  ['DuplicateSurface', 12],
  ['EnumDisplayModes', 20],
  ['EnumSurfaces', 20],
  ['FlipToGDISurface', 4],
  ['GetCaps', 12],
  ['GetDisplayMode', 8],
  ['GetFourCCCodes', 12],
  ['GetGDISurface', 8],
  ['GetMonitorFrequency', 8],
  ['GetScanLine', 8],
  ['GetVerticalBlankStatus', 8],
  ['Initialize', 8],
  ['RestoreDisplayMode', 4],
  ['SetCooperativeLevel', 12],
  ['SetDisplayMode', 16],
  ['WaitForVerticalBlank', 12],
];

export const DSOUND_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['CreateSoundBuffer', 16],
  ['GetCaps', 8],
  ['DuplicateSoundBuffer', 12],
  ['SetCooperativeLevel', 12],
  ['Compact', 4],
  ['GetSpeakerConfig', 8],
  ['SetSpeakerConfig', 8],
  ['Initialize', 8],
];

const SURFACE_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['AddAttachedSurface', 8],
  ['AddOverlayDirtyRect', 8],
  ['Blt', 24],
  ['BltBatch', 12],
  ['BltFast', 24],
  ['DeleteAttachedSurface', 12],
  ['EnumAttachedSurfaces', 12],
  ['EnumOverlayZOrders', 16],
  ['Flip', 12],
  ['GetAttachedSurface', 12],
  ['GetBltStatus', 8],
  ['GetCaps', 8],
  ['GetClipper', 8],
  ['GetColorKey', 12],
  ['GetDC', 8],
  ['GetFlipStatus', 8],
  ['GetOverlayPosition', 12],
  ['GetPalette', 8],
  ['GetPixelFormat', 8],
  ['GetSurfaceDesc', 8],
  ['Initialize', 12],
  ['IsLost', 4],
  ['Lock', 20],
  ['ReleaseDC', 8],
  ['Restore', 4],
  ['SetClipper', 8],
  ['SetColorKey', 12],
  ['SetOverlayPosition', 12],
  ['SetPalette', 8],
  ['Unlock', 8],
  ['UpdateOverlay', 24],
  ['UpdateOverlayDisplay', 8],
  ['UpdateOverlayZOrder', 12],
];

const PALETTE_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['GetCaps', 8],
  ['GetEntries', 20],
  ['Initialize', 16],
  ['SetEntries', 20],
];

const CLIPPER_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['GetClipList', 16],
  ['GetHWnd', 8],
  ['Initialize', 12],
  ['IsClipListChanged', 8],
  ['SetClipList', 12],
  ['SetHWnd', 12],
];

/** E_OUTOFMEMORY; DirectSound and DirectDraw report allocation failure as DSERR_/DDERR_OUTOFMEMORY, the same value. */
const OUT_OF_MEMORY = 0x8007_000e;
const SOUND_BUFFER_METHODS: Array<[string, number]> = [
  ['QueryInterface', 12],
  ['AddRef', 4],
  ['Release', 4],
  ['GetCaps', 8],
  ['GetCurrentPosition', 12],
  ['GetFormat', 16],
  ['GetVolume', 8],
  ['GetPan', 8],
  ['GetFrequency', 8],
  ['GetStatus', 8],
  ['Initialize', 12],
  ['Lock', 32],
  ['Play', 16],
  ['SetCurrentPosition', 8],
  ['SetFormat', 8],
  ['SetVolume', 8],
  ['SetPan', 8],
  ['SetFrequency', 8],
  ['Stop', 4],
  ['Unlock', 20],
  ['Restore', 4],
];

/**
 * Side-effect-free COM methods whose host branches return only constants. Generate guest constant stubs directly in their vtable slots (see createComObject), eliminating tens of thousands of VM/JS round trips per battlefield frame. Include only methods with no host-state reads/writes; Lock/Unlock/Blt and others touching surface.dirty / emitFrame retain full hypercall stubs.
 */
const CONSTANT_COM_METHODS: ReadonlyMap<string, number> = new Map([
  ['IDirectDrawSurface.IsLost', 0],
  ['IDirectDrawSurface.Restore', 0],
  ['IDirectDrawSurface.GetBltStatus', 0],
  ['IDirectDrawSurface.GetFlipStatus', 0],
  ['IDirectDraw.WaitForVerticalBlank', 0],
]);

const DIRECTDRAW_VBLANK_MS = 1000 / 60;
const DDSCAPS_PRIMARYSURFACE = 0x0000_0200;
/** Playback-cursor cache at the tail of guest IDirectSoundBuffer objects; vtable/refcount still occupy the first eight bytes. */
const SOUND_POSITION_CACHE = 8;
const SOUND_POSITION_BUDGET = 12;
const SOUND_POSITION_TICK = 16;
const SOUND_WRITE_POSITION_CACHE = 20;
// Bound both hot polling and infrequent queries. A call-count budget alone can replay the same
// cursor for seconds when voices are polled once per frame, preventing ring refill/completion.
// PIT epochs only invalidate the cache; the refreshed cursor still uses host/audio time.
const SOUND_POSITION_FAST_BUDGET = 1023;
/** Cache the full DDSURFACEDESC at the RA2 surface-object tail for direct copying by guest Lock stubs. */
const SURFACE_DESC_CACHE = 8;
const SURFACE_DESC_BYTES = 108;
const SURFACE_UNLOCK_MODE = SURFACE_DESC_CACHE + SURFACE_DESC_BYTES;
const SURFACE_UNLOCK_BUDGET = SURFACE_UNLOCK_MODE + 4;
const SURFACE_OBJECT_BYTES = SURFACE_UNLOCK_BUDGET + 4;
const SURFACE_UNLOCK_FAST_BUDGET = 7;
const SURFACE_UNLOCK_GENERIC = 0;
const SURFACE_UNLOCK_SHELL = 1;
const SURFACE_UNLOCK_PRIMARY = 2;

/**
 * Numeric COM interface tags precomputed into PeImport.comTag at createComObject time,
 * letting dispatch use numeric routing instead of per-call startsWith chains.
 */
const COM_TAG_DIRECTDRAW = 1;
const COM_TAG_SURFACE = 2;
const COM_TAG_CLIPPER = 3;
const COM_TAG_PALETTE = 4;
const COM_TAG_SOUND = 5;
const COM_TAG_SOUND_BUFFER = 6;

function comTagOf(interfaceName: string): number | undefined {
  switch (interfaceName) {
    case 'IDirectDraw':
      return COM_TAG_DIRECTDRAW;
    case 'IDirectDrawSurface':
      return COM_TAG_SURFACE;
    case 'IDirectDrawClipper':
      return COM_TAG_CLIPPER;
    case 'IDirectDrawPalette':
      return COM_TAG_PALETTE;
    case 'IDirectSound':
      return COM_TAG_SOUND;
    case 'IDirectSoundBuffer':
      return COM_TAG_SOUND_BUFFER;
    default:
      return undefined;
  }
}

/**
 * Cached GetCurrentPosition fast stub: polls within one scheduler tick replay the latest host-computed cursor; a new tick or exhausted budget falls back to hypercall refresh. Host monotonic time/WebAudio remains authoritative while avoiding thousands of RA2 music-thread VM/JS round trips per second.
 */
function makeCachedSoundPositionStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（this）
  code.push(0x85, 0xc9); // test ecx, ecx
  code.push(0x0f, 0x84, 0, 0, 0, 0); // jz fallback
  const nullPatch = code.length - 4;
  code.push(0xa1, ...[0, 8, 16, 24].map((shift) => (GUEST_SCHEDULER_TICKS >>> shift) & 255));
  code.push(0x3b, 0x41, SOUND_POSITION_TICK); // cmp eax, [ecx + cached tick]
  code.push(0x0f, 0x85, 0, 0, 0, 0); // jne fallback
  const tickPatch = code.length - 4;
  code.push(0x83, 0x79, SOUND_POSITION_BUDGET, 0x00); // cmp dword [ecx + budget], 0
  code.push(0x0f, 0x84, 0, 0, 0, 0); // je fallback
  const budgetPatch = code.length - 4;
  code.push(0xff, 0x49, SOUND_POSITION_BUDGET); // dec dword [ecx + budget]
  code.push(0x8b, 0x41, SOUND_POSITION_CACHE); // mov eax, [ecx + position]
  code.push(0x8b, 0x54, 0x24, 0x08); // mov edx, [esp + 8]（play cursor out）
  code.push(0x85, 0xd2); // test edx, edx
  const firstNull = code.length;
  code.push(0x74, 0x00); // jz second
  code.push(0x89, 0x02); // mov [edx], eax
  const second = code.length;
  code[firstNull + 1] = (second - (firstNull + 2)) & 0xff;
  code.push(0x8b, 0x41, SOUND_WRITE_POSITION_CACHE); // mov eax, [ecx + write position]
  code.push(0x8b, 0x54, 0x24, 0x0c); // mov edx, [esp + 12]（write cursor out）
  code.push(0x85, 0xd2); // test edx, edx
  const secondNull = code.length;
  code.push(0x74, 0x00); // jz success
  code.push(0x89, 0x02); // mov [edx], eax
  const success = code.length;
  code[secondNull + 1] = (success - (secondNull + 2)) & 0xff;
  code.push(0x31, 0xc0); // xor eax, eax（DS_OK）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);
  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  for (const patch of [nullPatch, tickPatch, budgetPatch]) {
    const relative = fallback - (patch + 4);
    code[patch] = relative & 0xff;
    code[patch + 1] = (relative >>> 8) & 0xff;
    code[patch + 2] = (relative >>> 16) & 0xff;
    code[patch + 3] = (relative >>> 24) & 0xff;
  }
  return new Uint8Array(code);
}

/**
 * RA2 Lock's host branch only writes a fixed DDSURFACEDESC. The guest stub copies 27 DWORDs from the surface-object tail; Unlock still enters the host each time, preserving presentation and input/Worker yield boundaries.
 */
function makeCachedSurfaceLockStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackPatches: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  const fallbackBranch = (condition: number) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    fallbackPatches.push(code.length - 4);
  };

  code.push(0x56, 0x57); // push esi; push edi（callee-saved）
  code.push(0x8b, 0x74, 0x24, 0x0c); // mov esi, [esp + 12]: original this.
  code.push(0x85, 0xf6); // test esi, esi
  fallbackBranch(0x84); // je fallback
  code.push(0x81, 0x7e, SURFACE_DESC_CACHE);
  emit32(SURFACE_DESC_BYTES); // cached dwSize == 108
  fallbackBranch(0x85); // jne fallback
  code.push(0x8b, 0x7c, 0x24, 0x14); // mov edi, [esp + 20]: original desc output pointer.
  code.push(0x85, 0xff); // test edi, edi
  const noOutput = code.length;
  code.push(0x74, 0x00); // je success
  code.push(0x83, 0xc6, SURFACE_DESC_CACHE); // add esi, cache
  code.push(0xb9);
  emit32(SURFACE_DESC_BYTES / 4); // mov ecx, 27
  code.push(0xfc, 0xf3, 0xa5); // cld; rep movsd
  const success = code.length;
  code[noOutput + 1] = (success - (noOutput + 2)) & 0xff;
  code.push(0x5f, 0x5e); // pop edi; pop esi
  code.push(0x31, 0xc0); // xor eax, eax（DD_OK）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const fallback = code.length;
  code.push(0x5f, 0x5e); // Restore registers, then take the ordinary hypercall path.
  code.push(...makeImportStub(id, argBytes));
  for (const patch of fallbackPatches) {
    const relative = fallback - (patch + 4);
    code[patch] = relative & 0xff;
    code[patch + 1] = (relative >>> 8) & 0xff;
    code[patch + 2] = (relative >>> 16) & 0xff;
    code[patch + 3] = (relative >>> 24) & 0xff;
  }
  return new Uint8Array(code);
}

/**
 * Non-primary Unlock may stay inside the guest for at most seven consecutive calls; force the eighth back to the host. Shell surfaces must also match the active host layer, otherwise return immediately to switch layers.
 */
function makeBudgetedSurfaceUnlockStub(id: number, argBytes: number): Uint8Array {
  const code: number[] = [];
  const fallbackPatches: number[] = [];
  const fastPatches: number[] = [];
  const emit32 = (value: number) =>
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  const branch = (condition: number, patches: number[]) => {
    code.push(0x0f, condition, 0, 0, 0, 0);
    patches.push(code.length - 4);
  };
  const patchAll = (patches: number[], target: number) => {
    for (const patch of patches) {
      const relative = target - (patch + 4);
      code[patch] = relative & 0xff;
      code[patch + 1] = (relative >>> 8) & 0xff;
      code[patch + 2] = (relative >>> 16) & 0xff;
      code[patch + 3] = (relative >>> 24) & 0xff;
    }
  };

  code.push(0x8b, 0x4c, 0x24, 0x04); // mov ecx, [esp + 4]（this）
  code.push(0x85, 0xc9); // test ecx, ecx
  branch(0x84, fallbackPatches); // je fallback
  code.push(0x81, 0x79, SURFACE_DESC_CACHE);
  emit32(SURFACE_DESC_BYTES);
  branch(0x85, fallbackPatches); // Not an RA2 extended object.
  code.push(0x83, 0x79, SURFACE_UNLOCK_MODE, SURFACE_UNLOCK_PRIMARY); // cmp mode, primary
  branch(0x84, fallbackPatches);
  code.push(0x83, 0x79, SURFACE_UNLOCK_MODE, SURFACE_UNLOCK_SHELL); // cmp mode, shell
  branch(0x85, fastPatches); // generic → budget
  code.push(0x3b, 0x0d);
  emit32(HYPERCALL_ACTIVE_SHELL_SURFACE); // cmp ecx, [activeShell]
  branch(0x85, fallbackPatches); // Shell layer switches must enter the host.

  const fast = code.length;
  code.push(0x83, 0x79, SURFACE_UNLOCK_BUDGET, 0x00); // cmp budget, 0
  branch(0x84, fallbackPatches);
  code.push(0xff, 0x49, SURFACE_UNLOCK_BUDGET); // dec budget
  code.push(0x31, 0xc0); // xor eax, eax（DD_OK）
  code.push(0xc2, argBytes & 0xff, (argBytes >>> 8) & 0xff);

  const fallback = code.length;
  code.push(...makeImportStub(id, argBytes));
  patchAll(fastPatches, fast);
  patchAll(fallbackPatches, fallback);
  return new Uint8Array(code);
}

/** DirectX Win32 API cases extracted from Win32Shim.dispatch's main switch. */
export function withDirectx<TBase extends Constructor<WinmmChain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    /** Last vblank tick in host milliseconds, used for 60Hz alignment; see WaitForVerticalBlank. */
    private lastVblankHostMs = 0;
    /** The native battlefield loop calls BLOCKBEGIN twice consecutively; the pair should consume only one refresh period. */
    private vblankPairSecondCall = false;
    private readonly clipperWindows = new Map<number, number>();

    dispatchDirectx(key: string, name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'DDRAW.DLL!DirectDrawCreate': {
          if (!a[1]) return { eax: 0x8000_4003 }; // E_POINTER
          const object = this.createComObject('IDirectDraw', DDRAW_METHODS);
          this.writeU32(a[1], object);
          return { eax: object ? 0 : OUT_OF_MEMORY }; // DD_OK
        }
        case 'DSOUND.DLL!ord1': {
          if (!a[1]) return { eax: 0x8000_4003 };
          const object = this.createComObject('IDirectSound', DSOUND_METHODS, 'DSOUND.COM');
          this.writeU32(a[1], object);
          return { eax: object ? 0 : OUT_OF_MEMORY };
        }
        default:
          void name;
          return null;
      }
    }
    protected dispatchDirectDraw(call: Win32Call): Win32Result | null {
      const key = call.imported.key;
      const a = call.args;
      // Dynamic COM stubs carry precomputed PeImport.comTag/method; handcrafted imports fall back to string parsing.
      const tag = call.imported.comTag;
      const method = call.imported.method ?? key.slice(key.lastIndexOf('.') + 1);
      const thisPtr = a[0] ?? 0;

      if (method === 'QueryInterface') {
        if (a[2]) this.writeU32(a[2], thisPtr);
        this.addComRef(thisPtr);
        return { eax: 0 };
      }
      if (method === 'AddRef') return { eax: this.addComRef(thisPtr) };
      if (method === 'Release') {
        const refs = this.releaseComObject(thisPtr);
        if (!refs) this.clipperWindows.delete(thisPtr);
        return { eax: refs };
      }

      if (tag === COM_TAG_DIRECTDRAW || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDraw.'))) {
        switch (method) {
          case 'GetCaps': {
            for (const caps of [a[1] ?? 0, a[2] ?? 0]) {
              if (!caps) continue;
              const size = this.readU32(caps);
              this.zero(caps, Math.min(Math.max(size, 4), 0x180));
              this.writeU32(caps, size);
              // Advertise software 8-bit Blt/color-key/palette capabilities, not 3D/overlay, so the game selects the correct path.
              this.writeU32(caps + 4, 0x0440_81c0);
              this.writeU32(caps + 0x30, 64 * 1024 * 1024);
              this.writeU32(caps + 0x34, 48 * 1024 * 1024);
            }
            return { eax: 0 };
          }
          case 'SetCooperativeLevel':
            return { eax: 0 };
          case 'SetDisplayMode': {
            const width = a[1] | 0;
            const height = a[2] | 0;
            const bpp = a[3] | 0;
            // RA2 natively uses 16-bit RGB565. Do not hardcode 640x480: classic-game
            // INI/command-line settings request 800x600 or larger modes, which the browser canvas supports directly.
            if ((bpp !== 8 && bpp !== 16) || width < 320 || width > 2560 || height < 200 || height > 1600) {
              return { eax: 0x8876_008a }; // DDERR_INVALIDMODE
            }
            this.displayWidth = width;
            this.displayHeight = height;
            this.displayBpp = bpp;
            this.setCursorPosition(this.cursorX, this.cursorY);
            return { eax: 0 };
          }
          case 'RestoreDisplayMode':
          case 'FlipToGDISurface':
            return { eax: 0 };
          case 'EnumDisplayModes': {
            const callback = a[4] ?? 0;
            if (!callback) return { eax: 0x8000_4003 };
            // Each suspended callback keeps its own mode snapshot, including across nested mode changes.
            // Slot ownership releases the descriptor with the bridge, without allocating permanent heap data.
            const frame = this.reserveGuestCallback(108); // sizeof(DDSURFACEDESC)
            const desc = frame.scratchAddress;
            this.writeSurfaceDesc(desc, {
              object: 0,
              width: this.displayWidth,
              height: this.displayHeight,
              pitch: (this.displayWidth * (this.displayBpp >>> 3) + 3) & ~3,
              bpp: this.displayBpp,
              pixels: 0,
              caps: 0x200,
              palette: 0,
              attached: 0,
              sourceColorKey: null,
              destinationColorKey: null,
              textRuns: [],
              lastDrawSerial: 0,
              dirty: false,
            });
            const originalReturn = this.readU32(call.stack);
            const code: number[] = [];
            const emit32 = (value: number) =>
              code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
            const push = (value: number) => {
              code.push(0x68);
              emit32(value);
            };
            code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp,esp
            push(a[3] ?? 0);
            push(desc);
            code.push(0xb8);
            emit32(callback);
            code.push(0xff, 0xd0); // callback(&DDSURFACEDESC, context)
            code.push(0x89, 0xec, 0x5d); // mov esp,ebp; pop ebp accommodates stdcall/cdecl cleanup differences.
            code.push(0x31, 0xc0); // DD_OK
            this.appendGuestCallbackReturn(code, frame, originalReturn);
            this.memory.write_memory(code, frame.trampoline);
            this.writeU32(call.stack, frame.trampoline);
            return { eax: 0 };
          }
          case 'WaitForVerticalBlank': {
            if (this.primarySurface) this.emitPrimaryFrame();
            // DDWAITVB_BLOCKBEGIN/BLOCKEND are synchronous waits in the native
            // API. Let the host poller yield for one 60 Hz refresh so the guest
            // cannot run its render loop at an artificial rate.
            const waitRequested = ((a[1] ?? 0) & 0x7) !== 0;
            if (!waitRequested) return { eax: 0 };
            if (this.vblankPairSecondCall) {
              this.vblankPairSecondCall = false;
              return { eax: 0 };
            }
            this.options.onLogicFrame?.();
            // Align to 60Hz ticks instead of sleeping a full frame per call: the game calls vblank twice per frame (BEGIN/END),
            // and two 16.7ms waits reduce it to 30fps with additional setTimeout jitter. Wait only for the remaining time
            // since the previous tick so consecutive calls share one cycle and restore a 60fps cadence.
            this.vblankPairSecondCall = true;
            const now = performance.now();
            const period = this.clock.toHostDelay(DIRECTDRAW_VBLANK_MS);
            const delay = Math.max(0, period - (now - this.lastVblankHostMs));
            this.lastVblankHostMs = now + delay;
            return { eax: 0, delayMs: delay };
          }
          case 'GetDisplayMode':
            if (a[1])
              this.writeSurfaceDesc(a[1], {
                object: 0,
                width: this.displayWidth,
                height: this.displayHeight,
                pitch: (this.displayWidth * (this.displayBpp >>> 3) + 3) & ~3,
                bpp: this.displayBpp,
                pixels: 0,
                caps: 0x200,
                palette: 0,
                attached: 0,
                sourceColorKey: null,
                destinationColorKey: null,
                textRuns: [],
                lastDrawSerial: 0,
                dirty: false,
              });
            return { eax: 0 };
          case 'CreateClipper': {
            if (!a[2]) return { eax: 0x8000_4003 };
            const clipper = this.createComObject('IDirectDrawClipper', CLIPPER_METHODS);
            if (!clipper) {
              this.writeU32(a[2], 0);
              return { eax: OUT_OF_MEMORY };
            }
            this.clipperWindows.set(clipper, 0);
            this.writeU32(a[2], clipper);
            return { eax: 0 };
          }
          case 'CreatePalette': {
            if (!a[3]) return { eax: 0x8000_4003 };
            const palette = this.createPalette(a[1] ?? 0, a[2] ?? 0);
            this.writeU32(a[3], palette);
            return { eax: palette ? 0 : OUT_OF_MEMORY };
          }
          case 'CreateSurface': {
            const desc = a[1] ?? 0;
            const out = a[2] ?? 0;
            if (!desc || !out) return { eax: 0x8000_4003 };
            const surface = this.createSurfaceFromDesc(desc);
            this.writeU32(out, surface?.object ?? 0);
            return { eax: surface ? 0 : OUT_OF_MEMORY };
          }
          default:
            return null;
        }
      }

      if (tag === COM_TAG_CLIPPER || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDrawClipper.'))) {
        switch (method) {
          case 'SetHWnd':
            this.clipperWindows.set(thisPtr, a[2] ?? 0);
            return { eax: 0 };
          case 'SetClipList':
          case 'Initialize':
            return { eax: 0 };
          case 'GetHWnd':
            if (a[1]) this.writeU32(a[1], this.clipperWindows.get(thisPtr) ?? 0);
            return { eax: 0 };
          case 'IsClipListChanged':
            if (a[1]) this.writeU32(a[1], 0);
            return { eax: 0 };
          default:
            return null;
        }
      }

      if (tag === COM_TAG_PALETTE || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDrawPalette.'))) {
        const palette = this.palettes.get(thisPtr);
        if (!palette) return { eax: 0x8876_00c2 }; // DDERR_INVALIDOBJECT
        switch (method) {
          case 'SetEntries': {
            const base = a[2] ?? 0;
            const count = a[3] ?? 0;
            const source = a[4] ?? 0;
            if (source && base < 256 && count > 0) {
              const clipped = Math.min(count, 256 - base);
              palette.entries.set(this.memory.read_memory(source, clipped * 4), base * 4);
              this.applyReservedSystemPalette(palette);
              this.remapGdiTextForPalette(palette.object);
            }
            // Transitions often update palette and pixels separately; capture them together at the next primary-surface presentation.
            return { eax: 0 };
          }
          case 'GetEntries': {
            const base = a[2] ?? 0;
            const count = Math.min(a[3] ?? 0, 256 - base);
            if (a[4] && count > 0)
              this.memory.write_memory(palette.entries.subarray(base * 4, (base + count) * 4), a[4]);
            return { eax: 0 };
          }
          case 'GetCaps':
            if (a[1]) this.writeU32(a[1], palette.caps);
            return { eax: 0 };
          default:
            return null;
        }
      }

      if (tag === COM_TAG_SURFACE || (tag === undefined && key.startsWith('DDRAW.COM!IDirectDrawSurface.'))) {
        const surface = this.surfaces.get(thisPtr);
        if (!surface) return { eax: 0x8876_00c2 };
        switch (method) {
          case 'GetAttachedSurface': {
            if (!surface.attached) return { eax: 0x8876_00b4 }; // DDERR_NOTFOUND
            if (a[2]) this.writeU32(a[2], surface.attached);
            return { eax: 0 };
          }
          case 'SetClipper':
            return { eax: 0 };
          case 'SetColorKey': {
            const flags = a[1] ?? 0;
            const key: [number, number] | null = a[2] ? [this.readU32(a[2]), this.readU32(a[2] + 4)] : null;
            if (flags & 0x8) surface.sourceColorKey = key; // DDCKEY_SRCBLT
            if (flags & 0x2) surface.destinationColorKey = key; // DDCKEY_DESTBLT
            return { eax: 0 };
          }
          case 'GetColorKey': {
            const flags = a[1] ?? 0;
            const key = flags & 0x8 ? surface.sourceColorKey : surface.destinationColorKey;
            if (!key) return { eax: 0x8876_006c }; // DDERR_NOCOLORKEY
            if (a[2]) {
              this.writeU32(a[2], key[0]);
              this.writeU32(a[2] + 4, key[1]);
            }
            return { eax: 0 };
          }
          case 'SetPalette':
            surface.palette = a[1] ?? 0;
            if (surface.attached) {
              const attached = this.surfaces.get(surface.attached);
              if (attached) attached.palette = surface.palette;
            }
            this.remapGdiTextRunColors(surface);
            if (surface.attached) {
              const attached = this.surfaces.get(surface.attached);
              if (attached) this.remapGdiTextRunColors(attached);
            }
            // SetPalette is not a pixel-presentation boundary; avoid applying new palettes to old pixels for one corrupt frame.
            // Since remap changes pixels, mark dirty so the next actual presentation boundary, vblank, resnapshots them.
            surface.dirty = true;
            return { eax: 0 };
          case 'GetPalette':
            if (a[1]) this.writeU32(a[1], surface.palette);
            return { eax: surface.palette ? 0 : 0x8876_006c };
          case 'GetCaps':
            if (a[1]) this.writeU32(a[1], surface.caps);
            return { eax: 0 };
          case 'GetPixelFormat':
            if (a[1]) this.writePixelFormat(a[1], surface.bpp);
            return { eax: 0 };
          case 'GetSurfaceDesc':
            if (a[1]) this.writeSurfaceDesc(a[1], surface);
            return { eax: 0 };
          case 'GetDC':
            if (a[1]) this.writeU32(a[1], this.createGdiDc(surface.object));
            return { eax: 0 };
          case 'Lock':
            if (a[2]) this.writeSurfaceDesc(a[2], surface);
            surface.dirty = true; // The guest writes pixels directly after locking; conservatively mark dirty.
            return { eax: 0 };
          case 'Unlock':
            // RA2 Lock already ran inside the guest; Unlock remains the host submission boundary, so mark dirty consistently.
            if (this.gameProfile.directDraw?.guestSurfaceFastPath) {
              surface.dirty = true;
              this.writeU32(
                surface.object + SURFACE_UNLOCK_BUDGET,
                (surface.caps & DDSCAPS_PRIMARYSURFACE) !== 0 ? 0 : SURFACE_UNLOCK_FAST_BUDGET,
              );
            }
            this.noteShellSurfaceDraw(surface);
            this.emitFrame(surface);
            return { eax: 0 };
          case 'Flip': {
            const attached = this.surfaces.get(surface.attached);
            if (attached) {
              // Swap pixel pointers and GDI text runs together because runs describe those pixels;
              // swapping pixels alone misaligns front-buffer runs, causing palette-change remapping
              // to rewrite the wrong glyphs and retain old text indexes, historically displayed as white.
              const pixels = surface.pixels;
              surface.pixels = attached.pixels;
              attached.pixels = pixels;
              const runs = surface.textRuns;
              surface.textRuns = attached.textRuns;
              attached.textRuns = runs;
              if (this.gameProfile.directDraw?.guestSurfaceFastPath) {
                this.refreshSurfaceDescCache(surface);
                this.refreshSurfaceDescCache(attached);
              }
            }
            surface.dirty = true; // After flipping, front pixels come from the back buffer.
            this.emitFrame(surface);
            return { eax: 0 };
          }
          case 'Blt':
            this.blit(surface, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0);
            surface.dirty = true;
            this.noteShellSurfaceDraw(surface);
            this.emitFrame(surface);
            return { eax: 0 };
          case 'BltFast':
            this.blitFast(surface, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0);
            surface.dirty = true;
            this.noteShellSurfaceDraw(surface);
            this.emitFrame(surface);
            return { eax: 0 };
          case 'IsLost':
          case 'Restore':
          case 'GetBltStatus':
          case 'GetFlipStatus':
            return { eax: 0 };
          case 'ReleaseDC':
            return { eax: this.releaseGdiDc(a[1] ?? 0, surface.object) ? 0 : 0x8876_00c2 };
          default:
            return null;
        }
      }
      return null;
    }
    protected dispatchDirectSound(call: Win32Call): Win32Result | null {
      const key = call.imported.key;
      const a = call.args;
      const tag = call.imported.comTag;
      const method = call.imported.method ?? key.slice(key.lastIndexOf('.') + 1);
      const thisPtr = a[0] ?? 0;

      if (method === 'QueryInterface') {
        if (a[2]) this.writeU32(a[2], thisPtr);
        this.addComRef(thisPtr);
        return { eax: 0 };
      }
      if (method === 'AddRef') return { eax: this.addComRef(thisPtr) };
      if (method === 'Release') return { eax: this.releaseComObject(thisPtr) };

      if (tag === COM_TAG_SOUND || (tag === undefined && key.startsWith('DSOUND.COM!IDirectSound.'))) {
        switch (method) {
          case 'SetCooperativeLevel':
          case 'Compact':
          case 'SetSpeakerConfig':
          case 'Initialize':
            return { eax: 0 };
          case 'GetCaps':
            if (a[1]) {
              this.zero(a[1], 96);
              this.writeU32(a[1], 96);
              this.writeU32(a[1] + 12, 1); // dwPrimaryBuffers
            }
            return { eax: 0 };
          case 'GetSpeakerConfig':
            if (a[1]) this.writeU32(a[1], 4); // DSSPEAKER_STEREO
            return { eax: 0 };
          case 'CreateSoundBuffer': {
            if (!a[1] || !a[2]) return { eax: 0x8000_4003 };
            const formatPtr = this.readU32(a[1] + 16);
            let format = { ...DEFAULT_PCM_FORMAT };
            try {
              if (formatPtr) format = parsePcmWaveFormatEx(this.memory.read_memory(formatPtr, 18));
            } catch {
              return { eax: 0x8878_0064 }; // DSERR_BADFORMAT
            }
            const buffer = this.createSoundBuffer(this.readU32(a[1] + 8), format);
            this.writeU32(a[2], buffer?.object ?? 0);
            return { eax: buffer ? 0 : OUT_OF_MEMORY };
          }
          case 'DuplicateSoundBuffer': {
            const source = this.soundBuffers.get(a[1] ?? 0);
            if (!source || !a[2]) return { eax: 0x8878_001e };
            const duplicate = this.createSoundBuffer(source.size, source.format);
            if (!duplicate) {
              this.writeU32(a[2], 0);
              return { eax: OUT_OF_MEMORY };
            }
            this.memory.write_memory(this.memory.read_memory(source.data, source.size), duplicate.data);
            duplicate.position = source.position;
            duplicate.volume = source.volume;
            duplicate.pan = source.pan;
            duplicate.frequency = source.frequency;
            this.options.audio?.duplicateBuffer(source.object, duplicate.object);
            this.options.audio?.setCurrentPosition(duplicate.object, duplicate.position);
            this.options.audio?.setVolume(duplicate.object, duplicate.volume);
            this.options.audio?.setPan(duplicate.object, duplicate.pan);
            this.options.audio?.setFrequency(duplicate.object, duplicate.frequency);
            this.writeU32(a[2], duplicate.object);
            return { eax: 0 };
          }
          default:
            return null;
        }
      }

      if (tag === COM_TAG_SOUND_BUFFER || (tag === undefined && key.startsWith('DSOUND.COM!IDirectSoundBuffer.'))) {
        const buffer = this.soundBuffers.get(thisPtr);
        if (!buffer) return { eax: 0x8878_0032 };
        switch (method) {
          case 'GetCaps':
            if (a[1]) {
              this.zero(a[1], 20);
              this.writeU32(a[1], 20);
              this.writeU32(a[1] + 8, buffer.size);
            }
            return { eax: 0 };
          case 'GetCurrentPosition':
            {
              const state = this.options.audio?.getState(buffer.object);
              const position = state?.positionBytes ?? this.soundBufferPosition(buffer);
              const writePosition = state?.writePositionBytes ?? position;
              if (a[1]) this.writeU32(a[1], position);
              if (a[2]) this.writeU32(a[2], writePosition);
              this.cacheSoundBufferPosition(buffer, position, writePosition);
            }
            return { eax: 0 };
          case 'GetFormat':
            if (a[3]) this.writeU32(a[3], 18);
            if (a[1] && a[2]) this.writeWaveFormat(a[1], a[2], buffer.format);
            return { eax: 0 };
          case 'GetVolume':
            if (a[1]) this.writeU32(a[1], buffer.volume);
            return { eax: 0 };
          case 'GetPan':
            if (a[1]) this.writeU32(a[1], buffer.pan);
            return { eax: 0 };
          case 'GetFrequency':
            if (a[1]) this.writeU32(a[1], buffer.frequency);
            return { eax: 0 };
          case 'GetStatus':
            {
              const hostState = this.options.audio?.getState(buffer.object);
              if (hostState) buffer.playing = hostState.playing;
              else if (buffer.playing) this.soundBufferPosition(buffer);
              this.invalidateSoundBufferPosition(buffer);
            }
            if (a[1]) this.writeU32(a[1], buffer.playing ? 1 : 0); // DSBSTATUS_PLAYING
            return { eax: 0 };
          case 'Lock': {
            const flags = a[7] ?? 0;
            // DSBLOCK_FROMWRITECURSOR (1) and DSBLOCK_ENTIREBUFFER (2): RA2 streaming music
            // uses these to maintain ring buffers. Ignoring ENTIREBUFFER with bytes=0
            // returns an empty lock, so only the prefilled portion plays.
            const state = (flags & 1) !== 0 ? this.options.audio?.getState(buffer.object) : null;
            const writePosition =
              state?.writePositionBytes ??
              state?.positionBytes ??
              ((flags & 1) !== 0 ? this.soundBufferPosition(buffer) : 0);
            // Locking from the write cursor must not seek or restart playback.
            const offset = Math.min((flags & 1) !== 0 ? writePosition : (a[1] ?? 0), buffer.size);
            const requested = (flags & 2) !== 0 ? buffer.size : Math.min(a[2] ?? 0, buffer.size);
            const first = Math.min(requested, buffer.size - offset);
            const second = requested - first;
            if (a[3]) this.writeU32(a[3], buffer.data + offset);
            if (a[4]) this.writeU32(a[4], first);
            if (a[5]) this.writeU32(a[5], second ? buffer.data : 0);
            if (a[6]) this.writeU32(a[6], second);
            return { eax: 0 };
          }
          case 'Play':
            {
              this.soundBufferPosition(buffer);
              const nextLooping = ((a[3] ?? 0) & 1) !== 0;
              // DirectSound Play is a no-op when already playing with unchanged flags. Bink repeats it each frame;
              // do not keep messaging the main thread for identical state.
              if (buffer.playing && buffer.looping === nextLooping) return { eax: 0 };
              if (!buffer.playing) buffer.startedAt = this.audioNow();
              buffer.playing = true;
              buffer.looping = nextLooping;
            }
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.play(buffer.object, { loop: buffer.looping });
            return { eax: 0 };
          case 'Stop':
            buffer.position = this.soundBufferPosition(buffer);
            buffer.startedAt = this.audioNow();
            buffer.playing = false;
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.stop(buffer.object);
            return { eax: 0 };
          case 'SetCurrentPosition':
            buffer.position = Math.min(a[1] ?? 0, buffer.size);
            buffer.startedAt = this.audioNow();
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.setCurrentPosition(buffer.object, buffer.position);
            return { eax: 0 };
          case 'SetFormat':
            if (!a[1]) return { eax: 0x8000_4003 };
            let nextFormat: PcmWaveFormat;
            try {
              nextFormat = parsePcmWaveFormatEx(this.memory.read_memory(a[1], 18));
            } catch {
              return { eax: 0x8878_0064 };
            }
            // Commit the playback cursor using the old format before switching; otherwise the new
            // block alignment interprets the old interval and causes an incorrect cursor jump.
            buffer.position = this.soundBufferPosition(buffer);
            buffer.startedAt = this.audioNow();
            buffer.format = nextFormat;
            buffer.frequency = buffer.format.nSamplesPerSec;
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.setFormat(buffer.object, buffer.format);
            return { eax: 0 };
          case 'SetVolume':
            {
              const next = Math.max(-10_000, Math.min(0, (a[1] ?? 0) | 0));
              if (next === buffer.volume) return { eax: 0 };
              buffer.volume = next;
            }
            this.options.audio?.setVolume(buffer.object, buffer.volume);
            return { eax: 0 };
          case 'SetPan':
            {
              const next = Math.max(-10_000, Math.min(10_000, (a[1] ?? 0) | 0));
              if (next === buffer.pan) return { eax: 0 };
              buffer.pan = next;
            }
            this.options.audio?.setPan(buffer.object, buffer.pan);
            return { eax: 0 };
          case 'SetFrequency':
            {
              const next = (a[1] ?? 0) || buffer.format.nSamplesPerSec;
              if (next === buffer.frequency) return { eax: 0 };
            }
            buffer.position = this.soundBufferPosition(buffer);
            buffer.startedAt = this.audioNow();
            buffer.frequency = (a[1] ?? 0) || buffer.format.nSamplesPerSec;
            this.invalidateSoundBufferPosition(buffer);
            this.options.audio?.setFrequency(buffer.object, a[1] ?? 0);
            return { eax: 0 };
          case 'Unlock':
            this.syncSoundRange(buffer, a[1] ?? 0, a[2] ?? 0);
            this.syncSoundRange(buffer, a[3] ?? 0, a[4] ?? 0);
            return { eax: 0 };
          case 'Restore':
          case 'Initialize':
            return { eax: 0 };
          default:
            return null;
        }
      }
      return null;
    }
    protected createComObject(
      interfaceName: string,
      methods: Array<[string, number]>,
      namespace = 'DDRAW.COM',
      objectBytes = 8,
    ): number {
      const vtableKey = `${namespace}!${interfaceName}`;
      let vtable = this.vtables.get(vtableKey);
      if (!vtable) {
        vtable = this.alloc(methods.length * 4, true);
        if (!vtable) return 0;
        for (let i = 0; i < methods.length; i++) {
          const [method, argBytes] = methods[i]!;
          const id = this.nextDynamicId++;
          // Side-effect-free COM queries such as IsLost run tens of thousands of times per battlefield frame;
          // host round trips cost far more than the methods. Their host branches already return only constants,
          // so generate constant guest stubs to eliminate VM/JS crossings.
          const constant = CONSTANT_COM_METHODS.get(`${interfaceName}.${method}`);
          const stubBytes =
            interfaceName === 'IDirectSoundBuffer' && method === 'GetCurrentPosition'
              ? makeCachedSoundPositionStub(id, argBytes)
              : this.gameProfile.directDraw?.guestSurfaceFastPath &&
                  interfaceName === 'IDirectDrawSurface' &&
                  method === 'Lock'
                ? makeCachedSurfaceLockStub(id, argBytes)
                : this.gameProfile.directDraw?.guestSurfaceFastPath &&
                    interfaceName === 'IDirectDrawSurface' &&
                    method === 'Unlock'
                  ? makeBudgetedSurfaceUnlockStub(id, argBytes)
                  : constant !== undefined
                    ? makeConstantImportStub(constant, argBytes)
                    : makeImportStub(id, argBytes);
          const stub = this.allocateDynamicCode(stubBytes);
          const name = `${interfaceName}.${method}`;
          const imported: PeImport = {
            id,
            dll: namespace,
            name,
            key: `${namespace}!${name}`,
            slot: vtable + i * 4,
            stub,
            argBytes,
            win32Module: win32ModuleOf(namespace),
            // Precompute routing; dispatch's hot path no longer uses lastIndexOf/slice/startsWith.
            method,
            comTag: comTagOf(interfaceName),
          };
          this.dynamicImports.set(id, imported);
          this.writeU32(imported.slot, stub);
        }
        this.vtables.set(vtableKey, vtable);
      }
      const object = this.alloc(Math.max(8, objectBytes), true);
      if (!object) return 0;
      this.writeU32(object, vtable);
      this.writeU32(object + 4, 1);
      return object;
    }
    /**
     * Returns null when the shim heap cannot hold the object or its PCM data. Reporting success with a NULL or
     * low-memory buffer would make the game write samples over guest address 0 and play nothing.
     */
    protected createSoundBuffer(
      size: number,
      format: PcmWaveFormat = { ...DEFAULT_PCM_FORMAT },
    ): SoundBufferState | null {
      const safeSize = Math.max(1, Math.min(size || 65_536, 4 * 1024 * 1024));
      const object = this.createComObject('IDirectSoundBuffer', SOUND_BUFFER_METHODS, 'DSOUND.COM', 24);
      if (!object) return null;
      const data = this.alloc(safeSize, true);
      if (!data) {
        this.freeAllocation(object);
        return null;
      }
      const buffer: SoundBufferState = {
        object,
        data,
        size: safeSize,
        startedAt: this.audioNow(),
        position: 0,
        playing: false,
        looping: false,
        format: { ...format },
        volume: 0,
        pan: 0,
        frequency: format.nSamplesPerSec,
      };
      this.soundBuffers.set(object, buffer);
      this.invalidateSoundBufferPosition(buffer);
      this.options.audio?.createBuffer(object, safeSize, buffer.format);
      return buffer;
    }

    private cacheSoundBufferPosition(buffer: SoundBufferState, position: number, writePosition: number): void {
      this.writeU32(buffer.object + SOUND_WRITE_POSITION_CACHE, writePosition);
      this.writeU32(buffer.object + SOUND_POSITION_CACHE, position >>> 0);
      this.writeU32(buffer.object + SOUND_POSITION_TICK, this.readU32(GUEST_SCHEDULER_TICKS));
      this.writeU32(buffer.object + SOUND_POSITION_BUDGET, SOUND_POSITION_FAST_BUDGET);
    }

    private invalidateSoundBufferPosition(buffer: SoundBufferState): void {
      this.writeU32(buffer.object + SOUND_POSITION_CACHE, buffer.position >>> 0);
      this.writeU32(buffer.object + SOUND_POSITION_BUDGET, 0);
    }
    /**
     * Use output observations when available, including the Worker's latest asynchronous report. Only headless sinks without playback observations use the monotonic fallback.
     */
    protected soundBufferPosition(buffer: SoundBufferState): number {
      const state = this.options.audio?.getState(buffer.object);
      if (state) {
        buffer.position = state.positionBytes;
        buffer.playing = state.playing;
        return buffer.position;
      }
      if (!buffer.playing || buffer.size <= 0) return buffer.position;
      const now = this.audioNow();
      const elapsedSeconds = Math.max(0, now - buffer.startedAt) / 1000;
      const blockAlign = Math.max(1, buffer.format.nBlockAlign);
      const advanced = Math.floor(elapsedSeconds * Math.max(1, buffer.frequency)) * blockAlign;
      const absolute = buffer.position + advanced;
      if (buffer.looping) return absolute % buffer.size;
      if (absolute < buffer.size) return absolute;
      buffer.playing = false;
      buffer.position = 0;
      buffer.startedAt = now;
      return 0;
    }
    protected audioNow(): number {
      return typeof performance === 'undefined' ? Date.now() : performance.now();
    }
    protected syncSoundRange(buffer: SoundBufferState, pointer: number, requested: number): void {
      if (!pointer || !requested || pointer < buffer.data || pointer >= buffer.data + buffer.size) return;
      const offset = pointer - buffer.data;
      const count = Math.min(requested, buffer.size - offset);
      if (count > 0) this.options.audio?.writeBuffer(buffer.object, offset, this.memory.read_memory(pointer, count));
    }
    protected writeWaveFormat(pointer: number, capacity: number, format: PcmWaveFormat): void {
      const bytes = new Uint8Array(18);
      const view = new DataView(bytes.buffer);
      view.setUint16(0, format.wFormatTag, true);
      view.setUint16(2, format.nChannels, true);
      view.setUint32(4, format.nSamplesPerSec, true);
      view.setUint32(8, format.nAvgBytesPerSec, true);
      view.setUint16(12, format.nBlockAlign, true);
      view.setUint16(14, format.wBitsPerSample, true);
      view.setUint16(16, format.cbSize, true);
      this.memory.write_memory(bytes.subarray(0, Math.min(bytes.length, capacity)), pointer);
    }
    /** Returns 0 when the shim heap cannot hold the object; callers must report DDERR_OUTOFMEMORY. */
    protected createPalette(caps: number, entriesPtr: number): number {
      const object = this.createComObject('IDirectDrawPalette', PALETTE_METHODS);
      if (!object) return 0;
      const entries = entriesPtr ? this.memory.read_memory(entriesPtr, 256 * 4).slice() : new Uint8Array(256 * 4);
      const palette = { object, caps, entries };
      this.applyReservedSystemPalette(palette);
      this.palettes.set(object, palette);
      return object;
    }
    protected applyReservedSystemPalette(palette: PaletteState): void {
      // When the guest supplies DDPCAPS_8BIT (0x4), it uses almost all
      // 256 indexes; do not impose windowed GDI's 20 reserved colors. Index 0 remains
      // the black/transparent key and must stay black, or undrawn battlefield regions appear color-key green.
      if (palette.caps & 0x40) return;
      palette.entries.set([0, 0, 0, 0], 0);
    }
    /** Returns null when the shim heap cannot hold the surface or its pixels; callers must report DDERR_OUTOFMEMORY. */
    protected createSurfaceFromDesc(desc: number): SurfaceState | null {
      const flags = this.readU32(desc + 4);
      const caps = this.readU32(desc + 104);
      const primary = (caps & 0x200) !== 0;
      const requestedWidth = (flags & 4) !== 0 ? this.readU32(desc + 12) : this.displayWidth;
      const requestedHeight = (flags & 2) !== 0 ? this.readU32(desc + 8) : this.displayHeight;
      // During initialization, DirectDraw wrappers may pass zero dimensions with WIDTH/HEIGHT flags;
      // Win9x drivers use the current display mode, so do not reduce these surfaces to 1x1.
      const width = requestedWidth || this.displayWidth || 800;
      const height = requestedHeight || this.displayHeight || 600;
      const surface = this.createSurface(width, height, caps);
      if (!surface) return null;
      const backBuffers = (flags & 0x20) !== 0 ? this.readU32(desc + 20) : 0;
      if (backBuffers > 0) {
        const back = this.createSurface(surface.width, surface.height, 0x4 | 0x40);
        // A flip chain without its back buffer would present garbage; release the front surface and fail the call.
        if (!back) {
          this.releaseComObject(surface.object);
          return null;
        }
        surface.attached = back.object;
        back.attached = surface.object;
      }
      if (primary) this.primarySurface = surface.object;
      return surface;
    }
    /** Returns null when the shim heap cannot hold the object or its pixels; never reports a surface at address 0. */
    protected createSurface(width: number, height: number, caps: number): SurfaceState | null {
      const object = this.createComObject(
        'IDirectDrawSurface',
        SURFACE_METHODS,
        'DDRAW.COM',
        this.gameProfile.directDraw?.guestSurfaceFastPath ? SURFACE_OBJECT_BYTES : 8,
      );
      if (!object) return null;
      const bpp = this.displayBpp === 16 ? 16 : 8;
      const pitch = (width * (bpp >>> 3) + 3) & ~3;
      const pixels = this.alloc(pitch * height, true);
      if (!pixels) {
        this.freeAllocation(object);
        return null;
      }
      const surface: SurfaceState = {
        object,
        width,
        height,
        pitch,
        bpp,
        pixels,
        caps,
        palette: 0,
        attached: 0,
        sourceColorKey: null,
        destinationColorKey: null,
        textRuns: [],
        lastDrawSerial: 0,
        dirty: false,
      };
      this.surfaces.set(object, surface);
      if (this.gameProfile.directDraw?.guestSurfaceFastPath) {
        this.refreshSurfaceDescCache(surface);
        const shell =
          this.gameProfile.shell?.compositeRgb565Layers &&
          width === this.displayWidth &&
          height === this.displayHeight &&
          bpp === 16;
        this.writeU32(
          object + SURFACE_UNLOCK_MODE,
          (caps & DDSCAPS_PRIMARYSURFACE) !== 0
            ? SURFACE_UNLOCK_PRIMARY
            : shell
              ? SURFACE_UNLOCK_SHELL
              : SURFACE_UNLOCK_GENERIC,
        );
        this.writeU32(object + SURFACE_UNLOCK_BUDGET, 0); // The first Unlock must enter the host.
      }
      return surface;
    }
    /**
     * 108-byte DDSURFACEDESC staging plus a reused DataView: Lock/GetDisplayMode run tens of thousands of times per second. Replace 13 write_blob calls with one to avoid intermediate states and allocations.
     */
    private readonly surfaceDescScratch = new Uint8Array(108);
    private readonly surfaceDescView = new DataView(this.surfaceDescScratch.buffer);

    protected writeSurfaceDesc(ptr: number, surface: SurfaceState): void {
      const bytes = this.surfaceDescScratch;
      const view = this.surfaceDescView;
      bytes.fill(0);
      view.setUint32(0, 108, true);
      view.setUint32(4, 0x180f, true); // CAPS | HEIGHT | WIDTH | PITCH | PIXELFORMAT | LPSURFACE
      view.setUint32(8, surface.height, true);
      view.setUint32(12, surface.width, true);
      view.setUint32(16, surface.pitch, true);
      view.setUint32(36, surface.pixels, true);
      // DDPIXELFORMAT, 32 bytes starting at 72, follows writePixelFormat branching; RA2's 16-bit
      // surfaces must not be reported as 8-bit palette formats.
      view.setUint32(72, 32, true); // DDPIXELFORMAT.dwSize
      if (surface.bpp === 16) {
        view.setUint32(76, 0x40, true); // DDPF_RGB
        view.setUint32(84, 16, true);
        view.setUint32(88, 0xf800, true);
        view.setUint32(92, 0x07e0, true);
        view.setUint32(96, 0x001f, true);
      } else {
        view.setUint32(76, 0x60, true); // DDPF_RGB | DDPF_PALETTEINDEXED8
        view.setUint32(84, 8, true);
      }
      view.setUint32(104, surface.caps, true);
      this.memory.write_memory(bytes, ptr);
    }

    /** After Flip swaps pixel pointers, synchronize the in-object descriptor read by RA2 Lock. */
    private refreshSurfaceDescCache(surface: SurfaceState): void {
      this.writeSurfaceDesc(surface.object + SURFACE_DESC_CACHE, surface);
    }
    protected writePixelFormat(ptr: number, bpp = this.displayBpp): void {
      this.zero(ptr, 32);
      this.writeU32(ptr, 32);
      if (bpp === 16) {
        this.writeU32(ptr + 4, 0x40); // DDPF_RGB
        this.writeU32(ptr + 12, 16);
        this.writeU32(ptr + 16, 0xf800);
        this.writeU32(ptr + 20, 0x07e0);
        this.writeU32(ptr + 24, 0x001f);
      } else {
        this.writeU32(ptr + 4, 0x60); // DDPF_RGB | DDPF_PALETTEINDEXED8
        this.writeU32(ptr + 12, 8);
      }
    }
    /** Record the most recently drawn fullscreen layer and select it by current display mode at presentation; see snapshotFrame. */
    protected noteShellSurfaceDraw(surface: SurfaceState): void {
      if (
        this.gameProfile.shell?.compositeRgb565Layers &&
        surface.width === this.displayWidth &&
        surface.height === this.displayHeight &&
        surface.bpp === 16
      ) {
        surface.lastDrawSerial = ++this.shellSurfaceDrawSerial;
        this.activeShellSurface = surface.object;
        this.writeU32(HYPERCALL_ACTIVE_SHELL_SURFACE, surface.object);
      }
    }
    protected blit(
      dest: SurfaceState,
      destRectPtr: number,
      sourceObject: number,
      sourceRectPtr: number,
      flags: number,
      effectsPtr: number,
    ): void {
      let destRect = destRectPtr ? this.readRect(destRectPtr) : [0, 0, dest.width, dest.height];
      if (destRect[2] <= destRect[0] || destRect[3] <= destRect[1]) {
        destRect = [0, 0, dest.width, dest.height];
      }
      // DDBLT_COLORFILL does not carry a source surface; the fill colour is the
      // 8-bit palette index in DDBLTFX.dwFillColor (offset 80).
      if (!sourceObject && flags & 0x400 && effectsPtr) {
        const mask = dest.bpp === 16 ? 0xffff : 0xff;
        this.fillRect(dest, destRect, this.readU32(effectsPtr + 80) & mask);
        return;
      }
      const source = this.surfaces.get(sourceObject);
      if (!source) return;
      const sourceRect = sourceRectPtr ? this.readRect(sourceRectPtr) : [0, 0, source.width, source.height];
      // Fullscreen presentation may still pass the windowed-mode global RECT, which stays empty in exclusive mode.
      // Old DirectDraw drivers treat it as the whole primary surface; normalize explicitly or all runtime custom drawing disappears.
      if (destRect[2] <= destRect[0] || destRect[3] <= destRect[1]) {
        destRect = [0, 0, dest.width, dest.height];
      }
      const sourceKey = flags & 0x8000 ? source.sourceColorKey : null; // DDBLT_KEYSRC
      const destinationKey = flags & 0x2000 ? dest.destinationColorKey : null; // DDBLT_KEYDEST
      this.copyRect(
        source,
        sourceRect,
        dest,
        destRect[0],
        destRect[1],
        destRect[2] - destRect[0],
        destRect[3] - destRect[1],
        sourceKey,
        destinationKey,
      );
    }
    protected blitFast(
      dest: SurfaceState,
      x: number,
      y: number,
      sourceObject: number,
      sourceRectPtr: number,
      flags: number,
    ): void {
      const source = this.surfaces.get(sourceObject);
      if (!source) return;
      const sourceRect = sourceRectPtr ? this.readRect(sourceRectPtr) : [0, 0, source.width, source.height];
      this.copyRect(
        source,
        sourceRect,
        dest,
        x | 0,
        y | 0,
        sourceRect[2] - sourceRect[0],
        sourceRect[3] - sourceRect[1],
        flags & 0x1 ? source.sourceColorKey : null, // DDBLTFAST_SRCCOLORKEY
        flags & 0x2 ? dest.destinationColorKey : null, // DDBLTFAST_DESTCOLORKEY
      );
    }
    protected copyRect(
      source: SurfaceState,
      sourceRect: number[],
      dest: SurfaceState,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
      sourceKey: [number, number] | null = null,
      destinationKey: [number, number] | null = null,
    ): void {
      const sx0 = sourceRect[0]! | 0;
      const sy0 = sourceRect[1]! | 0;
      const sw = Math.max(0, (sourceRect[2]! | 0) - sx0);
      const sh = Math.max(0, (sourceRect[3]! | 0) - sy0);
      const destWidth = Math.max(0, dw | 0);
      const destHeight = Math.max(0, dh | 0);
      if (sw <= 0 || sh <= 0 || destWidth <= 0 || destHeight <= 0) return;
      // Game-created front/back buffers share bit depth. Different depths have no reliable palette source;
      // skip with DirectDraw invalid-pixel-format semantics to avoid out-of-bounds guest-memory corruption.
      if (source.bpp !== dest.bpp) return;
      const bytesPerPixel = source.bpp >>> 3;

      // Equal-size Blt/BltFast is a per-frame battlefield hot path. Clip source and destination together,
      // especially negative destinations: the old implementation addressed before surface.pixels, letting edge
      // animations corrupt adjacent memory and create colored noise at the top.
      if (sw === destWidth && sh === destHeight) {
        let targetLeft = Math.max(0, dx);
        let targetTop = Math.max(0, dy);
        let sourceLeft = sx0 + targetLeft - dx;
        let sourceTop = sy0 + targetTop - dy;
        if (sourceLeft < 0) {
          targetLeft -= sourceLeft;
          sourceLeft = 0;
        }
        if (sourceTop < 0) {
          targetTop -= sourceTop;
          sourceTop = 0;
        }
        const targetRight = Math.min(dest.width, dx + destWidth, targetLeft + source.width - sourceLeft);
        const targetBottom = Math.min(dest.height, dy + destHeight, targetTop + source.height - sourceTop);
        const width = targetRight - targetLeft;
        const height = targetBottom - targetTop;
        if (width <= 0 || height <= 0) return;
        this.invalidateGdiTextRuns(dest, targetLeft, targetTop, targetRight, targetBottom);
        if (source.bpp === 8 && dest.bpp === 8) {
          this.transferGdiTextRuns(
            source,
            [sourceLeft, sourceTop, sourceLeft + width, sourceTop + height],
            dest,
            targetLeft,
            targetTop,
            width,
            height,
            sourceKey,
          );
        }
        this.copyUnscaledRect(
          source,
          sourceLeft,
          sourceTop,
          dest,
          targetLeft,
          targetTop,
          width,
          height,
          bytesPerPixel,
          sourceKey,
          destinationKey,
        );
        return;
      }

      // IDirectDrawSurface::Blt permits unequal source/destination RECT sizes. RA2 map previews and
      // UI animations shrink 198x99 surfaces to 144x72; use nearest-neighbor pixel-center mapping to retain
      // original RGB565 values and color-key semantics. BltFast never reaches this branch because its size comes from the source RECT.
      const targetLeft = Math.max(0, dx);
      const targetTop = Math.max(0, dy);
      const targetRight = Math.min(dest.width, dx + destWidth);
      const targetBottom = Math.min(dest.height, dy + destHeight);
      const width = targetRight - targetLeft;
      const height = targetBottom - targetTop;
      if (width <= 0 || height <= 0) return;
      this.invalidateGdiTextRuns(dest, targetLeft, targetTop, targetRight, targetBottom);
      const sourceBytes = this.memory.read_memory(source.pixels, source.pitch * source.height).slice();
      const destinationStart = dest.pixels + targetTop * dest.pitch + targetLeft * bytesPerPixel;
      const destinationSpan = (height - 1) * dest.pitch + width * bytesPerPixel;
      const destinationBytes = this.memory.read_memory(destinationStart, destinationSpan).slice();
      for (let row = 0; row < height; row++) {
        const targetY = targetTop + row;
        const sourceY = sy0 + Math.floor(((targetY - dy) * sh) / destHeight);
        if (sourceY < 0 || sourceY >= source.height) continue;
        for (let column = 0; column < width; column++) {
          const targetX = targetLeft + column;
          const sourceX = sx0 + Math.floor(((targetX - dx) * sw) / destWidth);
          if (sourceX < 0 || sourceX >= source.width) continue;
          const sourceOffset = sourceY * source.pitch + sourceX * bytesPerPixel;
          const destinationOffset = row * dest.pitch + column * bytesPerPixel;
          const sourcePixel =
            bytesPerPixel === 2
              ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
              : sourceBytes[sourceOffset]!;
          const destinationPixel =
            bytesPerPixel === 2
              ? destinationBytes[destinationOffset]! | (destinationBytes[destinationOffset + 1]! << 8)
              : destinationBytes[destinationOffset]!;
          const sourceTransparent = sourceKey && sourcePixel >= sourceKey[0] && sourcePixel <= sourceKey[1];
          const destinationBlocked =
            destinationKey && (destinationPixel < destinationKey[0] || destinationPixel > destinationKey[1]);
          if (!sourceTransparent && !destinationBlocked) {
            destinationBytes[destinationOffset] = sourcePixel & 0xff;
            if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourcePixel >>> 8;
          }
        }
      }
      this.memory.write_memory(destinationBytes, destinationStart);
    }

    protected copyUnscaledRect(
      source: SurfaceState,
      sourceLeft: number,
      sourceTop: number,
      dest: SurfaceState,
      targetLeft: number,
      targetTop: number,
      width: number,
      height: number,
      bytesPerPixel: number,
      sourceKey: [number, number] | null,
      destinationKey: [number, number] | null,
    ): void {
      const byteWidth = width * bytesPerPixel;
      const sourceStart = source.pixels + sourceTop * source.pitch + sourceLeft * bytesPerPixel;
      const destinationStart = dest.pixels + targetTop * dest.pitch + targetLeft * bytesPerPixel;
      const sourceSpan = (height - 1) * source.pitch + byteWidth;
      const destinationSpan = (height - 1) * dest.pitch + byteWidth;
      const sourceBytes = this.memory.read_memory(sourceStart, sourceSpan);
      if (!sourceKey && !destinationKey && source.pitch === byteWidth && dest.pitch === byteWidth) {
        this.memory.write_memory(sourceBytes, destinationStart);
        return;
      }
      // read_memory returns a guest-memory subarray view, not a copy. Modify that view directly to update
      // guest memory, eliminating a slice copy and write_memory per block. In the BlitFast hot path,
      // about 180,000 calls/sec in Tongyi Tianxia, these dominate allocation and memory round-trip overhead.
      const destinationBytes = this.memory.read_memory(destinationStart, destinationSpan);
      if (!sourceKey && !destinationKey) {
        for (let row = 0; row < height; row++) {
          destinationBytes.set(
            sourceBytes.subarray(row * source.pitch, row * source.pitch + byteWidth),
            row * dest.pitch,
          );
        }
        return;
      }
      // Separate pixel loops by color-key combination: source-only keying, commonly BltFast 0x11, need not read
      // the destination per pixel, saving one read and branch. Access 16-bit surfaces as two-byte pixels.
      if (sourceKey && !destinationKey) {
        const keyLow = sourceKey[0];
        const keyHigh = sourceKey[1];
        // Read/write aligned RGB565 as 16-bit values, avoiding repeated byte assembly/splitting per pixel.
        // Retain byte access for odd addresses or pitches; rounded views must not misread the next row.
        if (
          bytesPerPixel === 2 &&
          ((sourceBytes.byteOffset | destinationBytes.byteOffset | source.pitch | dest.pitch) & 1) === 0
        ) {
          const source16 = new Uint16Array(sourceBytes.buffer, sourceBytes.byteOffset, sourceSpan / 2);
          const destination16 = new Uint16Array(
            destinationBytes.buffer,
            destinationBytes.byteOffset,
            destinationSpan / 2,
          );
          const sourcePitch = source.pitch / 2;
          const destinationPitch = dest.pitch / 2;
          for (let row = 0; row < height; row++) {
            let sourceIndex = row * sourcePitch;
            let destinationIndex = row * destinationPitch;
            const end = sourceIndex + width;
            for (; sourceIndex < end; sourceIndex++, destinationIndex++) {
              const pixel = source16[sourceIndex]!;
              if (pixel < keyLow || pixel > keyHigh) destination16[destinationIndex] = pixel;
            }
          }
          return;
        }
        for (let row = 0; row < height; row++) {
          const sourceRow = row * source.pitch;
          const destinationRow = row * dest.pitch;
          for (let column = 0; column < width; column++) {
            const sourceOffset = sourceRow + column * bytesPerPixel;
            const sourceIndex =
              bytesPerPixel === 2
                ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
                : sourceBytes[sourceOffset]!;
            if (sourceIndex < keyLow || sourceIndex > keyHigh) {
              const destinationOffset = destinationRow + column * bytesPerPixel;
              destinationBytes[destinationOffset] = sourceIndex & 0xff;
              if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourceIndex >>> 8;
            }
          }
        }
        return;
      }
      if (destinationKey && !sourceKey) {
        const keyLow = destinationKey[0];
        const keyHigh = destinationKey[1];
        for (let row = 0; row < height; row++) {
          const sourceRow = row * source.pitch;
          const destinationRow = row * dest.pitch;
          for (let column = 0; column < width; column++) {
            const sourceOffset = sourceRow + column * bytesPerPixel;
            const destinationOffset = destinationRow + column * bytesPerPixel;
            const destinationIndex =
              bytesPerPixel === 2
                ? destinationBytes[destinationOffset]! | (destinationBytes[destinationOffset + 1]! << 8)
                : destinationBytes[destinationOffset]!;
            if (destinationIndex >= keyLow && destinationIndex <= keyHigh) {
              const sourceIndex =
                bytesPerPixel === 2
                  ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
                  : sourceBytes[sourceOffset]!;
              destinationBytes[destinationOffset] = sourceIndex & 0xff;
              if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourceIndex >>> 8;
            }
          }
        }
        return;
      }
      const sourceLow = sourceKey![0];
      const sourceHigh = sourceKey![1];
      const destinationLow = destinationKey![0];
      const destinationHigh = destinationKey![1];
      for (let row = 0; row < height; row++) {
        const sourceRow = row * source.pitch;
        const destinationRow = row * dest.pitch;
        for (let column = 0; column < width; column++) {
          const sourceOffset = sourceRow + column * bytesPerPixel;
          const destinationOffset = destinationRow + column * bytesPerPixel;
          const sourceIndex =
            bytesPerPixel === 2
              ? sourceBytes[sourceOffset]! | (sourceBytes[sourceOffset + 1]! << 8)
              : sourceBytes[sourceOffset]!;
          if (sourceIndex >= sourceLow && sourceIndex <= sourceHigh) continue;
          const destinationIndex =
            bytesPerPixel === 2
              ? destinationBytes[destinationOffset]! | (destinationBytes[destinationOffset + 1]! << 8)
              : destinationBytes[destinationOffset]!;
          if (destinationIndex < destinationLow || destinationIndex > destinationHigh) continue;
          destinationBytes[destinationOffset] = sourceIndex & 0xff;
          if (bytesPerPixel === 2) destinationBytes[destinationOffset + 1] = sourceIndex >>> 8;
        }
      }
    }
    protected fillRect(surface: SurfaceState, rect: number[], color: number): void {
      const left = Math.max(0, rect[0] ?? 0);
      const top = Math.max(0, rect[1] ?? 0);
      const right = Math.min(surface.width, rect[2] ?? surface.width);
      const bottom = Math.min(surface.height, rect[3] ?? surface.height);
      if (right <= left || bottom <= top) return;
      this.invalidateGdiTextRuns(surface, left, top, right, bottom);
      const width = right - left;
      const height = bottom - top;
      const bytesPerPixel = surface.bpp >>> 3;
      const byteWidth = width * bytesPerPixel;
      const start = surface.pixels + top * surface.pitch + left * bytesPerPixel;
      const row = new Uint8Array(byteWidth);
      if (bytesPerPixel === 2) {
        for (let offset = 0; offset < row.length; offset += 2) {
          row[offset] = color & 0xff;
          row[offset + 1] = (color >>> 8) & 0xff;
        }
      } else {
        row.fill(color & 0xff);
      }
      if (byteWidth === surface.pitch) {
        const block = new Uint8Array(byteWidth * height);
        for (let y = 0; y < height; y++) block.set(row, y * byteWidth);
        this.memory.write_memory(block, start);
        return;
      }
      const span = (height - 1) * surface.pitch + byteWidth;
      // As in copyUnscaledRect, modify views directly without slice plus writeback.
      const block = this.memory.read_memory(start, span);
      for (let y = 0; y < height; y++) block.set(row, y * surface.pitch);
    }
    protected addComRef(object: number): number {
      if (!object || !this.allocations.has(object)) return 0;
      const next = (this.readU32(object + 4) + 1) >>> 0;
      this.writeU32(object + 4, next);
      return next;
    }
    protected releaseComObject(object: number): number {
      if (!object || !this.allocations.has(object)) return 0;
      const current = this.readU32(object + 4);
      const next = current > 0 ? current - 1 : 0;
      this.writeU32(object + 4, next);
      if (next) return next;

      const surface = this.surfaces.get(object);
      if (surface) {
        this.surfaces.delete(object);
        this.freeAllocation(surface.pixels);
        if (this.primarySurface === object) this.primarySurface = 0;
        if (this.activeShellSurface === object) {
          this.activeShellSurface = 0;
          this.writeU32(HYPERCALL_ACTIVE_SHELL_SURFACE, 0);
        }
      }
      this.palettes.delete(object);
      const sound = this.soundBuffers.get(object);
      if (sound) {
        this.soundBuffers.delete(object);
        this.freeAllocation(sound.data);
        this.options.audio?.releaseBuffer(object);
      }
      this.freeAllocation(object);
      return 0;
    }
  };
}
