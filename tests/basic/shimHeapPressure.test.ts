import { describe, expect, it } from 'vitest';
import { Win32Shim } from '../../src/games/win32Shim';
import { callShim, createGuestMemory, readU32, writeU32 } from '../helpers/guestMemory';

const PROCESS_HEAP = 0x1_0001;

function fixture() {
  const memory = createGuestMemory();
  const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
  return { memory, shim };
}

function exhaustHeap(shim: Win32Shim): void {
  while (callShim(shim, 'KERNEL32.DLL!HeapAlloc', [PROCESS_HEAP, 0, 0x10000]).eax);
  while (callShim(shim, 'KERNEL32.DLL!HeapAlloc', [PROCESS_HEAP, 0, 16]).eax);
}

describe('长局堆压力下的 shim 行为', () => {
  it.each([
    ['DDRAW.DLL!DirectDrawCreate', [0, 0x1200, 0]],
    ['DSOUND.DLL!ord1', [0, 0x1200, 0]],
    ['DDRAW.COM!IDirectDraw.CreateClipper', [0, 0, 0x1200, 0]],
    ['DDRAW.COM!IDirectDraw.CreatePalette', [0, 0, 0, 0x1200, 0]],
    ['DDRAW.COM!IDirectDraw.CreateSurface', [0, 0x1000, 0x1200, 0]],
  ] as const)('%s clears its output when the heap is exhausted', (api, args) => {
    const { memory, shim } = fixture();
    exhaustHeap(shim);
    writeU32(memory, 0x1000, 108);
    writeU32(memory, 0x1008, 16);
    writeU32(memory, 0x100c, 16);
    writeU32(memory, 0x1200, 0xdeadbeef);
    const lowMemory = memory.read_memory(0, 128).slice();
    const baseline = shim.inspectHeapState().liveBytes;
    expect(callShim(shim, api, [...args]).eax).toBe(0x8007000e);
    expect(readU32(memory, 0x1200)).toBe(0);
    expect(memory.read_memory(0, 128)).toEqual(lowMemory);
    expect(shim.inspectHeapState().liveBytes).toBe(baseline);
    expect(shim.inspectSurfaceObjects()).toEqual([]);
  });

  it.each(['sound', 'duplicate', 'surface', 'back-buffer'] as const)(
    'rolls back %s allocations when only the final data allocation fails',
    (kind) => {
      const { memory, shim } = fixture();
      const sound = kind === 'sound' || kind === 'duplicate';
      const api = sound ? 'DSOUND.COM!IDirectSound.CreateSoundBuffer' : 'DDRAW.COM!IDirectDraw.CreateSurface';
      const release = sound ? 'DSOUND.COM!IDirectSoundBuffer.Release' : 'DDRAW.COM!IDirectDrawSurface.Release';
      const desc = 0x1000,
        out = 0x1200;
      writeU32(memory, desc, sound ? 20 : 108);
      if (!sound) writeU32(memory, desc + 4, 6); // DDSD_HEIGHT | DDSD_WIDTH
      writeU32(memory, desc + 8, sound ? 0x8000 : 16);
      writeU32(memory, desc + 12, 16);
      // Prime the shared vtable before measuring per-object ownership. Keep the duplicate's source alive.
      expect(callShim(shim, api, [0, desc, out, 0]).eax).toBe(0);
      const source = readU32(memory, out);
      if (kind !== 'duplicate') expect(callShim(shim, release, [source]).eax).toBe(0);
      const budget = kind === 'back-buffer' ? 288 : 16;
      const spare = callShim(shim, 'KERNEL32.DLL!HeapAlloc', [PROCESS_HEAP, 0, budget]).eax;
      expect(spare).toBeGreaterThan(0);
      exhaustHeap(shim);
      expect(callShim(shim, 'KERNEL32.DLL!HeapFree', [PROCESS_HEAP, 0, spare]).eax).toBe(1);
      if (kind === 'back-buffer') {
        writeU32(memory, desc + 4, 0x26);
        writeU32(memory, desc + 20, 1);
        writeU32(memory, desc + 104, 0x200);
      }
      const baseline = shim.inspectHeapState().liveBytes;
      const lowMemory = memory.read_memory(0, 128).slice();
      writeU32(memory, out, 0xdeadbeef);
      const result =
        kind === 'duplicate'
          ? callShim(shim, 'DSOUND.COM!IDirectSound.DuplicateSoundBuffer', [0, source, out])
          : callShim(shim, api, [0, desc, out, 0]);
      expect(result.eax).toBe(0x8007000e);
      expect(readU32(memory, out)).toBe(0);
      expect(shim.inspectHeapState().liveBytes).toBe(baseline);
      expect(memory.read_memory(0, 128)).toEqual(lowMemory);
      expect(shim.inspectSurfaceObjects()).toEqual([]);
      // Rollback must restore enough contiguous capacity for the original reservation.
      const recovered = callShim(shim, 'KERNEL32.DLL!HeapAlloc', [PROCESS_HEAP, 0, budget]).eax;
      expect(recovered).toBeGreaterThan(0);
      if (kind === 'duplicate') expect(callShim(shim, release, [source]).eax).toBe(0);
    },
  );

  it('堆耗尽时 CreateSoundBuffer 返回 DSERR_OUTOFMEMORY，而不是成功但给空缓冲', () => {
    const { memory, shim } = fixture();
    exhaustHeap(shim);
    const desc = 0x1000,
      out = 0x1200;
    writeU32(memory, desc, 20); // dwSize
    writeU32(memory, desc + 8, 0x8000); // dwBufferBytes
    writeU32(memory, out, 0xdead_beef);
    const lowMemory = memory.read_memory(0, 32).slice();
    const result = callShim(shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0x3000, desc, out, 0], 0x2000);
    expect(result.eax).toBe(0x8007_000e);
    expect(readU32(memory, out)).toBe(0);
    expect(memory.read_memory(0, 32)).toEqual(lowMemory);
  });
});
