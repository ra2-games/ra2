import { describe, expect, it } from 'vitest';
import { Win32Shim } from '../../src/games/win32Shim';
import {
  GUEST_CALLBACK_BASE,
  GUEST_CALLBACK_OWNERS,
  GUEST_CALLBACK_SLOTS,
  GUEST_CALLBACK_STRIDE,
  GUEST_THREAD_CRITICAL_DEPTH,
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_THREAD_CURRENT,
} from '../../src/vm86/pe';
import { callShim, createGuestMemory, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';
import type { GuestCallbackFrame } from '../../src/vm86/shim/state';

class AllocationShim extends Win32Shim {
  allocateCode(bytes: Uint8Array): number {
    return this.allocateDynamicCode(bytes);
  }
  createCom(): number {
    return this.createComObject('ITest', [['Invoke', 4]]);
  }
  reserveCallback(scratchBytes?: number) {
    return this.reserveGuestCallback(scratchBytes);
  }
  publishCallback(frame: GuestCallbackFrame, body: number[]) {
    const code = body.slice();
    this.appendGuestCallbackReturn(code, frame, 0x401000);
    this.memory.write_memory(code, frame.trampoline);
    return code.length;
  }
  enumerate(stack: number): void {
    this.invokeGuestCallbacks(
      {
        imported: {
          id: 1,
          dll: 'DPLAYX.DLL',
          name: 'TestEnum',
          key: 'DPLAYX.DLL!TestEnum',
          argBytes: 0,
          stub: 0,
          slot: 0,
        },
        stack,
        args: [],
      },
      0x401000,
      Array.from({ length: 20 }, () => [1, 2, 3, 4, 5]),
    );
  }
}

function fixture() {
  const memory = createGuestMemory();
  const shim = new AllocationShim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
  return { memory, shim };
}

describe('动态客体代码内存边界', () => {
  it.each([-1, GUEST_CALLBACK_STRIDE, 1.5, NaN])('rejects invalid scratch size %s before reserving a slot', (size) => {
    const { memory, shim } = fixture();
    expect(() => shim.reserveCallback(size)).toThrow(/scratch size/);
    expect(readU32(memory, GUEST_CALLBACK_OWNERS)).toBe(0);
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(0);
  });

  it('rejects callback code before it can overwrite its variable-size scratch tail', () => {
    const { memory, shim } = fixture();
    const frame = shim.reserveCallback(108);
    const scratch = new Uint8Array(108).fill(0xa5);
    memory.write_memory(scratch, frame.scratchAddress);
    const tailBytes = shim.publishCallback(frame, []);
    const body = new Array(frame.scratchAddress - frame.trampoline - tailBytes).fill(0x90);
    expect(shim.publishCallback(frame, body)).toBe(GUEST_CALLBACK_STRIDE - scratch.length);
    expect(memory.read_memory(frame.scratchAddress, scratch.length)).toEqual(scratch);
    const before = memory.read_memory(frame.trampoline, GUEST_CALLBACK_STRIDE).slice();
    expect(() => shim.publishCallback(frame, [...body, 0x90])).toThrow(/回调桥超出槽位/);
    expect(memory.read_memory(frame.trampoline, GUEST_CALLBACK_STRIDE)).toEqual(before);
  });

  it.each([0x30000, 0x2fff0])('分配到固件边界 %i 后，COM 桩跳过整个 BIOS', (size) => {
    const { memory, shim } = fixture();
    const firmware = new Uint8Array(0x10000).fill(0xa5);
    memory.write_memory(firmware, 0xf0000);
    expect(shim.allocateCode(new Uint8Array(size))).toBe(0xc0000);
    const object = shim.createCom();
    const vtable = readU32(memory, object);
    expect(readU32(memory, vtable)).toBe(0x100000);
    expect(memory.read_memory(0xf0000, 0x10000)).toEqual(firmware);
  });

  it('容量不足不写入、也不消耗余下空间；后续较小请求仍成功', () => {
    const { memory, shim } = fixture();
    shim.allocateCode(new Uint8Array(0x30000));
    expect(shim.allocateCode(new Uint8Array(0xffff0))).toBe(0x100000);
    memory.write_memory(new Uint8Array(32).fill(0xa5), 0x1ffff0);
    expect(() => shim.allocateCode(new Uint8Array(17).fill(0xcc))).toThrow(/动态 stub 区不足/);
    expect(memory.read_memory(0x1ffff0, 32)).toEqual(new Uint8Array(32).fill(0xa5));
    expect(shim.allocateCode(new Uint8Array(16))).toBe(0x1ffff0);
    expect(() => shim.allocateCode(new Uint8Array(1))).toThrow(/动态 stub 区不足/);
  });

  it('64 个尚未执行的回调各占一槽，溢出拒绝且不覆盖第 64 个', () => {
    const { memory, shim } = fixture();
    for (let i = 0; i < GUEST_CALLBACK_SLOTS; i++) {
      writeU32(memory, HYPERCALL_THREAD_CURRENT, i % 2);
      const frame = shim.reserveCallback();
      expect(frame.trampoline).toBe(GUEST_CALLBACK_BASE + i * GUEST_CALLBACK_STRIDE);
      writeU32(memory, frame.trampoline, i + 100);
    }
    expect(() => shim.reserveCallback()).toThrow(/回调槽耗尽/);
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(GUEST_CALLBACK_SLOTS);
    for (let i = 0; i < GUEST_CALLBACK_SLOTS; i++) {
      expect(readU32(memory, GUEST_CALLBACK_BASE + i * GUEST_CALLBACK_STRIDE)).toBe(i + 100);
    }
    // Simulate slot 7's guest tail returning first; allocations do not require different threads to finish in LIFO order.
    writeU32(memory, GUEST_CALLBACK_OWNERS + 7 * 4, 0);
    writeU32(memory, HYPERCALL_CALLBACK_DEPTH, GUEST_CALLBACK_SLOTS - 1);
    expect(shim.reserveCallback().depth).toBe(7);
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(GUEST_CALLBACK_SLOTS);
  });

  it('DirectPlay 多项枚举使用独立大槽，并与动态代码分配隔离', () => {
    const { memory, shim } = fixture();
    writeU32(memory, 0x3000, 0x401000);
    shim.enumerate(0x3000);
    const first = readU32(memory, 0x3000);
    const code = memory.read_memory(first, GUEST_CALLBACK_STRIDE).slice();
    expect(code.slice(128).some((byte) => byte !== 0)).toBe(true);
    writeU32(memory, 0x3004, 0x402000);
    shim.enumerate(0x3004);
    expect(readU32(memory, 0x3004)).not.toBe(first);
    shim.allocateCode(new Uint8Array(0x30000));
    shim.allocateCode(new Uint8Array(0x10000).fill(0xcc));
    expect(memory.read_memory(first, GUEST_CALLBACK_STRIDE)).toEqual(code);
  });

  it('超大 owner-draw 列表在写入数据前拒绝，不破坏前一个活动桥', () => {
    const { memory, shim } = fixture();
    writeAsciiZ(memory, 0x330000, 'Static');
    writeAsciiZ(memory, 0x330020, 'ListBox');
    const parent = callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x330000, 0, 0, 0, 0, 100, 1600, 0, 0, 0, 0]).eax;
    const list = callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      0x330020,
      0,
      0x50000010,
      0,
      0,
      100,
      1600,
      parent,
      1,
      0,
      0,
    ]).eax;
    for (let i = 0; i < 100; i++) callShim(shim, 'USER32.DLL!SendMessageA', [list, 0x180, 0, 0x330000]); // LB_ADDSTRING
    callShim(shim, 'USER32.DLL!SetWindowLongA', [parent, -4, 0x401000]);
    const active = shim.reserveCallback();
    const sentinel = new Uint8Array(GUEST_CALLBACK_STRIDE).fill(0xa5);
    memory.write_memory(sentinel, active.trampoline);
    writeU32(memory, 0x3100, 0x402000);
    expect(() => callShim(shim, 'USER32.DLL!DefWindowProcA', [list, 0x0f, 0, 0], 0x3100)).toThrow(/超出槽位/);
    expect(memory.read_memory(active.trampoline, GUEST_CALLBACK_STRIDE)).toEqual(sentinel);
    expect(readU32(memory, 0x3100)).toBe(0x402000);
  });

  it('删除其他临界区保留兼容性原子执行深度，非 owner 不能释放锁', () => {
    const { memory, shim } = fixture();
    const lock = 0x3000,
      other = 0x3020;
    callShim(shim, 'KERNEL32.DLL!InitializeCriticalSection', [lock]);
    callShim(shim, 'KERNEL32.DLL!InitializeCriticalSection', [other]);
    callShim(shim, 'KERNEL32.DLL!EnterCriticalSection', [lock]);
    writeU32(memory, GUEST_THREAD_CRITICAL_DEPTH, 2);
    callShim(shim, 'KERNEL32.DLL!DeleteCriticalSection', [other]);
    expect(readU32(memory, GUEST_THREAD_CRITICAL_DEPTH)).toBe(2);
    writeU32(memory, HYPERCALL_THREAD_CURRENT, 1);
    expect(() => callShim(shim, 'KERNEL32.DLL!LeaveCriticalSection', [lock])).toThrow(/不属于自己/);
    expect(readU32(memory, lock + 12)).toBe(1);
    expect(readU32(memory, lock + 8)).toBe(1);
  });

  it('长局反复 CoCreateInstance 已注册类复用回调槽，不消耗动态 stub 区', () => {
    const { memory, shim } = fixture();
    const clsid = 0x3000,
      iid = 0x3010,
      factory = 0x3100,
      cookie = 0x3020,
      ppv = 0x3024,
      stack = 0x3200;
    memory.write_memory(new Uint8Array(16).fill(0x11), clsid);
    memory.write_memory(new Uint8Array(16).fill(0x22), iid);
    expect(callShim(shim, 'OLE32.DLL!CoRegisterClassObject', [clsid, factory, 4, 1, cookie]).eax).toBe(0);
    // Leave only 16 bytes of dynamic stub space: any per-call stub allocation would throw.
    shim.allocateCode(new Uint8Array(0x30000));
    shim.allocateCode(new Uint8Array(0xffff0));
    let first = 0;
    for (let i = 0; i < 50_000; i++) {
      writeU32(memory, stack, 0x401000);
      expect(callShim(shim, 'OLE32.DLL!CoCreateInstance', [clsid, 0, 1, iid, ppv], stack).eax).toBe(0);
      const bridge = readU32(memory, stack);
      if (i === 0) first = bridge;
      expect(bridge).toBe(first);
      expect(bridge).toBeGreaterThanOrEqual(GUEST_CALLBACK_BASE);
      // Simulate the guest tail releasing the slot.
      writeU32(memory, GUEST_CALLBACK_OWNERS, 0);
      writeU32(memory, HYPERCALL_CALLBACK_DEPTH, 0);
    }
    expect(shim.allocateCode(new Uint8Array(16))).toBe(0x1ffff0);
  });

  it('线程在嵌套回调中退出时只回收自己的槽', () => {
    const { memory, shim } = fixture();
    callShim(shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, 0x401000, 0, 0, 0]);
    const mainFrame = shim.reserveCallback();
    writeU32(memory, HYPERCALL_THREAD_CURRENT, 1);
    const workerFrame = shim.reserveCallback();
    const nestedFrame = shim.reserveCallback();
    const imported = {
      id: 1,
      dll: 'KERNEL32.DLL',
      name: 'ExitThread',
      key: 'KERNEL32.DLL!ExitThread',
      stub: 0,
      slot: 0,
      argBytes: 4,
    };
    const result = callShim(shim, imported.key, [0]);
    shim.prepareGuestThreadReturn({ imported, args: [0] }, result);
    expect(readU32(memory, HYPERCALL_CALLBACK_DEPTH)).toBe(1);
    expect(readU32(memory, mainFrame.ownerAddress)).toBe(1);
    expect(readU32(memory, workerFrame.ownerAddress)).toBe(0);
    expect(readU32(memory, nestedFrame.ownerAddress)).toBe(0);
    writeU32(memory, HYPERCALL_THREAD_CURRENT, 0);
    expect(shim.reserveCallback().trampoline).toBe(workerFrame.trampoline);
  });
});
