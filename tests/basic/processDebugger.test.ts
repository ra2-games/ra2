import { expect, it, vi } from 'vitest';
import { GuestProcessKernel } from '../../src/vm86/processKernel';
import { type DebugProcessTarget } from '../../src/vm86/processDebugger';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../helpers/guestMemory';

function setup() {
  const kernel = new GuestProcessKernel(),
    owner = kernel.createProcess(),
    child = kernel.createProcess(owner);
  const memory = createGuestMemory(),
    caller = createGuestMemory();
  const target: DebugProcessTarget = {
    memory,
    memoryBytes: memory.bytes.length,
    imageBase: 0x400000,
    entry: 0x401000,
    allocate: vi.fn(() => 0x120000),
    free: vi.fn(() => true),
    context: () => new Uint8Array(716),
    setContext: vi.fn(),
    resume: vi.fn(),
    unhandledException: vi.fn(),
  };
  const handles = kernel.processHandles(owner, child);
  const session = kernel.attachDebugger(owner, child, target);
  const shim = createTestShim(caller, { processContext: { kernel, pid: owner } });
  return { kernel, owner, child, caller, memory, target, handles, session, shim };
}
it('keeps suspended creation, debugger event handles and continuation independent', async () => {
  const s = setup();
  expect(s.target.resume).not.toHaveBeenCalled();
  expect(s.session.resumeThread()).toBe(1);
  expect(s.target.resume).not.toHaveBeenCalled();
  const event = (await s.session.wait(0))!;
  expect(event.code).toBe(3);
  const eventThread = event.data[2]!;
  expect(eventThread).not.toBe(s.handles.thread);
  s.kernel.close(s.owner, s.handles.thread);
  expect(s.kernel.debugHandle(s.owner, eventThread, 'thread', 8).tid).toBe(event.tid);
  expect(() => s.session.continue(s.child, event.tid + 1, 0x10002)).toThrow();
  s.session.continue(event.pid, event.tid, 0x10002);
  expect(s.target.resume).toHaveBeenCalledOnce();
  s.shim.dispose();
});
it('delivers actual exceptions to a pending wait and rejects running-thread contexts', async () => {
  const s = setup(),
    event = (await s.session.wait(0))!;
  s.session.resumeThread();
  s.session.continue(event.pid, event.tid, 0x10002);
  expect(() => s.session.getContext(event.tid, 0x10001)).toThrow();
  const wait = s.session.wait(1000);
  s.session.exception(event.tid, 0x80000003, 0x401000);
  expect((await wait)?.data[3]).toBe(0x401000);
  expect(new DataView(s.session.getContext(event.tid, 0x10001).buffer).getUint32(0, true)).toBe(0x10001);
  expect(() => s.session.getContext(event.tid, 0x10010)).toThrow();
  s.shim.dispose();
});
it('copies only actual debuggee bytes and rejects invalid ranges without successful counts', () => {
  const s = setup();
  s.memory.write_memory([1, 2, 3, 4], 0x120000);
  const read = (address: number) =>
    callShim(s.shim, 'KERNEL32.DLL!ReadProcessMemory', [s.handles.process, address, 0x110000, 4, 0x110100]);
  expect(read(0x120000).eax).toBe(1);
  expect([...s.caller.read_memory(0x110000, 4)]).toEqual([1, 2, 3, 4]);
  writeU32(s.caller, 0x110100, 99);
  expect(read(s.memory.bytes.length - 1).eax).toBe(0);
  expect(readU32(s.caller, 0x110100)).toBe(99);
  s.shim.dispose();
});
it('cancels a pending debugger wait during teardown', async () => {
  const s = setup(),
    event = (await s.session.wait(0))!;
  s.session.resumeThread();
  s.session.continue(event.pid, event.tid, 0x10002);
  const wait = s.session.wait(0xffffffff);
  s.kernel.exit(s.owner, 0);
  expect(await wait).toBeNull();
  s.shim.dispose();
});

it('reports a debugger-declined exception without executing past the fault', async () => {
  const s = setup();
  const created = (await s.session.wait(0))!;
  s.session.resumeThread();
  s.session.continue(created.pid, created.tid, 0x10002);
  vi.mocked(s.target.resume).mockClear();
  s.session.exception(created.tid, 0xc000001d, 0x401234);
  const fault = (await s.session.wait(0))!;
  s.session.continue(fault.pid, fault.tid, 0x80010001);
  expect(s.target.unhandledException).toHaveBeenCalledWith(0xc000001d, 0x401234);
  expect(s.target.resume).not.toHaveBeenCalled();
  s.shim.dispose();
});

it('holds thread-exit notification until the native debugger continues it', async () => {
  const s = setup();
  const created = (await s.session.wait(0))!;
  s.session.resumeThread();
  s.session.continue(created.pid, created.tid, 0x10002);
  const released = vi.fn();
  const stopped = s.session.threadExited(created.tid, 17).then(released);
  const event = (await s.session.wait(0))!;
  expect(event.code).toBe(4);
  expect(event.data).toEqual([17]);
  expect(released).not.toHaveBeenCalled();
  s.session.continue(event.pid, event.tid, 0x10002);
  await stopped;
  expect(released).toHaveBeenCalledOnce();
  s.shim.dispose();
});

it.each(['dispose', 'owner-exit', 'child-exit'] as const)(
  'reports the debuggee identity and clears debugger presence on %s',
  (ending) => {
    const s = setup();
    const child = createTestShim(s.memory, { processContext: { kernel: s.kernel, pid: s.child } });
    const other = createTestShim(createGuestMemory(), {
      processContext: { kernel: s.kernel, pid: s.kernel.createProcess() },
    });
    try {
      expect(callShim(s.shim, 'KERNEL32.DLL!IsDebuggerPresent').eax).toBe(0);
      expect(callShim(other, 'KERNEL32.DLL!IsDebuggerPresent').eax).toBe(0);
      expect(callShim(child, 'KERNEL32.DLL!IsDebuggerPresent').eax).toBe(1);
      s.kernel.close(s.owner, s.handles.process);
      expect(callShim(child, 'KERNEL32.DLL!IsDebuggerPresent').eax).toBe(1);
      if (ending === 'dispose') s.session.dispose();
      else s.kernel.exit(ending === 'owner-exit' ? s.owner : s.child, 0);
      expect(callShim(child, 'KERNEL32.DLL!IsDebuggerPresent').eax).toBe(0);
    } finally {
      child.dispose();
      other.dispose();
      s.shim.dispose();
    }
  },
);
