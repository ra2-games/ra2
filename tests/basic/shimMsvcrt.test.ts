import { expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

it('reads cdecl arguments from the guest stack and preserves caller-owned stack words', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const stack = 0x110000;
  writeU32(memory, stack, 0x401234);
  writeU32(memory, stack + 4, 0x120000);
  writeU32(memory, stack + 8, 0x120100);
  writeAsciiZ(memory, 0x120000, 'alpha');
  writeAsciiZ(memory, 0x120100, 'beta');
  expect(callShim(shim, 'MSVCRT.DLL!strcmp', [], stack).eax | 0).toBeLessThan(0);
  expect(callShim(shim, 'MSVCRT.DLL!strlen', [], stack).eax).toBe(5);
  expect(readU32(memory, stack)).toBe(0x401234);
  expect(readU32(memory, stack + 4)).toBe(0x120000);
  writeU32(memory, stack + 12, 0);
  expect(callShim(shim, 'MSVCRT.DLL!strncmp', [], stack).eax).toBe(0);
  shim.dispose();
});

it('appends DLL exit callbacks while preserving earlier registrations', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const stack = 0x110000;
  writeU32(memory, stack + 8, 0x120000);
  writeU32(memory, stack + 12, 0x120004);
  for (const callback of [0x401000, 0x402000]) {
    writeU32(memory, stack + 4, callback);
    expect(callShim(shim, 'MSVCRT.DLL!__dllonexit', [], stack).eax).toBe(callback);
  }
  const first = readU32(memory, 0x120000);
  expect(readU32(memory, 0x120004) - first).toBe(8);
  expect([readU32(memory, first), readU32(memory, first + 4)]).toEqual([0x401000, 0x402000]);
  shim.dispose();
});

it('rejects unsupported memory protections and unmapped ranges without changing the result buffer', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const output = 0x110000;
  writeU32(memory, output, 0xdeadbeef);
  expect(callShim(shim, 'KERNEL32.DLL!VirtualProtect', [0x120000, 4096, 2, output]).eax).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(50);
  expect(readU32(memory, output)).toBe(0xdeadbeef);
  expect(callShim(shim, 'KERNEL32.DLL!VirtualProtect', [memory.bytes.length - 1, 2, 0x40, output]).eax).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(487);
  expect(readU32(memory, output)).toBe(0xdeadbeef);
  expect(callShim(shim, 'KERNEL32.DLL!VirtualProtect', [0x120000, 4096, 0x40, output]).eax).toBe(1);
  expect(readU32(memory, output)).toBe(0x40);
  shim.dispose();
});

it('resolves named exports from an imported system module and rejects unknown exports', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, {
    staticImports: [
      { id: 1, dll: 'WSOCK32.DLL', name: 'ord9', key: 'WSOCK32.DLL!ord9', slot: 0, stub: 0, argBytes: 4 },
    ],
    importArgBytes: (_dll, name) => {
      if (name !== 'inet_addr') throw new Error('Unknown export');
      return 4;
    },
  });
  writeAsciiZ(memory, 0x110000, 'wsock32.dll');
  const handle = callShim(shim, 'KERNEL32.DLL!LoadLibraryA', [0x110000]).eax;
  expect(handle).not.toBe(0x400000);
  expect(callShim(shim, 'KERNEL32.DLL!LoadLibraryA', [0x110000]).eax).toBe(handle);
  writeAsciiZ(memory, 0x110100, 'inet_addr');
  const proc = callShim(shim, 'KERNEL32.DLL!GetProcAddress', [handle, 0x110100]).eax;
  expect(proc).toBeGreaterThan(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetProcAddress', [handle, 0x110100]).eax).toBe(proc);
  writeAsciiZ(memory, 0x110100, 'absent');
  expect(callShim(shim, 'KERNEL32.DLL!GetProcAddress', [handle, 0x110100]).eax).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(127);
  for (const [text, value] of [
    ['127.0.0.1', 0x0100007f],
    ['127.1', 0x0100007f],
    ['0x7f.01', 0x0100007f],
    ['256.1.1.1', 0xffffffff],
    ['1.2.3.4.5', 0xffffffff],
    ['', 0xffffffff],
  ] as const) {
    writeAsciiZ(memory, 0x110100, text);
    expect(callShim(shim, 'WSOCK32.DLL!inet_addr', [0x110100]).eax, text).toBe(value);
  }
  shim.dispose();
});

it('queries ANSI and Unicode module handles without loading missing modules', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, {
    moduleName: 'app.exe',
    staticImports: [
      {
        id: 1,
        dll: 'KERNEL32.DLL',
        name: 'GetLastError',
        key: 'KERNEL32.DLL!GetLastError',
        slot: 0,
        stub: 0,
        argBytes: 0,
      },
    ],
  });
  const pointer = 0x110000;
  for (const api of ['GetModuleHandleA', 'GetModuleHandleW']) {
    const query = (name: string | null) => {
      if (name !== null) {
        if (api.endsWith('W')) {
          const words = Uint16Array.from([...name, '\0'].map((c) => c.charCodeAt(0)));
          memory.write_memory(new Uint8Array(words.buffer), pointer);
        } else writeAsciiZ(memory, pointer, name);
      }
      return callShim(shim, `KERNEL32.DLL!${api}`, [name === null ? 0 : pointer]).eax;
    };
    expect(query(null)).toBe(0x400000);
    expect(query('C:\\GAME\\APP.EXE')).toBe(0x400000);
    const handle = query('kernel32.dll');
    expect(handle).not.toBe(0);
    expect(handle).not.toBe(0x400000);
    expect(query('KERNEL32.DLL')).toBe(handle);
    expect(query('missing.dll')).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(126);
    expect(query('')).toBe(0);
  }
  shim.dispose();
});

it('finds the containing PE for an address without claiming unsupported module lookup modes', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const output = 0x110000;
  writeU32(memory, 0x40003c, 0x80);
  writeU32(memory, 0x400080 + 24 + 56, 0x3000);
  expect(callShim(shim, 'KERNEL32.DLL!GetModuleHandleExW', [6, 0x401234, output]).eax).toBe(1);
  expect(readU32(memory, output)).toBe(0x400000);
  writeU32(memory, output, 0xdeadbeef);
  expect(callShim(shim, 'KERNEL32.DLL!GetModuleHandleExW', [6, 0x403000, output]).eax).toBe(0);
  expect(readU32(memory, output)).toBe(0xdeadbeef);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(126);
  expect(callShim(shim, 'KERNEL32.DLL!GetModuleHandleExW', [0, 0x401234, output]).eax).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(50);
  shim.dispose();
});
