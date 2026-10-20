import { GuestKernelError } from './processError';
import { GuestRegistry } from './registry';
/** Session-owned guest kernel objects. No host processes or game-specific protocol data. */
import type { GuestMemory } from './win32';
import { ProcessDebugger, type DebugProcessTarget } from './processDebugger';

type EventObject = { kind: 'event'; manual: boolean; signaled: boolean };
type MutexObject = { kind: 'mutex'; owner: number | null; depth: number; abandoned: boolean };
type MappingObject = { kind: 'mapping'; bytes: Uint8Array; writable: boolean };
type ThreadObject = { kind: 'thread'; pid: number; local: number; exitCode?: number };
type ProcessObject = { kind: 'process'; pid: number; exitCode?: number };
type KernelObject = EventObject | MutexObject | MappingObject | ProcessObject | ThreadObject;
type Handle = { object: KernelObject; inherit: boolean; access: number };
type View = {
  object: MappingObject;
  memory: GuestMemory;
  pointer: number;
  offset: number;
  snapshot: Uint8Array;
  writable: boolean;
};
type Message = { message: number; wParam: number; lParam: number };
export interface GuestProcessContext {
  kernel: GuestProcessKernel;
  pid: number;
}
export interface GuestProcessRequest {
  application: string;
  commandLine: string;
  inherit: boolean;
  flags: number;
  directory: string;
  environment: number;
  information: number;
}
export { GuestKernelError } from './processError';

export class GuestProcessKernel {
  private readonly debuggers = new Map<number, ProcessDebugger>();
  readonly registry = new GuestRegistry();
  private readonly primaryThreads = new Map<number, ThreadObject>();
  private nextPid = 1;
  private nextHandle = 0x20000000;
  private readonly processes = new Map<number, ProcessObject>();
  private readonly handles = new Map<number, Map<number, Handle>>();
  private readonly names = new Map<string, KernelObject>();
  private readonly views = new Map<number, View[]>();
  private readonly queueWakeups = new Map<number, () => void>();
  private readonly queues = new Map<number, Message[]>();

