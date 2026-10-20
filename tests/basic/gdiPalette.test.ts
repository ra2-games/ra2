/**
 * Migrated GDI palette smoke tests: idempotent run-based remapping of text on 8-bit offscreen surfaces after palette changes (SetEntries/Flip/Blt), no intermediate frame submissions during loading, and preservation of the emit-time palette in rAF-delayed frames.
 *
 * The first test deliberately retains the original script's cumulative sequential state: later loading transactions, Flip, and Blt depend on the earlier palette/primary/offscreen objects and text already remapped to indices 210/60. Keep these checks together.
 */
import { describe, expect, it } from 'vitest';
import type { Win32Shim } from '../../src/games/win32Shim';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeU32,
  type FakeGuestMemory,
} from '../helpers/guestMemory';

const rulerColor = 0x009c_dcfb; // COLORREF RGB(251, 220, 156)

const textRasterizer = {
  rasterize: () => ({ width: 1, height: 1, alpha: new Uint8Array([255]), threshold: 96 }),
};

const surfaceDesc = (memory: FakeGuestMemory, address: number, caps: number) => {
  writeU32(memory, address, 108);
  writeU32(memory, address + 4, 6); // DDSD_HEIGHT | DDSD_WIDTH
  writeU32(memory, address + 8, 4);
  writeU32(memory, address + 12, 4);
  writeU32(memory, address + 104, caps);
};

/** Original script's dispatch: assert that the import is implemented and returns DD_OK. */
const dispatchOk = (shim: Win32Shim, key: string, args: number[]) => {
  expect(callShim(shim, key, args).eax, `${key} 应返回 DD_OK`).toBe(0);
};

