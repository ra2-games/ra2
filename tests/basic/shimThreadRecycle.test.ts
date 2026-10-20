import { describe, expect, it } from 'vitest';
import { Win32Shim } from '../../src/games/win32Shim';
import {
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_THREAD_FPU_CONTEXTS,
  GUEST_THREAD_FPU_CONTEXT_BYTES,
  GUEST_THREAD_LIMIT,
  HYPERCALL_THREAD_CURRENT,
} from '../../src/vm86/pe';
import { callShim, createGuestMemory, readU32, writeU32, type FakeGuestMemory } from '../helpers/guestMemory';

/** Run one CreateThread/ExitThread/CloseHandle cycle from the main thread's point of view. */
function cycle(memory: FakeGuestMemory, shim: Win32Shim, stackBytes: number): number {
  const handle = callShim(shim, 'KERNEL32.DLL!CreateThread', [0, stackBytes, 0x401000, 0, 0, 0]).eax;
  if (!handle) return 0;
  const imported = {
    id: 1,
    dll: 'KERNEL32.DLL',
    name: 'ExitThread',
    key: 'KERNEL32.DLL!ExitThread',
    stub: 0,
    slot: 0,
    argBytes: 4,
  };
  // The worker thread exits on its own stack, then the main thread closes its handle.
  const threadId = shim.inspectGuestThreads().find((thread) => thread.handle === handle)!.id;
  writeU32(memory, HYPERCALL_THREAD_CURRENT, threadId);
  const result = callShim(shim, imported.key, [0]);
  shim.prepareGuestThreadReturn({ imported, args: [0] }, result);
  writeU32(memory, HYPERCALL_THREAD_CURRENT, 0);
  callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
  return handle;
}

describe('客体线程回收', () => {
  it('退出并关闭句柄后复用线程 id 与栈内存，长会话不会耗尽 64 个线程', () => {
    const memory = createGuestMemory();
    const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
    const before = shim.inspectHeapState();
    // Far more cycles than GUEST_THREAD_LIMIT: ids and 1MB stacks must both come back.
    for (let i = 0; i < GUEST_THREAD_LIMIT * 3; i++) expect(cycle(memory, shim, 1024 * 1024)).toBeGreaterThan(0);
    const after = shim.inspectHeapState();
    // Only the final cycle's thread may still be pending; the reclaim runs on the next CreateThread.
    expect(shim.inspectGuestThreads().filter((thread) => thread.terminated).length).toBeLessThanOrEqual(1);
    // One live stack may remain until the next CreateThread reclaims it; nothing like 192 leaked stacks.
    expect(after.liveBytes - before.liveBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('句柄仍打开时保留已退出线程的状态，等待方仍可观察到它已结束', () => {
    const memory = createGuestMemory();
    const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
    const handle = callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x401000, 0, 0, 0]).eax;
    const threadId = shim.inspectGuestThreads().find((thread) => thread.handle === handle)!.id;
    writeU32(memory, HYPERCALL_THREAD_CURRENT, threadId);
    const imported = {
      id: 1,
      dll: 'KERNEL32.DLL',
      name: 'ExitThread',
      key: 'KERNEL32.DLL!ExitThread',
      stub: 0,
      slot: 0,
      argBytes: 4,
    };
    shim.prepareGuestThreadReturn({ imported, args: [0] }, callShim(shim, imported.key, [0]));
    writeU32(memory, HYPERCALL_THREAD_CURRENT, 0);
    // A second CreateThread runs the reclaim scan; the open handle must keep the exited thread observable.
    callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x402000, 0, 0, 0]);
    expect(shim.inspectGuestThreads().find((thread) => thread.id === threadId)?.terminated).toBe(true);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [handle, 0]).eax).toBe(0);
  });

  it('复用 id 时清空上个线程的兼容锁深度与 x87 状态', () => {
    const memory = createGuestMemory();
    const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
    const handle = callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x401000, 0, 0, 0]).eax;
    const id = shim.inspectGuestThreads().find((thread) => thread.handle === handle)!.id;
    // The thread dies holding a compat lock and with dirty x87/SSE state saved by FXSAVE.
    writeU32(memory, GUEST_THREAD_CRITICAL_DEPTH + id * 4, 3);
    const fpu = GUEST_THREAD_FPU_CONTEXTS + id * GUEST_THREAD_FPU_CONTEXT_BYTES;
    writeU32(memory, fpu, 0x0c7f);
    writeU32(memory, fpu + 24, 0);
    writeU32(memory, HYPERCALL_THREAD_CURRENT, id);
    const imported = {
      id: 1,
      dll: 'KERNEL32.DLL',
      name: 'ExitThread',
      key: 'KERNEL32.DLL!ExitThread',
      stub: 0,
      slot: 0,
      argBytes: 4,
    };
    shim.prepareGuestThreadReturn({ imported, args: [0] }, callShim(shim, imported.key, [0]));
    writeU32(memory, HYPERCALL_THREAD_CURRENT, 0);
    callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
    const reused = callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x402000, 0, 0, 0]).eax;
    expect(shim.inspectGuestThreads().find((thread) => thread.handle === reused)!.id).toBe(id);
    // Inheriting depth 3 would make the new thread's import tails skip STI and starve the scheduler.
    expect(readU32(memory, GUEST_THREAD_CRITICAL_DEPTH + id * 4)).toBe(0);
    expect(readU32(memory, fpu)).toBe(0x037f);
    expect(readU32(memory, fpu + 24)).toBe(0x1f80);
  });

  it('句柄关闭后线程仍可被等待，直到被回收', () => {
    const memory = createGuestMemory();
    const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
    const handle = callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x401000, 0, 0, 0]).eax;
    // Windows keeps the object alive for a thread already blocked on it when a third thread closes the handle.
    callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [handle, 0]).eax).not.toBe(0xffff_ffff);
  });
});
