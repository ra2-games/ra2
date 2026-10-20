import { describe, expect, it } from 'vitest';
import { makeImportStub } from '../../src/vm86/pe';
import { makeWin32ImportStub } from '../../src/vm86/win32';

function expectFallbackStub(dll: string, name: string, id: number, argBytes: number): Uint8Array {
  const stub = makeWin32ImportStub(dll, name, id, argBytes);
  const fallback = makeImportStub(id, argBytes);
  expect(stub.length).toBeGreaterThan(fallback.length);
  expect(stub.slice(-fallback.length)).toEqual(fallback);
  return stub;
}

describe('Win32 热点客体快速桩', () => {
  it('互斥体统一由 host 处理，通用桩不再硬编码游戏句柄', () => {
    expect(makeWin32ImportStub('KERNEL32.DLL', 'WaitForSingleObject', 7, 8)).toEqual(makeImportStub(7, 8));
    expect(makeWin32ImportStub('KERNEL32.DLL', 'ReleaseMutex', 8, 4)).toEqual(makeImportStub(8, 4));
  });

  it('PeekMessageA 使用预算并保留周期性 host fallback', () => {
    const stub = expectFallbackStub('USER32.DLL', 'PeekMessageA', 9, 20);
    expect(stub[0]).toBe(0xa1); // mov eax, [HYPERCALL_PEEK_BUDGET]
  });

  it('GetCursorPos 完全留在客体且按 stdcall 弹参', () => {
    const stub = makeWin32ImportStub('USER32.DLL', 'GetCursorPos', 10, 4);
    expect([...stub.slice(0, 4)]).toEqual([0x8b, 0x4c, 0x24, 0x04]);
    expect(stub.length).toBeLessThan(makeImportStub(10, 4).length);
    expect([...stub.slice(-3)]).toEqual([0xc2, 4, 0]);
  });
});