describe('GDI 调色板换页重映射（原 gdiPaletteSmoke）', () => {
  it('文字随 SetEntries 重映射；加载期间不提交中间帧；Flip/Blt 后 run 跟随像素', () => {
    const memory = createGuestMemory();
    let frames = 0;
    const shim = createTestShim(memory, {
      onFrame: () => {
        frames++;
      },
      textRasterizer,
    });
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);

    const primaryDesc = 0x10_000;
    const primaryOut = 0x10_100;
    surfaceDesc(memory, primaryDesc, 0x200); // DDSCAPS_PRIMARYSURFACE
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, primaryDesc, primaryOut, 0]);
    const primary = readU32(memory, primaryOut);

    const paletteBytes = 0x11_000;
    const paletteOut = 0x11_500;
    const initial = new Uint8Array(256 * 4);
    initial.set([222, 222, 168, 0], 40 * 4);
    memory.write_memory(initial, paletteBytes);
    dispatch('DDRAW.COM!IDirectDraw.CreatePalette', [0, 4, paletteBytes, paletteOut, 0]);
    const palette = readU32(memory, paletteOut);
    dispatch('DDRAW.COM!IDirectDrawSurface.SetPalette', [primary, palette]);

    const offscreenDesc = 0x12_000;
    const offscreenOut = 0x12_100;
    surfaceDesc(memory, offscreenDesc, 0);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, offscreenDesc, offscreenOut, 0]);
    const offscreen = readU32(memory, offscreenOut);
    const dcOut = 0x12_200;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetDC', [offscreen, dcOut]);
    const dc = readU32(memory, dcOut);

    expect(callShim(shim, 'GDI32.DLL!SetTextColor', [dc, rulerColor]).eax).toBe(0);
    memory.write_memory([0x41], 0x12_300);
    expect(callShim(shim, 'GDI32.DLL!TextOutA', [dc, 0, 0, 0x12_300, 1]).eax).toBe(1);
    expect(shim.inspectSurface(offscreen)?.pixels[0], '文字初次映射到旧调色板 index 40').toBe(40);

    const finalPalette = new Uint8Array(256 * 4);
    finalPalette.set([255, 0, 0, 0], 40 * 4); // The old index is red in the battle palette
    finalPalette.set([251, 220, 156, 0], 210 * 4); // Correct yellow-orange for the level/monarch name
    memory.write_memory(finalPalette, paletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);

    expect(shim.inspectGdiDc(dc)?.paletteIndex).toBe(210);
    expect(shim.inspectSurface(offscreen)?.pixels[0], '调色板切换后字形应重映射到 index 210').toBe(210);

    const stableFrames = frames;
    writeU32(memory, 0x004a_f234, 1); // Original game's large-map/level loading state
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);
    expect(frames, '加载期间不应提交调色板/分块绘制中间帧').toBe(stableFrames);
    writeU32(memory, 0x004a_f234, 0);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [primary, 0]);
    expect(frames, '加载完成后应恢复提交完整帧').toBe(stableFrames + 1);

    // Flip regression: back-buffer text -> flip -> palette change. Runs must swap with the pixels,
    // or foreground glyphs retain old indices (usually white in the new palette) until repainted.
    const flipDesc = 0x14_000;
    const flipOut = 0x14_100;
    writeU32(memory, flipDesc, 108);
    writeU32(memory, flipDesc + 4, 0x26); // DDSD_HEIGHT | DDSD_WIDTH | DDSD_BACKBUFFERCOUNT
    writeU32(memory, flipDesc + 8, 4);
    writeU32(memory, flipDesc + 12, 4);
    writeU32(memory, flipDesc + 20, 1); // One back buffer
    writeU32(memory, flipDesc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, flipDesc, flipOut, 0]);
    const flipPrimary = readU32(memory, flipOut);
    dispatch('DDRAW.COM!IDirectDrawSurface.SetPalette', [flipPrimary, palette]);

    const backOut = 0x14_200;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetAttachedSurface', [flipPrimary, 0, backOut, 0]);
    const back = readU32(memory, backOut);
    const backDcOut = 0x14_300;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetDC', [back, backDcOut]);
    const backDc = readU32(memory, backDcOut);
    expect(callShim(shim, 'GDI32.DLL!SetTextColor', [backDc, rulerColor]).eax).toBe(0);
    memory.write_memory([0x42], 0x14_400);
    expect(callShim(shim, 'GDI32.DLL!TextOutA', [backDc, 0, 0, 0x14_400, 1]).eax).toBe(1);
    expect(shim.inspectSurface(back)?.pixels[0], '后缓冲文字落在当前调色板的黄橙 index 210').toBe(210);

    dispatch('DDRAW.COM!IDirectDrawSurface.Flip', [flipPrimary, 0, 0]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Flip 后前台持有后缓冲像素').toBe(210);

    const flippedPalette = new Uint8Array(256 * 4);
    flippedPalette.set([255, 255, 255, 0], 210 * 4); // The old index is white in the new palette (the bug's symptom)
    flippedPalette.set([251, 220, 156, 0], 60 * 4);
    memory.write_memory(flippedPalette, paletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Flip 后换页，前台字形应随像素归属的 run 重映射').toBe(60);

    // Blt regression: after offscreen text is blitted to the primary, its glyph runs must follow,
    // or destination text retains old indices and turns white on palette changes. The offscreen glyphs now use index 60.
    const blitDestRect = 0x15_000;
    writeU32(memory, blitDestRect, 0);
    writeU32(memory, blitDestRect + 4, 0);
    writeU32(memory, blitDestRect + 8, 1);
    writeU32(memory, blitDestRect + 12, 1);
    const blitSourceRect = 0x15_020;
    writeU32(memory, blitSourceRect, 0);
    writeU32(memory, blitSourceRect + 4, 0);
    writeU32(memory, blitSourceRect + 8, 1);
    writeU32(memory, blitSourceRect + 12, 1);
    dispatch('DDRAW.COM!IDirectDrawSurface.Blt', [flipPrimary, blitDestRect, offscreen, blitSourceRect, 0, 0]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Blt 后主表面持有 offscreen 字形像素').toBe(60);

    const blitPalette = new Uint8Array(256 * 4);
    blitPalette.set([255, 255, 255, 0], 60 * 4); // The old index is white in the new palette
    blitPalette.set([251, 220, 156, 0], 90 * 4);
    memory.write_memory(blitPalette, paletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [palette, 0, 0, 256, paletteBytes]);
    expect(shim.inspectSurface(flipPrimary)?.pixels[0], 'Blt 后换页，主表面字形应随携带的 run 重映射').toBe(90);
  });

  it('rAF 延迟呈现：emit 后、回调前换调色板，帧仍携带 emit 时刻的调色板', () => {
    // Old pixels with the new palette reproduce the historical white-text symptom.
    const memory = createGuestMemory();
    let pendingEmit: (() => void) | null = null;
    let delivered: { pixels: Uint8Array; palette: Uint8Array } | null = null;
    const scheduledShim = createTestShim(memory, {
      onFrame: (frame) => {
        delivered = { pixels: frame.pixels, palette: frame.palette };
      },
      scheduleFrame: (emit) => {
        pendingEmit = emit;
      },
      textRasterizer,
    });
    const dispatch = (key: string, args: number[]) => callShim(scheduledShim, key, args).eax;

    const schedDesc = 0x16_000;
    const schedOut = 0x16_100;
    surfaceDesc(memory, schedDesc, 0x200);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, schedDesc, schedOut, 0]);
    const schedPrimary = readU32(memory, schedOut);
    const schedPaletteBytes = 0x16_200;
    const schedPaletteOut = 0x16_700;
    const oldPalette = new Uint8Array(256 * 4);
    oldPalette.set([251, 220, 156, 0], 40 * 4); // Golden-orange text
    memory.write_memory(oldPalette, schedPaletteBytes);
    dispatch('DDRAW.COM!IDirectDraw.CreatePalette', [0, 4, schedPaletteBytes, schedPaletteOut, 0]);
    const schedPalette = readU32(memory, schedPaletteOut);
    dispatch('DDRAW.COM!IDirectDrawSurface.SetPalette', [schedPrimary, schedPalette]);
    const schedDcOut = 0x16_800;
    dispatch('DDRAW.COM!IDirectDrawSurface.GetDC', [schedPrimary, schedDcOut]);
    const schedDc = readU32(memory, schedDcOut);
    expect(callShim(scheduledShim, 'GDI32.DLL!SetTextColor', [schedDc, rulerColor]).eax).toBe(0);
    memory.write_memory([0x43], 0x16_900);
    expect(callShim(scheduledShim, 'GDI32.DLL!TextOutA', [schedDc, 0, 0, 0x16_900, 1]).eax).toBe(1);

    // Releasing the primary surface DC triggers presentation (the common game path calls ReleaseDC immediately after drawing).
    expect(callShim(scheduledShim, 'USER32.DLL!ReleaseDC', [0, schedDc]).eax).toBe(1);
    expect(pendingEmit, 'scheduleFrame 应挂起一次呈现').toBeTruthy();
    // After emit but before the callback, the guest changes index 40 to white.
    const newPalette = new Uint8Array(256 * 4);
    newPalette.set([255, 255, 255, 0], 40 * 4);
    memory.write_memory(newPalette, schedPaletteBytes);
    dispatch('DDRAW.COM!IDirectDrawPalette.SetEntries', [schedPalette, 0, 0, 256, schedPaletteBytes]);
    const fire = pendingEmit!;
    pendingEmit = null;
    fire();
    expect(delivered, '回调应交付一帧').toBeTruthy();
    expect(delivered!.pixels[0], `帧像素应指向 index 40，实得 ${delivered!.pixels[0]}`).toBe(40);
    expect(
      [...delivered!.palette.subarray(40 * 4, 40 * 4 + 4)],
      '延迟呈现的帧必须携带 emit 时刻的调色板（金橙），而不是回调时的白色',
    ).toEqual([251, 220, 156, 0]);
  });
});

