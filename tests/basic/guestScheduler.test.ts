import { describe, expect, it } from 'vitest';
import { GUEST_THREAD_CRITICAL_DEPTH, HYPERCALL_THREAD_CURRENT, HYPERCALL_THREAD_NEXT } from '../../src/vm86/pe';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../helpers/guestMemory';

interface Thread {
  id: number;
  handle: number;
  runnable: boolean;
  terminated: boolean;
  wakeAt: number;
  wait?: { handles: number[]; waitAll: boolean; deadline: number };
}

describe('客体调度热路径', () => {
  it('乱序插入、终止、睡眠、轮转和 Sleep(0) 与原排序算法等价', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const event = callShim(shim, 'KERNEL32.DLL!CreateEventA', [0, 1, 0, 0]).eax;
    // Construct scheduler state only in tests; runtime code still manages threads through Win32 APIs.
    const scheduler = shim as unknown as {
      guestThreads: Map<number, Thread>;
      selectGuestThread(now: number, afterDelay: boolean, yielded: boolean): number;
    };
    let seed = 12345;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const now = 1000;
    for (let sample = 0; sample < 512; sample++) {
      scheduler.guestThreads.clear();
      const currentId = random() % 8;
      const yielded = Boolean(random() & 256);
      const atomic = Boolean(random() & 512);
      const afterDelay = Boolean(random() & 1024);
      const rate = sample % 2 ? 2 : 1;
      shim.setGameClockRate(rate);
      // An odd stride generates unique IDs and changes Map order, covering the requirement that sorting not depend on insertion order.
      const start = random() % 8;
      for (let i = 0; i < 8; i++) {
        const id = (start + i * 3) % 8;
        const flags = random();
        scheduler.guestThreads.set(id, {
          id,
          handle: id + 100,
          runnable: Boolean(flags & 256),
          terminated: Boolean(flags & 512),
          wakeAt: flags & 1024 ? now + 1 + (flags % 50) : 0,
          wait:
            !(flags & 256) && flags & 2048
              ? { handles: [event], waitAll: false, deadline: now + 1 + (flags % 30) }
              : undefined,
        });
      }
      writeU32(memory, HYPERCALL_THREAD_CURRENT, currentId);
      writeU32(memory, HYPERCALL_THREAD_NEXT, 0xffffffff);
      writeU32(memory, GUEST_THREAD_CRITICAL_DEPTH + currentId * 4, atomic ? 1 : 0);
      const threads = [...scheduler.guestThreads.values()];
      const current = scheduler.guestThreads.get(currentId)!;
      const runnable = threads.filter((t) => t.runnable && !t.terminated).sort((a, b) => a.id - b.id);
      const deadlines = threads
        .filter((t) => !t.terminated)
        .flatMap((t) => [t.wakeAt, t.wait?.deadline ?? 0])
        .filter((time) => time > now);
      let next = runnable.find((t) => t.id > currentId) ?? runnable[0];
      let expectedDelay = 0;
      if (atomic && current.runnable && !current.terminated) next = current;
      else if (yielded && next?.id === currentId && runnable.length === 1 && deadlines.length) {
        expectedDelay = Math.max(1, (Math.min(...deadlines) - now) / rate);
      } else {
        if (!next && afterDelay && !current.terminated && !current.wait) next = current;
        if (!next) expectedDelay = deadlines.length ? Math.max(1, (Math.min(...deadlines) - now) / rate) : 1;
      }
      expect(scheduler.selectGuestThread(now, afterDelay, yielded), `样本 ${sample} 延迟`).toBe(expectedDelay);
      expect(readU32(memory, HYPERCALL_THREAD_NEXT), `样本 ${sample} 线程`).toBe(next?.id ?? 0xffffffff);
    }
    shim.dispose();
  });
});
