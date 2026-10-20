/**
 * Host graphics microbenchmark with a fixed workload; does not start the game or measure actual game FPS.
 * An old worktree's absolute path can be supplied to measure a baseline with the same script/data, excluding direct transfer if unavailable there.
 */
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SurfaceState, VmFrame } from '../../src/vm86/win32';
import { FrameBufferPool } from '../../src/adapter/frameBufferPool';

const baselineRoot = process.argv[2];
const helper = baselineRoot
  ? pathToFileURL(resolve(baselineRoot, 'tests/helpers/guestMemory.ts'))
  : new URL('../../tests/helpers/guestMemory.ts', import.meta.url);
const { createGuestMemory, createTestShim } = (await import(
  helper.href
)) as typeof import('../../tests/helpers/guestMemory');

const memory = createGuestMemory(32 * 1024 * 1024);
const shim = createTestShim(memory, { onFrame: () => {} }) as unknown as {
  displayBpp: number;
  primarySurface: number;
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
    key: number[],
  ): void;
};
shim.displayBpp = 16;
const source = shim.createSurface(1440, 900, 0);
const target = shim.createSurface(1440, 900, 0x200);
shim.primarySurface = target.object;
const packedShim = createTestShim(memory, { onFrame: () => {}, packedRgb565Frames: true }) as unknown as typeof shim;
packedShim.primarySurface = target.object;
const pool = new FrameBufferPool();
const reusedShim = createTestShim(memory, {
  onFrame: () => {},
  packedRgb565Frames: true,
  takeFrameBuffer: (size) => pool.take(size),
}) as unknown as typeof shim;
reusedShim.primarySurface = target.object;
// Mix transparent and opaque pixels to avoid unrepresentative fully transparent or solid-color special cases.
const pixels = new Uint16Array(memory.bytes.buffer, source.pixels, 1440 * 900);
for (let i = 0; i < pixels.length; i++) pixels[i] = i % 3 ? i & 0xffff : 0;
memory.write_memory(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), target.pixels);

for (const [name, run, iterations] of [
  ['RGB565 帧快照', () => shim.snapshotFrame(target), 200],
  ['RGB565 GPU 直传快照', () => packedShim.snapshotFrame(target), 200],
  [
    'RGB565 GPU 回收快照',
    () => {
      const frame = reusedShim.snapshotFrame(target);
      if (frame?.rgb565) pool.release(frame.rgb565.buffer as ArrayBuffer);
    },
    200,
  ],
  ['RGB565 源色键 Blt', () => shim.copyRect(source, [0, 0, 1440, 900], target, 0, 0, 1440, 900, [0, 0]), 200],
] as const) {
  if (baselineRoot && name.includes('GPU')) continue;
  for (let i = 0; i < 30; i++) run();
  const samples: number[] = [];
  for (let batch = 0; batch < 5; batch++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name}: ${samples[2]!.toFixed(3)} ms/次（5 批中位数）`);
}