describe('GDI 画刷句柄与 DirectDraw Blt 几何（RA2 增补，原 gdiPaletteSmoke）', () => {
  it('CreateSolidBrush 返回有效 HBRUSH，DeleteObject 不可重复释放', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const brush = callShim(shim, 'GDI32.DLL!CreateSolidBrush', [0x0012_3456]).eax;
    expect(brush, 'CreateSolidBrush 应返回有效 HBRUSH').not.toBe(0);
    expect(callShim(shim, 'GDI32.DLL!DeleteObject', [brush]).eax, 'DeleteObject 应释放 HBRUSH').toBe(1);
    expect(callShim(shim, 'GDI32.DLL!DeleteObject', [brush]).eax, '重复释放 HBRUSH 应失败').toBe(0);
  });

  // DirectDraw UI animation regression: Blt must scale rather than crop the source surface's right/bottom;
  // negative destination coordinates in BltFast must clip without writing before surface.pixels.
  it('Blt 缩放采样完整源图；BltFast 负目标坐标裁剪且不越界写', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const dispatch = (key: string, args: number[]) => dispatchOk(shim, key, args);

    const offscreenDesc = 0x12_000;
    const offscreenOut = 0x12_100;
    surfaceDesc(memory, offscreenDesc, 0);
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, offscreenDesc, offscreenOut, 0]);
    const offscreen = readU32(memory, offscreenOut);

    const flipDesc = 0x14_000;
    const flipOut = 0x14_100;
    writeU32(memory, flipDesc, 108);
    writeU32(memory, flipDesc + 4, 0x26); // DDSD_HEIGHT | DDSD_WIDTH | DDSD_BACKBUFFERCOUNT
    writeU32(memory, flipDesc + 8, 4);
    writeU32(memory, flipDesc + 12, 4);
    writeU32(memory, flipDesc + 20, 1); // One back buffer
    writeU32(memory, flipDesc + 104, 0x200); // DDSCAPS_PRIMARYSURFACE
    dispatch('DDRAW.COM!IDirectDraw.CreateSurface', [0, flipDesc, flipOut, 0]);
    const flipPrimary = readU32(memory, flipOut);

    const geometryDesc = 0x17_000;
    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [offscreen, 0, geometryDesc, 0, 0]);
    const geometrySourcePixels = readU32(memory, geometryDesc + 36);
    memory.write_memory(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), geometrySourcePixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [offscreen, geometrySourcePixels]);
    const scaledDestRect = 0x17_100;
    writeU32(memory, scaledDestRect, 0);
    writeU32(memory, scaledDestRect + 4, 0);
    writeU32(memory, scaledDestRect + 8, 2);
    writeU32(memory, scaledDestRect + 12, 2);
    const fullSourceRect = 0x17_120;
    writeU32(memory, fullSourceRect, 0);
    writeU32(memory, fullSourceRect + 4, 0);
    writeU32(memory, fullSourceRect + 8, 4);
    writeU32(memory, fullSourceRect + 12, 4);
    dispatch('DDRAW.COM!IDirectDrawSurface.Blt', [flipPrimary, scaledDestRect, offscreen, fullSourceRect, 0, 0]);
    const scaled = shim.inspectSurface(flipPrimary)!.pixels;
    expect([scaled[0], scaled[1], scaled[4], scaled[5]], '4×4 → 2×2 Blt 应采样完整源图，而不是复制左上 2×2').toEqual([
      1, 3, 9, 11,
    ]);

    dispatch('DDRAW.COM!IDirectDrawSurface.Lock', [flipPrimary, 0, geometryDesc, 0, 0]);
    const geometryDestPixels = readU32(memory, geometryDesc + 36);
    memory.write_memory(new Uint8Array(16), geometryDestPixels);
    dispatch('DDRAW.COM!IDirectDrawSurface.Unlock', [flipPrimary, geometryDestPixels]);
    const byteBeforeDest = memory.read_memory(geometryDestPixels - 1, 1)[0];
    dispatch('DDRAW.COM!IDirectDrawSurface.BltFast', [flipPrimary, 0xffff_ffff, 0, offscreen, fullSourceRect, 0]);
    const clipped = shim.inspectSurface(flipPrimary)!.pixels;
    expect([...clipped.subarray(0, 4)], 'x=-1 的 BltFast 应裁掉源图第一列').toEqual([2, 3, 4, 0]);
    expect(memory.read_memory(geometryDestPixels - 1, 1)[0], '负坐标 BltFast 不得写到目标 surface 之前').toBe(
      byteBeforeDest,
    );
  });
});
