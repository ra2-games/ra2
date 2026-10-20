import type { GuestMemory } from './win32';
import { GuestKernelError } from './processError';

/** Adapter-owned execution boundary; this interface contains no emulator or game policy. */
export interface DebugProcessTarget {
  memory: GuestMemory;
  memoryBytes: number;
  imageBase: number;
  entry: number;
  allocate(address: number, size: number, type: number, protection: number): number;
  free(address: number, size: number, type: number): boolean;
  context(): Uint8Array;
  setContext(context: Uint8Array): void;
  resume(): void;
  unhandledException(code: number, address: number): void;
}
export interface ProcessDebugEvent {
  code: number;
  pid: number;
  tid: number;
  data: number[];
}

/** One debugger/debuggee relationship. Execution remains stopped until its event is continued. */
export class ProcessDebugger {
  private suspendCount = 1;
  private pending: ProcessDebugEvent[] = [];
  private active: ProcessDebugEvent | undefined;
  private waiter: ((event: ProcessDebugEvent | null) => void) | undefined;
  private disposed = false;
  private eventReleased: (() => void) | undefined;
  private exited = false;

  constructor(
    readonly owner: number,
    readonly pid: number,
    readonly tid: number,
    readonly target: DebugProcessTarget,
    handles: { process: number; thread: number },
  ) {
    this.pending.push({
      code: 3,
      pid,
      tid,
      data: [0, handles.process, handles.thread, target.imageBase, 0, 0, 0x70000, target.entry, 0, 0],
    });
  }
  private range(address: number, size: number): void {
    if (
      !Number.isInteger(address) ||
      !Number.isInteger(size) ||
      address < 0 ||
      size < 0 ||
      address + size > this.target.memoryBytes
    )
      throw new GuestKernelError(299, 'Invalid debuggee memory range');
  }
  read(address: number, size: number): Uint8Array {
    this.range(address, size);
    return this.target.memory.read_memory(address, size).slice();
  }
  write(address: number, bytes: Uint8Array): void {
    this.range(address, bytes.length);
    this.target.memory.write_memory(bytes, address);
  }
  resumeThread(): number {
    if (this.disposed) throw new GuestKernelError(6, 'Debuggee is gone');
    const previous = this.suspendCount;
    if (previous) this.suspendCount--;
    this.maybeRun();
    return previous;
  }
  private maybeRun(): void {
    if (!this.disposed && !this.exited && !this.suspendCount && !this.active && !this.pending.length)
      this.target.resume();
  }
  exception(tid: number, code: number, address: number): void {
    if (this.disposed || this.active || this.pending.length)
      throw new GuestKernelError(87, 'Debug event is already pending');
    // EXCEPTION_RECORD32 followed by dwFirstChance. Values come from the actual guest trap.
    const data = new Array<number>(21).fill(0);
    data[0] = code;
    data[3] = address;
    data[20] = 1;
    this.publish({ code: 1, pid: this.pid, tid, data });
  }
  threadCreated(tid: number, handle: number, start: number): Promise<void> {
    return this.stoppedEvent({ code: 2, pid: this.pid, tid, data: [handle, 0x70000, start] });
  }
  threadExited(tid: number, code: number): Promise<void> {
    return this.stoppedEvent({ code: 4, pid: this.pid, tid, data: [code] });
  }
  private async stoppedEvent(event: ProcessDebugEvent): Promise<void> {
    const released = new Promise<void>((resolve) => {
      this.eventReleased = resolve;
    });
    this.publish(event);
    await released;
  }
  private publish(event: ProcessDebugEvent): void {
    if (this.waiter) {
      this.active = event;
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(event);
    } else this.pending.push(event);
  }
  async wait(timeout: number): Promise<ProcessDebugEvent | null> {
    if (this.disposed || this.waiter || this.active) throw new GuestKernelError(87, 'Invalid debugger wait state');
    const event = this.pending.shift();
    if (event) {
      this.active = event;
      return event;
    }
    if (!timeout) return null;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.waiter = (next) => {
        if (timer) clearTimeout(timer);
        resolve(next);
      };
      if (timeout !== 0xffffffff)
        timer = setTimeout(() => {
          this.waiter = undefined;
          resolve(null);
        }, timeout);
    });
  }
  continue(pid: number, tid: number, status: number): void {
    if (!this.active || this.active.pid !== pid || this.active.tid !== tid)
      throw new GuestKernelError(87, 'No matching debug event');
    if (status === 0x80010001 && this.active.code === 1) {
      const event = this.active;
      this.active = undefined;
      // Guest SEH dispatch is not implemented. Fail closed rather than resume a rejected exception.
      this.target.unhandledException(event.data[0]!, event.data[3]!);
      return;
    }
    if (status !== 0x10002) throw new GuestKernelError(87, 'Unsupported debug continuation status');
    this.active = undefined;
    const released = this.eventReleased;
    this.eventReleased = undefined;
    if (released) released();
    else this.maybeRun();
  }
  getContext(tid: number, flags: number): Uint8Array {
    this.checkContext(tid, flags);
    const bytes = this.target.context().slice();
    new DataView(bytes.buffer).setUint32(0, flags, true);
    return bytes;
  }
  setContext(tid: number, bytes: Uint8Array): void {
    this.checkContext(tid, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true));
    this.target.setContext(bytes);
  }
  private checkContext(tid: number, flags: number): void {
    if (this.active?.code !== 1 || this.active.tid !== tid)
      throw new GuestKernelError(87, 'Thread is not stopped at a debug exception');
    if (flags & ~0x10007 || !(flags & 7) || (flags & 0x10000) === 0)
      throw new GuestKernelError(50, 'Unsupported x86 context groups');
  }
  get attached(): boolean {
    return !this.disposed && !this.exited;
  }
  exit(code: number): void {
    if (this.disposed) return;
    this.exited = true;
    this.publish({ code: 5, pid: this.pid, tid: this.tid, data: [code] });
  }
  dispose(): void {
    this.disposed = true;
    this.pending.length = 0;
    this.active = undefined;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(null);
    this.eventReleased?.();
    this.eventReleased = undefined;
  }
}
