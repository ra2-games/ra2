import { expect, it } from 'vitest';
import { createGuestMemory, createTestShim, callShim, readU32 } from '../helpers/guestMemory';

it('单客体进程的 PID 稳定，与窗口归属一致，且不同于进程伪句柄', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  callShim(shim, 'KERNEL32.DLL!SetLastError', [123]);
  const pid = callShim(shim, 'KERNEL32.DLL!GetCurrentProcessId').eax;
  expect(pid).toBeGreaterThan(0);
  expect(callShim(shim, 'KERNEL32.DLL!GetCurrentProcessId').eax).toBe(pid);
  expect(callShim(shim, 'KERNEL32.DLL!GetCurrentProcess').eax).not.toBe(pid);
  expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(123);
  callShim(shim, 'USER32.DLL!GetWindowThreadProcessId', [0x10001, 0x310000]);
  expect(readU32(memory, 0x310000)).toBe(pid);
});
