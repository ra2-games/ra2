import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

function fixture(gameId?: 'ra2' | 'yr') {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, { gameId });
  writeAsciiZ(memory, 0x1000, "SOFTWARE\\Westwood\\Yuri's Revenge");
  writeAsciiZ(memory, 0x1100, 'Serial');
  // Explicitly create an empty test key; no installation identity is prepopulated.
  callShim(shim, 'ADVAPI32.DLL!RegCreateKeyExA', [0x80000002, 0x1000, 0, 0, 0, 0xf003f, 0, 0x1200, 0]);
  const handle = readU32(memory, 0x1200);
  const query = (capacity = 128, destination = 0x1400) => {
    writeU32(memory, 0x1300, capacity);
    const result = callShim(shim, 'ADVAPI32.DLL!RegQueryValueExA', [handle, 0x1100, 0, 0x1304, destination, 0x1300]);
    return {
      result: result.eax,
      size: readU32(memory, 0x1300),
      type: readU32(memory, 0x1304),
      bytes: memory.read_memory(0x1400, readU32(memory, 0x1300)).slice(),
    };
  };
  return { memory, shim, handle, query };
}

describe('YR 虚拟安装会话身份', () => {
  it('missing credentials stay missing across reads and VM instances', () => {
    const a = fixture('yr'),
      b = fixture('yr');
    expect(a.query().result).toBe(2);
    expect(a.query().result).toBe(2);
    expect(b.query().result).toBe(2);
  });

  it('explicit registry data obeys size queries and buffer bounds', () => {
    const f = fixture('yr');
    // This is intentionally not an activation key; only registry transport is tested.
    writeAsciiZ(f.memory, 0x1500, 'invalid');
    callShim(f.shim, 'ADVAPI32.DLL!RegSetValueExA', [f.handle, 0x1100, 0, 1, 0x1500, 8]);
    expect(f.query(0, 0)).toMatchObject({ result: 0, size: 8, type: 1 });
    f.memory.bytes.fill(0xcc, 0x1400, 0x1420);
    expect(f.query(7)).toMatchObject({ result: 234, size: 8 });
    expect(f.memory.read_memory(0x1400, 32)).toEqual(new Uint8Array(32).fill(0xcc));
    expect(f.query(8).result).toBe(0);
    expect(f.memory.bytes[0x1408]).toBe(0xcc);
  });

  it('deleting explicit credentials does not regenerate a fallback', () => {
    const f = fixture('yr');
    expect(f.query().result).toBe(2);
    writeAsciiZ(f.memory, 0x1500, 'explicit-value');
    expect(callShim(f.shim, 'ADVAPI32.DLL!RegSetValueExA', [f.handle, 0x1100, 0, 1, 0x1500, 15]).eax).toBe(0);
    expect(new TextDecoder().decode(f.query().bytes)).toBe('explicit-value\0');
    callShim(f.shim, 'ADVAPI32.DLL!RegDeleteValueA', [f.handle, 0x1100]);
    expect(f.query().result).toBe(2);
  });

  it.each(['ra2', undefined] as const)('不影响其他 profile（%s）或未知注册表键', (gameId) => {
    expect(fixture(gameId).query().result).toBe(2);
    const f = fixture('yr');
    writeAsciiZ(f.memory, 0x1100, 'Unknown');
    expect(f.query().result).toBe(2);
  });
});
