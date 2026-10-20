import { GuestKernelError } from '../processKernel';
/**
 * Guest synchronization/cooperative scheduling extracted from state.ts: Event/Mutex/critical sections, WaitFor* semantics, and thread selection. Apply after file/DLL layers and before kernel32 dispatch.
 */
import type { PeImport } from '../win32';
import {
  GUEST_SCHEDULER_TICKS,
  GUEST_THREAD_CONTEXT_ESPS,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_THREAD_RUN_STATES,
  HYPERCALL_THREAD_CURRENT,
  HYPERCALL_THREAD_NEXT,
} from '../pe';
import type { Constructor, GuestEventObject, GuestMutexObject, GuestThreadState, GuestWaitState } from './state';
import type { ShimGuestDllChain } from './stateGuestDll';

export type ShimSyncChain = InstanceType<ReturnType<typeof withShimSync>>;

export function withShimSync<TBase extends Constructor<ShimGuestDllChain>>(Base: TBase) {
  return class extends Base {
    /** Threads, events, and mutexes share one non-reused identity space without reserved launcher identities. */
    private nextWaitHandle: number;
    protected readonly guestEvents = new Map<number, GuestEventObject>();
    protected readonly namedGuestEvents = new Map<string, GuestEventObject>();
    protected readonly guestMutexes = new Map<number, GuestMutexObject>();
    protected readonly namedGuestMutexes = new Map<string, GuestMutexObject>();

    constructor(...args: any[]) {
      super(...args);
      this.nextWaitHandle = 0x0001_0020;
    }

    protected allocateGuestWaitHandle(): number {
      // Never wrap into stale handles or the current-thread/current-process pseudo handles.
      if (this.nextWaitHandle >= 0xffff_fffe) throw new Error('Guest wait handle space exhausted');
      return this.nextWaitHandle++;
    }

    private duplicateGuestEvent(object: GuestEventObject): number {
      const handle = this.allocateGuestWaitHandle();
      object.handles.add(handle);
      this.guestEvents.set(handle, object);
      return handle;
    }

    protected createGuestEvent(manualReset: boolean, initialState: boolean, name: string): number {
      const normalized = name.toLowerCase();
      const existing = normalized ? this.namedGuestEvents.get(normalized) : undefined;
      if (existing) {
        this.lastError = 183; // ERROR_ALREADY_EXISTS
        return this.duplicateGuestEvent(existing);
      }
      const object: GuestEventObject = {
        manualReset,
        signaled: initialState,
        name: normalized,
        handles: new Set(),
      };
      if (normalized) this.namedGuestEvents.set(normalized, object);
      this.lastError = 0;
      return this.duplicateGuestEvent(object);
    }

    protected openGuestEvent(name: string): number {
      const object = this.namedGuestEvents.get(name.toLowerCase());
      if (!object) {
        this.lastError = 2; // ERROR_FILE_NOT_FOUND
        return 0;
      }
      this.lastError = 0;
      return this.duplicateGuestEvent(object);
    }

    protected setGuestEvent(handle: number): boolean {
      const event = this.guestEvents.get(handle);
      if (!event) {
        this.lastError = 6; // ERROR_INVALID_HANDLE
        return false;
      }
      event.signaled = true;
      this.lastError = 0;
      this.wakeGuestWaiters();
      return true;
    }

    protected resetGuestEvent(handle: number): boolean {
      const event = this.guestEvents.get(handle);
      if (!event) {
        this.lastError = 6;
        return false;
      }
      event.signaled = false;
      this.lastError = 0;
      return true;
    }

    private duplicateGuestMutex(object: GuestMutexObject): number {
      const handle = this.allocateGuestWaitHandle();
      object.handles.add(handle);
      this.guestMutexes.set(handle, object);
      return handle;
    }

    protected createGuestMutex(initialOwner: boolean, name: string): number {
      const normalized = name.toLowerCase();
      const existing = normalized ? this.namedGuestMutexes.get(normalized) : undefined;
      if (existing) {
        this.lastError = 183;
        return this.duplicateGuestMutex(existing);
      }
      const object: GuestMutexObject = {
        ownerThreadId: initialOwner ? this.readU32(HYPERCALL_THREAD_CURRENT) : null,
        recursion: initialOwner ? 1 : 0,
        abandoned: false,
        name: normalized,
        handles: new Set(),
      };
      if (normalized) this.namedGuestMutexes.set(normalized, object);
      this.lastError = 0;
      return this.duplicateGuestMutex(object);
    }

    protected openGuestMutex(name: string): number {
      const object = this.namedGuestMutexes.get(name.toLowerCase());
      if (!object) {
        this.lastError = 2;
        return 0;
      }
      this.lastError = 0;
      return this.duplicateGuestMutex(object);
    }

    protected releaseGuestMutex(handle: number): boolean {
      const mutex = this.guestMutexes.get(handle);
      if (!mutex) {
        this.lastError = 6;
        return false;
      }
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      if (mutex.ownerThreadId !== currentId || mutex.recursion <= 0) {
        this.lastError = 288; // ERROR_NOT_OWNER
        return false;
      }
      mutex.recursion--;
      if (mutex.recursion === 0) mutex.ownerThreadId = null;
      this.lastError = 0;
      if (mutex.ownerThreadId === null) this.wakeGuestWaiters();
      return true;
    }

    protected closeGuestSyncHandle(handle: number): boolean {
      const event = this.guestEvents.get(handle);
      if (event) {
        this.guestEvents.delete(handle);
        event.handles.delete(handle);
        if (event.handles.size === 0 && event.name) this.namedGuestEvents.delete(event.name);
        this.wakeGuestWaiters();
        return true;
      }
      const mutex = this.guestMutexes.get(handle);
      if (!mutex) return false;
      this.guestMutexes.delete(handle);
      mutex.handles.delete(handle);
      if (mutex.handles.size === 0 && mutex.name) this.namedGuestMutexes.delete(mutex.name);
      this.wakeGuestWaiters();
      return true;
    }

    /**
     * Return WAIT_OBJECT_0+n / WAIT_ABANDONED_0+n / WAIT_TIMEOUT / WAIT_FAILED. With nonzero timeout and unmet conditions, initially return placeholder WAIT_OBJECT_0; the import stub saves the thread's return context, and actual wakeup overwrites saved EAX.
     */
    protected waitForGuestObjects(handles: number[], waitAll: boolean, timeout: number): number {
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      const current = this.guestThreads.get(currentId);
      if (
        !current ||
        handles.length === 0 ||
        handles.length > 64 ||
        handles.some((handle) => !this.isGuestWaitHandle(handle))
      ) {
        this.lastError = 6;
        return 0xffff_ffff;
      }
      const wait: GuestWaitState = { handles: [...handles], waitAll };
      let ready: number | null;
      try {
        ready = this.evaluateGuestWait(wait, currentId, true);
      } catch (error) {
        if (!(error instanceof GuestKernelError)) throw error;
        this.lastError = error.code;
        return 0xffffffff;
      }
      if (ready !== null) {
        this.lastError = 0;
        return ready;
      }
      if (timeout === 0) {
        this.lastError = 0;
        return 0x0000_0102; // WAIT_TIMEOUT
      }
      if (timeout !== 0xffff_ffff) wait.deadline = this.clock.now() + timeout;
      current.wait = wait;
      current.waitResult = undefined;
      this.lastError = 0;
      return 0; // Correct the return value on wakeup/timeout.
    }

    private isGuestWaitHandle(handle: number): boolean {
      return (
        (this.options.processContext?.kernel.waitable(this.options.processContext.pid, handle) ?? false) ||
        handle === 0xffff_fffe ||
        this.guestEvents.has(handle) ||
        this.guestMutexes.has(handle) ||
        this.guestThreadHandles.has(handle)
      );
    }

    private evaluateGuestWait(wait: GuestWaitState, threadId: number, consume: boolean): number | null {
      if (wait.handles.some((handle) => !this.isGuestWaitHandle(handle))) return 0xffff_ffff;
      const ready = wait.handles.map((handle) => {
        const context = this.options.processContext;
        if (context?.kernel.has(context.pid, handle))
          return context.kernel.ready(context.pid, handle, context.kernel.threadId(context.pid, threadId));
        const targetId = handle === 0xffff_fffe ? threadId : this.guestThreadHandles.get(handle);
        if (targetId !== undefined) return this.guestThreads.get(targetId)?.terminated === true;
        const event = this.guestEvents.get(handle);
        if (event) return event.signaled;
        const mutex = this.guestMutexes.get(handle)!;
        return mutex.ownerThreadId === null || mutex.ownerThreadId === threadId;
      });
      const selected = wait.waitAll ? (ready.every(Boolean) ? 0 : -1) : ready.findIndex(Boolean);
      if (selected < 0) return null;
      if (!consume) return selected;

      let abandonedIndex = -1;
      const indices = wait.waitAll ? wait.handles.map((_, index) => index) : [selected];
      for (const index of indices) {
        const handle = wait.handles[index]!;
        const context = this.options.processContext;
        if (context?.kernel.has(context.pid, handle)) {
          if (
            context.kernel.consume(context.pid, handle, context.kernel.threadId(context.pid, threadId)) &&
            abandonedIndex < 0
          )
            abandonedIndex = index;
          continue;
        }
        const event = this.guestEvents.get(handle);
        if (event && !event.manualReset) event.signaled = false;
        const mutex = this.guestMutexes.get(handle);
        if (mutex) {
          if (mutex.abandoned && abandonedIndex < 0) abandonedIndex = index;
          mutex.abandoned = false;
          mutex.ownerThreadId = threadId;
          mutex.recursion++;
        }
      }
      if (abandonedIndex >= 0) return 0x0000_0080 + abandonedIndex;
      return wait.waitAll ? 0 : selected;
    }

    /** The guest structure is authoritative for both fast and slow paths; +16 stores an internal waiter count, not a usable exposed handle. */
    protected initializeCriticalSection(pointer: number): void {
      this.zero(pointer, 24);
      this.writeU32(pointer + 4, 0xffff_ffff);
    }

    protected deleteCriticalSection(pointer: number): void {
      if (this.readU32(pointer + 16)) throw new Error('不能删除仍有等待线程的临界区');
      this.zero(pointer, 24);
    }

    private tryEnterCriticalSection(pointer: number, threadId: number): boolean {
      const owner = this.readU32(pointer + 12);
      if (owner !== 0 && owner !== threadId + 1) return false;
      const recursion = this.readU32(pointer + 8) + 1;
      this.writeU32(pointer + 8, recursion);
      this.writeU32(pointer + 12, threadId + 1);
      this.writeU32(pointer + 4, recursion - 1 + this.readU32(pointer + 16));
      return true;
    }

    protected enterCriticalSection(pointer: number): void {
      const threadId = this.readU32(HYPERCALL_THREAD_CURRENT);
      if (this.tryEnterCriticalSection(pointer, threadId)) return;
      const thread = this.guestThreads.get(threadId);
      if (!thread) throw new Error(`临界区等待线程不存在: ${threadId}`);
      thread.criticalSection = pointer;
      thread.waitResult = undefined;
      this.writeU32(pointer + 16, this.readU32(pointer + 16) + 1);
      this.writeU32(pointer + 4, this.readU32(pointer + 4) + 1);
    }

    protected leaveCriticalSection(pointer: number): void {
      const owner = this.readU32(HYPERCALL_THREAD_CURRENT) + 1;
      const recursion = this.readU32(pointer + 8);
      if (this.readU32(pointer + 12) !== owner || recursion === 0) {
        throw new Error(`线程 ${owner} 试图释放不属于自己的临界区 0x${pointer.toString(16)}`);
      }
      this.writeU32(pointer + 8, recursion - 1);
      this.writeU32(pointer + 4, recursion - 2 + this.readU32(pointer + 16));
      if (recursion === 1) {
        this.writeU32(pointer + 12, 0);
        this.wakeGuestCriticalWaiters();
      }
    }

    private wakeGuestCriticalWaiters(): void {
      for (const thread of this.guestThreads.values()) {
        const pointer = thread.criticalSection;
        if (pointer === undefined || thread.terminated || !this.tryEnterCriticalSection(pointer, thread.id)) continue;
        this.writeU32(pointer + 16, this.readU32(pointer + 16) - 1);
        this.writeU32(pointer + 4, this.readU32(pointer + 4) - 1);
        thread.criticalSection = undefined;
        this.completeGuestWait(thread, 0);
      }
    }

    private completeGuestWait(thread: GuestThreadState, result: number): void {
      thread.wait = undefined;
      thread.runnable = true;
      this.writeU32(GUEST_THREAD_RUN_STATES + thread.id * 4, 1);
      // The current thread is still in this Wait import stub; nonzero contextEsps refers only to a previous
      // switch's stale frame, so writing context+28 corrupts a reused live stack. vmCore writes
      // the result into this call's shared EAX. Only other waiting threads own saved frames safe to overwrite.
      if (thread.id === this.readU32(HYPERCALL_THREAD_CURRENT)) {
        thread.waitResult = result;
        return;
      }
      const context = this.readU32(GUEST_THREAD_CONTEXT_ESPS + thread.id * 4);
      if (context) this.writeU32(context + 28, result);
      else thread.waitResult = result;
    }

    private wakeGuestWaiters(): void {
      for (const thread of [...this.guestThreads.values()].sort((a, b) => a.id - b.id)) {
        if (!thread.wait || thread.terminated) continue;
        const result = this.evaluateGuestWait(thread.wait, thread.id, true);
        if (result !== null) this.completeGuestWait(thread, result);
      }
    }

    private abandonGuestMutexes(threadId: number): void {
      const seen = new Set<GuestMutexObject>();
      for (const mutex of this.guestMutexes.values()) {
        if (seen.has(mutex) || mutex.ownerThreadId !== threadId) continue;
        seen.add(mutex);
        mutex.ownerThreadId = null;
        mutex.recursion = 0;
        mutex.abandoned = true;
      }
      this.wakeGuestWaiters();
    }

    /** Update thread state before this hypercall returns and select the next guest execution thread. */
    prepareGuestThreadReturn(
      call: { imported: PeImport; args: number[] },
      result: { delayMs?: number; threadExit?: boolean; eax?: number },
    ): number {
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      const current = this.guestThreads.get(currentId);
      const now = this.clock.now();
      // PIT may make expired threads runnable between hypercalls; merge firmware state before
      // handling this API so the host does not still classify an already running thread as asleep.
      const schedulerTicks = this.readU32(GUEST_SCHEDULER_TICKS);
      for (const thread of this.guestThreads.values()) {
        const runState = this.readU32(GUEST_THREAD_RUN_STATES + thread.id * 4);
        if (runState === 1 && !thread.terminated) {
          thread.runnable = true;
          thread.wakeAt = 0;
        } else if (runState >= 2 && ((schedulerTicks - (runState - 2)) | 0) >= 0) {
          thread.runnable = true;
          thread.wakeAt = 0;
          this.writeU32(GUEST_THREAD_RUN_STATES + thread.id * 4, 1);
        }
      }
      if (current) {
        if (result.threadExit) {
          const context = this.options.processContext;
          if (context) context.kernel.exitThread(context.pid, currentId, result.eax ?? 0);
          current.terminated = true;
          current.runnable = false;
          this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, 0);
          this.releaseExitedThreadCallbacks(currentId);
          this.abandonGuestMutexes(currentId);
        } else if (call.imported.key === 'KERNEL32.DLL!Sleep') {
          const milliseconds = call.args[0] ?? 0;
          if (milliseconds > 0) {
            current.runnable = false;
            current.wakeAt = now + milliseconds;
            const ticks = Math.max(1, Math.ceil(this.clock.toHostDelay(milliseconds) / 10));
            this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, (schedulerTicks + ticks + 2) >>> 0);
          }
        } else if (result.delayMs && result.delayMs > 0) {
          current.runnable = false;
          current.wakeAt = now + this.clock.toGuestDelay(result.delayMs);
          const ticks = Math.max(1, Math.ceil(result.delayMs / 10));
          this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, (schedulerTicks + ticks + 2) >>> 0);
        }
        if (current.wait || current.criticalSection !== undefined) {
          current.runnable = false;
          this.writeU32(GUEST_THREAD_RUN_STATES + currentId * 4, 0);
        }
      }
      return this.selectGuestThread(now, false, call.imported.key === 'KERNEL32.DLL!Sleep');
    }

    completeGuestThreadDelay(): { delayMs: number; result?: number } {
      const current = this.guestThreads.get(this.readU32(HYPERCALL_THREAD_CURRENT));
      const delayMs = this.selectGuestThread(this.clock.now(), true);
      const result = current?.waitResult;
      if (current) current.waitResult = undefined;
      return result === undefined ? { delayMs } : { delayMs, result };
    }

    private selectGuestThread(now: number, afterDelay = false, yielded = false): number {
      this.wakeGuestCriticalWaiters();
      for (const thread of this.guestThreads.values()) {
        if (thread.terminated) continue;
        if (thread.wait) {
          const ready = this.evaluateGuestWait(thread.wait, thread.id, true);
          if (ready !== null) this.completeGuestWait(thread, ready);
          else if (thread.wait.deadline !== undefined && now >= thread.wait.deadline) {
            this.completeGuestWait(thread, 0x0000_0102);
          }
        }
        if (!thread.runnable && thread.wakeAt > 0 && now >= thread.wakeAt) {
          thread.wakeAt = 0;
          thread.runnable = true;
          this.writeU32(GUEST_THREAD_RUN_STATES + thread.id * 4, 1);
        }
      }
      const currentId = this.readU32(HYPERCALL_THREAD_CURRENT);
      // Compatibility atomic regions constrain both host and PIT scheduling; ordinary Win32 critical sections permit scheduling.
      const current = this.guestThreads.get(currentId);
      if (current?.runnable && !current.terminated && this.readU32(GUEST_THREAD_CRITICAL_DEPTH + currentId * 4) > 0) {
        this.writeU32(HYPERCALL_THREAD_NEXT, currentId);
        return 0;
      }
      // Every hypercall passes here; use one scan instead of temporary arrays, sorting, and flatMap.
      // Compare IDs explicitly rather than relying on Map insertion order; preserve round-robin order and nearest wake times.
      let first: GuestThreadState | undefined;
      let next: GuestThreadState | undefined;
      let runnableCount = 0;
      let earliestDeadline = Infinity;
      for (const thread of this.guestThreads.values()) {
        if (thread.terminated) continue;
        if (thread.runnable) {
          runnableCount++;
          if (!first || thread.id < first.id) first = thread;
          if (thread.id > currentId && (!next || thread.id < next.id)) next = thread;
        }
        if (thread.wakeAt > now && thread.wakeAt < earliestDeadline) earliestDeadline = thread.wakeAt;
        const waitDeadline = thread.wait?.deadline ?? 0;
        if (waitDeadline > now && waitDeadline < earliestDeadline) earliestDeadline = waitDeadline;
      }
      next ??= first;
      // RA2's main thread waits for background work with while (!workerDone) Sleep(0). Windows
      // returns immediately, but copying that into the browser causes thousands of VM/JS crossings per second. When the
      // caller is the only runnable thread, coalesce directly to the nearest thread deadline, preserving observable scheduling
      // while eliminating the entire spin interval.
      if (yielded && next?.id === currentId && runnableCount === 1 && earliestDeadline < Infinity) {
        this.writeU32(HYPERCALL_THREAD_NEXT, currentId);
        return Math.max(1, this.clock.toHostDelay(earliestDeadline - now));
      }
      if (!next && afterDelay) {
        const current = this.guestThreads.get(currentId);
        if (current && !current.terminated && !current.wait && current.criticalSection === undefined) {
          current.runnable = true;
          current.wakeAt = 0;
          this.writeU32(GUEST_THREAD_RUN_STATES + current.id * 4, 1);
          next = current;
        }
      }
      if (next) {
        this.writeU32(HYPERCALL_THREAD_NEXT, next.id);
        return 0;
      }
      const delay = earliestDeadline < Infinity ? Math.max(1, this.clock.toHostDelay(earliestDeadline - now)) : 1;
      // Another emulator may signal a shared object before this process's own timeout.
      return this.options.processContext ? Math.min(delay, 10) : delay;
    }
  };
}
