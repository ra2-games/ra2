import { describe, expect, it } from 'vitest';
import {
  GUEST_CALLBACK_OWNERS,
  GUEST_THREAD_CONTEXT_ESPS,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_THREAD_RUN_STATES,
  GUEST_SCHEDULER_TICKS,
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_IMPORT_ACTIVE,
  HYPERCALL_THREAD_CURRENT,
  HYPERCALL_THREAD_NEXT,
} from '../../../src/vm86/pe';
import { makeWin32ImportStubWithFastRead } from '../../../src/vm86/win32';
import { callShim } from '../../helpers/guestMemory';
import {
  call32,
  DONE,
  finish,
  le32,
  PROGRAM,
  push32,
  store32,
  withGuestMachine,
  type GuestMachine,
} from '../../helpers/guestMachine';

const DATA = 0x0030_0100;
const WORKER = PROGRAM + 0x1000;
const memoryOp = (opcode: number[], address: number): number[] => [...opcode, ...le32(address)];
const copy32 = (source: number, target: number): number[] => [...memoryOp([0xa1], source), ...memoryOp([0xa3], target)];

/** Disable PIT preemption when testing cooperative switching alone; force every API return to yield to another thread. */
function cooperativePair(machine: GuestMachine): void {
  callShim(machine.shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, WORKER, 0, 0, 0]);
  machine.write(GUEST_THREAD_CRITICAL_DEPTH, 1);
  machine.write(GUEST_THREAD_CRITICAL_DEPTH + 4, 1);
  machine.write(machine.read(GUEST_THREAD_CONTEXT_ESPS + 4) + 32, 2);
  machine.afterCall = () => machine.write(HYPERCALL_THREAD_NEXT, 1 - machine.read(HYPERCALL_THREAD_CURRENT));
}

