import { describe, expect, it } from 'vitest';
import { GuestProcessKernel } from '../../src/vm86/processKernel';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

describe('guest process kernel', () => {
  it('inherits only eligible handles, retains views after close, and transfers actual guest writes', () => {
    const k = new GuestProcessKernel();
    const parent = k.createProcess();
    const shared = k.mapping(parent, '', 4096, true, true).handle;
    const privateMapping = k.mapping(parent, '', 32, true, false).handle;
    const child = k.createProcess(parent, true);
    const unrelated = k.createProcess();
    expect(k.has(child, shared)).toBe(true);
    expect(k.has(child, privateMapping)).toBe(false);
    expect(k.has(unrelated, shared)).toBe(false);
    const a = createGuestMemory(8192),
      b = createGuestMemory(8192);
    k.map(parent, shared, a, 4096, 0, 4096, true);
    k.map(child, shared, b, 4096, 0, 4096, true);
    k.close(parent, shared);
    a.write_memory([17, 29, 41], 4096);
    k.unmap(parent, 4096);
    k.synchronize(child);
    expect([...b.read_memory(4096, 3)]).toEqual([17, 29, 41]);
    k.close(child, shared);
    b.write_memory([53], 4097);
    k.unmap(child, 4096);
    expect(() => k.map(child, shared, b, 4096, 0, 32, true)).toThrow();
  });

  it('keeps named events case-sensitive, distinguishes missing and wrong-type objects, and consumes auto-reset once', () => {
    const k = new GuestProcessKernel(),
      p = k.createProcess(),
      c = k.createProcess();
    expect(() => k.open(c, 'Ready', 'event', false)).toThrow();
    const event = k.event(p, 'Ready', false, false, false);
    expect(event.existed).toBe(false);
    expect(() => k.open(c, 'ready', 'event', false)).toThrow();
    expect(() => k.mutex(c, 'Ready', null, false)).toThrow();
    const receiver = k.open(c, 'Ready', 'event', false);
    expect(k.ready(c, receiver, k.threadId(c, 0))).toBe(false);
    k.setEvent(p, event.handle, true);
    expect(k.ready(c, receiver, k.threadId(c, 0))).toBe(true);
    k.consume(c, receiver, k.threadId(c, 0));
    expect(k.ready(p, event.handle, k.threadId(p, 0))).toBe(false);
    k.close(p, event.handle);
    expect(k.event(c, 'Ready', true, true, false).existed).toBe(true);
  });

  it('does not invent queues, readiness, process completion, or successful mappings', () => {
    const k = new GuestProcessKernel(),
      p = k.createProcess(),
      c = k.createProcess();
    const id = k.threadId(c, 0);
    expect(() => k.post(id, { message: 1000, wParam: 0, lParam: 0 })).toThrow();
    k.ensureQueue(c, 0);
    k.post(id, { message: 1000, wParam: 7, lParam: 9 });
    expect(k.take(c, 0)).toEqual([{ message: 1000, wParam: 7, lParam: 9 }]);
    expect(k.take(c, 0)).toEqual([]);
    const handles = k.processHandles(p, c);
    expect(k.exitCode(p, handles.process)).toBe(259);
    expect(k.ready(p, handles.process, k.threadId(p, 0))).toBe(false);
    k.exit(c, 23);
    expect(k.exitCode(p, handles.process)).toBe(23);
    expect(k.ready(p, handles.process, k.threadId(p, 0))).toBe(true);
    expect(() => k.post(id, { message: 1000, wParam: 0, lParam: 0 })).toThrow();
    expect(() => k.mapping(p, '', 0, true, false)).toThrow();
  });

  it('routes shim calls between independent processes without launcher profile substitutions', () => {
    const kernel = new GuestProcessKernel(),
      p = kernel.createProcess(),
      c = kernel.createProcess();
    const a = createGuestMemory(),
      b = createGuestMemory();
    const parent = createTestShim(a, { processContext: { kernel, pid: p } });
    const child = createTestShim(b, { processContext: { kernel, pid: c } });
    writeAsciiZ(a, 0x10000, 'TestMutex');
    writeAsciiZ(b, 0x10000, 'TestMutex');
    const one = callShim(parent, 'KERNEL32.DLL!CreateMutexA', [0, 0, 0x10000]);
    expect(callShim(parent, 'KERNEL32.DLL!GetLastError').eax).toBe(0);
    const two = callShim(child, 'KERNEL32.DLL!CreateMutexA', [0, 0, 0x10000]);
    expect(callShim(child, 'KERNEL32.DLL!GetLastError').eax).toBe(183);
    expect(two.eax).not.toBe(one.eax);
    const thread = callShim(child, 'KERNEL32.DLL!GetCurrentThreadId').eax;
    expect(callShim(parent, 'USER32.DLL!PostThreadMessageA', [thread, 1000, 7, 9]).eax).toBe(0);
    callShim(child, 'USER32.DLL!PeekMessageA', [0x11000, 0, 1000, 1000, 1]);
    expect(callShim(parent, 'USER32.DLL!PostThreadMessageA', [thread, 1000, 7, 9]).eax).toBe(1);
    expect(callShim(child, 'USER32.DLL!PeekMessageA', [0x11000, 0, 1000, 1000, 1]).eax).toBe(1);
    expect(readU32(b, 0x11004)).toBe(1000);
    expect(readU32(b, 0x1100c)).toBe(9);
    writeU32(a, 0x12000, 68);
    writeAsciiZ(a, 0x13000, 'child.exe');
    const request = callShim(parent, 'KERNEL32.DLL!CreateProcessA', [0, 0x13000, 0, 0, 1, 0, 0, 0, 0x12000, 0x14000]);
    expect(request.eax).toBe(0);
    expect(request.createProcess?.commandLine).toBe('child.exe');
    expect(readU32(a, 0x14000)).toBe(0);
    // A debugger-created suspended child cannot be downgraded to ordinary execution.
    const debugRequest = callShim(
      parent,
      'KERNEL32.DLL!CreateProcessA',
      [0, 0x13000, 0, 0, 0, 6, 0, 0, 0x12000, 0x14000],
    );
    expect(debugRequest.eax).toBe(0);
    expect(debugRequest.createProcess?.flags).toBe(6);
    expect(readU32(a, 0x14000)).toBe(0);
    expect(callShim(parent, 'KERNEL32.DLL!CloseHandle', [one.eax]).eax).toBe(1);
    expect(callShim(parent, 'KERNEL32.DLL!CloseHandle', [one.eax]).eax).toBe(0);
    expect(callShim(parent, 'KERNEL32.DLL!GetLastError').eax).toBe(6);
    parent.dispose();
    child.dispose();
  });
});

it('preserves object access and reports abandonment without inventing process exit', () => {
  const k = new GuestProcessKernel(),
    p = k.createProcess(),
    c = k.createProcess();
  const owner = k.threadId(p, 0),
    waiter = k.threadId(c, 0);
  const original = k.mutex(p, 'Owned', owner, true);
  const mutex = k.open(c, 'Owned', 'mutex', false);
  expect(k.ready(c, mutex, waiter)).toBe(false);
  const handles = k.processHandles(c, p);
  k.exitThread(p, 0, 13);
  expect(k.ready(c, handles.thread, waiter)).toBe(true);
  expect(k.ready(c, handles.process, waiter)).toBe(false);
  expect(k.ready(c, mutex, waiter)).toBe(true);
  expect(k.consume(c, mutex, waiter)).toBe(true);
  k.event(p, 'Restricted', true, false, false);
  const restricted = k.open(c, 'Restricted', 'event', false, 0x100000);
  expect(() => k.setEvent(c, restricted, true)).toThrow('Access denied');
  k.close(p, original.handle);
  k.exit(p, 13);
  expect(k.exitCode(c, handles.process)).toBe(13);
});
