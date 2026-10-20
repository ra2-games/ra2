import { describe, expect, it } from 'vitest';
import { GUEST_THREAD_CONTEXT_ESPS, HYPERCALL_THREAD_CURRENT, type PeImport } from '../../src/vm86/pe';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const WAIT_FAILED = 0xffff_ffff;

describe('Guest wait handle identity', () => {
  it.each([
    ['ra2', 'event', false],
    ['yr', 'event', false],
    ['ra2', 'mutex', false],
    ['yr', 'mutex', false],
    ['ra2', 'event', true],
    ['yr', 'mutex', true],
  ] as const)('%s %s handles cannot alias later threads (closed=%s)', (gameId, kind, closed) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { gameId });
    let handle = 0;
    // Cross the former first-thread handle through normal create/close calls, without keeping thousands of objects alive.
    for (let count = 0; count < 5000 && handle < 0x0001_1000; count++) {
      if (handle) callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
      handle =
        kind === 'event'
          ? callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 1, 1, 0]).eax
          : callShim(shim, 'KERNEL32.DLL!CreateMutexA', [0, 0, 0]).eax;
    }
    expect(handle).toBeGreaterThanOrEqual(0x0001_1000);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [handle, 0]).eax).toBe(WAIT_OBJECT_0);
    if (closed) callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
    const thread = callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x401000, 0, 0, 0]).eax;
    expect(thread).not.toBe(0);
    expect(thread).not.toBe(handle);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [handle, 0]).eax).toBe(
      closed ? WAIT_FAILED : WAIT_OBJECT_0,
    );
    if (!closed) callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [handle, 0]).eax).toBe(WAIT_FAILED);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [thread, 0]).eax).toBe(WAIT_TIMEOUT);
  });
});

describe('Win32 event 语义', () => {
  it('auto-reset event 只消费一次，manual-reset event 保持到 ResetEvent', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const auto = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 0, 1, 0]).eax;
    const manual = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 1, 1, 0]).eax;

    expect(auto).not.toBe(manual);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [auto, 0]).eax).toBe(WAIT_OBJECT_0);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [auto, 0]).eax).toBe(WAIT_TIMEOUT);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [manual, 0]).eax).toBe(WAIT_OBJECT_0);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [manual, 0]).eax).toBe(WAIT_OBJECT_0);
    expect(callShim(shim, 'KERNEL32.DLL!ResetEvent', [manual]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [manual, 0]).eax).toBe(WAIT_TIMEOUT);
    expect(callShim(shim, 'KERNEL32.DLL!SetEvent', [manual]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [manual, 0]).eax).toBe(WAIT_OBJECT_0);
  });

  it('命名 event 的 Create/Open 共享状态并报告 ERROR_ALREADY_EXISTS', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const name = 0x2000;
    writeAsciiZ(memory, name, 'load-complete');
    const first = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 1, 0, name]).eax;
    const second = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 0, 1, name]).eax;
    expect(second).not.toBe(first);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(183);
    const opened = callShim(shim, 'KERNEL32.DLL!OpenEventA', [0, 0, name]).eax;
    expect(opened).not.toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!SetEvent', [first]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [opened, 0]).eax).toBe(WAIT_OBJECT_0);
  });

  it('WaitForMultipleObjects 返回就绪索引并验证句柄', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const first = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 1, 0, 0]).eax;
    const second = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 1, 1, 0]).eax;
    const handles = 0x3000;
    writeU32(memory, handles, first);
    writeU32(memory, handles + 4, second);

    expect(callShim(shim, 'KERNEL32.DLL!WaitForMultipleObjects', [2, handles, 0, 0]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForMultipleObjects', [2, handles, 1, 0]).eax).toBe(WAIT_TIMEOUT);
    writeU32(memory, handles + 4, 0xdead_beef);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForMultipleObjects', [2, handles, 0, 0]).eax).toBe(WAIT_FAILED);
  });

  it('当前线程等待完成不覆写上一次切换留下的旧上下文', async () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const event = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 1, 0, 0]).eax;
    const staleContext = 0x9000;
    const sentinel = 0x1234_5678;
    const waitMs = 100;
    writeU32(memory, GUEST_THREAD_CONTEXT_ESPS, staleContext);
    writeU32(memory, staleContext + 28, sentinel);

    const imported: PeImport = {
      id: 1,
      dll: 'KERNEL32.DLL',
      name: 'WaitForSingleObject',
      key: 'KERNEL32.DLL!WaitForSingleObject',
      slot: 0,
      stub: 0,
      argBytes: 8,
    };
    const result = callShim(shim, imported.key, [event, waitMs]);
    const delay = shim.prepareGuestThreadReturn({ imported, args: [event, waitMs] }, result);
    expect(delay).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(delay) + 25));
    const completion = shim.completeGuestThreadDelay();

    expect(completion.result).toBe(WAIT_TIMEOUT);
    expect(readU32(memory, staleContext + 28)).toBe(sentinel);
  });
});

describe('Win32 mutex 语义', () => {
  it('互斥体有独立句柄、owner 与递归计数', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const mutex = callShim(shim, 'KERNEL32.DLL!CreateMutexA', [0, 0, 0]).eax;
    const other = callShim(shim, 'KERNEL32.DLL!CreateMutexA', [0, 0, 0]).eax;
    expect(other).not.toBe(mutex);

    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [mutex, 0]).eax).toBe(WAIT_OBJECT_0);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [mutex, 0]).eax).toBe(WAIT_OBJECT_0);
    expect(callShim(shim, 'KERNEL32.DLL!ReleaseMutex', [mutex]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!ReleaseMutex', [mutex]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!ReleaseMutex', [mutex]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(288);
  });

  it('其他线程对已占有 mutex 的零超时等待返回 WAIT_TIMEOUT', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const mutex = callShim(shim, 'KERNEL32.DLL!CreateMutexA', [0, 1, 0]).eax;
    callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x401000, 0, 0, 0]);
    writeU32(memory, HYPERCALL_THREAD_CURRENT, 1);
    expect(callShim(shim, 'KERNEL32.DLL!WaitForSingleObject', [mutex, 0]).eax).toBe(WAIT_TIMEOUT);
    expect(callShim(shim, 'KERNEL32.DLL!ReleaseMutex', [mutex]).eax).toBe(0);
  });
});