  createProcess(parent?: number, inherit = false): number {
    const pid = this.nextPid++;
    this.processes.set(pid, { kind: 'process', pid });
    this.primaryThreads.set(pid, { kind: 'thread', pid, local: 0 });
    const handles = new Map<number, Handle>();
    if (inherit && parent !== undefined)
      for (const [id, handle] of this.table(parent)) if (handle.inherit) handles.set(id, { ...handle });
    this.handles.set(pid, handles);
    this.views.set(pid, []);
    return pid;
  }
  attachDebugger(owner: number, pid: number, target: DebugProcessTarget): ProcessDebugger {
    if (this.debuggers.has(owner)) throw new GuestKernelError(50, 'Only one debuggee per debugger is supported');
    const session = new ProcessDebugger(owner, pid, this.threadId(pid, 0), target, this.processHandles(owner, pid));
    this.debuggers.set(owner, session);
    return session;
  }
  isDebugged(pid: number): boolean {
    return [...this.debuggers.values()].some((session) => session.pid === pid && session.attached);
  }
  debugThreadHandle(owner: number, pid: number, local: number): number {
    return this.add(owner, { kind: 'thread', pid, local }, false);
  }
  debuggerFor(owner: number): ProcessDebugger {
    const session = this.debuggers.get(owner);
    if (!session) throw new GuestKernelError(6, 'No attached debuggee');
    return session;
  }
  debugHandle(
    owner: number,
    handle: number,
    kind: 'process' | 'thread',
    access: number,
  ): { session: ProcessDebugger; tid: number } {
    this.requireAccess(owner, handle, access);
    const object = this.object(owner, handle);
    const session = this.debuggerFor(owner);
    if (object.kind !== kind || !('pid' in object) || object.pid !== session.pid)
      throw new GuestKernelError(6, 'Handle is not part of this debug session');
    return { session, tid: this.threadId(object.pid, object.kind === 'thread' ? object.local : 0) };
  }
  threadId(pid: number, local: number): number {
    return pid * 256 + local + 1;
  }
  private table(pid: number): Map<number, Handle> {
    const table = this.handles.get(pid);
    if (!table) throw new GuestKernelError(6, 'Unknown guest process');
    return table;
  }
  private fullAccess(object: KernelObject): number {
    return object.kind === 'event'
      ? 0x1f0003
      : object.kind === 'mutex'
        ? 0x1f0001
        : object.kind === 'mapping'
          ? 0xf001f
          : 0x1fffff;
  }
  private requireAccess(pid: number, handle: number, access: number): void {
    const entry = this.table(pid).get(handle);
    if (!entry) throw new GuestKernelError(6, 'Invalid handle');
    if ((entry.access & access) !== access) throw new GuestKernelError(5, 'Access denied');
  }
  private add(pid: number, object: KernelObject, inherit: boolean, access = this.fullAccess(object)): number {
    const handle = this.nextHandle++;
    this.table(pid).set(handle, { object, inherit, access });
    return handle;
  }
  private object(pid: number, handle: number): KernelObject {
    const value = this.table(pid).get(handle);
    if (!value) throw new GuestKernelError(6, 'Invalid guest kernel handle');
    return value.object;
  }
  has(pid: number, handle: number): boolean {
    return this.table(pid).has(handle);
  }
  private named(
    pid: number,
    name: string,
    object: KernelObject,
    inherit: boolean,
  ): { handle: number; existed: boolean } {
    const existing = name ? this.names.get(name) : undefined;
    if (existing && existing.kind !== object.kind) throw new GuestKernelError(6, 'Named object type mismatch');
    if (name && !existing) this.names.set(name, object);
    return { handle: this.add(pid, existing ?? object, inherit), existed: !!existing };
  }
  event(pid: number, name: string, manual: boolean, signaled: boolean, inherit: boolean) {
    return this.named(pid, name, { kind: 'event', manual, signaled }, inherit);
  }
  mutex(pid: number, name: string, owner: number | null, inherit: boolean) {
    return this.named(pid, name, { kind: 'mutex', owner, depth: owner === null ? 0 : 1, abandoned: false }, inherit);
  }
  open(pid: number, name: string, kind: KernelObject['kind'], inherit: boolean, access?: number): number {
    const object = this.names.get(name);
    if (!object) throw new GuestKernelError(2, 'Named object does not exist');
    if (object.kind !== kind) throw new GuestKernelError(6, 'Named object type mismatch');
    const requested = access ?? this.fullAccess(object);
    if ((requested & ~this.fullAccess(object)) !== 0) throw new GuestKernelError(5, 'Unsupported object access');
    return this.add(pid, object, inherit, requested);
  }
  setEvent(pid: number, handle: number, value: boolean): void {
    const object = this.object(pid, handle);
    if (object.kind !== 'event') throw new GuestKernelError(6, 'Not an event');
    this.requireAccess(pid, handle, 2);
    object.signaled = value;
  }
  releaseMutex(pid: number, handle: number, thread: number): void {
    const object = this.object(pid, handle);
    if (object.kind !== 'mutex') throw new GuestKernelError(6, 'Not a mutex');
    this.requireAccess(pid, handle, 1);
    if (object.owner !== thread) throw new GuestKernelError(288, 'Mutex is owned by another thread');
    if (--object.depth === 0) object.owner = null;
  }
  waitable(pid: number, handle: number): boolean {
    return this.has(pid, handle) && this.object(pid, handle).kind !== 'mapping';
  }
  ready(pid: number, handle: number, thread: number): boolean {
    this.requireAccess(pid, handle, 0x100000);
    const object = this.object(pid, handle);
    switch (object.kind) {
      case 'event':
        return object.signaled;
      case 'mutex':
        return object.owner === null || object.owner === thread;
      case 'process':
      case 'thread':
        return object.exitCode !== undefined;
      default:
        throw new GuestKernelError(6, 'Object is not waitable');
    }
  }
  consume(pid: number, handle: number, thread: number): boolean {
    const object = this.object(pid, handle);
    if (object.kind === 'event' && !object.manual) object.signaled = false;
    if (object.kind === 'mutex') {
      const abandoned = object.abandoned;
      object.owner = thread;
      object.depth++;
      object.abandoned = false;
      return abandoned;
    }
    return false;
  }
  processHandles(parent: number, child: number): { process: number; thread: number } {
    const object = this.processes.get(child);
    if (!object) throw new GuestKernelError(6, 'Unknown child');
    return {
      process: this.add(parent, object, false),
      thread: this.add(parent, this.primaryThreads.get(child)!, false),
    };
  }
  exitCode(pid: number, handle: number): number {
    const object = this.object(pid, handle);
    if (object.kind !== 'process') throw new GuestKernelError(6, 'Not a process');
    return object.exitCode ?? 259;
  }
  mapping(pid: number, name: string, size: number, writable: boolean, inherit: boolean) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > 64 * 1024 * 1024)
      throw new GuestKernelError(87, 'Unsupported mapping size');
    return this.named(pid, name, { kind: 'mapping', bytes: new Uint8Array(size), writable }, inherit);
  }
  mappingSize(pid: number, handle: number): number {
    const object = this.object(pid, handle);
    if (object.kind !== 'mapping') throw new GuestKernelError(6, 'Not a mapping');
    return object.bytes.length;
  }
  map(
    pid: number,
    handle: number,
    memory: GuestMemory,
    pointer: number,
    offset: number,
    size: number,
    writable: boolean,
  ): void {
    const object = this.object(pid, handle);
    if (object.kind !== 'mapping') throw new GuestKernelError(6, 'Not a mapping');
    this.requireAccess(pid, handle, writable ? 2 : 4);
    if (writable && !object.writable) throw new GuestKernelError(5, 'Mapping is read-only');
    if (offset < 0 || offset % 65536 || size <= 0 || offset + size > object.bytes.length)
      throw new GuestKernelError(87, 'Invalid mapping range');
    const snapshot = object.bytes.slice(offset, offset + size);
    memory.write_memory(snapshot, pointer);
    this.views.get(pid)!.push({ object, memory, pointer, offset, snapshot, writable });
  }
  /** Publish writes and acquire updates at guest OS boundaries. Not a lock-free shared-memory implementation. */
  synchronize(pid: number): void {
    const views = this.views.get(pid) ?? [];
    for (const view of views) {
      const bytes = view.memory.read_memory(view.pointer, view.snapshot.length);
      for (let i = 0; i < bytes.length; i++)
        if (bytes[i] !== view.snapshot[i]) {
          if (!view.writable) throw new GuestKernelError(5, 'Write to read-only mapping');
          view.object.bytes[view.offset + i] = bytes[i]!;
        }
    }
    for (const view of views) {
      view.snapshot = view.object.bytes.slice(view.offset, view.offset + view.snapshot.length);
      view.memory.write_memory(view.snapshot, view.pointer);
    }
  }
  unmap(pid: number, pointer: number): void {
    this.synchronize(pid);
    const views = this.views.get(pid)!;
    const index = views.findIndex((view) => view.pointer === pointer);
    if (index < 0) throw new GuestKernelError(487, 'Unknown mapped view');
    views.splice(index, 1);
    this.collectNames();
  }
  exitThread(pid: number, local: number, code: number): void {
    if (local === 0) this.primaryThreads.get(pid)!.exitCode = code >>> 0;
    const thread = this.threadId(pid, local);
    this.queues.delete(thread);
    this.queueWakeups.delete(thread);
    const objects = new Set(
      [...this.handles.values()].flatMap((table) => [...table.values()].map((handle) => handle.object)),
    );
    for (const object of objects) {
      if (object.kind === 'thread' && object.pid === pid && object.local === local) object.exitCode = code >>> 0;
      if (object.kind === 'mutex' && object.owner === thread) {
        object.owner = null;
        object.depth = 0;
        object.abandoned = true;
      }
    }
  }
  ensureQueue(pid: number, local: number, wakeup?: () => void): void {
    const id = this.threadId(pid, local);
    if (!this.queues.has(id)) this.queues.set(id, []);
    if (wakeup) this.queueWakeups.set(id, wakeup);
  }
  post(thread: number, message: Message): void {
    const queue = this.queues.get(thread);
    if (!queue) throw new GuestKernelError(1444, 'Target thread has no message queue');
    if (queue.length >= 10000) throw new GuestKernelError(1816, 'Thread message queue is full');
    queue.push(message);
    this.queueWakeups.get(thread)?.();
  }
  take(pid: number, local: number): Message[] {
    return this.queues.get(this.threadId(pid, local))?.splice(0) ?? [];
  }
  close(pid: number, handle: number): void {
    if (!this.table(pid).delete(handle)) throw new GuestKernelError(6, 'Invalid handle');
    this.collectNames();
  }
  exit(pid: number, code: number): void {
    const process = this.processes.get(pid);
    if (process?.exitCode !== undefined) return;
    this.debuggers.get(pid)?.dispose();
    for (const session of this.debuggers.values()) if (session.pid === pid) session.exit(code);
    if (!process || process.exitCode !== undefined) return;
    process.exitCode = code >>> 0;
    for (let local = 0; local < 256; local++) this.exitThread(pid, local, code);
    this.table(pid).clear();
    this.views.set(pid, []);
    for (const [id] of this.queues) if (Math.floor((id - 1) / 256) === pid) this.queues.delete(id);
    for (const object of this.names.values())
      if (object.kind === 'mutex' && object.owner !== null && Math.floor((object.owner - 1) / 256) === pid) {
        object.owner = null;
        object.depth = 0;
        object.abandoned = true;
      }
    this.collectNames();
  }
  private collectNames(): void {
    const live = new Set<KernelObject>();
    for (const table of this.handles.values()) for (const handle of table.values()) live.add(handle.object);
    for (const views of this.views.values()) for (const view of views) live.add(view.object);
    for (const [name, object] of this.names) if (!live.has(object)) this.names.delete(name);
  }
}
