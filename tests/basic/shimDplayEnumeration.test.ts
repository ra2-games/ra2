import { describe, expect, it } from 'vitest';
import { Win32Shim } from '../../src/games/win32Shim';
import type { Win32Call } from '../../src/vm86/win32';
import type { DplayTransportHandlers } from '../../src/vm86/shim/dplayTransport';
import {
  GUEST_CALLBACK_BASE,
  GUEST_CALLBACK_OWNERS,
  GUEST_CALLBACK_STRIDE,
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_THREAD_CURRENT,
} from '../../src/vm86/pe';
import { callShim, createGuestMemory, readU32, writeU32 } from '../helpers/guestMemory';

class EnumerationShim extends Win32Shim {
  callbackArguments: number[][] = [];
  startDplay(): number {
    return this.createDirectPlay();
  }
  protected override invokeGuestCallbacks(call: Win32Call, callback: number, sets: number[][], result = 0) {
    this.callbackArguments = sets;
    return super.invokeGuestCallbacks(call, callback, sets, result);
  }
}

function fixture() {
  const memory = createGuestMemory();
  let transport!: DplayTransportHandlers;
  const shim = new EnumerationShim(memory, {
    heapTop: 0xc00000,
    virtualTop: 0xc00000,
    dplayTransportFactory: (handlers) => {
      transport = handlers;
      return { clientId: 'enumeration-test', send: () => true, close: () => {} };
    },
  });
  const object = shim.startDplay();
  callShim(shim, 'DPLAYX.COM!IDirectPlay3.InitializeConnection', [object, 0, 0]);
  const instance = '11111111-1111-1111-1111-111111111111';
  function announce(players: number, session = instance) {
    transport.onMessage({
      t: 'announce',
      i: session,
      n: Uint8Array.from([65]),
      m: 8,
      c: players,
      g: '22222222-2222-2222-2222-222222222222',
      f: 0,
    });
  }
  function enumerate() {
    const stack = 0x3000;
    writeU32(memory, stack, 0x401000);
    const result = callShim(shim, 'DPLAYX.COM!IDirectPlay3.EnumSessions', [object, 0, 0, 0x402000, 0, 0], stack);
    const bridge = readU32(memory, stack);
    const owner = GUEST_CALLBACK_OWNERS + ((bridge - GUEST_CALLBACK_BASE) / GUEST_CALLBACK_STRIDE) * 4;
    return { result, owner, descriptor: shim.callbackArguments[0]?.[0] ?? 0 };
  }
  function finish(owner: number) {
    // Dispatch-level tests model the release performed by the real guest bridge tail.
    writeU32(memory, owner, 0);
    writeU32(memory, HYPERCALL_CALLBACK_DEPTH, readU32(memory, HYPERCALL_CALLBACK_DEPTH) - 1);
  }
  return {
    memory,
    shim,
    announce,
    enumerate,
    finish,
    closeRoom: () => transport.onMessage({ t: 'sclose', i: instance }),
  };
}

describe('DirectPlay enumeration callback storage', () => {
  it('releases staging and the reserved slot when the callback bridge is too large', () => {
    const { memory, shim, announce, enumerate } = fixture();
    const baseline = shim.inspectHeapState().liveBytes;
    for (let i = 0; i < 200; i++) announce(1, `${i.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`);
    expect(() => enumerate()).toThrow(/超出槽位/);
    expect(shim.inspectHeapState().liveBytes).toBe(baseline);
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(0);
    expect(readU32(memory, GUEST_CALLBACK_OWNERS)).toBe(0);
    expect(readU32(memory, 0x3000)).toBe(0x401000);
  });

  it('rolls back partial allocation failure without writing low guest memory', () => {
    const { memory, shim, announce, enumerate } = fixture();
    const heap = 0x10001;
    const spare = callShim(shim, 'KERNEL32.DLL!HeapAlloc', [heap, 0, 16]).eax;
    expect(spare).toBeGreaterThan(0);
    while (callShim(shim, 'KERNEL32.DLL!HeapAlloc', [heap, 0, 0x10000]).eax);
    while (callShim(shim, 'KERNEL32.DLL!HeapAlloc', [heap, 0, 16]).eax);
    // Leave space for a name but not its descriptor; failure must return the name allocation too.
    expect(callShim(shim, 'KERNEL32.DLL!HeapFree', [heap, 0, spare]).eax).toBe(1);
    const baseline = shim.inspectHeapState().liveBytes;
    const lowMemory = memory.read_memory(0, 128).slice();
    announce(1);
    expect(enumerate().result.eax).toBe(0x8007000e);
    expect(shim.inspectHeapState().liveBytes).toBe(baseline);
    expect(memory.read_memory(0, 128)).toEqual(lowMemory);
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(0);
  });

  it('preserves suspended outer callbacks across nested enumerations', () => {
    const { memory, announce, enumerate } = fixture();
    announce(1);
    const outer = enumerate();
    const before = memory.read_memory(outer.descriptor, 80).slice();
    announce(2);
    enumerate();
    announce(3);
    enumerate();
    expect(readU32(memory, outer.owner)).not.toBe(0);
    expect(memory.read_memory(outer.descriptor, 80)).toEqual(before);
  });

  it('reclaims completed callbacks out of order while retaining an older active callback', () => {
    const { memory, shim, announce, enumerate, finish, closeRoom } = fixture();
    const baseline = shim.inspectHeapState().liveBytes;
    announce(1);
    const outer = enumerate();
    const retained = shim.inspectHeapState().liveBytes;
    for (let i = 0; i < 100; i++) {
      announce(2);
      const inner = enumerate();
      expect(readU32(memory, outer.descriptor + 44)).toBe(1);
      finish(inner.owner);
    }
    closeRoom();
    enumerate();
    expect(shim.inspectHeapState().liveBytes).toBe(retained);
    finish(outer.owner);
    enumerate();
    expect(shim.inspectHeapState().liveBytes).toBe(baseline);
  });

  it('reclaims an exited thread callback without releasing another thread data', () => {
    const { memory, shim, announce, enumerate, finish, closeRoom } = fixture();
    const baseline = shim.inspectHeapState().liveBytes;
    announce(1);
    const outer = enumerate();
    const outerBytes = shim.inspectHeapState().liveBytes - baseline;
    const handle = callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x401000, 0, 0, 0]).eax;
    const thread = shim.inspectGuestThreads().find((value) => value.handle === handle)!;
    writeU32(memory, HYPERCALL_THREAD_CURRENT, thread.id);
    announce(2);
    enumerate();
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
    const beforeCleanup = shim.inspectHeapState().liveBytes;
    closeRoom();
    enumerate();
    expect(shim.inspectHeapState().liveBytes).toBe(beforeCleanup - outerBytes);
    expect(readU32(memory, outer.descriptor + 44)).toBe(1);
    finish(outer.owner);
    enumerate();
  });
});