describe('真实汇编上下文与并发回归', () => {
  it.each(['PIT', 'Sleep(0)'])('%s preserves XMM and MXCSR across guest threads', async (mode) => {
    await withGuestMachine(async (m) => {
      callShim(m.shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, WORKER, 0, 0, 0]);
      const yieldGuest = m.api('Sleep', 4, (id, bytes) =>
        mode === 'PIT'
          ? new Uint8Array([0xfb, 0xf4, 0xc2, 4, 0])
          : makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes),
      );
      const yieldHost = m.api('Sleep', 4);
      m.write(DATA, 0x3f80);
      m.write(DATA + 4, 0x5f80);
      m.write(DATA + 32, 0x12345678);
      m.code(PROGRAM, [
        ...(mode === 'Sleep(0)' ? [0xb0, 0xef, 0xe6, 0x21] : []),
        0xfa,
        ...memoryOp([0x0f, 0xae, 0x15], DATA), // ldmxcsr
        ...memoryOp([0x66, 0x0f, 0x6e, 0x05], DATA + 32), // movd xmm0
        ...push32(0),
        ...call32(yieldGuest),
        ...memoryOp([0x0f, 0xae, 0x1d], DATA + 8),
        ...memoryOp([0x66, 0x0f, 0x7e, 0x05], DATA + 12),
        ...finish,
      ]);
      m.code(WORKER, [
        ...memoryOp([0x0f, 0xae, 0x1d], DATA + 16),
        ...memoryOp([0x0f, 0xae, 0x15], DATA + 4),
        0x66,
        0x0f,
        0xef,
        0xc0, // pxor xmm0,xmm0
        ...push32(0),
        ...call32(yieldHost),
        0xfa,
        0xf4,
      ]);
      await m.run();
      expect(m.read(DATA + 8)).toBe(0x3f80);
      expect(m.read(DATA + 12)).toBe(0x12345678);
      expect(m.read(DATA + 16)).toBe(0x1f80);
    });
  });
  it.each(['PIT', 'Sleep(0)'])('%s 保存的 x87 上下文可由协作切换恢复', async (mode) => {
    await withGuestMachine(async (m) => {
      callShim(m.shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, WORKER, 0, 0, 0]);
      const pitYield = m.api('Sleep', 4, (id, bytes) =>
        mode === 'PIT'
          ? new Uint8Array([0xfb, 0xf4, 0xc2, 4, 0]) // Explicitly verify the hardware PIT path
          : makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes),
      );
      const hostYield = m.api('Sleep', 4);
      m.write(DATA, 0x077f);
      m.write(DATA + 4, 0x0b7f);
      m.code(PROGRAM, [
        ...(mode === 'Sleep(0)' ? [0xb0, 0xef, 0xe6, 0x21] : []), // Mask PIT, retain UART
        0xfa,
        0xdb,
        0xe3,
        ...memoryOp([0xd9, 0x2d], DATA),
        0xd9,
        0xe8,
        ...push32(0),
        ...call32(pitYield),
        ...memoryOp([0xd9, 0x3d], DATA + 8),
        ...memoryOp([0xdb, 0x1d], DATA + 12),
        ...finish,
      ]);
      m.code(WORKER, [
        ...memoryOp([0xd9, 0x3d], DATA + 16),
        ...memoryOp([0xd9, 0x2d], DATA + 4),
        0xd9,
        0xee,
        ...push32(0),
        ...call32(hostYield),
        0xfa,
        0xf4,
      ]);
      await m.run();
      expect(m.read(DATA + 8) & 65535).toBe(0x077f);
      expect(m.read(DATA + 12)).toBe(1); // fistp should read back the 1 pushed by the main thread
      expect(m.read(DATA + 16) & 65535).toBe(0x037f);
      expect(m.calls).toHaveLength(1);
      if (mode === 'Sleep(0)') expect(m.read(GUEST_SCHEDULER_TICKS), '软件让出不能推进 PIT tick').toBe(0);
    });
  });

  it.each([0, 1])('Sleep(0) 无竞争线程时立即返回，保留锁深度 %i 的中断状态', async (depth) => {
    await withGuestMachine(async (m) => {
      m.write(GUEST_THREAD_CRITICAL_DEPTH, depth);
      const sleep = m.api('Sleep', 4, (id, bytes) =>
        makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes),
      );
      m.code(PROGRAM, [
        0xb0,
        0xef,
        0xe6,
        0x21, // Mask PIT; the old sti/hlt would stall and must not falsely pass
        ...push32(0),
        ...call32(sleep),
        0x9c,
        0x58,
        ...memoryOp([0xa3], DATA), // pushfd; pop eax; save IF
        ...finish,
      ]);
      await m.run();
      expect(m.read(DATA) & 0x200).toBe(depth ? 0 : 0x200);
      expect(m.read(GUEST_THREAD_CRITICAL_DEPTH)).toBe(depth);
      expect(m.read(GUEST_SCHEDULER_TICKS)).toBe(0);
      expect(m.calls).toHaveLength(0);
    });
  });

  it('持锁反复 Sleep(0) 时真实 PIT 仍能唤醒到期线程', async () => {
    await withGuestMachine(async (m) => {
      callShim(m.shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, WORKER, 0, 0, 0]);
      m.write(GUEST_THREAD_CRITICAL_DEPTH, 1);
      m.write(GUEST_THREAD_RUN_STATES + 4, 7); // Ready only on the fifth real PIT tick
      const sleep = m.api('Sleep', 4, (id, bytes) =>
        makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes),
      );
      const body = [...push32(0), ...call32(sleep), ...memoryOp([0x83, 0x3d], DATA), 0];
      m.code(PROGRAM, [...body, 0x74, -(body.length + 2) & 255, ...finish]);
      m.code(WORKER, [...store32(DATA, 1), ...push32(0), ...call32(sleep), 0xfa, 0xf4]);
      await m.run(1500);
      expect(m.read(DATA)).toBe(1);
      expect(m.read(GUEST_SCHEDULER_TICKS)).toBeGreaterThanOrEqual(5);
      expect(m.calls).toHaveLength(0);
    });
  });

  it('连续千次软件轮转不泄漏栈、不覆盖其他线程寄存器', async () => {
    await withGuestMachine(async (m) => {
      cooperativePair(m);
      const sleep = m.api('Sleep', 4, (id, bytes) =>
        makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes),
      );
      const loop = (counter: number, marker: number) => {
        const body = [...memoryOp([0xff, 0x05], counter), ...push32(0), ...call32(sleep), 0x49];
        return [
          0xbe,
          ...le32(marker),
          0xb9,
          ...le32(1000), // Each thread must save ESI and ECX independently
          ...memoryOp([0x89, 0x25], counter + 8), // ESP before the call
          ...body,
          0x75,
          -(body.length + 2) & 255,
          ...memoryOp([0x89, 0x35], counter + 4),
          ...memoryOp([0x89, 0x25], counter + 12),
        ];
      };
      m.code(PROGRAM, [0xb0, 0xef, 0xe6, 0x21, ...loop(DATA, 0x11223344), ...push32(0), ...call32(sleep), ...finish]);
      m.code(WORKER, [...loop(DATA + 16, 0x55667788), ...push32(0), ...call32(sleep), 0xfa, 0xf4]);
      await m.run();
      expect([m.read(DATA), m.read(DATA + 16)]).toEqual([1000, 1000]);
      expect([m.read(DATA + 4), m.read(DATA + 20)]).toEqual([0x11223344, 0x55667788]);
      expect(m.read(DATA + 8)).toBe(m.read(DATA + 12));
      expect(m.read(DATA + 24)).toBe(m.read(DATA + 28));
      expect(m.read(GUEST_SCHEDULER_TICKS)).toBe(0);
      expect(m.calls).toHaveLength(0);
    });
  });

  it.each(['sleeping', 'import-active'])('Sleep(0) 不越过 %s 线程切换边界', async (mode) => {
    await withGuestMachine(async (m) => {
      callShim(m.shim, 'KERNEL32.DLL!CreateThread', [0, 0x10000, WORKER, 0, 0, 0]);
      if (mode === 'sleeping')
        m.write(GUEST_THREAD_RUN_STATES + 4, 102); // Ready only on tick 100
      else m.write(HYPERCALL_IMPORT_ACTIVE, 1);
      const sleep = m.api('Sleep', 4, (id, bytes) =>
        makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes),
      );
      m.code(PROGRAM, [0xb0, 0xef, 0xe6, 0x21, ...push32(0), ...call32(sleep), ...finish]);
      m.code(WORKER, [...store32(DATA, 1), ...finish]);
      await m.run();
      expect(m.read(DATA)).toBe(0);
      expect(m.read(HYPERCALL_THREAD_CURRENT)).toBe(0);
      expect(m.read(GUEST_SCHEDULER_TICKS)).toBe(0);
      expect(m.read(mode === 'sleeping' ? GUEST_THREAD_RUN_STATES + 4 : HYPERCALL_IMPORT_ACTIVE)).toBe(
        mode === 'sleeping' ? 102 : 1,
      );
      expect(m.calls).toHaveLength(0);
    });
  });

  it.each(['host', 'software'])('%s 协作切换隔离 x87 控制字、寄存器栈与 MMX', async (mode) => {
    await withGuestMachine(async (m) => {
      cooperativePair(m);
      const yieldThread = m.api(
        'Sleep',
        4,
        mode === 'software'
          ? (id, bytes) => makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes)
          : undefined,
      );
      const yieldCode = [...push32(0), ...call32(yieldThread)];
      m.write(DATA, 0x077f);
      m.write(DATA + 4, 0x0b7f);
      m.write(DATA + 8, 0x12345678);
      m.write(DATA + 12, 0x9abcdef0);
      m.write(DATA + 16, 0x11223344);
      m.write(DATA + 20, 0x55667788);
      m.code(PROGRAM, [
        0xfa,
        0xdb,
        0xe3, // cli; fninit
        ...memoryOp([0xd9, 0x2d], DATA),
        0xd9,
        0xe8,
        0xd9,
        0xeb, // fldcw; fld1; fldpi
        ...yieldCode,
        ...memoryOp([0xd9, 0x3d], DATA + 32), // fnstcw
        ...memoryOp([0xdd, 0x1d], DATA + 40),
        ...memoryOp([0xdd, 0x1d], DATA + 48), // fstp qword ×2
        ...memoryOp([0x0f, 0x6f, 0x05], DATA + 8), // movq mm0,[A]
        ...yieldCode,
        ...memoryOp([0x0f, 0x7f, 0x05], DATA + 56),
        0x0f,
        0x77, // movq [out],mm0; emms
        ...finish,
      ]);
      m.code(WORKER, [
        ...memoryOp([0xd9, 0x3d], DATA + 64), // New thread's control word
        ...memoryOp([0xd9, 0x2d], DATA + 4),
        0xd9,
        0xed, // fldcw; fldln2
        ...yieldCode,
        ...memoryOp([0xdd, 0x1d], DATA + 72),
        ...memoryOp([0x0f, 0x6f, 0x05], DATA + 16),
        ...yieldCode,
        0xfa,
        0xf4,
      ]);
      await m.run();
      expect(m.read(DATA + 32) & 65535).toBe(0x077f);
      expect(m.read(DATA + 64) & 65535).toBe(0x037f);
      const float = (address: number) => {
        const b = m.memory.read_memory(address, 8);
        return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
      };
      expect(float(DATA + 40)).toBeCloseTo(Math.PI, 12);
      expect(float(DATA + 48)).toBe(1);
      expect(float(DATA + 72)).toBeCloseTo(Math.LN2, 12);
      expect(m.read(DATA + 56)).toBe(0x12345678);
      expect(m.read(DATA + 60)).toBe(0x9abcdef0);
      expect(m.calls).toHaveLength(mode === 'software' ? 0 : 4);
    });
  });

  it.each(['slow', 'fast', 'mixed'])('%s 临界区阻塞竞争者，递归退出后才移交所有权', async (mode) => {
    await withGuestMachine(async (m) => {
      const api = (name: string) =>
        m.api(
          name,
          4,
          mode === 'fast' || (mode === 'mixed' && name !== 'LeaveCriticalSection')
            ? (id, bytes) => makeWin32ImportStubWithFastRead('KERNEL32.DLL', name, id, bytes)
            : undefined,
        );
      const init = api('InitializeCriticalSection');
      const enter = api('EnterCriticalSection');
      const leave = api('LeaveCriticalSection');
      const remove = api('DeleteCriticalSection');
      const sleep = m.api('Sleep', 4);
      const zeroSleep = m.api('Sleep', 4, (id, bytes) =>
        makeWin32ImportStubWithFastRead('KERNEL32.DLL', 'Sleep', id, bytes),
      );
      const create = m.api('CreateThread', 24);
      const lock = DATA,
        other = DATA + 24,
        flag = DATA + 64;
      const lockCall = (stub: number, pointer = lock) => [...push32(pointer), ...call32(stub)];
      m.code(PROGRAM, [
        ...lockCall(init),
        ...lockCall(init, other),
        ...lockCall(enter),
        ...lockCall(enter),
        ...push32(DATA + 96),
        ...push32(0),
        ...push32(0),
        ...push32(WORKER),
        ...push32(0x10000),
        ...push32(0),
        ...call32(create),
        ...push32(0),
        ...call32(zeroSleep),
        ...copy32(flag, DATA + 100),
        ...push32(20),
        ...call32(sleep),
        ...copy32(flag, DATA + 68),
        ...lockCall(leave),
        ...copy32(flag, DATA + 72),
        ...lockCall(remove, other),
        ...copy32(lock + 12, DATA + 76),
        ...lockCall(leave),
        ...push32(20),
        ...call32(sleep),
        ...finish,
      ]);
      m.code(WORKER, [
        ...lockCall(enter),
        ...store32(flag, 1),
        ...copy32(lock + 12, DATA + 80),
        ...lockCall(leave),
        0x31,
        0xc0,
        0xc2,
        4,
        0,
      ]);
      await m.run();
      expect(m.read(DATA + 100), '持锁软件让出不能让竞争者越过锁').toBe(0);
      expect(m.read(DATA + 68), '持锁 Sleep 后竞争者仍阻塞').toBe(0);
      expect(m.read(DATA + 72), '递归锁只退出一层不能唤醒').toBe(0);
      expect(m.read(DATA + 76), '删除其他锁不能改变 A 的 owner').toBe(1);
      expect(m.read(DATA + 80), '工作线程取得自己的 Win32 owner id').toBe(2);
      expect(m.read(DATA + 96), 'CreateThread 返回的 id 与 owner 一致').toBe(2);
      expect(m.read(flag)).toBe(1);
      expect([m.read(lock + 4), m.read(lock + 8), m.read(lock + 12), m.read(lock + 16)]).toEqual([0xffffffff, 0, 0, 0]);
      expect(m.read(GUEST_THREAD_CRITICAL_DEPTH)).toBe(0);
      if (mode !== 'slow') expect(m.calls.filter((c) => c.imported.name === 'EnterCriticalSection')).toHaveLength(1);
    });
  });

  it('两个线程在桥执行前生成 SendMessage 回调，返回各自调用者并释放槽', async () => {
    await withGuestMachine(async (m) => {
      cooperativePair(m);
      const wndproc = PROGRAM + 0x2000;
      m.code(DATA, [...new TextEncoder().encode('CALLBACKTEST'), 0]);
      m.write(DATA + 64 + 4, wndproc);
      m.write(DATA + 64 + 36, DATA);
      callShim(m.shim, 'USER32.DLL!RegisterClassA', [DATA + 64]);
      const hwnd = callShim(m.shim, 'USER32.DLL!CreateWindowExA', [0, DATA, DATA, 0, 0, 0, 100, 100, 0, 0, 0, 0]).eax;
      const send = m.api('SendMessageA', 16, undefined, 'USER32.DLL');
      const sleep = m.api('Sleep', 4);
      const sendCode = (value: number) => [
        ...push32(value),
        ...push32(0),
        ...push32(0x400),
        ...push32(hwnd),
        ...call32(send),
      ];
      m.code(PROGRAM, [...sendCode(111), ...memoryOp([0xa3], DATA + 128), ...push32(0), ...call32(sleep), ...finish]);
      m.code(WORKER, [...sendCode(222), ...memoryOp([0xa3], DATA + 132), ...push32(0), ...call32(sleep), 0xfa, 0xf4]);
      m.code(wndproc, [0x8b, 0x44, 0x24, 0x10, 0xc2, 16, 0]); // Return lParam
      let sends = 0;
      const switchThread = m.afterCall!;
      m.afterCall = (call) => {
        if (call.imported.name === 'SendMessageA' && ++sends === 2) {
          expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(2);
          expect([m.read(GUEST_CALLBACK_OWNERS), m.read(GUEST_CALLBACK_OWNERS + 4)]).toEqual([1, 2]);
        }
        switchThread(call);
      };
      await m.run();
      expect(m.read(DONE)).toBe(1);
      expect([m.read(DATA + 128), m.read(DATA + 132)]).toEqual([111, 222]);
      expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(0);
      expect([m.read(GUEST_CALLBACK_OWNERS), m.read(GUEST_CALLBACK_OWNERS + 4)]).toEqual([0, 0]);
    });
  });

  it('嵌套 SendMessage 返回后可重复复用回调槽', async () => {
    await withGuestMachine(async (m) => {
      const wndproc = PROGRAM + 0x2000;
      m.code(DATA, [...new TextEncoder().encode('NESTEDTEST'), 0]);
      m.write(DATA + 68, wndproc);
      m.write(DATA + 100, DATA);
      callShim(m.shim, 'USER32.DLL!RegisterClassA', [DATA + 64]);
      const hwnd = callShim(m.shim, 'USER32.DLL!CreateWindowExA', [0, DATA, DATA, 0, 0, 0, 100, 100, 0, 0, 0, 0]).eax;
      const send = m.api('SendMessageA', 16, undefined, 'USER32.DLL');
      const args = [...push32(0), ...push32(0x400), ...push32(hwnd), ...call32(send)];
      const recurse = [0x48, 0x50, ...args, 0x40, 0xc2, 16, 0]; // dec eax; push eax; SendMessage; inc eax; ret 16
      m.code(wndproc, [
        0x8b,
        0x44,
        0x24,
        0x10,
        0x85,
        0xc0,
        0x74,
        recurse.length,
        ...recurse,
        0xb8,
        ...le32(123),
        0xc2,
        16,
        0,
      ]);
      const body = [...push32(4), ...args, ...memoryOp([0xa3], DATA + 128)];
      m.code(PROGRAM, [...Array.from({ length: 20 }, () => body).flat(), ...finish]);
      let activeMax = 0;
      m.afterCall = () => {
        activeMax = Math.max(activeMax, m.read(HYPERCALL_CALLBACK_DEPTH));
      };
      await m.run();
      expect(m.calls).toHaveLength(100);
      expect(activeMax).toBe(5);
      expect(m.read(DATA + 128)).toBe(127);
      expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(0);
      expect(m.memory.read_memory(GUEST_CALLBACK_OWNERS, 64 * 4).every((byte) => byte === 0)).toBe(true);
    });
  });
});
