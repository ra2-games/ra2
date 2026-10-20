/** Game compatibility capabilities require explicit opt-in; the default shim inherits no supported game's patches. */
import { describe, expect, it } from 'vitest';
import { RA2_SHIM_PROFILE } from '../../src/games/ra2/profile';
import { YR_SHIM_PROFILE } from '../../src/games/yr/profile';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

describe('游戏 shim 隔离', () => {
  it('RA2 与 YR profile 显式开启各自能力', () => {
    expect(RA2_SHIM_PROFILE.virtualWinsockLan).toBe(true);
  });

  it('默认 profile 不接管 RA2 的 XWIS 与 Winsock 导入', () => {
    const shim = createTestShim(createGuestMemory());
    expect(() => callShim(shim, 'XWIS.DLL!ord1')).toThrow(/未实现的导入/);
    expect(() => callShim(shim, 'WSOCK32.DLL!ord115', [0x0101, 0x2000])).toThrow(/未实现的导入/);
  });

  it('RA2 rejects unsupported XWIS imports while retaining virtual Winsock', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameProfile: RA2_SHIM_PROFILE });
    expect(() => callShim(shim, 'XWIS.DLL!ord1')).toThrow(/未实现的导入/);
    expect(callShim(shim, 'WSOCK32.DLL!ord115', [0x0101, 0x2000]).eax).toBe(0);
    expect(memory.read_memory(0x2000, 4)).toEqual(new Uint8Array([1, 1, 1, 1]));
  });

  it('XWIS launcher 哨兵不会泄漏到默认同步对象层', () => {
    const name = 0x3000;
    const baseMemory = createGuestMemory();
    writeAsciiZ(baseMemory, name, '48bc11bd-c4d7-466b-8a31-c6abbad47b3e');
    const base = createTestShim(baseMemory);
    expect(callShim(base, 'KERNEL32.DLL!OpenMutexA', [0, 0, name]).eax).toBe(0);

    const ra2Memory = createGuestMemory();
    writeAsciiZ(ra2Memory, name, '48bc11bd-c4d7-466b-8a31-c6abbad47b3e');
    const ra2 = createTestShim(ra2Memory, { gameProfile: RA2_SHIM_PROFILE });
    expect(callShim(ra2, 'KERNEL32.DLL!OpenMutexA', [0, 0, name]).eax).toBe(0);
  });

  it.each([RA2_SHIM_PROFILE, YR_SHIM_PROFILE])(
    'does not manufacture launcher objects or verification data',
    (profile) => {
      const memory = createGuestMemory();
      const shim = createTestShim(memory, { gameProfile: profile });
      writeAsciiZ(memory, 0x4000, '48bc11bd-c4d7-466b-8a31-c6abbad47b3e');
      writeAsciiZ(memory, 0x4100, 'd6e7fc97-64f9-4d28-b52c-754edf721c6f');
      expect(callShim(shim, 'KERNEL32.DLL!OpenMutexA', [0, 0, 0x4000]).eax).toBe(0);
      expect(callShim(shim, 'KERNEL32.DLL!OpenEventA', [2, 0, 0x4100]).eax).toBe(0);
      expect(callShim(shim, 'USER32.DLL!PeekMessageA', [0x3000, 0, 0xbeef, 0xbeef, 1]).eax).toBe(0);
      expect(callShim(shim, 'KERNEL32.DLL!MapViewOfFileEx', [0x10020, 0xf001f, 0, 0, 0, 0]).eax).toBe(0);
      expect(callShim(shim, 'KERNEL32.DLL!UnmapViewOfFile', [0]).eax).toBe(0);
    },
  );

  it('missing YR Serial remains missing; explicitly supplied registry data is preserved', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameProfile: YR_SHIM_PROFILE });
    writeAsciiZ(memory, 0x4000, "Software\\Westwood\\Yuri's Revenge");
    writeAsciiZ(memory, 0x4100, 'Serial');
    expect(callShim(shim, 'ADVAPI32.DLL!RegOpenKeyExA', [0x80000002, 0x4000, 0, 0x20019, 0x4200]).eax).toBe(2);
    callShim(shim, 'ADVAPI32.DLL!RegCreateKeyExA', [0x80000002, 0x4000, 0, 0, 0, 0xf003f, 0, 0x4200, 0]);
    const handle = readU32(memory, 0x4200);
    const query = () => callShim(shim, 'ADVAPI32.DLL!RegQueryValueExA', [handle, 0x4100, 0, 0, 0x4300, 0x4400]);
    writeU32(memory, 0x4400, 64);
    expect(query().eax).toBe(2);
    expect(query().eax).toBe(2);
    // Deliberately invalid data checks registry transport, not key acceptance.
    writeAsciiZ(memory, 0x4500, 'invalid-test-input');
    callShim(shim, 'ADVAPI32.DLL!RegSetValueExA', [handle, 0x4100, 0, 1, 0x4500, 19]);
    expect(query().eax).toBe(0);
    expect(memory.read_memory(0x4300, 19)).toEqual(memory.read_memory(0x4500, 19));
  });
});
