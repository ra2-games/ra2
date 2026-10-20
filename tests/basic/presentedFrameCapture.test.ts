import { afterEach, expect, it, vi } from 'vitest';
import { copyFramePixels, PresentedFrameCapture } from '../../src/graphics/presentedFrameCapture';
import type { VmFrame } from '../../src/vm86/win32';

function indexed(): VmFrame {
  const palette = new Uint8Array(1024);
  palette.set([12, 34, 56, 0], 4);
  return { width: 1, height: 1, pixels: new Uint8Array([1]), palette };
}
afterEach(() => vi.useRealTimers());

it('copies indexed colors with opaque alpha and never retains pooled buffers', () => {
  const frame = indexed();
  const copied = copyFramePixels(frame);
  frame.pixels.fill(0);
  frame.palette.fill(0);
  expect([...copied]).toEqual([12, 34, 56, 255]);
});

it('preserves RGBA and expands RGB565 primary colors', () => {
  const frame = { ...indexed(), rgba: new Uint8Array([1, 2, 3, 255]) };
  const copied = copyFramePixels(frame);
  frame.rgba.fill(0);
  expect([...copied]).toEqual([1, 2, 3, 255]);
  expect([...copyFramePixels({ ...indexed(), width: 3, rgb565: new Uint16Array([0xf800, 0x07e0, 0x001f]) })]).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  ]);
});

it('rejects invalid dimensions and truncated pixel sources', () => {
  expect(() => copyFramePixels({ ...indexed(), width: 0 })).toThrow('dimensions');
  expect(() => copyFramePixels({ ...indexed(), width: 100000, height: 100000 })).toThrow('dimensions');
  expect(() => copyFramePixels({ ...indexed(), pixels: new Uint8Array() })).toThrow('indexed');
  expect(() => copyFramePixels({ ...indexed(), rgba: new Uint8Array(3) })).toThrow('RGBA');
});

it('captures only the next presented frame and allows only one outstanding request', async () => {
  const capture = new PresentedFrameCapture();
  capture.present(indexed());
  const pending = capture.request();
  await expect(capture.request()).rejects.toThrow('pending');
  const frame = indexed();
  frame.palette[4] = 90;
  capture.present(frame);
  frame.palette.fill(0);
  const result = await pending;
  expect(result.presentation).toBe(2);
  expect([...result.rgba]).toEqual([90, 34, 56, 255]);
  capture.destroy();
});

it('rejects clear, timeout and disposal without allowing late presentation to revive requests', async () => {
  vi.useFakeTimers();
  const capture = new PresentedFrameCapture();
  const cleared = expect(capture.request()).rejects.toThrow('cleared');
  capture.clear();
  await cleared;
  const timed = expect(capture.request(100)).rejects.toThrow('timeout');
  await vi.advanceTimersByTimeAsync(100);
  await timed;
  const disposed = expect(capture.request()).rejects.toThrow('disposed');
  capture.destroy();
  capture.present(indexed());
  await disposed;
  await expect(capture.request()).rejects.toThrow('disposed');
  expect(vi.getTimerCount()).toBe(0);
});
