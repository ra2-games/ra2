import { describe, expect, it } from 'vitest';
import type { SurfaceState, VmFrame } from '../../src/vm86/win32';
import { createGuestMemory, createTestShim } from '../helpers/guestMemory';

function fixture(packedRgb565Frames = false) {
  const memory = createGuestMemory();
  // Campaign-page compensation is game-profile-specific; use the same RA2 registration as the smoke test.
  const shim = createTestShim(memory, { gameId: 'ra2', onFrame: () => {}, packedRgb565Frames }) as unknown as {
    displayBpp: number;
    primarySurface: number;
    shellPageTitle: string;
    windowZOrder: number[];
    windows: Map<number, number>;
    windowClassNames: Map<number, string>;
    windowLongs: Map<string, number>;
    windowRects: Map<number, { x: number; y: number; width: number; height: number }>;
    createSurface(width: number, height: number, caps: number): SurfaceState;
    snapshotFrame(surface: SurfaceState): VmFrame;
    copyRect(
      source: SurfaceState,
      rect: number[],
      target: SurfaceState,
      x: number,
      y: number,
      width: number,
      height: number,
      key: [number, number],
      destinationKey?: [number, number],
    ): void;
  };
  shim.displayBpp = 16;
  return { memory, shim };
}

describe('RGB565 绘图快速路径', () => {
  it('可见滚动条强制 RGBA 合成，隐藏后才恢复 GPU 直传', () => {
    const { shim } = fixture(true);
    const surface = shim.createSurface(32, 32, 0x200);
    shim.primarySurface = surface.object;
    const hwnd = 0x9000;
    shim.windows.set(hwnd, 0);
    shim.windowZOrder.push(hwnd);
    shim.windowClassNames.set(hwnd, 'SCROLLBAR');
    shim.windowRects.set(hwnd, { x: 0, y: 0, width: 12, height: 32 });
    shim.windowLongs.set(`${hwnd}:-16`, 0x10000001);
    const visible = shim.snapshotFrame(surface);
    expect(visible.rgb565).toBeUndefined();
    expect(visible.rgba?.some((byte) => byte !== 0 && byte !== 255)).toBe(true);
    shim.windowLongs.set(`${hwnd}:-16`, 1);
    expect(shim.snapshotFrame(surface).rgb565).toHaveLength(1024);
  });
  it('紧凑帧跳过 padding、拥有独立缓冲区，菜单修复时退回 RGBA', () => {
    const { memory, shim } = fixture(true);
    const surface = shim.createSurface(3, 2, 0x200);
    shim.primarySurface = surface.object;
    memory.write_memory([0, 248, 224, 7, 31, 0, 123, 123, 255, 255, 0, 0, 0x10, 0x84, 123, 123], surface.pixels);
    const frame = shim.snapshotFrame(surface);
    expect([...frame.rgb565!]).toEqual([0xf800, 0x07e0, 0x001f, 0xffff, 0, 0x8410]);
    expect(frame.rgba).toBeUndefined();
    memory.bytes.fill(0, surface.pixels, surface.pixels + 16);
    expect(frame.rgb565![0]).toBe(0xf800);
    const transferred = structuredClone(frame, { transfer: [frame.rgb565!.buffer] });
    expect(transferred.rgb565![0]).toBe(0xf800);
    expect(memory.bytes.byteLength).toBeGreaterThan(0);
    shim.shellPageTitle = 'campaignmenu';
    const menuFrame = shim.snapshotFrame(surface);
    expect(menuFrame.rgb565).toBeUndefined();
    expect(menuFrame.rgba).toHaveLength(24);
  });
  for (const oddAddress of [false, true]) {
    it(`快照跳过行尾填充，颜色保持一致（奇数地址=${oddAddress}）`, () => {
      const { memory, shim } = fixture();
      const surface = shim.createSurface(3, 2, 0x200);
      if (oddAddress) surface.pixels++;
      shim.primarySurface = surface.object;
      memory.write_memory([0, 248, 224, 7, 31, 0, 123, 123, 255, 255, 0, 0, 0x10, 0x84, 123, 123], surface.pixels);
      const frame = shim.snapshotFrame(surface);
      expect([...frame.rgba!]).toEqual([
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 132, 130, 132, 255,
      ]);
    });
  }

  for (const oddLayout of [false, true]) {
    for (const destinationKey of [undefined, [0x1234, 0x1234] as [number, number]]) {
      it(`源色键范围、裁剪、目标色键与行尾保护（奇数布局=${oddLayout}, 目标色键=${!!destinationKey}）`, () => {
        const { memory, shim } = fixture();
        const source = shim.createSurface(5, 3, 0);
        const target = shim.createSurface(3, 2, 0);
        if (oddLayout) {
          source.pixels++;
          source.pitch++;
          target.pixels++;
          target.pitch++;
        }
        const sourceView = new DataView(memory.bytes.buffer);
        for (let y = 0; y < 3; y++)
          for (let x = 0; x < 5; x++) {
            sourceView.setUint16(source.pixels + y * source.pitch + x * 2, 10 + y * 5 + x, true);
          }
        const start = target.pixels - 1;
        memory.bytes.fill(0xa5, start, target.pixels + target.pitch * 2 + 1);
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 3; x++) {
            sourceView.setUint16(target.pixels + y * target.pitch + x * 2, x === 2 ? 0x5678 : 0x1234, true);
          }
        const expected = memory.bytes.slice(start, target.pixels + target.pitch * 2 + 1);
        const expectedView = new DataView(expected.buffer);
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 3; x++) {
            const value = 10 + (y + 1) * 5 + x + 1;
            if ((value < 17 || value > 21) && (!destinationKey || x !== 2)) {
              expectedView.setUint16(1 + y * target.pitch + x * 2, value, true);
            }
          }
        shim.copyRect(source, [0, 0, 5, 3], target, -1, -1, 5, 3, [17, 21], destinationKey);
        expect(memory.bytes.slice(start, target.pixels + target.pitch * 2 + 1)).toEqual(expected);
      });
    }
  }
});
