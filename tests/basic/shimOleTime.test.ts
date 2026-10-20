import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32 } from '../helpers/guestMemory';

const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

describe('OLE32 time', () => {
  it('CoFileTimeNow writes the current guest wall clock as FILETIME', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const output = 0x3000;
    const before = Date.now();

    expect(callShim(shim, 'OLE32.DLL!CoFileTimeNow', [output]).eax).toBe(0);

    const after = Date.now();
    const actual = BigInt(readU32(memory, output)) | (BigInt(readU32(memory, output + 4)) << 32n);
    const unixMilliseconds = Number((actual - FILETIME_UNIX_EPOCH) / 10_000n);
    expect(unixMilliseconds).toBeGreaterThanOrEqual(before - 1);
    expect(unixMilliseconds).toBeLessThanOrEqual(after + 1);
  });

  it('CoFileTimeNow rejects a null output pointer', () => {
    const shim = createTestShim(createGuestMemory());
    expect(callShim(shim, 'OLE32.DLL!CoFileTimeNow', [0]).eax).toBe(0x8000_4003);
  });
});
