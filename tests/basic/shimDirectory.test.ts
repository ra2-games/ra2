import { expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ } from '../helpers/guestMemory';

it.each(['A', 'W'])('creates and enumerates session directories with the %s entry point', (suffix) => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const input = 0x110000;
  const create = (name: string) => {
    if (suffix === 'W')
      memory.write_memory(new Uint8Array(Uint16Array.from([...name, '\0'].map((c) => c.charCodeAt(0))).buffer), input);
    else writeAsciiZ(memory, input, name);
    return callShim(shim, `KERNEL32.DLL!CreateDirectory${suffix}`, [input, 0]).eax;
  };
  expect(create('missing/child')).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(3);
  expect(create('logs')).toBe(1);
  expect(create('logs')).toBe(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(183);
  expect(create('logs/session')).toBe(1);
  writeAsciiZ(memory, input, 'logs/*');
  const found = callShim(shim, 'KERNEL32.DLL!FindFirstFileA', [input, input + 1024]).eax;
  expect(found).not.toBe(0xffffffff);
  expect(readU32(memory, input + 1024)).toBe(0x10);
  callShim(shim, 'KERNEL32.DLL!FindClose', [found]);
  writeAsciiZ(memory, input, 'logs');
  expect(callShim(shim, 'KERNEL32.DLL!_lcreat', [input, 0]).eax).toBe(0xffffffff);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(5);
  shim.dispose();
});
