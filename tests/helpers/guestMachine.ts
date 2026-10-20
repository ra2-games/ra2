/** Execute small machine-code snippets with real boot.bin/v86; no original assets or CI assembler required. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { V86 } from 'v86';
import { Win32Shim } from '../../src/games/win32Shim';
import {
  makeImportStub,
  HYPERCALL_EAX,
  HYPERCALL_EDX,
  HYPERCALL_ENTRY,
  HYPERCALL_EXCEPTION,
  HYPERCALL_EXCEPTION_EIP,
  HYPERCALL_REQUEST,
  HYPERCALL_STACK,
  HYPERCALL_STACK_TOP,
  type PeImport,
} from '../../src/vm86/pe';
import { readStackArgs, type Win32Call, type Win32ShimOptions } from '../../src/vm86/win32';

export const PROGRAM = 0x0040_0000;
export const DONE = 0x0030_0000;
export const le32 = (value: number): number[] => [0, 8, 16, 24].map((shift) => (value >>> shift) & 255);
export const store32 = (address: number, value: number): number[] => [0xc7, 0x05, ...le32(address), ...le32(value)];
export const push32 = (value: number): number[] => [0x68, ...le32(value)];
export const call32 = (address: number): number[] => [0xb8, ...le32(address), 0xff, 0xd0];
export const finish = [...store32(DONE, 1), 0xfa, 0xf4, 0xeb, 0xfd];

export class GuestMachine {
  readonly shim: Win32Shim;
  readonly calls: Win32Call[] = [];
  afterCall?: (call: Win32Call) => void;
  private readonly imports = new Map<number, PeImport>();
  constructor(
    readonly memory: V86,
    options: Win32ShimOptions = {},
  ) {
    this.shim = new Win32Shim(memory, {
      heapTop: 0x00e0_0000,
      virtualTop: 0x00e0_0000,
      firstDynamicId: 1000,
      ...options,
    });
    this.write(HYPERCALL_ENTRY, PROGRAM);
    this.write(HYPERCALL_STACK_TOP, 0x0070_0000);
  }
  read(address: number): number {
    const bytes = this.memory.read_memory(address, 4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }
  write(address: number, value: number): void {
    this.memory.write_memory(le32(value), address);
  }
  code(address: number, bytes: number[] | Uint8Array): void {
    this.memory.write_memory(bytes, address);
  }
  api(name: string, argBytes: number, factory = makeImportStub, dll = 'KERNEL32.DLL'): number {
    const id = this.imports.size + 1;
    const stub = 0x0008_0000 + id * 1024;
    this.imports.set(id, { id, name, dll, argBytes, key: `${dll}!${name}`, stub, slot: 0 });
    this.code(stub, factory(id, argBytes));
    return stub;
  }
  async run(timeoutMs = 5000): Promise<void> {
    let waiting = false;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let notify = () => {};
    const completion = new Promise<void>((done, reject) => {
      const service = () => {
        try {
          if (this.read(HYPERCALL_EXCEPTION))
            throw new Error(
              `CPU 异常 #${this.read(HYPERCALL_EXCEPTION) - 1} @0x${this.read(HYPERCALL_EXCEPTION_EIP).toString(16)}`,
            );
          if (this.read(DONE)) {
            done();
            return;
          }
          if (waiting) return;
          const id = this.read(HYPERCALL_REQUEST);
          if (!id) return;
          const imported = this.imports.get(id) ?? this.shim.resolveDynamicImport(id);
          if (!imported) throw new Error(`未知 import ${id}`);
          const stack = this.read(HYPERCALL_STACK);
          const call = { imported, stack, args: readStackArgs(this.memory, stack, imported.argBytes) };
          this.calls.push(call);
          const result = this.shim.dispatch(call);
          if (!result) throw new Error(`未实现 ${imported.key}`);
          waiting = true;
          const release = () => {
            this.afterCall?.(call);
            this.write(HYPERCALL_EAX, result.eax);
            this.write(HYPERCALL_EDX, result.edx ?? 0);
            this.write(HYPERCALL_REQUEST, 0);
            waiting = false;
            this.memory.serial0_send('\0');
          };
          const delay = this.shim.prepareGuestThreadReturn(call, result);
          const resume = () => {
            try {
              const completion = this.shim.completeGuestThreadDelay();
              if (completion.result !== undefined) result.eax = completion.result;
              if (completion.delayMs > 0) delayTimer = setTimeout(resume, completion.delayMs);
              else release();
            } catch (error) {
              reject(error);
            }
          };
          if (delay > 0) delayTimer = setTimeout(resume, delay);
          else release();
        } catch (error) {
          reject(error);
        }
      };
      notify = () => queueMicrotask(service);
      this.memory.add_listener('serial0-output-byte', notify);
      poll = setInterval(service, 5);
      deadline = setTimeout(
        () => reject(new Error(`机器码测试超时：${this.calls.map((c) => c.imported.name).join(', ')}`)),
        timeoutMs,
      );
    });
    try {
      await this.memory.run();
      await completion;
    } finally {
      clearInterval(poll);
      clearTimeout(deadline);
      clearTimeout(delayTimer);
      this.memory.remove_listener('serial0-output-byte', notify);
      await this.memory.stop();
    }
  }
}

export async function withGuestMachine(
  test: (machine: GuestMachine) => Promise<void>,
  options: Win32ShimOptions = {},
): Promise<void> {
  const bios = new Uint8Array(readFileSync(resolve('src/vm86/boot.bin')));
  const vm = new V86({
    wasm_path: resolve('node_modules/v86/build/v86.wasm'),
    memory_size: 32 * 1024 * 1024,
    bios: { buffer: bios.buffer },
    autostart: false,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  });
  await new Promise<void>((done) => vm.add_listener('emulator-ready', done));
  try {
    await test(new GuestMachine(vm, options));
  } finally {
    await vm.destroy();
  }
}
