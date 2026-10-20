import { expect, it } from 'vitest';
import { createGuestMemory, createTestShim, readU32 } from '../helpers/guestMemory';

const BASE = 0x600000;
function fixture(relocations: boolean): Uint8Array {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const word = (offset: number, value: number) => view.setUint32(offset, value, true);
  view.setUint16(0, 0x5a4d, true);
  word(60, 0x80);
  word(0x80, 0x4550);
  view.setUint16(0x86, 1, true);
  view.setUint16(0x94, 224, true);
  const opt = 0x98;
  word(opt + 16, 0x1000);
  word(opt + 28, BASE);
  word(opt + 56, 0x2000);
  word(opt + 60, 0x200);
  word(opt + 224 + 12, 0x1000);
  word(opt + 224 + 16, 0x200);
  word(opt + 224 + 20, 0x200);
  word(0x230, BASE + 0x1040);
  if (relocations) {
    word(opt + 136, 0x1100);
    word(opt + 140, 12);
    word(0x300, 0x1000);
    word(0x304, 12);
    view.setUint16(0x308, 0x3030, true);
  }
  return bytes;
}

it('relocates a conflicting DLL without overwriting the first module', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, {
    files: new Map([
      ['first.dll', fixture(true)],
      ['second.dll', fixture(true)],
    ]),
    importArgBytes: () => 0,
  });
  shim.initializeGuestDllBeforeEntry('first.dll', 0x400000);
  shim.initializeGuestDllBeforeEntry('second.dll', 0x400000);
  expect(readU32(memory, BASE + 0x1030)).toBe(BASE + 0x1040);
  expect(readU32(memory, BASE + 0x10000 + 0x1030)).toBe(BASE + 0x10000 + 0x1040);
  shim.dispose();
});

it('rejects a conflicting non-relocatable DLL before overwriting memory', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, {
    files: new Map([
      ['first.dll', fixture(true)],
      ['second.dll', fixture(false)],
    ]),
    importArgBytes: () => 0,
  });
  shim.initializeGuestDllBeforeEntry('first.dll', 0x400000);
  expect(() => shim.initializeGuestDllBeforeEntry('second.dll', 0x400000)).toThrow('address conflict');
  expect(readU32(memory, BASE + 0x1030)).toBe(BASE + 0x1040);
  shim.dispose();
});

it('preserves a preferred DLL address above the bounded file mirror', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, {
    files: new Map([['above.dll', fixture(false)]]),
    importArgBytes: () => 0,
    fastFileMirrorBase: 0x400000,
    fastFileMirrorTop: 0x500000,
  });
  shim.initializeGuestDllBeforeEntry('above.dll', 0x400000);
  expect(readU32(memory, BASE + 0x1030)).toBe(BASE + 0x1040);
  shim.dispose();
});

it('relocates an image whose preferred address exceeds the actual process RAM', () => {
  const memory = createGuestMemory(512 * 1024 * 1024);
  const bytes = fixture(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(0x98 + 28, 0x60000000, true);
  view.setUint32(0x230, 0x60001040, true);
  const shim = createTestShim(memory, {
    guestMemoryBytes: memory.bytes.length,
    files: new Map([['large-address.dll', bytes]]),
    importArgBytes: () => 0,
  });
  shim.initializeGuestDllBeforeEntry('large-address.dll', 0x400000);
  expect(readU32(memory, 0x10001030)).toBe(0x10001040);
  shim.dispose();
});
