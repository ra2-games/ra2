/** The guest already draws the map list; host presentation must not overwrite these pixels using a cached selection index. */
import { describe, expect, it } from 'vitest';
import type { SurfaceState, VmFrame } from '../../src/vm86/win32';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

const W = 800;
const H = 600;
// List geometry: three rows, each 16 pixels high, at screen y = LIST_Y..LIST_Y+48.
const LIST_X = 100;
const LIST_Y = 100;
const LIST_W = 200;
const LIST_H = 64;
const ROW_H = 16;

type FakeMemory = ReturnType<typeof createGuestMemory>;

/** Write a 16bpp RGB565 pixel. */
function write565(memory: FakeMemory, address: number, value: number): void {
  memory.write_memory([value & 0xff, value >>> 8], address);
}

/** Convert 0xR,G,B to RGB565 and write it. */
function seed565(memory: FakeMemory, address: number, r: number, g: number, b: number): void {
  write565(memory, address, ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3));
}

/** Fill a rectangle in the primary surface with one RGB565 value. */
function fillArea(
  memory: FakeMemory,
  surface: SurfaceState,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value565: number,
): void {
  const rowBuffer = new Uint8Array((x1 - x0) * 2);
  for (let i = 0; i < rowBuffer.length; i += 2) {
    rowBuffer[i] = value565 & 0xff;
    rowBuffer[i + 1] = value565 >>> 8;
  }
  for (let y = y0; y < y1; y++) {
    memory.write_memory(rowBuffer, surface.pixels + y * surface.pitch + x0 * 2);
  }
}

interface PageHarness {
  memory: FakeMemory;
  shim: ReturnType<typeof createTestShim>;
  frames: VmFrame[];
  primary: SurfaceState;
  hwnd: number;
  bg: SurfaceState;
  unlockPrimary: () => void;
}

function setupPage(id: number): PageHarness {
  const memory = createGuestMemory();
  const frames: VmFrame[] = [];
  const shim = createTestShim(memory, { gameId: 'ra2', onFrame: (frame) => frames.push(frame) });
  (shim as unknown as { shellPageTitle: string }).shellPageTitle = 'choosemap';

  // Both map and mode lists are drawn through the guest window procedure.
  writeAsciiZ(memory, 0x60_000, 'ListBox');
  const hwnd = callShim(shim, 'USER32.DLL!CreateWindowExA', [
    0,
    0x60_000,
    0,
    0x5000_0000,
    LIST_X,
    LIST_Y,
    LIST_W,
    LIST_H,
    0,
    id,
    0,
    0,
  ]).eax;
  expect(hwnd).toBeGreaterThan(0);
  const send = (message: number, w = 0, l = 0) => callShim(shim, 'USER32.DLL!SendMessageA', [hwnd, message, w, l]).eax;
  writeAsciiZ(memory, 0x61_000, '第一张地图');
  send(0x0180, 0, 0x61_000); // LB_ADDSTRING
  writeAsciiZ(memory, 0x61_000, '第二张地图');
  send(0x0180, 0, 0x61_000);
  writeAsciiZ(memory, 0x61_000, '第三张地图');
  send(0x0180, 0, 0x61_000);
  send(0x01a0, 0, ROW_H); // LB_SETITEMHEIGHT

  // DirectDraw: primary + fullscreen caps=0 background working layer.
  callShim(shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [0, W, H, 16]);
  const desc = 0x10_000;
  const out = 0x10_100;
  const createSurface = (caps: number): SurfaceState => {
    writeU32(memory, desc, 108);
    writeU32(memory, desc + 4, 6 | 1); // DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT
    writeU32(memory, desc + 8, H);
    writeU32(memory, desc + 12, W);
    writeU32(memory, desc + 104, caps);
    const result = callShim(shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, desc, out, 0]);
    expect(result.eax).toBe(0);
    const surfaces = (
      shim as unknown as {
        surfaces: Map<number, SurfaceState>;
      }
    ).surfaces;
    return surfaces.get(readU32(memory, out))!;
  };
  const bg = createSurface(0);
  const primary = createSurface(0x200);

  return {
    memory,
    shim,
    frames,
    primary,
    hwnd,
    bg,
    unlockPrimary: () => {
      callShim(shim, 'DDRAW.COM!IDirectDrawSurface.Unlock', [primary.object, primary.pixels]);
    },
  };
}

/** Use a gray background with white text on the specified row to simulate list text. */
function paintRows(harness: PageHarness, textRow: number): void {
  const { memory, primary, bg } = harness;
  fillArea(memory, bg, 0, 0, W, H, 0x001f); // Background layer: blue
  fillArea(memory, primary, 0, 0, W, H, 0x39e7); // Primary surface: gray 60
  if (textRow >= 0) {
    seed565(
      memory,
      primary.pixels + (LIST_Y + textRow * ROW_H + 8) * primary.pitch + (LIST_X + 60) * 2,
      0xff,
      0xff,
      0xff,
    );
  }
}

const select = (harness: PageHarness, index: number): void => {
  callShim(harness.shim, 'USER32.DLL!SendMessageA', [harness.hwnd, 0x0186, index, 0]); // LB_SETCURSEL
};

describe('ChooseMap 客体画面保持', () => {
  it.each([1363, 1771])('列表 %i 重建、移动或更换选择时不覆写客体画面', (id) => {
    const page = setupPage(id);
    paintRows(page, 1);
    // Guest lists can scroll, so the selection index differs from the screen row; preserve both red content and white text.
    fillArea(page.memory, page.primary, LIST_X, LIST_Y, LIST_X + LIST_W, LIST_Y + ROW_H, 0xf800);
    page.unlockPrimary();
    const before = page.frames.at(-1)!.rgba!.slice();

    for (const index of [2, 0, -1, 1]) {
      select(page, index);
      page.unlockPrimary();
      expect(Buffer.from(page.frames.at(-1)!.rgba!).equals(before)).toBe(true);
    }
    callShim(page.shim, 'USER32.DLL!SendMessageA', [page.hwnd, 0x0184, 0, 0]); // LB_RESETCONTENT
    callShim(page.shim, 'USER32.DLL!SendMessageA', [page.hwnd, 0x0180, 0, 0]); // LB_ADDSTRING
    select(page, 0);
    callShim(page.shim, 'USER32.DLL!MoveWindow', [page.hwnd, LIST_X + 20, LIST_Y, LIST_W, LIST_H, 1]);
    page.unlockPrimary();
    expect(Buffer.from(page.frames.at(-1)!.rgba!).equals(before)).toBe(true);
  });
});
