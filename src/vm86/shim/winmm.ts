import { gbkBytesOf } from '../../utils/encoding/gbk';
import { RegistryError } from '../registry';
import type { Win32Call, Win32Result } from '../win32';
import { fourCc, readBytesU32 } from './text';
import { normalizeGuestPath } from '../paths';
import { withUser32 } from './user32';
import { shimTraceEnabled } from './state';
import type { Constructor } from './state';

type User32Chain = InstanceType<ReturnType<typeof withUser32>>;

/** Winmm Win32 API cases extracted from Win32Shim.dispatch's main switch. */
export function withWinmm<TBase extends Constructor<User32Chain>>(Base: TBase) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...args);
    }

    dispatchWinmm(call: Win32Call, key: string, name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'WINMM.DLL!timeGetTime':
          return { eax: this.clock.now() >>> 0 };
        case 'WINMM.DLL!timeGetDevCaps':
          if (a[0] && (a[1] ?? 0) >= 8) {
            this.writeU32(a[0], 1); // wPeriodMin
            this.writeU32(a[0] + 4, 1000); // wPeriodMax
          }
          return { eax: 0 }; // TIMERR_NOERROR
        case 'WINMM.DLL!mmioOpenA':
          return { eax: this.mmioOpen(a[0] ?? 0) };
        case 'WINMM.DLL!mmioDescend':
          return { eax: this.mmioDescend(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) };
        case 'WINMM.DLL!mmioAscend':
          return { eax: this.mmioAscend(a[0] ?? 0, a[1] ?? 0) };
        case 'WINMM.DLL!mmioRead':
          return { eax: this.mmioRead(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) >>> 0 };
        case 'WINMM.DLL!mmioClose':
          return { eax: this.mmioHandles.delete(a[0] ?? 0) ? 0 : 5 };
        case 'WINMM.DLL!timeBeginPeriod':
        case 'WINMM.DLL!timeEndPeriod':
          return { eax: 0 };
        case 'WINMM.DLL!timeKillEvent': {
          const removed = this.multimediaTimers.delete(a[0] ?? 0);
          this.invalidateFastPeek();
          return { eax: removed ? 0 : 97 }; // TIMERR_NOERROR/NOCANDO
        }
        case 'WINMM.DLL!timeSetEvent': {
          const id = this.nextMultimediaTimer++;
          const interval = Math.max(1, a[0] || 1);
          if (shimTraceEnabled('VM_TRACE_TIMER'))
            console.log(
              `⏲️ timeSetEvent id=${id} interval=${interval} callback=0x${(a[2] ?? 0).toString(16)} periodic=${((a[4] ?? 0) & 1) !== 0}`,
            );
          this.multimediaTimers.set(id, {
            id,
            interval,
            callback: a[2] ?? 0,
            user: a[3] ?? 0,
            periodic: ((a[4] ?? 0) & 1) !== 0,
            next: this.clock.now() + interval,
          });
          this.invalidateFastPeek();
          return { eax: id };
        }
        case 'WINMM.DLL!waveOutOpen':
          if (a[0]) this.writeU32(a[0], 1);
          return { eax: 0 };
        case 'WINMM.DLL!waveOutPrepareHeader':
          if (a[1]) this.writeU32(a[1] + 16, this.readU32(a[1] + 16) | 0x2); // WHDR_PREPARED
          return { eax: 0 };
        case 'WINMM.DLL!waveOutWrite':
          if (a[1]) this.writeU32(a[1] + 16, (this.readU32(a[1] + 16) & ~0x10) | 0x1); // WHDR_DONE
          return { eax: 0 };
        case 'WINMM.DLL!waveOutUnprepareHeader':
          if (a[1]) this.writeU32(a[1] + 16, this.readU32(a[1] + 16) & ~0x2);
          return { eax: 0 };
        case 'WINMM.DLL!waveOutRestart':
        case 'WINMM.DLL!waveOutSetVolume':
        case 'WINMM.DLL!waveOutPause':
        case 'WINMM.DLL!waveOutReset':
        case 'WINMM.DLL!waveOutClose':
          return { eax: 0 };
        case 'WINMM.DLL!mciSendCommandA': {
          const command = a[1] ?? 0;
          const params = a[3] ?? 0;
          if (command === 0x0803 && params) {
            // MCI_OPEN
            this.writeU32(params + 4, 1); // wDeviceID
          } else if (command === 0x0814 && params) {
            // MCI_STATUS
            const item = this.readU32(params + 8);
            // MCI_STATUS_MODE reports the intro stopped; position/length return 0.
            this.writeU32(params + 4, item === 4 ? 525 : 0); // MCI_MODE_STOP
          }
          return { eax: 0 };
        }
        case 'ADVAPI32.DLL!RegOpenKeyA':
        case 'ADVAPI32.DLL!RegOpenKeyExA':
        case 'ADVAPI32.DLL!RegCreateKeyExA':
        case 'ADVAPI32.DLL!RegQueryValueExA':
        case 'ADVAPI32.DLL!RegSetValueExA':
        case 'ADVAPI32.DLL!RegDeleteValueA':
        case 'ADVAPI32.DLL!RegDeleteKeyA':
        case 'ADVAPI32.DLL!RegEnumKeyExA':
        case 'ADVAPI32.DLL!RegQueryInfoKeyA':
        case 'ADVAPI32.DLL!RegCloseKey':
          return this.dispatchRegistry(key, a);
        case 'MSVFW32.DLL!MCIWndCreateA':
          return { eax: this.createMciWindow(call) };
        default:
          void name;
          return null;
      }
    }
    private dispatchRegistry(key: string, a: number[]): Win32Result {
      const arg = (index: number) => (a[index] ?? 0) >>> 0;
      const requirePointer = (pointer: number, length: number) => {
        if (!pointer || length > 16 * 1024 * 1024 || this.memory.read_memory(pointer, length).length !== length)
          throw new RegistryError(87);
      };
      const output = (index: number) => {
        requirePointer(arg(index), 4);
        return arg(index);
      };
      const string = (index: number) => (arg(index) ? this.readCString(arg(index)) : '');
      const encode = (value: string): Uint8Array => {
        const bytes: number[] = [];
        for (const character of value) {
          const code = character.charCodeAt(0);
          const encoded = code < 128 ? [code] : gbkBytesOf(character);
          if (!encoded) throw new RegistryError(1113);
          bytes.push(...encoded);
        }
        return Uint8Array.from(bytes);
      };
      const checkString = (pointer: number, sizePointer: number, value: string) => {
        if (!sizePointer) {
          if (pointer) throw new RegistryError(87);
          return;
        }
        requirePointer(sizePointer, 4);
        if (pointer) {
          const bytes = encode(value);
          if (this.readU32(sizePointer) <= bytes.length) throw new RegistryError(234);
          requirePointer(pointer, bytes.length + 1);
        }
      };
      const writeString = (pointer: number, sizePointer: number, value: string) => {
        const bytes = encode(value);
        if (pointer) this.memory.write_memory(Uint8Array.from([...bytes, 0]), pointer);
        if (sizePointer) this.writeU32(sizePointer, bytes.length);
      };
      const writeTime = (pointer: number, milliseconds: number) => {
        if (!pointer) return;
        requirePointer(pointer, 8);
        const ticks = BigInt(milliseconds) * 10000n + 116444736000000000n;
        this.writeU32(pointer, Number(ticks & 0xffffffffn));
        this.writeU32(pointer + 4, Number(ticks >> 32n));
      };
      try {
        switch (key) {
          case 'ADVAPI32.DLL!RegOpenKeyA':
          case 'ADVAPI32.DLL!RegOpenKeyExA': {
            const legacy = key.endsWith('RegOpenKeyA');
            const out = output(legacy ? 2 : 4);
            if (!legacy && arg(2)) throw new RegistryError(50);
            const handle = this.registry.open(arg(0), string(1), legacy ? 0xf003f : arg(3));
            this.writeU32(out, handle);
            break;
          }
          case 'ADVAPI32.DLL!RegCreateKeyExA': {
            const out = output(7);
            if (arg(2) || !arg(1)) throw new RegistryError(87);
            if (arg(4) > 1 || arg(6)) throw new RegistryError(50);
            if (arg(8)) requirePointer(arg(8), 4);
            const created = this.registry.create(arg(0), string(1), arg(5), string(3));
            this.writeU32(out, created.handle);
            if (arg(8)) this.writeU32(arg(8), created.disposition);
            break;
          }
          case 'ADVAPI32.DLL!RegQueryValueExA': {
            if (arg(2)) throw new RegistryError(87);
            const value = this.registry.query(arg(0), string(1));
            if (arg(3)) requirePointer(arg(3), 4);
            if (arg(4) && !arg(5)) throw new RegistryError(87);
            const capacity = arg(5) ? this.readU32(output(5)) : 0;
            if (arg(3)) this.writeU32(arg(3), value.type);
            if (arg(5)) this.writeU32(arg(5), value.bytes.length);
            if (arg(4)) {
              if (capacity < value.bytes.length) throw new RegistryError(234);
              requirePointer(arg(4), value.bytes.length);
              this.memory.write_memory(value.bytes, arg(4));
            }
            break;
          }
          case 'ADVAPI32.DLL!RegSetValueExA': {
            if (arg(2) || arg(5) > 16 * 1024 * 1024) throw new RegistryError(87);
            if (arg(5)) requirePointer(arg(4), arg(5));
            this.registry.set(
              arg(0),
              string(1),
              arg(3),
              arg(5) ? this.memory.read_memory(arg(4), arg(5)) : new Uint8Array(),
            );
            break;
          }
          case 'ADVAPI32.DLL!RegDeleteValueA':
            this.registry.deleteValue(arg(0), string(1));
            break;
          case 'ADVAPI32.DLL!RegDeleteKeyA':
            if (!arg(1)) throw new RegistryError(87);
            this.registry.deleteKey(arg(0), string(1));
            break;
          case 'ADVAPI32.DLL!RegEnumKeyExA': {
            if (arg(4)) throw new RegistryError(87);
            output(3);
            if (!arg(2)) throw new RegistryError(87);
            const child = this.registry.enumerate(arg(0), arg(1));
            checkString(arg(2), arg(3), child.name);
            checkString(arg(5), arg(6), child.className);
            if (arg(7)) requirePointer(arg(7), 8);
            writeString(arg(2), arg(3), child.name);
            writeString(arg(5), arg(6), child.className);
            writeTime(arg(7), child.modified);
            break;
          }
          case 'ADVAPI32.DLL!RegQueryInfoKeyA': {
            if (arg(3)) throw new RegistryError(87);
            if (arg(10)) throw new RegistryError(50); // Security descriptors are not modeled.
            const info = this.registry.info(arg(0), (value) => encode(value).length);
            checkString(arg(1), arg(2), info.className);
            for (let i = 4; i <= 9; i++) if (arg(i)) requirePointer(arg(i), 4);
            if (arg(11)) requirePointer(arg(11), 8);
            writeString(arg(1), arg(2), info.className);
            for (const [index, value] of [
              [4, info.subkeys],
              [5, info.maxSubkey],
              [6, info.maxClass],
              [7, info.values],
              [8, info.maxValueName],
              [9, info.maxValueBytes],
            ])
              if (arg(index!)) this.writeU32(arg(index!), value!);
            writeTime(arg(11), info.modified);
            break;
          }
          case 'ADVAPI32.DLL!RegCloseKey':
            this.registry.close(arg(0));
            break;
        }
        return { eax: 0 };
      } catch (error) {
        if (error instanceof RegistryError) return { eax: error.code };
        if (error instanceof RangeError) return { eax: 87 };
        throw error;
      }
    }
    protected mmioOpen(pathPtr: number): number {
      const path = normalizeGuestPath(this.readCString(pathPtr));
      const bytes = this.files.get(path);
      if (!bytes) return 0;
      const handle = this.nextMmioHandle++;
      this.mmioHandles.set(handle, { path, bytes, position: 0 });
      return handle;
    }
    protected mmioDescend(handle: number, chunkPtr: number, parentPtr: number, flags: number): number {
      const stream = this.mmioHandles.get(handle);
      if (!stream || !chunkPtr) return 5;
      const bytes = stream.bytes;
      let start = Math.max(0, stream.position);
      let end = bytes.length;
      if (parentPtr) {
        const parentId = this.readU32(parentPtr);
        const parentSize = this.readU32(parentPtr + 4);
        const parentData = this.readU32(parentPtr + 12);
        const parentStart = parentData - (parentId === fourCc('RIFF') || parentId === fourCc('LIST') ? 12 : 8);
        start = Math.max(start, parentData);
        end = Math.min(end, parentStart + 8 + parentSize);
      }

      const wantedId = this.readU32(chunkPtr);
      const wantedType = this.readU32(chunkPtr + 8);
      for (let offset = start; offset + 8 <= end; ) {
        const id = readBytesU32(bytes, offset);
        const size = readBytesU32(bytes, offset + 4);
        const list = id === fourCc('RIFF') || id === fourCc('LIST');
        const type = list && offset + 12 <= end ? readBytesU32(bytes, offset + 8) : 0;
        const idMatches =
          (flags & 0x20) !== 0
            ? id === fourCc('RIFF') && (!wantedType || type === wantedType)
            : (flags & 0x40) !== 0
              ? id === fourCc('LIST') && (!wantedType || type === wantedType)
              : (flags & 0x10) !== 0
                ? id === wantedId
                : true;
        if (idMatches) {
          const dataOffset = offset + (list ? 12 : 8);
          this.writeU32(chunkPtr, id);
          this.writeU32(chunkPtr + 4, size);
          this.writeU32(chunkPtr + 8, type);
          this.writeU32(chunkPtr + 12, dataOffset);
          this.writeU32(chunkPtr + 16, 0);
          stream.position = dataOffset;
          return 0;
        }
        const next = offset + 8 + size + (size & 1);
        if (next <= offset || next > end) break;
        offset = next;
      }
      return 257; // MMIOERR_CHUNKNOTFOUND
    }
    protected mmioAscend(handle: number, chunkPtr: number): number {
      const stream = this.mmioHandles.get(handle);
      if (!stream || !chunkPtr) return 5;
      const id = this.readU32(chunkPtr);
      const size = this.readU32(chunkPtr + 4);
      const dataOffset = this.readU32(chunkPtr + 12);
      const headerBytes = id === fourCc('RIFF') || id === fourCc('LIST') ? 12 : 8;
      const start = dataOffset - headerBytes;
      stream.position = Math.min(stream.bytes.length, start + 8 + size + (size & 1));
      return 0;
    }
    protected mmioRead(handle: number, bufferPtr: number, requested: number): number {
      const stream = this.mmioHandles.get(handle);
      if (!stream || !bufferPtr || requested < 0) return -1;
      const count = Math.min(requested, Math.max(0, stream.bytes.length - stream.position));
      this.memory.write_memory(stream.bytes.subarray(stream.position, stream.position + count), bufferPtr);
      stream.position += count;
      return count;
    }
  };
}
