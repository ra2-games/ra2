import { expect, it } from 'vitest';
import { GUEST_THREAD_CRITICAL_DEPTH } from '../../src/vm86/pe';
import { callShim, createGuestMemory, createTestShim, readU32 } from '../helpers/guestMemory';

it.each([
  ['_BinkOpen@8', [0, 0]],
  ['_BinkSetSoundSystem@8', [0, 0]],
  ['_BinkCopyToBuffer@28', [0, 0, 0, 0, 0, 0, 0]],
  ['_BinkGoto@12', [0, 1, 0]],
  ['_BinkWait@4', [0]],
] as const)('does not fabricate success when native %s is unavailable', (name, args) => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { gameId: 'ra2' });
  expect(() => callShim(shim, `BINKW32.DLL!${name}`, [...args], 0x100000)).toThrow(`未实现的导入: BINKW32.DLL!${name}`);
  expect(readU32(memory, GUEST_THREAD_CRITICAL_DEPTH)).toBe(0);
});

it('rejects a required guest DLL that is absent or invalid', () => {
  const shim = createTestShim(createGuestMemory(), { importArgBytes: () => 0 });
  expect(() => shim.linkGuestDllBeforeEntry('test.dll', 0x400000, [])).toThrow(
    'Required guest DLL could not be loaded: test.dll',
  );
  shim.mountFile('test.dll', new Uint8Array(64));
  expect(() => shim.linkGuestDllBeforeEntry('test.dll', 0x400000, [])).toThrow(
    'Required guest DLL could not be loaded: test.dll',
  );
});
