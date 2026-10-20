import { expect, it, vi } from 'vitest';
import { ScaledClock } from '../../src/vm86/clock';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ, readU32 } from '../helpers/guestMemory';
import { yrWin32ArgBytes } from '../../src/games/yr/abi';

function wide(memory: ReturnType<typeof createGuestMemory>, pointer: number, text: string): void {
  const view = new DataView(memory.bytes.buffer);
  for (let i = 0; i <= text.length; i++)
    view.setUint16(pointer + i * 2, i < text.length ? text.charCodeAt(i) : 0, true);
}

it('OffsetRect translates all signed edges and rejects a null rectangle', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const view = new DataView(memory.bytes.buffer);
  [-10, 20, 30, 40].forEach((value, i) => view.setInt32(0x110000 + i * 4, value, true));
  expect(callShim(shim, 'USER32.DLL!OffsetRect', [0x110000, 5, -30]).eax).toBe(1);
  expect([0, 1, 2, 3].map((i) => view.getInt32(0x110000 + i * 4, true))).toEqual([-5, -10, 35, 10]);
  expect(callShim(shim, 'USER32.DLL!OffsetRect', [0, 5, -30]).eax).toBe(0);
  shim.dispose();
});

it('64-bit seek preserves signed offsets and rejects overflow without truncation', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { files: new Map([['sample', Uint8Array.of(1, 2, 3)]]) });
  writeAsciiZ(memory, 0x100000, 'sample');
  const handle = callShim(shim, 'KERNEL32.DLL!CreateFileA', [0x100000, 0x80000000, 1, 0, 3, 0, 0]).eax;
  expect(callShim(shim, 'KERNEL32.DLL!SetFilePointerEx', [handle, 0xffffffff, 0xffffffff, 0x110010, 2]).eax).toBe(1);
  expect(readU32(memory, 0x110010)).toBe(2);
  expect(callShim(shim, 'KERNEL32.DLL!SetFilePointerEx', [handle, 0, 1, 0x110010, 0]).eax).toBe(0);
  expect(readU32(memory, 0x110010)).toBe(2);
  expect(callShim(shim, 'KERNEL32.DLL!SetFilePointerEx', [handle, 0xffffffff, 0xffffffff, 0, 0]).eax).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(131);
  callShim(shim, 'KERNEL32.DLL!ReadFile', [handle, 0x110000, 1, 0x110020, 0]);
  expect(memory.bytes[0x110000]).toBe(3);
  expect(yrWin32ArgBytes('kernel32.dll', 'SetFilePointerEx')).toBe(20);
});

it('UTF-16 file paths share file state and preserve missing-file errors', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { files: new Map([['存档.sav', Uint8Array.of(7, 8, 9)]]) });
  wide(memory, 0x100000, '存档.sav');
  const handle = callShim(shim, 'KERNEL32.DLL!CreateFileW', [0x100000, 0x80000000, 1, 0, 3, 0, 0]).eax;
  expect(handle).not.toBe(0xffffffff);
  expect(callShim(shim, 'KERNEL32.DLL!ReadFile', [handle, 0x110000, 3, 0x110010, 0]).eax).toBe(1);
  expect([...memory.bytes.slice(0x110000, 0x110003)]).toEqual([7, 8, 9]);
  callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
  wide(memory, 0x100000, '不存在.sav');
  expect(callShim(shim, 'KERNEL32.DLL!CreateFileW', [0x100000, 0x80000000, 1, 0, 3, 0, 0]).eax).toBe(0xffffffff);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(2);
});

it('wide directory sizing includes terminator only when the buffer is too small', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const required = callShim(shim, 'KERNEL32.DLL!GetCurrentDirectoryW', [0, 0]).eax;
  memory.bytes.fill(0xa5, 0x110000, 0x110100);
  expect(callShim(shim, 'KERNEL32.DLL!GetCurrentDirectoryW', [required - 1, 0x110000]).eax).toBe(required);
  expect(memory.bytes[0x110000]).toBe(165);
  expect(callShim(shim, 'KERNEL32.DLL!GetCurrentDirectoryW', [required, 0x110000]).eax).toBe(required - 1);
  expect(new DataView(memory.bytes.buffer).getUint16(0x110000 + (required - 1) * 2, true)).toBe(0);
  expect(memory.bytes[0x110000 + required * 2]).toBe(165);
});

