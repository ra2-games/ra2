import { GuestKernelError, type GuestProcessContext } from '../processKernel';
import type { GuestMemory, Win32Result } from '../win32';

export interface ProcessApiMemory {
  memory: GuestMemory;
  read(pointer: number): number;
  string(pointer: number): string;
  alloc(size: number): number;
  free(pointer: number): void;
  error(code: number): void;
  localThread: number;
}
/** Only supported OS contracts dispatch here; unsupported calls remain explicit failures. */
export function dispatchProcessApi(
  context: GuestProcessContext,
  api: ProcessApiMemory,
  key: string,
  a: number[],
): Win32Result | undefined {
  const { kernel: k, pid } = context;
  const thread = k.threadId(pid, api.localThread);
  const inherited = (pointer: number) => !!pointer && api.read(pointer + 8) !== 0;
  const name = (pointer: number) => (pointer ? api.string(pointer) : '');
  const created = (result: { handle: number; existed: boolean }) => {
    api.error(result.existed ? 183 : 0);
    return { eax: result.handle };
  };
  try {
    switch (key) {
      case 'KERNEL32.DLL!GetCurrentProcessId':
        return { eax: pid };
      case 'KERNEL32.DLL!GetCurrentThreadId':
        return { eax: thread };
      case 'KERNEL32.DLL!CreateMutexA':
        return created(k.mutex(pid, name(a[2]!), a[1] ? thread : null, inherited(a[0]!)));
      case 'KERNEL32.DLL!OpenMutexA':
        return { eax: k.open(pid, name(a[2]!), 'mutex', !!a[1], a[0]) };
      case 'KERNEL32.DLL!CreateEventA':
        return created(k.event(pid, name(a[3]!), !!a[1], !!a[2], inherited(a[0]!)));
      case 'KERNEL32.DLL!OpenEventA':
        return { eax: k.open(pid, name(a[2]!), 'event', !!a[1], a[0]) };
      case 'KERNEL32.DLL!SetEvent':
        k.setEvent(pid, a[0]!, true);
        return { eax: 1 };
      case 'KERNEL32.DLL!ResetEvent':
        k.setEvent(pid, a[0]!, false);
        return { eax: 1 };
      case 'KERNEL32.DLL!ReleaseMutex':
        k.releaseMutex(pid, a[0]!, thread);
        return { eax: 1 };
      case 'KERNEL32.DLL!CloseHandle':
        if (!k.has(pid, a[0]!) && a[0]! < 0x20000000) return;
        k.close(pid, a[0]!);
        return { eax: 1 };
      case 'KERNEL32.DLL!GetExitCodeProcess': {
        const code = k.exitCode(pid, a[0]!);
        if (!a[1]) throw new GuestKernelError(87, 'Missing exit-code pointer');
        api.memory.write_memory(new Uint8Array(new Uint32Array([code]).buffer), a[1]);
        return { eax: 1 };
      }
      case 'KERNEL32.DLL!CreateProcessA': {
        if (!a[9] || !a[8] || api.read(a[8]) < 68) throw new GuestKernelError(87, 'Invalid process startup structures');
        // Restricted launch contract: unsupported security, environment and creation modes cannot be ignored.
        if (a[2] || a[3] || ![0, 6].includes(a[5]!) || a[6] || api.read(a[8] + 44))
          throw new GuestKernelError(50, 'Unsupported process creation options');
        return {
          eax: 0,
          createProcess: {
            application: name(a[0]!),
            commandLine: name(a[1]!),
            inherit: !!a[4],
            flags: a[5]!,
            environment: a[6]!,
            directory: name(a[7]!),
            information: a[9]!,
          },
        };
      }
      case 'KERNEL32.DLL!WaitForDebugEvent':
        k.debuggerFor(pid);
        if (!a[0]) throw new GuestKernelError(87, 'Missing debug-event buffer');
        return { eax: 0, debugWait: { address: a[0]!, timeout: a[1]! } };
      case 'KERNEL32.DLL!ContinueDebugEvent':
        k.debuggerFor(pid).continue(a[0]!, a[1]!, a[2]!);
        return { eax: 1 };
      case 'KERNEL32.DLL!ResumeThread':
        return { eax: k.debugHandle(pid, a[0]!, 'thread', 2).session.resumeThread() };
      case 'KERNEL32.DLL!ReadProcessMemory':
      case 'KERNEL32.DLL!WriteProcessMemory': {
        const reading = key.endsWith('ReadProcessMemory');
        const { session } = k.debugHandle(pid, a[0]!, 'process', reading ? 0x10 : 0x28);
        const size = a[3]!;
        if (size && !a[2]) throw new GuestKernelError(87, 'Missing memory transfer buffer');
        if (reading) api.memory.write_memory(session.read(a[1]!, size), a[2]!);
        else {
          const bytes = api.memory.read_memory(a[2]!, size);
          if (bytes.length !== size) throw new GuestKernelError(299, 'Incomplete debugger memory buffer');
          session.write(a[1]!, bytes.slice());
        }
        if (a[4]) api.memory.write_memory(new Uint8Array(new Uint32Array([size]).buffer), a[4]);
        return { eax: 1 };
      }
      case 'KERNEL32.DLL!VirtualAllocEx': {
        const { session } = k.debugHandle(pid, a[0]!, 'process', 8);
        if (!a[2] || ![0x1000, 0x2000, 0x3000].includes(a[3]!) || ![4, 0x40].includes(a[4]!))
          throw new GuestKernelError(50, 'Unsupported debuggee allocation options');
        return { eax: session.target.allocate(a[1]!, a[2]!, a[3]!, a[4]!) };
      }
      case 'KERNEL32.DLL!VirtualFreeEx': {
        const { session } = k.debugHandle(pid, a[0]!, 'process', 8);
        if (a[2] || a[3] !== 0x8000)
          throw new GuestKernelError(50, 'Only full debuggee allocation release is supported');
        return { eax: session.target.free(a[1]!, a[2]!, a[3]!) ? 1 : 0 };
      }
      case 'KERNEL32.DLL!GetThreadContext':
      case 'KERNEL32.DLL!SetThreadContext': {
        const reading = key.endsWith('GetThreadContext');
        const { session, tid } = k.debugHandle(pid, a[0]!, 'thread', reading ? 8 : 0x10);
        if (!a[1]) throw new GuestKernelError(87, 'Missing thread context');
        if (reading) api.memory.write_memory(session.getContext(tid, api.read(a[1]!)), a[1]!);
        else {
          const bytes = api.memory.read_memory(a[1]!, 716);
          if (bytes.length !== 716) throw new GuestKernelError(299, 'Incomplete x86 context');
          session.setContext(tid, bytes.slice());
        }
        return { eax: 1 };
      }
      case 'KERNEL32.DLL!CreateFileMappingA':
        if (a[0] !== 0xffffffff || a[3] || ![2, 4].includes(a[2]!))
          throw new GuestKernelError(50, 'Only pagefile-backed read/read-write mappings are supported');
        return created(k.mapping(pid, name(a[5]!), a[4]!, a[2] === 4, inherited(a[1]!)));
      case 'KERNEL32.DLL!MapViewOfFile':
      case 'KERNEL32.DLL!MapViewOfFileEx': {
        if (a[2] || a[5] || ![2, 4, 6, 0xf001f].includes(a[1]!))
          throw new GuestKernelError(50, 'Unsupported mapping view');
        const offset = a[3]!;
        const size = a[4] || k.mappingSize(pid, a[0]!) - offset;
        if (offset % 65536 || size <= 0 || offset + size > k.mappingSize(pid, a[0]!))
          throw new GuestKernelError(87, 'Invalid mapping bounds');
        const pointer = api.alloc(size);
        if (!pointer) throw new GuestKernelError(8, 'Mapping allocation failed');
        try {
          k.map(pid, a[0]!, api.memory, pointer, offset, size, (a[1]! & 2) !== 0);
        } catch (error) {
          api.free(pointer);
          throw error;
        }
        return { eax: pointer };
      }
      case 'KERNEL32.DLL!UnmapViewOfFile':
        k.unmap(pid, a[0]!);
        api.free(a[0]!);
        return { eax: 1 };
      case 'USER32.DLL!PostThreadMessageA':
        k.post(a[0]!, { message: a[1]!, wParam: a[2]!, lParam: a[3]! });
        return { eax: 1 };
    }
  } catch (error) {
    if (!(error instanceof GuestKernelError)) throw error;
    api.error(error.code);
    return { eax: key === 'KERNEL32.DLL!ResumeThread' ? 0xffffffff : 0 };
  }
}
