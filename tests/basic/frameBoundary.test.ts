/**
 * Migrated DirectDraw frame-boundary smoke tests: Unlock/VBlank submissions are all deferred through scheduleFrame. Dirty updates during an in-flight frame coalesce into one subsequent snapshot.
 * VBlank is a full-frame boundary: each wait is at most one 60 Hz refresh interval, and a pair of calls waits only once. In deferFrameSnapshot mode, a full mailbox delays snapshots and retains only the latest frame.
 *
 * The first test deliberately preserves the original script's sequential cumulative state (frames/scheduled/logicFrames across Unlock coalescing, VBlank, paired VBlank calls, and rescheduling while waiting).
 */
import { describe, expect, it } from 'vitest';
import {
  HYPERCALL_ACTIVE_SHELL_SURFACE,
  HYPERCALL_CURSOR_COUNT,
  HYPERCALL_CURSOR_X,
  HYPERCALL_CURSOR_Y,
} from '../../src/vm86/pe';
import type { VmFrame, Win32Result } from '../../src/vm86/win32';
import type { Win32Shim } from '../../src/games/win32Shim';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeU32,
  type FakeGuestMemory,
} from '../helpers/guestMemory';

const surfaceDesc = (memory: FakeGuestMemory, address: number) => {
  writeU32(memory, address, 108);
  writeU32(memory, address + 4, 6); // DDSD_HEIGHT | DDSD_WIDTH
  writeU32(memory, address + 8, 4);
  writeU32(memory, address + 12, 4);
  writeU32(memory, address + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
};

/** Original script's dispatch: assert that the import is implemented and returns DD_OK; return Win32Result to inspect delayMs. */
const dispatchOk = (shim: Win32Shim, key: string, args: number[]): Win32Result => {
  const result = callShim(shim, key, args);
  expect(result.eax, `${key} should return DD_OK`).toBe(0);
  return result;
};

describe('DirectDraw 帧边界（原 frameBoundarySmoke）', () => {
  it('鼠标边界跟随实际呈现帧而不是尚未呈现的 primary surface', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    const shim = createTestShim(memory, { gameId: 'ra2', onFrame: (frame) => frames.push(frame) });
    const windowState = shim as unknown as {
      primaryWindow: number;
      windows: Map<number, number>;
      windowRects: Map<number, { x: number; y: number; width: number; height: number }>;
    };
    windowState.primaryWindow = 0x2000;
    windowState.windows.set(0x2000, 0x401000);
    windowState.windowRects.set(0x2000, { x: 0, y: 0, width: 800, height: 600 });
    dispatchOk(shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 800, 600, 16]);
    shim.setCursorPosition(1439, 899);
    expect(readU32(memory, HYPERCALL_CURSOR_X)).toBe(799);
    expect(readU32(memory, HYPERCALL_CURSOR_Y)).toBe(599);

    const desc = 0x10_000;
    const out = 0x10_100;
    writeU32(memory, desc, 108);
    writeU32(memory, desc + 4, 6); // DDSD_HEIGHT | DDSD_WIDTH
    writeU32(memory, desc + 8, 900);
    writeU32(memory, desc + 12, 1440);
    writeU32(memory, desc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
    dispatchOk(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    const highResolutionPrimary = readU32(memory, out);
    const lockDesc = 0x10_200;
    dispatchOk(shim, 'DDRAW.COM!IDirectDrawSurface.Lock', [highResolutionPrimary, 0, lockDesc, 0, 0]);
    dispatchOk(shim, 'DDRAW.COM!IDirectDrawSurface.Unlock', [highResolutionPrimary, readU32(memory, lockDesc + 36)]);
    expect(frames.at(-1)?.width).toBe(1440);

    shim.setCursorPosition(1439, 899);
    expect(shim.inspectPointerState()).toMatchObject({
      x: 1439,
      y: 899,
      width: 1440,
      height: 900,
      clientWidth: 1440,
      clientHeight: 900,
    });
    expect(readU32(memory, HYPERCALL_CURSOR_X)).toBe(1439);
    expect(readU32(memory, HYPERCALL_CURSOR_Y)).toBe(899);

    // RA2 may register the next 800x600 primary while the old battle frame is still displayed. Do not suddenly
    // clamp the locked mouse to 799x599 until the new surface actually produces a presented frame.
    writeU32(memory, desc + 8, 600);
    writeU32(memory, desc + 12, 800);
    dispatchOk(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    shim.setCursorPosition(1439, 899);
    expect(shim.inspectPointerState()).toMatchObject({
      x: 1439,
      y: 899,
      width: 1440,
      height: 900,
      clientWidth: 1440,
      clientHeight: 900,
    });
  });

  it('默认 profile 不扩展 RA2 专用的 surface 客体布局', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const desc = 0x10_000;
    const out = 0x10_100;
    surfaceDesc(memory, desc);
    dispatchOk(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    const primary = readU32(memory, out);

    expect(readU32(memory, primary + 8)).toBe(0);
  });

  it('帧携带独立小光标层，移动光标不复制 framebuffer', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    const shim = createTestShim(memory, { gameId: 'ra2', onFrame: (frame) => frames.push(frame) });
    const cursorRgba = new Uint8Array([0xff, 0, 0, 0xff, 0, 0xff, 0, 0xff]);
    const cursorState = shim as unknown as {
      cursorImages: Map<
        number,
        {
          width: number;
          height: number;
          hotspotX: number;
          hotspotY: number;
          rgba: Uint8Array;
        }
      >;
      currentCursorHandle: number;
    };
    cursorState.currentCursorHandle = 0x9001;
    cursorState.cursorImages.set(0x9001, {
      width: 2,
      height: 1,
      hotspotX: 1,
      hotspotY: 0,
      rgba: cursorRgba,
    });
    shim.setCursorPosition(2, 3);
    const desc = 0x10_000;
    const out = 0x10_100;
    surfaceDesc(memory, desc);
    dispatchOk(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    const primary = readU32(memory, out);

    dispatchOk(shim, 'DDRAW.COM!IDirectDrawSurface.Unlock', [primary, readU32(memory, primary + 44)]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.cursor).toMatchObject({
      handle: 0x9001,
      width: 2,
      height: 1,
      hotspotX: 1,
      hotspotY: 0,
      x: 2,
      y: 3,
    });
    expect(frames[0]!.cursor!.rgba).toEqual(cursorRgba);
    expect(frames[0]!.cursor!.rgba).not.toBe(cursorRgba);

    shim.setCursorPosition(4, 5);
    expect(frames).toHaveLength(1);

    writeU32(memory, HYPERCALL_CURSOR_COUNT, 0xffff_ffff);
    dispatchOk(shim, 'DDRAW.COM!IDirectDrawSurface.Unlock', [primary, readU32(memory, primary + 44)]);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.cursor).toBeUndefined();
  });

  it('RA2 primary Unlock 始终回 host，非 primary 使用有界预算', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    const shim = createTestShim(memory, { gameId: 'ra2', onFrame: (frame) => frames.push(frame) });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);
    const desc = 0x10_000;
    const out = 0x10_100;
    surfaceDesc(memory, desc);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    const primary = readU32(memory, out);
    const vtable = readU32(memory, primary);
    const lockStub = readU32(memory, vtable + 25 * 4);
    const unlockStub = readU32(memory, vtable + 32 * 4);

    expect(readU32(memory, primary + 8)).toBe(108); // DDSURFACEDESC at the end of the object
    expect(memory.read_memory(lockStub, 2)).toEqual(new Uint8Array([0x56, 0x57]));
    expect(memory.read_memory(unlockStub, 4)).toEqual(new Uint8Array([0x8b, 0x4c, 0x24, 0x04]));
    expect(readU32(memory, primary + 116)).toBe(2); // Primary mode
    expect(readU32(memory, primary + 120)).toBe(0);

    // Every Unlock must mark dirty and submit even without a host Lock, preserving input/cursor presentation boundaries.
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, readU32(memory, primary + 8 + 36)]);
    expect(frames).toHaveLength(1);
    expect(readU32(memory, primary + 120)).toBe(0); // No fast-path budget for the primary

    const offscreenDesc = 0x10_200;
    const offscreenOut = 0x10_300;
    surfaceDesc(memory, offscreenDesc);
    writeU32(memory, offscreenDesc + 104, 0);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, offscreenDesc, offscreenOut, 0]);
    const offscreen = readU32(memory, offscreenOut);
    expect(readU32(memory, offscreen + 116)).toBe(0); // generic offscreen
    expect(readU32(memory, offscreen + 120)).toBe(0); // The first call still returns to the host
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [offscreen, readU32(memory, offscreen + 8 + 36)]);
    expect(readU32(memory, offscreen + 120)).toBe(7); // Then at most seven fast calls
  });

  it('RA2 shell surface Unlock 同步活跃层，换层时客体桩可强制回 host', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      gameId: 'ra2',
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);
    dispatch('DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 800, 600, 16]);
    const desc = 0x10_000;
    const out = 0x10_100;
    surfaceDesc(memory, desc);
    writeU32(memory, desc + 8, 600);
    writeU32(memory, desc + 12, 800);
    writeU32(memory, desc + 104, 0);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    const shell = readU32(memory, out);
    expect(readU32(memory, shell + 116)).toBe(1);
    expect(readU32(memory, HYPERCALL_ACTIVE_SHELL_SURFACE)).toBe(0);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [shell, readU32(memory, shell + 8 + 36)]);
    expect(readU32(memory, HYPERCALL_ACTIVE_SHELL_SURFACE)).toBe(shell);
    expect(readU32(memory, shell + 120)).toBe(7);
  });

  it('含 USER32 标准控件的 shell 合成不修改客体 surface', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    const shim = createTestShim(memory, {
      gameProfile: {
        directDraw: { guestSurfaceFastPath: true },
        shell: { compositeRgb565Layers: true, defaultSourceColorKey: [0, 0] },
      },
      onFrame: (frame) => frames.push(frame),
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);
    dispatch('DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 800, 600, 16]);
    const create = (desc: number, out: number, caps: number) => {
      surfaceDesc(memory, desc);
      writeU32(memory, desc + 8, 600);
      writeU32(memory, desc + 12, 800);
      writeU32(memory, desc + 104, caps);
      dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
      return readU32(memory, out);
    };
    const primary = create(0x10_000, 0x10_100, 0x200);
    const background = create(0x10_200, 0x10_300, 0);
    const primaryPixels = readU32(memory, primary + 44);
    const backgroundPixels = readU32(memory, background + 44);
    memory.write_memory([0x00, 0xf8, 0x00, 0xf8], primaryPixels); // RGB565 red
    memory.write_memory([0xe0, 0x07, 0xe0, 0x07], backgroundPixels); // RGB565 green
    memory.write_memory([0x00, 0xf8, 0x00, 0xf8, 0x00, 0xf8, 0x00, 0xf8], primaryPixels + 8);
    memory.write_memory([0xe0, 0x07, 0xe0, 0x07, 0xe0, 0x07, 0xe0, 0x07], backgroundPixels + 8);
    memory.write_memory(
      [0xe0, 0x07, 0xe0, 0x07, 0xe0, 0x07, 0xe0, 0x07],
      backgroundPixels + readU32(memory, background + 24) + 8,
    );
    const shellState = shim as unknown as {
      shellPageTitle: string;
      windowClassNames: Map<number, string>;
      windowLongs: Map<string, number>;
      windowParents: Map<number, number>;
      windowRects: Map<number, { x: number; y: number; width: number; height: number }>;
      isShellVisible(): boolean;
    };
    shellState.windowClassNames.set(0x1200, '#32770');
    shellState.windowLongs.set('4608:-16', 0x1000_0000); // WS_VISIBLE
    shellState.windowRects.set(0x1200, { x: 0, y: 0, width: 800, height: 600 });
    shellState.shellPageTitle = 'GUI:SkirmishGame';
    expect(shellState.isShellVisible()).toBe(true);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [background, readU32(memory, background + 44)]);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, readU32(memory, primary + 44)]);
    frames.length = 0;
    memory.write_memory([0x00, 0xf8, 0x00, 0xf8], readU32(memory, background + 44));
    shellState.shellPageTitle = ''; // Simulate temporary title-control destruction during a page switch
    shellState.windowClassNames.set(0x1234, 'ListBox');
    shellState.windowLongs.set('4660:-16', 0x1000_0000); // WS_VISIBLE
    shellState.windowParents.set(0x1234, 0x1200);
    shellState.windowClassNames.set(0x1250, 'ComboBox');
    shellState.windowLongs.set('4688:-16', 0); // Already hidden by ShowWindow(SW_HIDE)
    shellState.windowParents.set(0x1250, 0x1200);
    shellState.windowRects.set(0x1250, { x: 4, y: 0, width: 4, height: 4 });
    shellState.windowClassNames.set(0x1260, 'Static');
    shellState.windowLongs.set('4704:-16', 0); // Template placeholder hidden from creation
    shellState.windowParents.set(0x1260, 0x1200);
    shellState.windowRects.set(0x1260, { x: 0, y: 0, width: 1, height: 1 });
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [background, readU32(memory, background + 44)]);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, readU32(memory, primary + 44)]);

    expect(frames).toHaveLength(1);
    expect([...frames[0]!.rgba!.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...frames[0]!.rgba!.subarray(16, 20)]).toEqual([255, 0, 0, 255]);
    expect(memory.read_memory(primaryPixels + 8, 2)).toEqual(new Uint8Array([0x00, 0xf8]));
  });

  it('退出 shell 后游戏内 Tab 设置面板不重新激活旧菜单层', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      gameProfile: {
        directDraw: { guestSurfaceFastPath: true },
        shell: { compositeRgb565Layers: true, defaultSourceColorKey: [0, 0] },
      },
    });
    const desc = 0x10_000;
    const out = 0x10_100;
    surfaceDesc(memory, desc);
    writeU32(memory, desc + 8, 600);
    writeU32(memory, desc + 12, 800);
    callShim(shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 800, 600, 16]);
    dispatchOk(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);

    const state = shim as unknown as {
      shellPageTitle: string;
      windowClassNames: Map<number, string>;
      windowLongs: Map<string, number>;
      windowRects: Map<number, { x: number; y: number; width: number; height: number }>;
      isShellVisible(): boolean;
    };
    state.windowClassNames.set(0x1200, '#32770');
    state.windowLongs.set('4608:-16', 0x1000_0000);
    state.windowRects.set(0x1200, { x: 0, y: 0, width: 800, height: 600 });
    state.shellPageTitle = 'GUI:SkirmishGame';
    expect(state.isShellVisible()).toBe(true);

    state.windowLongs.set('4608:-16', 0);
    state.shellPageTitle = '';
    expect(state.isShellVisible()).toBe(false);
    state.windowClassNames.set(0x1201, '#32770');
    state.windowLongs.set('4609:-16', 0x1000_0000);
    state.windowRects.set(0x1201, { x: 140, y: 90, width: 520, height: 420 });
    expect(state.isShellVisible()).toBe(false);
  });

  it('离屏层交替 Unlock 不覆盖完整的 primary', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      onFrame: (frame) => frames.push(frame),
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);
    dispatch('DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 800, 600, 16]);
    const create = (desc: number, out: number, caps: number) => {
      surfaceDesc(memory, desc);
      writeU32(memory, desc + 8, 600);
      writeU32(memory, desc + 12, 800);
      writeU32(memory, desc + 104, caps);
      dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
      return readU32(memory, out);
    };
    const primary = create(0x10_000, 0x10_100, 0x200);
    const background = create(0x10_200, 0x10_300, 0);
    const overlay = create(0x10_400, 0x10_500, 0x800);
    memory.write_memory([0xe0, 0x07], readU32(memory, primary + 44)); // RGB565 green
    memory.write_memory([0x1f, 0x00], readU32(memory, background + 44)); // RGB565 blue
    memory.write_memory([0x00, 0xf8], readU32(memory, overlay + 44)); // RGB565 red
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [overlay, readU32(memory, overlay + 44)]);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [background, readU32(memory, background + 44)]);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, readU32(memory, primary + 44)]);

    expect(frames).toHaveLength(1);
    expect([...frames[0]!.rgba!.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
  });

  it('离屏 surface 的源色键不参与 primary 快照', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      onFrame: (frame) => frames.push(frame),
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);
    dispatch('DDRAW.COM!IDirectDraw.SetDisplayMode', [0, 800, 600, 16]);
    const create = (desc: number, out: number, caps: number) => {
      surfaceDesc(memory, desc);
      writeU32(memory, desc + 8, 600);
      writeU32(memory, desc + 12, 800);
      writeU32(memory, desc + 104, caps);
      dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
      return readU32(memory, out);
    };
    const primary = create(0x10_000, 0x10_100, 0x200);
    const background = create(0x10_200, 0x10_300, 0);
    const overlay = create(0x10_400, 0x10_500, 0x800);
    const backgroundPixels = readU32(memory, background + 44);
    const overlayPixels = readU32(memory, overlay + 44);
    memory.write_memory([0xe0, 0x07, 0x00, 0xf8], readU32(memory, primary + 44)); // Green, red
    memory.write_memory([0x1f, 0x00, 0x1f, 0x00], backgroundPixels); // Blue
    memory.write_memory([0x34, 0x12, 0x00, 0x00], overlayPixels);
    writeU32(memory, 0x10_600, 0x1234);
    writeU32(memory, 0x10_604, 0x1234);
    dispatch('DDRAW.COM!IDirectDrawSurface.SetColorKey', [overlay, 0x8, 0x10_600]);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [background, backgroundPixels]);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [overlay, overlayPixels]);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, readU32(memory, primary + 44)]);

    expect(frames).toHaveLength(1);
    expect([...frames[0]!.rgba!.subarray(0, 8)]).toEqual([0, 255, 0, 255, 255, 0, 0, 255]);
  });

  it('Unlock/VBlank 延迟提交 + 在途帧 dirty 合并 + VBlank 对有界等待', () => {
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    let logicFrames = 0;
    let scheduled: (() => void) | null = null;
    const shim = createTestShim(memory, {
      onFrame: (frame) => frames.push(frame),
      onLogicFrame: () => {
        logicFrames++;
      },
      scheduleFrame: (emit) => {
        scheduled = emit;
      },
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);

    const primaryDesc = 0x10_000;
    const primaryOut = 0x10_100;
    surfaceDesc(memory, primaryDesc);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, primaryDesc, primaryOut, 0]);
    const primary = readU32(memory, primaryOut);

    const primarySurfaceDesc = 0x12_000;
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, primarySurfaceDesc, 0, 0]);
    const primaryPixels = readU32(memory, primarySurfaceDesc + 36);

    memory.write_memory(new Uint8Array(16).fill(7), primaryPixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, primaryPixels]);
    expect(frames.length, 'Unlock delivery should remain deferred').toBe(0);
    expect(scheduled, 'Unlock should schedule delivery when a scheduler is provided').toBeTruthy();
    // Keep modifying the surface before the first frame is presented: do not create/register a second scheduler callback,
    // but retain dirty state. After sending the first frame, automatically schedule a snapshot containing the latest pixels.
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, primarySurfaceDesc, 0, 0]);
    memory.write_memory(new Uint8Array(16).fill(8), primaryPixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, primaryPixels]);
    // scheduled is assigned inside the scheduleFrame closure, but TS narrows it to its initial null; explicitly restore its declared type.
    const deliverUnlock: (() => void) | null = scheduled;
    scheduled = null;
    deliverUnlock!();
    expect(frames.length).toBe(1);
    expect(Array.from(frames[0]!.pixels)).toEqual(new Array(16).fill(7));
    expect(scheduled, 'dirty updates during an in-flight frame should schedule one follow-up snapshot').toBeTruthy();
    const deliverCoalesced: (() => void) | null = scheduled;
    scheduled = null;
    deliverCoalesced!();
    expect(frames.length).toBe(2);
    expect(Array.from(frames[1]!.pixels)).toEqual(new Array(16).fill(8));

    // VBlank is a complete-frame boundary and must yield for one 60 Hz refresh.
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, primarySurfaceDesc, 0, 0]);
    const vblankPixels = readU32(memory, primarySurfaceDesc + 36);
    memory.write_memory(new Uint8Array(16).fill(9), vblankPixels);
    const vblank = dispatch('DDRAW.COM!IDirectDraw.WaitForVerticalBlank', [0, 1]);
    expect(logicFrames, 'first VBlank in a pair should count one guest logic frame').toBe(1);
    expect(
      vblank.delayMs !== undefined && vblank.delayMs >= 0 && vblank.delayMs <= 17,
      `VBlank should stay within one refresh period, got ${vblank.delayMs}`,
    ).toBeTruthy();
    expect(frames.length, 'VBlank delivery should remain deferred').toBe(2);
    expect(scheduled, 'VBlank should schedule a complete frame').toBeTruthy();
    const deliverVblank: (() => void) | null = scheduled;
    scheduled = null;
    deliverVblank!();
    expect(frames.length).toBe(3);
    expect(Array.from(frames[2]!.pixels)).toEqual(new Array(16).fill(9));
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, vblankPixels]);

    // The original battle loop invokes BLOCKBEGIN twice per frame. The second call
    // must return immediately; otherwise the 60 Hz wait is paid twice and FPS falls
    // to about 30. The next pair may wait for one refresh.
    const secondExistingPairCall = dispatch('DDRAW.COM!IDirectDraw.WaitForVerticalBlank', [0, 1]);
    const firstNextPairCall = dispatch('DDRAW.COM!IDirectDraw.WaitForVerticalBlank', [0, 1]);
    const secondNextPairCall = dispatch('DDRAW.COM!IDirectDraw.WaitForVerticalBlank', [0, 1]);
    expect(logicFrames, 'three additional VBlank calls should complete exactly one new logic frame pair').toBe(2);
    expect((secondExistingPairCall.delayMs ?? 0) <= 1, 'the second VBlank call in a pair must not wait').toBeTruthy();
    expect((firstNextPairCall.delayMs ?? 0) >= 0 && (firstNextPairCall.delayMs ?? 0) <= 17).toBeTruthy();
    expect((secondNextPairCall.delayMs ?? 0) <= 1, 'each VBlank pair should wait at most once').toBeTruthy();

    // A second surface update while waiting for scheduling must not be permanently swallowed by frameScheduled.
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, primarySurfaceDesc, 0, 0]);
    const firstPendingPixels = readU32(memory, primarySurfaceDesc + 36);
    memory.write_memory(new Uint8Array(16).fill(11), firstPendingPixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, firstPendingPixels]);
    expect(scheduled, 'the first pending update should schedule delivery').toBeTruthy();
    const firstPendingDelivery: (() => void) | null = scheduled;
    scheduled = null;

    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, primarySurfaceDesc, 0, 0]);
    const secondPendingPixels = readU32(memory, primarySurfaceDesc + 36);
    memory.write_memory(new Uint8Array(16).fill(13), secondPendingPixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, secondPendingPixels]);
    firstPendingDelivery!();
    expect(scheduled, 'a second update during delivery wait should be rescheduled').toBeTruthy();
    const secondPendingDelivery: (() => void) | null = scheduled;
    scheduled = null;
    secondPendingDelivery!();
    expect(Array.from(frames.at(-1)!.pixels)).toEqual(new Array(16).fill(13));
  });

  it('deferFrameSnapshot：mailbox 满时延迟取快照，只保留最新画面', () => {
    // When the Worker mailbox is full, defer the snapshot and retain only the latest frame to avoid repeatedly copying stale frames at 4x.
    const memory = createGuestMemory();
    const frames: VmFrame[] = [];
    let scheduled: (() => void) | null = null;
    const shim = createTestShim(memory, {
      onFrame: (frame) => frames.push(frame),
      scheduleFrame: (emit) => {
        scheduled = emit;
      },
      deferFrameSnapshot: true,
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);

    const desc = 0x10_000;
    const out = 0x10_100;
    surfaceDesc(memory, desc);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    const primary = readU32(memory, out);
    const surfaceDescOut = 0x12_000;
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, surfaceDescOut, 0, 0]);
    const pixels = readU32(memory, surfaceDescOut + 36);
    memory.write_memory(new Uint8Array(16).fill(17), pixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, pixels]);
    expect(scheduled).toBeTruthy();
    const deliverDeferred: (() => void) | null = scheduled;
    scheduled = null;
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [primary, 0, surfaceDescOut, 0, 0]);
    const latestPixels = readU32(memory, surfaceDescOut + 36);
    memory.write_memory(new Uint8Array(16).fill(19), latestPixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, latestPixels]);
    deliverDeferred!();
    expect(Array.from(frames[0]!.pixels)).toEqual(new Array(16).fill(19));
    expect(scheduled, 'latest deferred snapshot should clear dirty state once').toBe(null);
  });
});