it('wide command line is stable and startup info preserves buffer boundaries', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { moduleName: 'gamemd.exe', commandLineArguments: '-CD -LOG' });
  const pointer = callShim(shim, 'KERNEL32.DLL!GetCommandLineW').eax;
  expect(callShim(shim, 'KERNEL32.DLL!GetCommandLineW').eax).toBe(pointer);
  const expected = 'gamemd.exe -CD -LOG';
  expect(new TextDecoder('utf-16le').decode(memory.bytes.slice(pointer, pointer + expected.length * 2))).toBe(expected);
  memory.bytes.fill(0xa5, 0x110000, 0x110050);
  callShim(shim, 'KERNEL32.DLL!GetStartupInfoW', [0x110000]);
  expect(readU32(memory, 0x110000)).toBe(68);
  expect(memory.bytes[0x110044]).toBe(165);
});

it('process heap handle supports allocation, size and release', () => {
  const shim = createTestShim(createGuestMemory());
  const heap = callShim(shim, 'KERNEL32.DLL!GetProcessHeap').eax;
  expect(heap).not.toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetProcessHeap').eax).toBe(heap);
  const pointer = callShim(shim, 'KERNEL32.DLL!HeapAlloc', [heap, 8, 64]).eax;
  expect(pointer).not.toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!HeapSize', [heap, 0, pointer]).eax).toBe(64);
  expect(callShim(shim, 'KERNEL32.DLL!HeapFree', [heap, 0, pointer]).eax).toBe(1);
});

it('system FILETIME uses the wall clock and writes exactly eight bytes', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  memory.bytes.fill(0xa5, 0x1000, 0x1010);
  const wall = vi.spyOn(ScaledClock.prototype, 'wallNow').mockReturnValue(1700000000123);
  callShim(shim, 'KERNEL32.DLL!GetSystemTimeAsFileTime', [0x1004]);
  wall.mockRestore();
  const ticks = new DataView(memory.bytes.buffer).getBigUint64(0x1004, true);
  expect(ticks).toBe(133444736001230000n);
  expect([...memory.bytes.slice(0x1000, 0x1004)]).toEqual([165, 165, 165, 165]);
  expect([...memory.bytes.slice(0x100c, 0x1010)]).toEqual([165, 165, 165, 165]);
  expect(yrWin32ArgBytes('kernel32.dll', 'GetSystemTimeAsFileTime')).toBe(4);
});

it('guest process has no attached Windows debugger', () => {
  const shim = createTestShim(createGuestMemory());
  expect(callShim(shim, 'KERNEL32.DLL!IsDebuggerPresent').eax).toBe(0);
  expect(yrWin32ArgBytes('kernel32.dll', 'IsDebuggerPresent')).toBe(0);
  expect(yrWin32ArgBytes('kernel32.dll', 'GetProcessHeap')).toBe(0);
});

it('extended file size reports mounted bytes and rejects a closed handle without overwriting output', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { files: new Map([['sample.bin', new Uint8Array(513)]]) });
  writeAsciiZ(memory, 0x100000, 'sample.bin');
  const handle = callShim(shim, 'KERNEL32.DLL!CreateFileA', [0x100000, 0x80000000, 1, 0, 3, 0, 0]).eax;
  expect(handle).not.toBe(0xffffffff);
  expect(callShim(shim, 'KERNEL32.DLL!GetFileSizeEx', [handle, 0x110000]).eax).toBe(1);
  expect(new DataView(memory.bytes.buffer).getBigUint64(0x110000, true)).toBe(513n);
  callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
  expect(callShim(shim, 'KERNEL32.DLL!GetFileSizeEx', [handle, 0x110000]).eax).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(6);
  expect(readU32(memory, 0x110000)).toBe(513);
});

it('spin-count initialization retains recursive critical-section ownership', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const lock = 0x110000;
  expect(callShim(shim, 'KERNEL32.DLL!InitializeCriticalSectionAndSpinCount', [lock, 4000]).eax).toBe(1);
  callShim(shim, 'KERNEL32.DLL!EnterCriticalSection', [lock]);
  callShim(shim, 'KERNEL32.DLL!EnterCriticalSection', [lock]);
  expect(readU32(memory, lock + 8)).toBe(2);
  callShim(shim, 'KERNEL32.DLL!LeaveCriticalSection', [lock]);
  callShim(shim, 'KERNEL32.DLL!LeaveCriticalSection', [lock]);
  expect(readU32(memory, lock + 12)).toBe(0);
  callShim(shim, 'KERNEL32.DLL!DeleteCriticalSection', [lock]);
  expect(yrWin32ArgBytes('kernel32.dll', 'InitializeCriticalSectionAndSpinCount')).toBe(8);
  expect(yrWin32ArgBytes('kernel32.dll', 'GetFileSizeEx')).toBe(8);
});
