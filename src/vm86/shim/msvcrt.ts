import type { Win32Call, Win32Result } from '../win32';
import type { Constructor } from './state';
import type { withKernel32 } from './kernel32';

type KernelChain = InstanceType<ReturnType<typeof withKernel32>>;

/** cdecl CRT imports retain their arguments on the caller's stack. */
export function withMsvcrt<TBase extends Constructor<KernelChain>>(Base: TBase) {
  return class extends Base {
    private readonly crtLocks = new Map<number, number>();
    dispatchMsvcrt(call: Win32Call): Win32Result | null {
      const arg = (index: number) => this.readU32(call.stack + 4 + index * 4);
      const name = call.imported.name;
      switch (name) {
        case '_lock':
        case '_unlock': {
          const id = arg(0);
          let address = this.crtLocks.get(id);
          if (address === undefined) {
            address = this.alloc(24, true);
            if (!address) throw new Error('Cannot allocate CRT lock');
            this.crtLocks.set(id, address);
          }
          if (name === '_lock') this.enterCriticalSection(address);
          else this.leaveCriticalSection(address);
          return { eax: 0 };
        }
        case 'malloc':
          return { eax: this.alloc(arg(0), false) };
        case 'calloc': {
          const size = arg(0) * arg(1);
          return { eax: size > 0xffffffff ? 0 : this.alloc(size, true) };
        }
        case 'free':
          return this.dispatchKernel32(call, 'KERNEL32.DLL!HeapFree', 'HeapFree', [0x10001, 0, arg(0)]);
        case 'memcpy': {
          this.memory.write_memory(this.memory.read_memory(arg(1), arg(2)).slice(), arg(0));
          return { eax: arg(0) };
        }
        case 'memset': {
          this.memory.write_memory(new Uint8Array(arg(2)).fill(arg(1) & 255), arg(0));
          return { eax: arg(0) };
        }
        case 'strlen': {
          let size = 0;
          while (this.memory.read_memory(arg(0) + size, 1)[0]) size++;
          return { eax: size };
        }
        case 'strcmp':
        case 'strncmp': {
          const limit = name === 'strncmp' ? arg(2) : 0xffffffff;
          for (let i = 0; i < limit; i++) {
            const a = this.memory.read_memory(arg(0) + i, 1)[0]!;
            const b = this.memory.read_memory(arg(1) + i, 1)[0]!;
            if (a !== b) return { eax: (a - b) >>> 0 };
            if (!a) break;
          }
          return { eax: 0 };
        }
        case '_initterm': {
          const first = arg(0),
            end = arg(1);
          if (end < first || (end - first) % 4 || end - first > 0x100000)
            throw new Error('Invalid CRT initializer table');
          const code: number[] = [0x56, 0x57]; // Preserve callee-saved ESI/EDI.
          const word = (value: number) =>
            code.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
          // Unroll this bounded pointer table, but read pointers in the guest at
          // execution time. The initializer may update a later slot.
          for (let slot = first; slot < end; slot += 4) {
            code.push(0xa1);
            word(slot);
            code.push(0x85, 0xc0, 0x74, 0x02, 0xff, 0xd0);
          }
          code.push(0x5f, 0x5e, 0x68);
          word(this.readU32(call.stack));
          code.push(0xc3);
          this.writeU32(call.stack, this.allocateDynamicCode(code));
          return { eax: 0 };
        }
        case '__dllonexit': {
          const first = this.readU32(arg(1)),
            end = this.readU32(arg(2));
          if (end < first || (end - first) % 4) throw new Error('Invalid CRT exit table');
          const size = end - first;
          const replacement = this.realloc(first, size + 4, false);
          if (!replacement) return { eax: 0 };
          this.writeU32(replacement + size, arg(0));
          this.writeU32(arg(1), replacement);
          this.writeU32(arg(2), replacement + size + 4);
          return { eax: arg(0) };
        }
        case 'abort':
        case '_amsg_exit':
          throw new Error(`Guest CRT terminated: ${name}`);
        default:
          return null;
      }
    }
  };
}
