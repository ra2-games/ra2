/**
 * Fixture end-to-end runner: boot a synthetic PE in Node with v86 and the real boot.bin firmware, and run the hypercall service loop (same handshake as tests/real-game/helpers/runVmSmoke.ts, without game-specific assertions).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V86 } from 'v86';
import {
  HYPERCALL_CALLBACK_DEPTH,
  HYPERCALL_EAX,
  HYPERCALL_EDX,
  HYPERCALL_ENTRY,
  HYPERCALL_EXCEPTION,
  HYPERCALL_EXCEPTION_EIP,
  HYPERCALL_HALTED,
  HYPERCALL_REQUEST,
  HYPERCALL_STACK,
  HYPERCALL_STACK_TOP,
  loadPe,
} from '../../src/vm86/pe';
import {
  annotateWin32Modules,
  makeWin32ImportStub,
  makeWin32ImportStubWithFastRead,
  readStackArgs,
} from '../../src/vm86/win32';
import { Win32Shim } from '../../src/games/win32Shim';
import { buildFixturePe, FIXTURE_FILE_BYTES, FIXTURE_FILE_PATH, FIXTURE_MODULE_NAME } from './fixtureProgram';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function v86WasmPath(): string {
  const candidates = [
    resolve(ROOT, 'node_modules/v86/build/v86.wasm'),
    // Git worktrees commonly share dependencies from the main checkout.
    resolve(ROOT, '..', '..', 'node_modules/v86/build/v86.wasm'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** fast = guest fast stubs (_lread mirrors + critical sections); slow = host hypercalls for every call. */
export type FixtureMode = 'fast' | 'slow';

export interface FixtureRunResult {
  exitCode: number;
  calls: number;
  firstCall: string;
  callCounts: Map<string, number>;
}

export async function runFixture(mode: FixtureMode, timeoutMs = 30_000): Promise<FixtureRunResult> {
  const { built, abi } = buildFixturePe();
  const argBytes = (dll: string, name: string): number => {
    const value = abi[`${dll.toUpperCase()}!${name}`];
    if (value === undefined) throw new Error(`fixture ABI 未登记: ${dll}!${name}`);
    return value;
  };

  const staging = new Uint8Array(8 * 1024 * 1024);
  let stubNext = 0x8_0000;
  const image = loadPe(
    staging,
    built.exe,
    (size) => {
      const address = stubNext;
      stubNext = (stubNext + size + 15) & ~15;
      return address;
    },
    argBytes,
    mode === 'fast' ? makeWin32ImportStubWithFastRead : makeWin32ImportStub,
  );
  annotateWin32Modules(image.importList);

  const biosBytes = new Uint8Array(readFileSync(join(ROOT, 'src/vm86/boot.bin')));
  if (biosBytes.length !== 0x1_0000) throw new Error(`boot.bin 应为 64KB，实际 ${biosBytes.length}`);

  const emulator = new V86({
    wasm_path: v86WasmPath(),
    memory_size: 32 * 1024 * 1024,
    bios: { buffer: exactBuffer(biosBytes) },
    autostart: false,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
  });
  await new Promise<void>((done) => emulator.add_listener('emulator-ready', done));
  emulator.write_memory(staging.subarray(HYPERCALL_STACK, stubNext), HYPERCALL_STACK);
  emulator.write_memory(staging.subarray(image.imageBase, image.imageBase + image.sizeOfImage), image.imageBase);
  writeU32(emulator, HYPERCALL_ENTRY, image.entry);
  writeU32(emulator, HYPERCALL_CALLBACK_DEPTH, 0);
  // Firmware reads the main-thread stack top from the shared page (no longer hardcoded to 0x700000 since RA2), matching vmCore.
  writeU32(emulator, HYPERCALL_STACK_TOP, 0x0070_0000);

  const shim = new Win32Shim(emulator, {
    firstDynamicId: image.importList.length + 1,
    enableFastFileMirror: mode === 'fast',
    moduleName: FIXTURE_MODULE_NAME,
    // Narrow the heap arena to below 16 MB to fit the 32 MB guest memory.
    heapTop: 0x00e0_0000,
    virtualTop: 0x00e0_0000,
  });
  shim.mountFile(FIXTURE_FILE_PATH, FIXTURE_FILE_BYTES);

  const callCounts = new Map<string, number>();
  let calls = 0;
  let firstCall = '';

  const completion = new Promise<number>((done, reject) => {
    let waiting = false;
    let stopped = false;
    let delayTimer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => queueMicrotask(service);
    const cleanup = () => {
      stopped = true;
      clearTimeout(deadline);
      clearTimeout(delayTimer);
      clearInterval(poll);
      emulator.remove_listener('serial0-output-byte', notify);
    };
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`fixture VM 超时：calls=${calls}`));
    }, timeoutMs);
    const service = (): void => {
      if (stopped || waiting) return;
      const exception = readU32(emulator, HYPERCALL_EXCEPTION);
      if (exception) {
        cleanup();
        const eip = readU32(emulator, HYPERCALL_EXCEPTION_EIP);
        reject(new Error(`fixture CPU 异常 #${exception - 1} @EIP=0x${eip.toString(16)}，calls=${calls}`));
        return;
      }
      if (readU32(emulator, HYPERCALL_HALTED)) {
        cleanup();
        reject(new Error('fixture 入口直接返回（应走 ExitProcess）'));
        return;
      }
      const id = readU32(emulator, HYPERCALL_REQUEST);
      if (!id) return;
      const imported = image.importList[id - 1] ?? shim.resolveDynamicImport(id);
      if (!imported) {
        cleanup();
        reject(new Error(`非法 hypercall id ${id}`));
        return;
      }
      const stack = readU32(emulator, HYPERCALL_STACK);
      const args = readStackArgs(emulator, stack, imported.argBytes);
      calls++;
      callCounts.set(imported.key, (callCounts.get(imported.key) ?? 0) + 1);
      if (!firstCall) firstCall = imported.key;
      const result = shim.dispatch({ imported, stack, args });
      if (!result) {
        cleanup();
        reject(new Error(`fixture 触发未实现 API: ${imported.key}`));
        return;
      }
      const release = () => {
        waiting = false;
        writeU32(emulator, HYPERCALL_EAX, result.eax);
        writeU32(emulator, HYPERCALL_EDX, result.edx ?? 0);
        writeU32(emulator, HYPERCALL_REQUEST, 0);
        emulator.serial0_send('\0');
      };
      if (result.exit) {
        release();
        cleanup();
        done(result.eax);
        return;
      }
      const threadDelay = shim.prepareGuestThreadReturn({ imported, args }, result);
      if (threadDelay) {
        waiting = true;
        const resume = () => {
          if (stopped) return;
          try {
            const completion = shim.completeGuestThreadDelay();
            if (completion.result !== undefined) result.eax = completion.result;
            if (completion.delayMs) delayTimer = setTimeout(resume, completion.delayMs);
            else release();
          } catch (error) {
            cleanup();
            reject(error);
          }
        };
        delayTimer = setTimeout(resume, threadDelay);
      } else {
        release();
      }
    };
    emulator.add_listener('serial0-output-byte', notify);
    const poll = setInterval(service, 50);
  });

  await emulator.run();
  const exitCode = await completion;
  if (emulator.is_running()) await emulator.stop();
  await emulator.destroy();
  return { exitCode, calls, firstCall, callCounts };
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function readU32(memory: V86, address: number): number {
  const b = memory.read_memory(address, 4);
  return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
}

function writeU32(memory: V86, address: number, value: number): void {
  memory.write_memory([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff], address);
}
