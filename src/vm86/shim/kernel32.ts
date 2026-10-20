import type { FileState, Win32Call, Win32Result } from '../win32';
import type { Constructor } from './state';
import type { ShimGraphicsChain } from './stateGraphics';
import {
  DRIVE_CDROM,
  DRIVE_NO_ROOT_DIR,
  FAST_FILE_ENTRY_BYTES,
  FAST_FILE_HANDLE_BASE,
  FAST_FILE_TABLE,
  FAST_FILE_TABLE_ENTRIES,
  FAST_TLS_ENTRIES,
  FAST_TLS_TABLE,
  FAST_TLS_THREAD_BYTES,
  GUEST_PROCESS_ID,
  shimTraceEnabled,
} from './state';
import {
  GUEST_THREAD_RUN_STATES,
  HYPERCALL_THREAD_COUNT,
  HYPERCALL_THREAD_CURRENT,
  GUEST_THREAD_CONTEXT_ESPS,
  GUEST_THREAD_CONTEXT_LAST_ERROR,
  GUEST_THREAD_CONTEXT_SEH,
  GUEST_THREAD_CONTEXT_STACK_BOTTOM,
  GUEST_THREAD_FPU_CONTEXT_BYTES,
  GUEST_THREAD_FPU_CONTEXTS,
  GUEST_THREAD_CRITICAL_DEPTH,
  GUEST_THREAD_CONTEXT_STACK_TOP,
  GUEST_THREAD_LIMIT,
} from '../pe';
import { normalizeGuestPath } from '../paths';
import { guestFileSearch, type GuestFileEntry } from './fileSearch';

/** Kernel32 Win32 API cases extracted from Win32Shim.dispatch's main switch. */
/** FILETIME counts 100ns intervals since 1601-01-01; this is the match for the 1970-01-01 Unix epoch. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const FILETIME_TICKS_PER_MILLISECOND = 10_000n;

/** GetDateFormatA/GetTimeFormatA flag bits the shim honors; the remaining DATE_/TIME_ flags only affect reading order. */
const DATE_LONGDATE = 0x0000_0002;
const DATE_YEARMONTH = 0x0000_0008;
const TIME_NOMINUTESORSECONDS = 0x0000_0001;
const TIME_NOSECONDS = 0x0000_0002;
const TIME_NOTIMEMARKER = 0x0000_0004;
const TIME_FORCE24HOURFORMAT = 0x0000_0008;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** Invariant-culture names: the shim exposes the Gregorian calendar only, so a requested LCID cannot change these. */
const MONTH_SHORT_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAY_SHORT_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** SYSTEMTIME's eight consecutive WORDs decoded into plain numbers. */
interface SystemTimeFields {
  year: number;
  month: number;
  weekday: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  milliseconds: number;
}

function padNumber(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** CompareStringA/W fold ASCII letters under NORM_IGNORECASE; other units compare by code point. */
export function withKernel32<TBase extends Constructor<ShimGraphicsChain>>(Base: TBase) {
  return class extends Base {
    private dllGetVersionStub = 0;
    private readonly importedModuleHandles = new Map<string, number>();
    private readonly importedProcStubs = new Map<string, number>();
    private wideCommandLine = 0;
    private readonly pointerCookie = crypto.getRandomValues(new Uint32Array(1))[0]! | 1;
    private readonly fileSearchListings = new Map<string, readonly GuestFileEntry[]>();
    private readonly fileSearchHandles = new Map<number, { entries: GuestFileEntry[]; index: number }>();
    private nextFileSearchHandle = 0x6100_0000;

    /** The host supplies directory snapshots without mounting metadata placeholders as empty files; refresh per search to include new saves. */
    setFileSearchResults(pattern: string, entries: readonly GuestFileEntry[]): void {
      this.fileSearchListings.set(
        normalizeGuestPath(pattern),
        entries.map((entry) => ({ ...entry })),
      );
    }

    private writeFindData(address: number, entry: GuestFileEntry): void {
      this.zero(address, 320); // WIN32_FIND_DATAA: cFileName begins at offset 44.
      this.writeU32(address, entry.directory ? 0x10 : 0x20);
      const path = normalizeGuestPath(entry.path);
      const times = this.fileTimes.get(path);
      const written = this.guestFileTimeOverrides.has(path) ? times?.written : (entry.lastWriteTime ?? times?.written);
      for (const [offset, time] of [
        [4, times?.created],
        [12, times?.accessed],
        [20, written],
      ] as const) {
        this.writeU32(address + offset, Number((time ?? 0n) & 0xffff_ffffn));
        this.writeU32(address + offset + 4, Number((time ?? 0n) >> 32n));
      }
      this.writeU32(address + 28, Math.floor(entry.size / 0x1_0000_0000));
      this.writeU32(address + 32, entry.size >>> 0);
      const name = entry.path.replace(/\\/g, '/').split('/').at(-1)!;
      // Native A interfaces preserve single-byte filenames; game add-ons and saves use ASCII names.
      this.memory.write_memory(
        Uint8Array.from(name.slice(0, 259), (c) => c.charCodeAt(0) & 0xff),
        address + 44,
      );
    }
    constructor(...args: any[]) {
      super(...args);
    }

    dispatchKernel32(call: Win32Call, key: string, name: string, a: number[]): Win32Result | null {
      switch (key) {
        case 'KERNEL32.DLL!IsProcessorFeaturePresent':
          // Boot enables SSE; both scheduler paths preserve XMM/MXCSR state.
          return { eax: a[0] === 2 || a[0] === 6 || a[0] === 8 || a[0] === 10 ? 1 : 0 };
        case 'KERNEL32.DLL!EncodePointer':
        case 'KERNEL32.DLL!DecodePointer':
          return { eax: ((a[0] ?? 0) ^ this.pointerCookie) >>> 0 };
        case 'KERNEL32.DLL!InitializeSListHead':
          this.zero(a[0] ?? 0, 8);
          return { eax: 0 };
        case 'KERNEL32.DLL!InterlockedFlushSList': {
          // Dispatch is synchronous while the single guest CPU is suspended.
          const head = a[0] ?? 0;
          const first = this.readU32(head);
          this.writeU32(head, 0);
          this.writeU32(head + 4, this.readU32(head + 4) & 0xffff0000);
          return { eax: first };
        }
        case 'KERNEL32.DLL!GetProcessHeap':
          // The current allocator exposes a single process heap.
          return { eax: 0x10001 };
        case 'KERNEL32.DLL!VirtualProtect': {
          // This flat, non-paged guest already maps accessible RAM as RWX.
          // Honoring stricter permissions requires paging and must not be faked.
          const [address = 0, size = 0, protection = 0, previous = 0] = a;
          if (!address || !size || !previous || address + size > 0xffffffff) {
            this.lastError = 87;
            return { eax: 0 };
          }
          if (protection !== 0x40) {
            this.lastError = 50;
            return { eax: 0 };
          }
          try {
            if (
              this.memory.read_memory(address, 1).length !== 1 ||
              this.memory.read_memory(address + size - 1, 1).length !== 1
            )
              throw new Error('Unmapped address');
            this.writeU32(previous, 0x40);
            return { eax: 1 };
          } catch {
            this.lastError = 487;
            return { eax: 0 };
          }
        }
        case 'KERNEL32.DLL!IsDebuggerPresent': {
          // Report guest debugger relationships; host diagnostics alone do not attach one.
          const context = this.options.processContext;
          return { eax: context?.kernel.isDebugged(context.pid) ? 1 : 0 };
        }
        case 'KERNEL32.DLL!GetSystemTimeAsFileTime': {
          const ticks = BigInt(Math.trunc(this.clock.wallNow())) * FILETIME_TICKS_PER_MILLISECOND + FILETIME_UNIX_EPOCH;
          this.writeFileTimeValue(a[0] ?? 0, ticks);
          return { eax: 0 };
        }
        case 'KERNEL32.DLL!HeapCreate':
          return { eax: 0x10001 };
        case 'KERNEL32.DLL!HeapDestroy':
          return { eax: 1 };
        case 'KERNEL32.DLL!HeapAlloc':
          return { eax: this.alloc(a[2] ?? 0, ((a[1] ?? 0) & 8) !== 0) };
        case 'KERNEL32.DLL!HeapReAlloc':
          return { eax: this.realloc(a[2] ?? 0, a[3] ?? 0, ((a[1] ?? 0) & 8) !== 0) };
        case 'KERNEL32.DLL!HeapFree':
          return { eax: this.freeAllocation(a[2] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!HeapSize': {
          const size = this.allocations.get(a[2] ?? 0);
          if (size === undefined) {
            this.lastError = 87; // ERROR_INVALID_PARAMETER
            return { eax: 0xffff_ffff }; // (SIZE_T)-1
          }
          return { eax: size };
        }
        case 'KERNEL32.DLL!GlobalAlloc':
          return { eax: this.alloc(a[1] ?? 0, ((a[0] ?? 0) & 0x40) !== 0) };
        case 'KERNEL32.DLL!GlobalFree':
          return { eax: this.freeAllocation(a[0] ?? 0) ? 0 : (a[0] ?? 0) };
        case 'KERNEL32.DLL!GlobalLock':
        case 'KERNEL32.DLL!GlobalHandle':
          return { eax: a[0] ?? 0 };
        case 'KERNEL32.DLL!GlobalUnlock':
          return { eax: 1 };
        case 'KERNEL32.DLL!GlobalMemoryStatus': {
          const status = a[0] ?? 0;
          if (status) {
            this.zero(status, 32);
            this.writeU32(status, 32);
            this.writeU32(status + 4, 25); // dwMemoryLoad
            this.writeU32(status + 8, 256 * 1024 * 1024);
            this.writeU32(status + 12, 192 * 1024 * 1024);
            this.writeU32(status + 16, 512 * 1024 * 1024);
            this.writeU32(status + 20, 384 * 1024 * 1024);
            this.writeU32(status + 24, 0x7fff_ffff);
            this.writeU32(status + 28, 0x7000_0000);
          }
          return { eax: 0 };
        }
        case 'KERNEL32.DLL!VirtualAlloc':
          return { eax: this.virtualAlloc(a[0] ?? 0, a[1] ?? 0) };
        case 'KERNEL32.DLL!VirtualFree':
          return { eax: this.virtualFree(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!GetVersion':
          // Windows 98 4.10; a set high bit denotes Win9x, matching the game's 2001 environment.
          return { eax: 0x8000_0a04 };
        case 'KERNEL32.DLL!GetVersionExA': {
          const info = a[0] ?? 0;
          if (!info) return { eax: 0 };
          const size = this.readU32(info);
          if (size < 148) return { eax: 0 };
          this.zero(info, Math.min(size, 156));
          this.writeU32(info, size);
          this.writeU32(info + 4, 4); // Windows 98: major 4
          this.writeU32(info + 8, 10);
          this.writeU32(info + 12, 2222);
          this.writeU32(info + 16, 1); // VER_PLATFORM_WIN32_WINDOWS
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetTickCount':
          return { eax: this.clock.now() >>> 0 };
        case 'KERNEL32.DLL!QueryPerformanceFrequency':
          // Share the unified guest millisecond clock: 1 tick = 1ms.
          if (a[0]) {
            this.writeU32(a[0], 1000);
            this.writeU32(a[0] + 4, 0);
          }
          return { eax: 1 };
        case 'KERNEL32.DLL!QueryPerformanceCounter': {
          const value = BigInt(Math.max(0, Math.floor(this.clock.now())));
          if (a[0]) {
            this.writeU32(a[0], Number(value & 0xffff_ffffn));
            this.writeU32(a[0] + 4, Number(value >> 32n));
          }
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetDriveTypeA':
          return { eax: this.getDriveType(a[0] ?? 0) };
        case 'KERNEL32.DLL!GetLogicalDriveStringsA': {
          const drives =
            [...this.driveTypes.keys()]
              .sort()
              .map((letter) => `${letter}:\\\0`)
              .join('') + '\0';
          const required = drives.length - 1;
          if ((a[0] ?? 0) >= required && a[1]) {
            this.memory.write_memory(new TextEncoder().encode(drives), a[1]);
          }
          return { eax: required };
        }
        case 'KERNEL32.DLL!GetDiskFreeSpaceA': {
          const cdrom = this.getDriveType(a[0] ?? 0) === DRIVE_CDROM;
          // Read-only CD-ROMs have no writable clusters. RA2 then queries volume label/serial;
          // pretending the CD drive is a hard disk with free space enters native AutoDet copy-protection handling.
          if (a[1]) this.writeU32(a[1], cdrom ? 1 : 8); // sectors / cluster
          if (a[2]) this.writeU32(a[2], cdrom ? 2048 : 512);
          if (a[3]) this.writeU32(a[3], cdrom ? 0 : 0x0010_0000);
          if (a[4]) this.writeU32(a[4], cdrom ? 300_000 : 0x0020_0000);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetVolumeInformationA': {
          const cdrom = this.getDriveType(a[0] ?? 0) === DRIVE_CDROM;
          const writeString = (pointer: number, capacity: number, value: string) => {
            if (!pointer || capacity <= 0) return;
            const bytes = new TextEncoder().encode(value.slice(0, Math.max(0, capacity - 1)));
            this.memory.write_memory(Uint8Array.from([...bytes, 0]), pointer);
          };
          writeString(a[1] ?? 0, a[2] ?? 0, cdrom ? (this.gameProfile.cdromVolumeLabel ?? 'CDROM') : 'GAME');
          if (a[3]) this.writeU32(a[3], (this.options.volumeSerial ?? 0x2001_0701) >>> 0);
          if (a[4]) this.writeU32(a[4], 255);
          if (a[5]) this.writeU32(a[5], 0);
          writeString(a[6] ?? 0, a[7] ?? 0, cdrom ? 'CDFS' : 'FAT32');
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!SetCurrentDirectoryA': {
          const path = this.readCString(a[0] ?? 0);
          if (!path) return { eax: 0 };
          this.currentDirectory = path.replace(/[\\/]+$/, '') || 'C:\\';
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!CreateDirectoryA':
        case 'KERNEL32.DLL!CreateDirectoryW': {
          if (!a[0] || a[1]) {
            this.lastError = a[1] ? 50 : 87;
            return { eax: 0 };
          }
          const raw = name.endsWith('W')
            ? String.fromCharCode(...this.readWideUnits(a[0], -1).filter((unit) => unit !== 0))
            : this.readCString(a[0]);
          const path = normalizeGuestPath(raw);
          if (!raw || this.files.has(path) || this.sharedFileMirrors.has(path) || this.isVirtualDirectory(path)) {
            this.lastError = raw ? 183 : 123;
            return { eax: 0 };
          }
          const slash = path.lastIndexOf('/');
          if (slash >= 0 && !this.isVirtualDirectory(path.slice(0, slash))) {
            this.lastError = 3;
            return { eax: 0 };
          }
          this.createdDirectories.add(path);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetCurrentDirectoryW': {
          const required = this.currentDirectory.length;
          const capacity = a[0] ?? 0;
          if (a[1] && capacity > required) this.writeUtf16String(a[1], this.currentDirectory);
          return { eax: capacity > required ? required : required + 1 };
        }
        case 'KERNEL32.DLL!GetCurrentDirectoryA': {
          const required = this.currentDirectory.length;
          const capacity = a[0] ?? 0;
          if (a[1] && capacity > required) this.writeAscii(a[1], this.currentDirectory);
          return { eax: capacity > required ? required : required + 1 };
        }
        case 'KERNEL32.DLL!GetComputerNameA': {
          const name = 'BROWSER-PC';
          const capacity = a[1] ? this.readU32(a[1]) : 0;
          if (capacity <= name.length) {
            if (a[1]) this.writeU32(a[1], name.length + 1);
            return { eax: 0 };
          }
          if (a[0]) this.writeAscii(a[0], name);
          if (a[1]) this.writeU32(a[1], name.length);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetSystemTime':
          this.writeSystemTime(a[0] ?? 0, false);
          return { eax: 0 };
        case 'KERNEL32.DLL!GetLocalTime':
          // SYSTEMTIME contains eight consecutive WORDs. Use the host's local timezone: RA2 calls
          // this during homepage initialization, so UTC GetSystemTime semantics are incorrect.
          this.writeSystemTime(a[0] ?? 0, true);
          return { eax: 0 };
        case 'KERNEL32.DLL!SystemTimeToFileTime':
          return { eax: this.systemTimeToFileTime(a[0] ?? 0, a[1] ?? 0) ? 1 : 0 };
        // Saving a game walks the whole FILETIME family: FileTimeToLocalFileTime and CompareFileTime
        // are reached on different hosts, and the DOS conversions follow when the save list refreshes.
        case 'KERNEL32.DLL!FileTimeToSystemTime':
          return { eax: this.fileTimeToSystemTime(a[0] ?? 0, a[1] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!FileTimeToLocalFileTime':
          return { eax: this.fileTimeToLocalFileTime(a[0] ?? 0, a[1] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!CompareFileTime':
          return { eax: this.compareFileTime(a[0] ?? 0, a[1] ?? 0) };
        case 'KERNEL32.DLL!FileTimeToDosDateTime':
          return { eax: this.fileTimeToDosDateTime(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!DosDateTimeToFileTime':
          return { eax: this.dosDateTimeToFileTime(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!GetFileTime':
          return { eax: this.getFileTime(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!SetFileTime':
          return { eax: this.setFileTime(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!GetFileInformationByHandle':
          return { eax: this.getFileInformationByHandle(a[0] ?? 0, a[1] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!GetTimeZoneInformation': {
          const info = a[0] ?? 0;
          if (!info) {
            this.lastError = 87; // ERROR_INVALID_PARAMETER
            return { eax: 0xffff_ffff }; // TIME_ZONE_ID_INVALID
          }
          // TIME_ZONE_INFORMATION is 172 bytes. JavaScript provides no Windows-style
          // SYSTEMTIME daylight-saving transition table, so report valid TIME_ZONE_ID_UNKNOWN
          // and write the current host offset into Bias, whose sign matches getTimezoneOffset:
          // UTC = local + Bias。
          this.zero(info, 172);
          this.writeU32(info, new Date(this.clock.wallNow()).getTimezoneOffset() | 0);
          this.lastError = 0;
          return { eax: 0 }; // TIME_ZONE_ID_UNKNOWN
        }
        // The save-game screen labels its slots through the locale date/time APIs. a[0] is the LCID, which
        // the shim ignores because it carries a single (invariant) calendar; a[1] holds the DATE_/TIME_ flags.
        case 'KERNEL32.DLL!GetDateFormatA':
          return { eax: this.getDateFormatA(a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, (a[5] ?? 0) | 0) };
        case 'KERNEL32.DLL!GetTimeFormatA':
          return { eax: this.getTimeFormatA(a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, (a[5] ?? 0) | 0) };
        case 'KERNEL32.DLL!CreateFileA':
          return { eax: this.openFile(a) };
        case 'KERNEL32.DLL!CreateFileW':
          return {
            eax: this.openFile(
              a,
              this.readWideUnits(a[0] ?? 0, -1)
                .filter((unit) => unit !== 0)
                .map((unit) => String.fromCharCode(unit))
                .join(''),
            ),
          };
        case 'KERNEL32.DLL!FindFirstFileA': {
          if (!a[0] || !a[1]) {
            this.lastError = 87;
            return { eax: 0xffff_ffff };
          }
          const search = guestFileSearch(this.readCString(a[0]));
          const entries = new Map<string, GuestFileEntry>();
          for (const entry of this.fileSearchListings.get(search.normalized) ?? []) {
            entries.set(normalizeGuestPath(entry.path), entry);
          }
          // After large read-only archives are mirrored into the guest, release their JS snapshots but retain enumerable file existence.
          for (const [path, mirror] of this.sharedFileMirrors) {
            entries.set(path, { path, size: mirror.size });
          }
          // Files created/modified synchronously override provider metadata; searches already in progress keep independent snapshots.
          for (const [path, bytes] of this.files) {
            entries.set(path, { path, size: this.fileLogicalSizes.get(path) ?? bytes.length });
          }
          for (const path of this.createdDirectories) entries.set(path, { path, size: 0, directory: true });
          const matched = [...entries.values()]
            .filter((entry) => {
              const path = normalizeGuestPath(entry.path);
              const slash = path.lastIndexOf('/');
              return (
                (slash < 0 ? '' : path.slice(0, slash)) === search.directory && search.matches(path.slice(slash + 1))
              );
            })
            .sort((a, b) => normalizeGuestPath(a.path).localeCompare(normalizeGuestPath(b.path)));
          if (!matched.length) {
            this.lastError = 2;
            return { eax: 0xffff_ffff };
          }
          const handle = this.nextFileSearchHandle++;
          this.fileSearchHandles.set(handle, { entries: matched, index: 0 });
          this.writeFindData(a[1], matched[0]!);
          this.lastError = 0;
          return { eax: handle };
        }
        case 'KERNEL32.DLL!FindNextFileA': {
          const search = this.fileSearchHandles.get(a[0] ?? 0);
          if (!search) {
            this.lastError = 6;
            return { eax: 0 };
          }
          if (!a[1]) {
            this.lastError = 87;
            return { eax: 0 };
          }
          const entry = search.entries[search.index + 1];
          if (!entry) {
            this.lastError = 18;
            return { eax: 0 };
          }
          search.index++;
          this.writeFindData(a[1], entry);
          this.lastError = 0;
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!FindClose': {
          const closed = this.fileSearchHandles.delete(a[0] ?? 0);
          this.lastError = closed ? 0 : 6;
          return { eax: closed ? 1 : 0 };
        }
        case 'KERNEL32.DLL!FindResourceA': {
          const resource = this.findPeResource(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
          if (!resource) {
            this.lastError = 1813; // ERROR_RESOURCE_TYPE_NOT_FOUND
            return { eax: 0 };
          }
          this.loadedResources.set(resource.handle, resource);
          this.lastError = 0;
          return { eax: resource.handle };
        }
        case 'KERNEL32.DLL!LoadResource': {
          const handle = a[1] ?? 0;
          if (!this.loadedResources.has(handle)) {
            this.lastError = 1812; // ERROR_RESOURCE_DATA_NOT_FOUND
            return { eax: 0 };
          }
          return { eax: handle };
        }
        case 'KERNEL32.DLL!LockResource':
          return { eax: this.loadedResources.get(a[0] ?? 0)?.data ?? 0 };
        case 'KERNEL32.DLL!ReadFile':
          return { eax: this.readFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) >= 0 ? 1 : 0 };
        case 'KERNEL32.DLL!GetFileSizeEx': {
          const file = this.fileHandles.get(a[0] ?? 0);
          if (!file || !a[1]) {
            this.lastError = file ? 87 : 6;
            return { eax: 0 };
          }
          const size = BigInt(file.size);
          this.writeU32(a[1], Number(size & 0xffff_ffffn));
          this.writeU32(a[1] + 4, Number(size >> 32n));
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetFileSize': {
          const file = this.fileHandles.get(a[0] ?? 0);
          if (!file) return { eax: 0xffff_ffff };
          if (a[1]) this.writeU32(a[1], 0);
          return { eax: file.size >>> 0 };
        }
        case 'KERNEL32.DLL!SetFilePointer':
          return { eax: this.seekFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) };
        case 'KERNEL32.DLL!SetFilePointerEx': {
          const handle = a[0] ?? 0;
          const file = this.fileHandles.get(handle);
          if (!file) {
            this.lastError = 6;
            return { eax: 0 };
          }
          const origin = a[4] ?? 0;
          if (origin > 2 || origin < 0) {
            this.lastError = 87;
            return { eax: 0 };
          }
          this.pullFastFilePosition(handle, file);
          // LARGE_INTEGER is passed by value as two stack words on x86.
          const distance = (BigInt((a[2] ?? 0) | 0) << 32n) + BigInt((a[1] ?? 0) >>> 0);
          const position = BigInt(origin === 1 ? file.position : origin === 2 ? file.size : 0) + distance;
          if (position < 0n || position > 0xffff_ffffn) {
            // Fast-file descriptors currently represent positions with one DWORD.
            this.lastError = position < 0n ? 131 : 87;
            return { eax: 0 };
          }
          file.position = Number(position);
          this.pushFastFilePosition(handle, file);
          if (a[3]) {
            this.writeU32(a[3], Number(position));
            this.writeU32(a[3] + 4, 0);
          }
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!SetEndOfFile': {
          const file = this.fileHandles.get(a[0] ?? 0);
          if (!file || !file.writable) return { eax: 0 };
          this.demoteFileMirror(a[0] ?? 0, file);
          file.size = file.position;
          this.storeFile(file.path, file.bytes.subarray(0, file.size));
          file.dirty = true;
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!_lopen':
          return { eax: this.openLegacyFile(a[0] ?? 0, false, a[1] ?? 0) };
        case 'KERNEL32.DLL!_lcreat':
          return { eax: this.openLegacyFile(a[0] ?? 0, true) };
        case 'KERNEL32.DLL!_lread':
          return { eax: this.readFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, 0) };
        case 'KERNEL32.DLL!_lwrite':
          return { eax: this.writeFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, 0) };
        case 'KERNEL32.DLL!_llseek':
          return { eax: this.seekFile(a[0] ?? 0, a[1] ?? 0, 0, a[2] ?? 0) };
        case 'KERNEL32.DLL!_lclose':
          return { eax: this.closeFile(a[0] ?? 0) ? 0 : 0xffff_ffff };
        case 'KERNEL32.DLL!GetModuleHandleExW': {
          // Address lookup with unchanged reference count, used by native exception machinery.
          if (a[0] !== 6 || !a[2]) {
            this.lastError = a[2] ? 50 : 87;
            return { eax: 0 };
          }
          const address = a[1] ?? 0;
          let handle = [...this.loadedGuestDlls.values()].find(
            (module) => address >= module.base && address < module.base + module.size,
          )?.base;
          const pe = this.readU32(0x40003c);
          const mainSize = this.readU32(0x400000 + pe + 24 + 56);
          if (address >= 0x400000 && address < 0x400000 + mainSize) handle = 0x400000;
          if (handle === undefined) {
            this.lastError = 126;
            return { eax: 0 };
          }
          this.writeU32(a[2]!, handle);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetModuleHandleA':
        case 'KERNEL32.DLL!GetModuleHandleW': {
          const pointer = a[0] ?? 0;
          if (!pointer) return { eax: 0x0040_0000 };
          const name = call.imported.name.endsWith('W')
            ? String.fromCharCode(...this.readWideUnits(pointer, -1).filter((unit) => unit !== 0))
            : this.readCString(pointer);
          const basename = (value: string) => value.replace(/^.*[\\/]/, '').toLowerCase();
          const wanted = basename(name);
          if (wanted === basename(this.moduleName)) return { eax: 0x0040_0000 };
          // A query must not load a DLL or substitute the main image for an absent module.
          const module = this.loadedGuestDlls.get(normalizeGuestPath(name));
          if (module) return { eax: module.base };
          const imported = this.staticImports.find((item) => basename(item.dll) === wanted);
          if (imported) {
            const dll = imported.dll.toUpperCase();
            let handle = this.importedModuleHandles.get(dll);
            if (handle === undefined) {
              handle = 0x70000000 + this.importedModuleHandles.size * 0x10000;
              this.importedModuleHandles.set(dll, handle);
            }
            return { eax: handle };
          }
          this.lastError = 126; // ERROR_MOD_NOT_FOUND
          return { eax: 0 };
        }
        case 'KERNEL32.DLL!LoadLibraryA':
          return this.loadLibrary(call, a[0] ?? 0);
        case 'KERNEL32.DLL!LoadLibraryExW': {
          if (a[1] || ((a[2] ?? 0) & ~0x800) !== 0) {
            this.lastError = 87;
            return { eax: 0 };
          }
          const name = this.readWideUnits(a[0] ?? 0, -1)
            .filter((unit) => unit !== 0)
            .map((unit) => String.fromCharCode(unit))
            .join('');
          if (!this.files.has(normalizeGuestPath(name))) {
            this.lastError = 126;
            return { eax: 0 };
          }
          return this.loadLibrary(call, 0, name);
        }
        case 'KERNEL32.DLL!FreeLibrary':
          return { eax: 1 };
        case 'KERNEL32.DLL!GetProcAddress':
          return { eax: this.getGuestProcAddress(a[0] ?? 0, a[1] ?? 0) };
        case 'KERNEL32.DLL!GetCommandLineA':
          return { eax: this.commandLine };
        case 'KERNEL32.DLL!GetCommandLineW': {
          if (!this.wideCommandLine) {
            const text = this.readCString(this.commandLine);
            const pointer = this.alloc((text.length + 1) * 2, true);
            if (!pointer) return { eax: 0 };
            this.writeUtf16String(pointer, text);
            this.wideCommandLine = pointer;
          }
          return { eax: this.wideCommandLine };
        }
        case 'KERNEL32.DLL!GetModuleFileNameA': {
          const max = a[2] ?? 0;
          const bytes = this.readBytes(this.modulePath, 260);
          const length = Math.min(bytes.indexOf(0), Math.max(0, max - 1));
          if (a[1] && max > 0) this.memory.write_memory(bytes.subarray(0, length + 1), a[1]);
          return { eax: length };
        }
        case 'KERNEL32.DLL!GetModuleFileNameW': {
          const handle = a[0] ?? 0;
          const module = this.guestDllByHandle(handle);
          const text = handle === 0 || handle === 0x400000 ? this.readCString(this.modulePath) : module?.name;
          if (text === undefined) {
            this.lastError = 6;
            return { eax: 0 };
          }
          const capacity = a[2] ?? 0;
          if (!a[1] || capacity <= 0) {
            this.lastError = 122;
            return { eax: 0 };
          }
          this.writeUtf16String(a[1], text.slice(0, capacity - 1));
          if (text.length >= capacity) {
            this.lastError = 122;
            return { eax: capacity };
          }
          return { eax: text.length };
        }
        case 'KERNEL32.DLL!GetStartupInfoW':
        case 'KERNEL32.DLL!GetStartupInfoA':
          if (a[0]) {
            this.zero(a[0], 68);
            this.writeU32(a[0], 68);
          }
          return { eax: 0 };
        case 'KERNEL32.DLL!GetACP':
        case 'KERNEL32.DLL!GetOEMCP':
          return { eax: 950 }; // Big5
        case 'KERNEL32.DLL!GetCPInfo':
          if (a[1]) {
            this.zero(a[1], 20);
            this.writeU32(a[1], 2); // MaxCharSize
            this.memory.write_memory([0x3f, 0x00], a[1] + 4);
            this.memory.write_memory([0x81, 0xfe, 0, 0], a[1] + 6);
          }
          return { eax: 1 };
        case 'KERNEL32.DLL!GetEnvironmentStrings':
          return { eax: this.environmentA };
        case 'KERNEL32.DLL!GetEnvironmentStringsW':
          return { eax: this.environmentW };
        case 'KERNEL32.DLL!GetEnvironmentVariableA': {
          const name = this.readCString(a[0] ?? 0).toLowerCase();
          const values: Record<string, string> = {
            windir: 'C:\\WINDOWS',
            systemroot: 'C:\\WINDOWS',
            temp: 'C:\\WINDOWS\\TEMP',
            tmp: 'C:\\WINDOWS\\TEMP',
          };
          const value = values[name];
          if (value === undefined) {
            this.lastError = 203; // ERROR_ENVVAR_NOT_FOUND
            return { eax: 0 };
          }
          const capacity = a[2] ?? 0;
          if (capacity <= value.length) return { eax: value.length + 1 };
          if (a[1]) this.writeAscii(a[1], value);
          this.lastError = 0;
          return { eax: value.length };
        }
        case 'KERNEL32.DLL!SetErrorMode':
          return { eax: 0 };
        case 'KERNEL32.DLL!GetSystemDirectoryA':
        case 'KERNEL32.DLL!GetWindowsDirectoryA': {
          const value = key.endsWith('GetSystemDirectoryA') ? 'C:\\WINDOWS\\SYSTEM' : 'C:\\WINDOWS';
          const capacity = a[1] ?? 0;
          if (capacity <= value.length) return { eax: value.length + 1 };
          if (a[0]) this.writeAscii(a[0], value);
          return { eax: value.length };
        }
        case 'KERNEL32.DLL!FreeEnvironmentStringsA':
        case 'KERNEL32.DLL!FreeEnvironmentStringsW':
          return { eax: 1 };
        case 'KERNEL32.DLL!GetLastError':
          return { eax: this.lastError };
        case 'KERNEL32.DLL!SetLastError':
          this.lastError = a[0] ?? 0;
          return { eax: 0 };
        case 'KERNEL32.DLL!TlsAlloc': {
          const id = this.nextTls++;
          this.tls.set(id, 0);
          const thread = this.readU32(0x0006_0068);
          if (id < FAST_TLS_ENTRIES) this.writeU32(FAST_TLS_TABLE + thread * 256 + id * 4, 0);
          return { eax: id };
        }
        case 'KERNEL32.DLL!TlsFree':
          return { eax: this.tls.delete(a[0] ?? -1) ? 1 : 0 };
        case 'KERNEL32.DLL!TlsSetValue':
          this.tls.set(a[0] ?? 0, a[1] ?? 0);
          if ((a[0] ?? FAST_TLS_ENTRIES) < FAST_TLS_ENTRIES) {
            const thread = this.readU32(0x0006_0068);
            this.writeU32(FAST_TLS_TABLE + thread * 256 + (a[0] ?? 0) * 4, a[1] ?? 0);
          }
          return { eax: 1 };
        case 'KERNEL32.DLL!TlsGetValue':
          return {
            eax:
              (a[0] ?? FAST_TLS_ENTRIES) < FAST_TLS_ENTRIES
                ? this.readU32(FAST_TLS_TABLE + this.readU32(0x0006_0068) * 256 + (a[0] ?? 0) * 4)
                : (this.tls.get(a[0] ?? 0) ?? 0),
          };
        case 'KERNEL32.DLL!InitializeCriticalSectionAndSpinCount':
          if (!a[0]) {
            this.lastError = 87;
            return { eax: 0 };
          }
          // A single guest CPU cannot make progress by spinning; retain the
          // scheduler-backed ownership/wait semantics of InitializeCriticalSection.
          this.initializeCriticalSection(a[0]);
          return { eax: 1 };
        case 'KERNEL32.DLL!InitializeCriticalSection':
          if (a[0]) this.initializeCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!DeleteCriticalSection':
          if (a[0]) this.deleteCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!EnterCriticalSection':
          if (a[0]) this.enterCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!LeaveCriticalSection':
          if (a[0]) this.leaveCriticalSection(a[0]);
          return { eax: 0 };
        case 'KERNEL32.DLL!InterlockedIncrement': {
          const value = (this.readU32(a[0] ?? 0) + 1) >>> 0;
          this.writeU32(a[0] ?? 0, value);
          return { eax: value };
        }
        case 'KERNEL32.DLL!InterlockedDecrement': {
          const value = (this.readU32(a[0] ?? 0) - 1) >>> 0;
          this.writeU32(a[0] ?? 0, value);
          return { eax: value };
        }
        case 'KERNEL32.DLL!IsBadCodePtr':
        case 'KERNEL32.DLL!IsBadReadPtr':
        case 'KERNEL32.DLL!IsBadWritePtr':
          return { eax: 0 };
        case 'KERNEL32.DLL!SetUnhandledExceptionFilter':
          return { eax: 0 };
        // Default filter: delegate to the nearest __except with EXCEPTION_EXECUTE_HANDLER, matching Win32 defaults.
        case 'KERNEL32.DLL!UnhandledExceptionFilter':
          return { eax: 1 };
        // Relative guest milliseconds sharing the clock used by multimedia timers and message timestamps.
        case 'KERNEL32.DLL!WideCharToMultiByte': {
          const source = this.readWideUnits(a[2] ?? 0, (a[3] ?? 0) | 0);
          const out = new Uint8Array(source.length);
          for (let i = 0; i < source.length; i++) out[i] = source[i]! <= 0xff ? source[i]! : 0x3f;
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) this.memory.write_memory(out.subarray(0, capacity), a[4]);
          if (a[7]) this.memory.write_memory([0], a[7]);
          return { eax: out.length };
        }
        case 'KERNEL32.DLL!MultiByteToWideChar': {
          const source = this.readNarrowBytes(a[2] ?? 0, (a[3] ?? 0) | 0);
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) {
            const count = Math.min(source.length, capacity);
            const out = new Uint8Array(count * 2);
            for (let i = 0; i < count; i++) out[i * 2] = source[i]!;
            this.memory.write_memory(out, a[4]);
          }
          return { eax: source.length };
        }
        case 'KERNEL32.DLL!GetStringTypeW': {
          const source = this.readWideUnits(a[1] ?? 0, (a[2] ?? 0) | 0);
          this.writeCharTypes(a[3] ?? 0, source);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!GetStringTypeA': {
          const source = this.readNarrowBytes(a[2] ?? 0, (a[3] ?? 0) | 0);
          this.writeCharTypes(a[4] ?? 0, [...source]);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!LCMapStringW': {
          const flags = a[1] ?? 0;
          const source = this.readWideUnits(a[2] ?? 0, (a[3] ?? 0) | 0);
          const mapped = source.map((c) => this.mapAsciiCase(c, flags));
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) {
            const count = Math.min(mapped.length, capacity);
            const out = new Uint8Array(count * 2);
            for (let i = 0; i < count; i++) {
              out[i * 2] = mapped[i]! & 0xff;
              out[i * 2 + 1] = mapped[i]! >>> 8;
            }
            this.memory.write_memory(out, a[4]);
          }
          return { eax: mapped.length };
        }
        case 'KERNEL32.DLL!LCMapStringA': {
          const flags = a[1] ?? 0;
          const source = this.readNarrowBytes(a[2] ?? 0, (a[3] ?? 0) | 0);
          const mapped = Uint8Array.from(source, (c) => this.mapAsciiCase(c, flags));
          const capacity = a[5] ?? 0;
          if (a[4] && capacity > 0) this.memory.write_memory(mapped.subarray(0, capacity), a[4]);
          return { eax: mapped.length };
        }
        case 'KERNEL32.DLL!GetCurrentThreadId':
          return { eax: this.readU32(HYPERCALL_THREAD_CURRENT) + 1 };
        case 'KERNEL32.DLL!GetCurrentThread':
          return { eax: 0xffff_fffe };
        case 'KERNEL32.DLL!GetCurrentProcess':
          return { eax: 0xffff_ffff };
        case 'KERNEL32.DLL!SetProcessAffinityMask':
          // The VM exposes one processor. Only the current process and CPU 0 exist.
          if (a[0] !== 0xffff_ffff || a[1] !== 1) {
            this.lastError = a[0] !== 0xffff_ffff ? 6 : 87;
            return { eax: 0 };
          }
          return { eax: 1 };
        case 'KERNEL32.DLL!GetCurrentProcessId':
          return { eax: GUEST_PROCESS_ID };
        case 'KERNEL32.DLL!GetUserDefaultLCID':
          return { eax: 0x0404 }; // zh-TW
        case 'KERNEL32.DLL!IsValidCodePage':
        case 'KERNEL32.DLL!IsValidLocale':
        case 'KERNEL32.DLL!SetConsoleCtrlHandler':
        case 'KERNEL32.DLL!SetEnvironmentVariableA':
          return { eax: 1 };
        case 'KERNEL32.DLL!GetStdHandle':
          return { eax: 0x10010 + ((a[0] ?? 0) & 3) };
        case 'KERNEL32.DLL!SetStdHandle':
          return { eax: 1 };
        case 'KERNEL32.DLL!CloseHandle': {
          const handle = a[0] ?? 0;
          if (!this.closeGuestThreadHandle(handle) && !this.closeGuestSyncHandle(handle)) this.closeFile(handle);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!FlushFileBuffers': {
          const file = this.fileHandles.get(a[0] ?? 0);
          if (!file) return { eax: 0 };
          this.flushFile(file);
          return { eax: 1 };
        }
        case 'KERNEL32.DLL!SetHandleCount':
          return { eax: a[0] ?? 0 };
        case 'KERNEL32.DLL!GetFileType':
          return { eax: this.fileHandles.has(a[0] ?? 0) ? 1 : 2 }; // DISK / CHAR
        case 'KERNEL32.DLL!HeapValidate':
          return { eax: 1 };
        case 'KERNEL32.DLL!DebugBreak':
        case 'KERNEL32.DLL!OutputDebugStringA':
          return { eax: 0 };
        case 'KERNEL32.DLL!CreateMutexA': {
          const name = a[2] ? this.readCString(a[2]) : '';
          return { eax: this.createGuestMutex(!!a[1], name) };
        }
        case 'KERNEL32.DLL!OpenMutexA': {
          const name = a[2] ? this.readCString(a[2]) : '';
          return { eax: this.openGuestMutex(name) };
        }
        case 'KERNEL32.DLL!CreateEventA':
          return { eax: this.createGuestEvent(!!a[1], !!a[2], a[3] ? this.readCString(a[3]) : '') };
        case 'KERNEL32.DLL!OpenEventA': {
          const name = a[2] ? this.readCString(a[2]) : '';
          return { eax: this.openGuestEvent(name) };
        }
        case 'KERNEL32.DLL!MapViewOfFileEx':
        case 'KERNEL32.DLL!UnmapViewOfFile':
          // No mapping objects exist until the generic mapping implementation is available.
          this.lastError = 6; // ERROR_INVALID_HANDLE
          return { eax: 0 };
        case 'KERNEL32.DLL!CreateThread': {
          return { eax: this.createGuestThread(a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0) };
        }
        case 'KERNEL32.DLL!SetThreadPriority':
          return { eax: 1 };
        case 'KERNEL32.DLL!SetEvent':
          return { eax: this.setGuestEvent(a[0] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!ResetEvent':
          return { eax: this.resetGuestEvent(a[0] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!ReleaseMutex':
          return { eax: this.releaseGuestMutex(a[0] ?? 0) ? 1 : 0 };
        case 'KERNEL32.DLL!WaitForSingleObject':
          return { eax: this.waitForGuestObjects([a[0] ?? 0], false, a[1] ?? 0xffff_ffff) };
        case 'KERNEL32.DLL!WaitForMultipleObjects': {
          const count = a[0] ?? 0;
          const pointer = a[1] ?? 0;
          if (!pointer || count < 1 || count > 64) {
            this.lastError = 87; // ERROR_INVALID_PARAMETER
            return { eax: 0xffff_ffff };
          }
          const handles = Array.from({ length: count }, (_, index) => this.readU32(pointer + index * 4));
          return { eax: this.waitForGuestObjects(handles, !!a[2], a[3] ?? 0xffff_ffff) };
        }
        case 'KERNEL32.DLL!WriteFile':
          return { eax: this.writeFile(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0) >= 0 ? 1 : 0 };
        case 'KERNEL32.DLL!lstrlenA':
          // Win32 measures bytes; decoding GBK double-byte characters would reduce the character count,
          // so count raw bytes before NUL directly.
          return { eax: this.narrowStringLength(a[0] ?? 0) };
        case 'KERNEL32.DLL!lstrlenW': {
          let length = 0;
          while (a[0] && this.readU16((a[0] ?? 0) + length * 2)) length++;
          return { eax: length };
        }
        case 'KERNEL32.DLL!lstrcpyA': {
          const value = this.readCString(a[1] ?? 0);
          if (a[0]) this.writeAscii(a[0], value);
          return { eax: a[0] ?? 0 };
        }
        case 'KERNEL32.DLL!lstrcatA': {
          const target = a[0] ?? 0;
          if (target) this.writeAscii(target, this.readCString(target) + this.readCString(a[1] ?? 0));
          return { eax: target };
        }
        case 'KERNEL32.DLL!Sleep':
          return { eax: 0, delayMs: this.clock.toHostDelay(a[0] ?? 0) };
        case 'KERNEL32.DLL!ExitThread':
          return { eax: a[0] ?? 0, threadExit: true };
        case 'KERNEL32.DLL!ExitProcess':
        case 'KERNEL32.DLL!TerminateProcess':
          return { eax: a.at(-1) ?? 0, exit: true };
        default:
          void name;
          return null;
      }
    }

    /** Find type/name/lang resources in a loaded PE image; represent HRSRC by the data-entry address. */
    protected findPeResource(
      requestedModule: number,
      requestedName: number,
      requestedType: number,
    ): { handle: number; module: number; data: number; size: number } | null {
      const module = requestedModule || 0x0040_0000;
      if (this.readU16(module) !== 0x5a4d) return null;
      const pe = module + this.readU32(module + 0x3c);
      if (this.readU32(pe) !== 0x0000_4550) return null;
      const optional = pe + 24;
      if (this.readU16(optional) !== 0x010b) return null; // PE32
      const resourceRva = this.readU32(optional + 112); // data directory[IMAGE_DIRECTORY_ENTRY_RESOURCE]
      const resourceSize = this.readU32(optional + 116);
      if (!resourceRva || resourceSize < 16) return null;
      const root = module + resourceRva;
      const withinResource = (address: number, bytes: number): boolean =>
        address >= root && address + bytes >= address && address + bytes <= root + resourceSize;
      const resourceName = (value: number): { id?: number; text?: string } =>
        value > 0xffff ? { text: this.readCString(value).toLowerCase() } : { id: value & 0xffff };
      const findEntry = (directory: number, wanted: { id?: number; text?: string }): number => {
        if (!withinResource(directory, 16)) return 0;
        const count = this.readU16(directory + 12) + this.readU16(directory + 14);
        for (let index = 0; index < count; index++) {
          const entry = directory + 16 + index * 8;
          if (!withinResource(entry, 8)) return 0;
          const name = this.readU32(entry);
          let matches = false;
          if ((name & 0x8000_0000) !== 0 && wanted.text !== undefined) {
            const stringAddress = root + (name & 0x7fff_ffff);
            if (!withinResource(stringAddress, 2)) continue;
            const length = this.readU16(stringAddress);
            if (!withinResource(stringAddress + 2, length * 2)) continue;
            let text = '';
            for (let i = 0; i < length; i++) text += String.fromCharCode(this.readU16(stringAddress + 2 + i * 2));
            matches = text.toLowerCase() === wanted.text;
          } else if ((name & 0x8000_0000) === 0 && wanted.id !== undefined) {
            matches = (name & 0xffff) === wanted.id;
          }
          if (matches) return this.readU32(entry + 4);
        }
        return 0;
      };
      const descend = (offset: number): number => {
        if ((offset & 0x8000_0000) === 0) return 0;
        const address = root + (offset & 0x7fff_ffff);
        return withinResource(address, 16) ? address : 0;
      };
      const typeDirectory = descend(findEntry(root, resourceName(requestedType)));
      const nameDirectory = typeDirectory && descend(findEntry(typeDirectory, resourceName(requestedName)));
      if (!nameDirectory || !withinResource(nameDirectory, 16)) return null;
      const languageCount = this.readU16(nameDirectory + 12) + this.readU16(nameDirectory + 14);
      if (!languageCount) return null;
      const languageEntry = nameDirectory + 16;
      if (!withinResource(languageEntry, 8)) return null;
      const dataOffset = this.readU32(languageEntry + 4);
      if ((dataOffset & 0x8000_0000) !== 0) return null;
      const handle = root + dataOffset;
      if (!withinResource(handle, 16)) return null;
      const data = module + this.readU32(handle);
      const size = this.readU32(handle + 4);
      if (data < module || data + size < data) return null;
      return { handle, module, data, size };
    }

    /** LoadCursorA decodes cursor resources to RGBA and returns HCURSOR, reused by module:id. */
    protected loadCursorImage(module: number, cursorId: number): number {
      const key = `${module >>> 0}:${cursorId >>> 0}`;
      const existing = this.cursorHandleById.get(key);
      if (existing) return existing;
      const handle = this.nextCursorHandle++;
      this.cursorHandleById.set(key, handle);
      const decoded = this.decodeCursorResource(module || 0x0040_0000, cursorId >>> 0);
      if (decoded) this.cursorImages.set(handle, decoded);
      if (shimTraceEnabled('VM_TRACE_CURSOR'))
        console.log(
          `[cursor] LoadCursor module=0x${(module >>> 0).toString(16)} id=${cursorId} -> handle=0x${handle.toString(16)} decoded=${decoded ? `${decoded.width}x${decoded.height} hot=${decoded.hotspotX},${decoded.hotspotY}` : 'null'}`,
        );
      return handle;
    }

    /** Resolve RT_GROUP_CURSOR(12) to RT_CURSOR(1), decoding .cur XOR/AND masks into RGBA. */
    private decodeCursorResource(
      module: number,
      cursorId: number,
    ): { width: number; height: number; hotspotX: number; hotspotY: number; rgba: Uint8Array } | null {
      const group = this.findPeResource(module, cursorId, 12); // RT_GROUP_CURSOR
      if (shimTraceEnabled('VM_TRACE_CURSOR'))
        console.log(`[cursor] decode id=${cursorId} group=${group ? `size=${group.size}` : 'null'}`);
      if (!group) return null;
      const g = this.memory.read_memory(group.data, Math.min(group.size, 20));
      const count = g[4]! | (g[5]! << 8);
      if (!count) return null;
      // Use the first CURSORDIRENTRY, 14 bytes at offset 6.
      const hotspotX = g[10]! | (g[11]! << 8);
      const hotspotY = g[12]! | (g[13]! << 8);
      const imageId = g[18]! | (g[19]! << 8);
      const image = this.findPeResource(module, imageId, 1); // RT_CURSOR
      if (!image) return null;
      const data = this.memory.read_memory(image.data, image.size);
      // RT_CURSOR should begin with BITMAPINFOHEADER biSize=40; RA2 resources have a four-byte prefix, so detect the actual offset.
      let hdr = 0;
      if (this.readI32From(data, 0) !== 40) {
        if (this.readI32From(data, 4) === 40) hdr = 4;
        else return null;
      }
      const width = this.readI32From(data, hdr + 4);
      const height = this.readI32From(data, hdr + 8) >> 1; // biHeight includes both XOR and AND sections.
      const bitCount = data[hdr + 14]! | (data[hdr + 15]! << 8);
      if (shimTraceEnabled('VM_TRACE_CURSOR'))
        console.log(
          `[cursor] decode id=${cursorId} imageId=${imageId} imgSize=${image.size} hdr=${hdr} w=${width} h=${height} bits=${bitCount} hot=${hotspotX},${hotspotY}`,
        );
      if (width <= 0 || height <= 0 || width > 256 || height > 256) return null;
      const rgba = new Uint8Array(width * height * 4);
      const colorTableBytes = bitCount <= 8 ? (1 << bitCount) * 4 : 0;
      const xorOffset = hdr + 40 + colorTableBytes;
      const rowBits = width * bitCount;
      const xorStride = ((rowBits + 31) >> 5) << 2;
      const andStride = ((width + 31) >> 5) << 2;
      const andOffset = xorOffset + xorStride * height;
      // 32-bit cursors may contain all-zero alpha; use the AND mask for transparency then.
      let hasAlpha = false;
      if (bitCount === 32) {
        for (let i = 0; i < width * height; i++)
          if (data[xorOffset + i * 4 + 3]! !== 0) {
            hasAlpha = true;
            break;
          }
      }
      for (let y = 0; y < height; y++) {
        const row = height - 1 - y; // Bottom-up bitmap.
        for (let x = 0; x < width; x++) {
          const di = (y * width + x) * 4;
          let r = 0;
          let gg = 0;
          let b = 0;
          let a = 0;
          if (bitCount === 32) {
            const si = xorOffset + (row * width + x) * 4;
            b = data[si]!;
            gg = data[si + 1]!;
            r = data[si + 2]!;
            a = data[si + 3]!;
            if (!hasAlpha) {
              const andByte = data[andOffset + row * andStride + (x >> 3)]!;
              a = (andByte >> (7 - (x & 7))) & 1 ? 0 : 0xff;
            }
          } else if (bitCount === 8 || bitCount === 4 || bitCount === 1) {
            let index = 0;
            if (bitCount === 8) index = data[xorOffset + row * xorStride + x]!;
            else if (bitCount === 4) {
              const byte = data[xorOffset + row * xorStride + (x >> 1)]!;
              index = x & 1 ? byte & 0x0f : byte >> 4;
            } else {
              const byte = data[xorOffset + row * xorStride + (x >> 3)]!;
              index = (byte >> (7 - (x & 7))) & 1;
            }
            // RT_CURSOR may prefix BITMAPINFOHEADER with a four-byte hotspot; palette
            // and XOR offsets are relative to the actual header, never a fixed 40 bytes from resource start.
            const ci = hdr + 40 + index * 4;
            b = data[ci]!;
            gg = data[ci + 1]!;
            r = data[ci + 2]!;
            const andByte = data[andOffset + row * andStride + (x >> 3)]!;
            a = (andByte >> (7 - (x & 7))) & 1 ? 0 : 0xff;
          } else {
            return null;
          }
          rgba[di] = r;
          rgba[di + 1] = gg;
          rgba[di + 2] = b;
          rgba[di + 3] = a;
        }
      }
      return { width, height, hotspotX, hotspotY, rgba };
    }

    private readI32From(data: Uint8Array, offset: number): number {
      return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24) | 0;
    }
    /**
     * Drop the guest's last reference to a thread. The id becomes reusable once the thread has also exited;
     * until then its state stays so waits and exit codes on other handles keep working.
     */
    protected closeGuestThreadHandle(handle: number): boolean {
      const id = this.guestThreadHandles.get(handle);
      if (id === undefined) return false;
      const thread = this.guestThreads.get(id);
      if (!thread) {
        this.guestThreadHandles.delete(handle);
        return true;
      }
      // Keep the handle resolvable until the thread is reclaimed: another thread may already be blocked on it, and
      // Windows keeps the object alive for that waiter. Handle numbers are never reused, so this cannot alias.
      thread.handleClosed = true;
      return true;
    }

    /**
     * Release exited threads' stacks and recycle their ids. Called from CreateThread, never from the exit path
     * itself: the exiting thread is still executing on its own stack when ExitThread reaches the shim.
     */
    protected reclaimExitedGuestThreads(): void {
      const current = this.readU32(HYPERCALL_THREAD_CURRENT);
      for (const thread of [...this.guestThreads.values()]) {
        if (!thread.terminated || thread.id === current || thread.id === 0) continue;
        if (thread.stackBase) {
          this.freeAllocation(thread.stackBase);
          thread.stackBase = undefined;
        }
        if (!thread.handleClosed) continue;
        this.guestThreads.delete(thread.id);
        this.guestThreadHandles.delete(thread.handle);
        this.freeThreadIds.push(thread.id);
      }
    }

    protected createGuestThread(
      stackBytes: number,
      start: number,
      parameter: number,
      flags: number,
      tidPtr: number,
    ): number {
      // Reclaim first: without it, a session that churns threads exhausts the 64 ids and leaks every stack.
      this.reclaimExitedGuestThreads();
      if (!start || (this.freeThreadIds.length === 0 && this.nextThreadId >= GUEST_THREAD_LIMIT)) {
        this.lastError = 8;
        return 0;
      }
      const id = this.freeThreadIds.pop() ?? this.nextThreadId++;
      const handle = this.allocateGuestWaitHandle();
      if (shimTraceEnabled('VM_TRACE_THREAD'))
        console.log(`🧵 CreateThread id=${id} 入口=0x${start.toString(16)} 参数=0x${parameter.toString(16)}`);
      const reserve = Math.max(64 * 1024, Math.min(stackBytes || 64 * 1024, 1024 * 1024));
      const base = this.alloc(reserve, true);
      if (!base) {
        this.freeThreadIds.push(id);
        this.lastError = 8;
        return 0;
      }
      if (!this.threadExitStub) {
        this.threadExitStub = this.registerDynamicWin32Import('KERNEL32.DLL', 'ExitThread', 4);
        this.threadReturnTrampoline = this.allocateDynamicCode([
          0x50,
          0xb8,
          this.threadExitStub & 0xff,
          (this.threadExitStub >>> 8) & 0xff,
          (this.threadExitStub >>> 16) & 0xff,
          (this.threadExitStub >>> 24) & 0xff,
          0xff,
          0xd0,
          0xf4,
          0xeb,
          0xfd,
        ]);
      }
      const top = base + reserve;
      const context = top - 48;
      const frame = [0, 0, 0, top - 16, 0, 0, 0, 0, 0x0000_0202, start, this.threadReturnTrampoline, parameter];
      for (let i = 0; i < frame.length; i++) this.writeU32(context + i * 4, frame[i]!);
      this.writeU32(GUEST_THREAD_CONTEXT_ESPS + id * 4, context);
      this.writeU32(GUEST_THREAD_CONTEXT_SEH + id * 4, 0xffff_ffff);
      this.writeU32(GUEST_THREAD_CONTEXT_STACK_TOP + id * 4, top);
      this.writeU32(GUEST_THREAD_CONTEXT_STACK_BOTTOM + id * 4, base);
      this.writeU32(GUEST_THREAD_CONTEXT_LAST_ERROR + id * 4, 0);
      this.zero(FAST_TLS_TABLE + id * FAST_TLS_THREAD_BYTES, FAST_TLS_THREAD_BYTES);
      // A reused id must not inherit the previous thread's compat lock depth (its import tails would skip STI and
      // starve the scheduler) or its saved x87/SSE state, which boot.asm restores with FXRSTOR on the first switch.
      this.writeU32(GUEST_THREAD_CRITICAL_DEPTH + id * 4, 0);
      const fpu = GUEST_THREAD_FPU_CONTEXTS + id * GUEST_THREAD_FPU_CONTEXT_BYTES;
      this.zero(fpu, GUEST_THREAD_FPU_CONTEXT_BYTES);
      this.writeU32(fpu, 0x037f); // Default x87 control word.
      this.writeU32(fpu + 24, 0x1f80); // Default MXCSR; zero abridged tag marks x87 registers empty.
      this.guestThreads.set(id, {
        id,
        handle,
        runnable: (flags & 0x4) === 0,
        terminated: false,
        wakeAt: 0,
        stackBase: base,
      });
      this.writeU32(GUEST_THREAD_RUN_STATES + id * 4, (flags & 0x4) === 0 ? 1 : 0);
      this.writeU32(HYPERCALL_THREAD_COUNT, this.nextThreadId);
      this.guestThreadHandles.set(handle, id);
      if (tidPtr) this.writeU32(tidPtr, id + 1);
      this.lastError = 0;
      return handle;
    }
    protected loadLibrary(call: Win32Call, namePtr: number, name = this.readCString(namePtr)): Win32Result {
      const module = this.loadGuestDll(name);
      if (!module) {
        const dll = name.replace(/^.*[\\/]/, '').toUpperCase();
        if (this.staticImports.some((item) => item.dll.toUpperCase() === dll)) {
          let handle = this.importedModuleHandles.get(dll);
          if (handle === undefined) {
            handle = 0x70000000 + this.importedModuleHandles.size * 0x10000;
            this.importedModuleHandles.set(dll, handle);
          }
          return { eax: handle };
        }
        // CRT optional system-DLL probes retain the main-module dummy handle.
        return { eax: 0x0040_0000 };
      }
      if (!module.initialized && module.entry) {
        module.initialized = true;
        const originalReturn = this.readU32(call.stack);
        const code: number[] = [];
        const emit32 = (value: number) =>
          code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
        const push = (value: number) => {
          code.push(0x68);
          emit32(value);
        };
        push(0); // lpReserved
        push(1); // DLL_PROCESS_ATTACH
        push(module.base);
        code.push(0xb8);
        emit32(module.entry);
        code.push(0xff, 0xd0); // call DllMainCRTStartup
        // A failed native initializer must not become a successful module handle.
        // Structured loader-failure unwinding is unsupported: stop at a real fault.
        code.push(0x85, 0xc0, 0x75, 0x03, 0x0f, 0x0b, 0xf4);
        code.push(0xb8);
        emit32(module.base); // LoadLibraryA returns HMODULE.
        code.push(0xb9);
        emit32(originalReturn);
        code.push(0xff, 0xe1); // jmp original return
        this.writeU32(call.stack, this.allocateDynamicCode(code));
      }
      return { eax: module.base };
    }

    protected getGuestProcAddress(handle: number, namePtr: number): number {
      const module = this.guestDllByHandle(handle);
      const name = namePtr <= 0xffff ? `ord${namePtr}` : this.readCString(namePtr);
      const importedDll = [...this.importedModuleHandles].find(([, value]) => value === handle)?.[0];
      if (importedDll === 'COMCTL32.DLL' && name === 'DllGetVersion') {
        this.dllGetVersionStub ||= this.registerDynamicWin32Import(importedDll, name, 4);
        return this.dllGetVersionStub;
      }
      if (importedDll) {
        const key = `${importedDll}!${name}`;
        let stub = this.importedProcStubs.get(key);
        if (stub !== undefined) return stub;
        let bytes: number | undefined;
        try {
          bytes = this.options.importArgBytes?.(importedDll, name);
        } catch {
          /* Unknown export. */
        }
        if (bytes === undefined) {
          this.lastError = 127;
          return 0;
        }
        stub = this.registerDynamicWin32Import(importedDll, name, bytes);
        this.importedProcStubs.set(key, stub);
        return stub;
      }
      if (!module) {
        // Provide a normal host hypercall for comctl32 version checks; keep other optional CRT
        // system functions absent so callers take Win9x compatibility paths.
        if (name === 'DllGetVersion') {
          this.dllGetVersionStub ||= this.registerDynamicWin32Import('COMCTL32.DLL', name, 4);
          return this.dllGetVersionStub;
        }
        return 0;
      }
      return module.exports.get(name) ?? 0;
    }
    private writeUtf16String(pointer: number, text: string): void {
      const bytes = new Uint8Array((text.length + 1) * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
      this.memory.write_memory(bytes, pointer);
    }

    protected openFile(args: number[], rawPath = this.readCString(args[0] ?? 0)): number {
      // Drive-root paths, including C: with or without a trailing backslash and the root backslash alone, probe drive existence.
      // Win9x CreateFileA returns a valid handle for existing drive roots; provide a closable dummy handle for these probes.
      if (/^[a-z]:[\\/]?$/i.test(rawPath) || rawPath === '\\' || rawPath === '/') {
        const handle = this.allocateFileHandle();
        this.fileHandles.set(handle, {
          path: '',
          bytes: new Uint8Array(),
          size: 0,
          position: 0,
          writable: false,
          dirty: false,
        });
        return handle;
      }
      const path = normalizeGuestPath(rawPath);
      const desiredAccess = args[1] ?? 0;
      const disposition = args[4] ?? 3;
      let bytes = this.files.get(path);
      const sharedMirror = this.sharedFileMirrors.get(path);
      const exists = bytes !== undefined || sharedMirror !== undefined;

      // CREATE_NEW / CREATE_ALWAYS / OPEN_ALWAYS may create files; OPEN_EXISTING requires an existing mount.
      if (disposition === 1 && exists) {
        this.lastError = 80; // ERROR_FILE_EXISTS
        return 0xffff_ffff;
      }
      if (!exists && disposition !== 1 && disposition !== 2 && disposition !== 4) {
        this.lastError = 2; // ERROR_FILE_NOT_FOUND
        this.noteFailedOpen(path);
        return 0xffff_ffff;
      }
      if (!exists || disposition === 1 || disposition === 2) {
        bytes = new Uint8Array();
        this.sharedFileMirrors.delete(path);
        this.storeFile(path, bytes);
      }
      if (disposition === 5) {
        // TRUNCATE_EXISTING
        if (!exists) {
          this.lastError = 2;
          this.noteFailedOpen(path);
          return 0xffff_ffff;
        }
        bytes = new Uint8Array();
        this.sharedFileMirrors.delete(path);
        this.storeFile(path, bytes);
      }

      const handle = this.allocateFileHandle();
      const file: FileState = {
        path,
        bytes: bytes ?? new Uint8Array(),
        size: sharedMirror?.size ?? this.fileLogicalSizes.get(path) ?? bytes!.length,
        position: 0,
        writable: (desiredAccess & 0x4000_0000) !== 0 || disposition !== 3,
        dirty: !exists || disposition === 1 || disposition === 2 || disposition === 5,
      };
      this.fileHandles.set(handle, file);
      this.mirrorFile(handle, file);
      this.lastError = disposition === 4 && exists ? 183 : 0; // ERROR_ALREADY_EXISTS
      return handle;
    }
    protected openLegacyFile(pathPtr: number, create: boolean, openFlags = 0): number {
      const path = normalizeGuestPath(this.readCString(pathPtr));
      // _lopen oflag OF_WRITE(1)/OF_READWRITE(2) opens writable handles; native saves use them
      // to rewrite label.sav/record.sav in place, silently losing list/record updates if writes fail.
      const writable = create || (openFlags & 3) !== 0;
      // Real _lcreat fails with access denied on directories; reject creating files over virtual directories too.
      if (create && this.isVirtualDirectory(path)) {
        this.lastError = 5; // ERROR_ACCESS_DENIED
        return 0xffff_ffff;
      }
      let bytes = create ? new Uint8Array() : this.files.get(path);
      const sharedMirror = create ? undefined : this.sharedFileMirrors.get(path);
      if (!bytes && !sharedMirror) {
        this.lastError = 2;
        this.noteFailedOpen(path);
        return 0xffff_ffff;
      }
      if (create) {
        this.sharedFileMirrors.delete(path);
        this.storeFile(path, bytes!);
      }
      const handle = this.allocateFileHandle();
      const file: FileState = {
        path,
        bytes: bytes ?? new Uint8Array(),
        size: sharedMirror?.size ?? this.fileLogicalSizes.get(path) ?? bytes!.length,
        position: 0,
        writable,
        dirty: create,
      };
      this.fileHandles.set(handle, file);
      this.mirrorFile(handle, file);
      this.lastError = 0;
      return handle;
    }
    /** Return actual byte count on success, -1 on failure. */
    protected readFile(handle: number, buffer: number, requested: number, bytesReadPtr: number): number {
      const file = this.fileHandles.get(handle);
      if (!file) {
        if (bytesReadPtr) this.writeU32(bytesReadPtr, 0);
        this.lastError = 6; // ERROR_INVALID_HANDLE
        return -1;
      }
      if (!file.mirror) {
        const reads = (this.unmirroredReads.get(handle) ?? 0) + 1;
        this.unmirroredReads.set(handle, reads);
        if (reads === 1000 || reads % 100_000 === 0) {
          console.info(
            `[VM files] 高频 hypercall 读：${file.path}（句柄 0x${handle.toString(16)}，未镜像，第 ${reads} 次）`,
          );
        }
      }
      this.pullFastFilePosition(handle, file);
      const count = Math.min(requested >>> 0, Math.max(0, file.size - file.position));
      // Missing provider-backed pages are I/O failures, not sparse zero-filled data. Check before touching the
      // destination or advancing the handle so both ReadFile and _lread can retry after the host fetches the range.
      if (this.rangeBackedFiles.has(file.path) && !this.hasFileRange(file.path, file.position, count)) {
        if (bytesReadPtr) this.writeU32(bytesReadPtr, 0);
        this.lastError = 30; // ERROR_READ_FAULT
        return -1;
      }
      if (buffer && count) {
        if (file.sharedMirror && file.mirror) {
          this.memory.write_memory(this.memory.read_memory(file.mirror + file.position, count), buffer);
        } else if (this.rangeBackedFiles.has(file.path)) {
          this.copyFileRange(file.path, file.position, count, buffer);
        } else {
          const available = Math.min(count, Math.max(0, file.bytes.length - file.position));
          if (available) {
            this.memory.write_memory(file.bytes.subarray(file.position, file.position + available), buffer);
          }
          if (available < count) this.zero(buffer + available, count - available);
        }
      }
      file.position += count;
      this.pushFastFilePosition(handle, file);
      if (bytesReadPtr) this.writeU32(bytesReadPtr, count);
      this.lastError = 0;
      return count;
    }
    /** Return actual byte count on success, -1 on failure. */
    protected writeFile(handle: number, buffer: number, requested: number, bytesWrittenPtr: number): number {
      const file = this.fileHandles.get(handle);
      if (!file) {
        // CRT stdout/stderr need no actual guest-device output.
        if (handle >= 0x10010 && handle <= 0x10013) {
          if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, requested >>> 0);
          return requested >>> 0;
        }
        if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, 0);
        this.lastError = 6;
        return -1;
      }
      if (!file.writable) {
        if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, 0);
        this.lastError = 5; // ERROR_ACCESS_DENIED
        return -1;
      }
      this.demoteFileMirror(handle, file);
      const count = requested >>> 0;
      const end = file.position + count;
      if (shimTraceEnabled('VM_TRACE_FILE_WRITE')) {
        console.log(
          `[VM files] WriteFile ${file.path} handle=0x${handle.toString(16)} pos=${file.position} count=${count} end=${end} capacity=${file.bytes.length}`,
        );
      }
      if (end > file.bytes.length) {
        const capacity = Math.max(4096, Math.min(0x7fff_ffff, Math.max(1, file.bytes.length) * 2));
        const grown = new Uint8Array(Math.max(end, capacity));
        grown.set(file.bytes.subarray(0, file.size));
        file.bytes = grown;
      }
      if (file.position > file.size) file.bytes.fill(0, file.size, file.position);
      if (buffer && count) file.bytes.set(this.memory.read_memory(buffer, count), file.position);
      file.position = end;
      file.size = Math.max(file.size, end);
      this.storeFile(file.path, file.bytes.subarray(0, file.size));
      file.dirty = true;
      if (bytesWrittenPtr) this.writeU32(bytesWrittenPtr, count);
      this.lastError = 0;
      return count;
    }
    protected seekFile(handle: number, low: number, highPtr: number, origin: number): number {
      const file = this.fileHandles.get(handle);
      if (!file) {
        this.lastError = 6;
        return 0xffff_ffff;
      }
      this.pullFastFilePosition(handle, file);
      const high = highPtr ? this.readU32(highPtr) | 0 : low & 0x8000_0000 ? -1 : 0;
      const distance = high * 0x1_0000_0000 + (low >>> 0);
      const base = origin === 1 ? file.position : origin === 2 ? file.size : origin === 0 ? 0 : -1;
      const position = base + distance;
      if (file.writable && shimTraceEnabled('VM_TRACE_FILE_WRITE')) {
        console.log(
          `[VM files] SetFilePointer ${file.path} handle=0x${handle.toString(16)} origin=${origin} low=0x${(low >>> 0).toString(16)} high=${high} ${file.position}->${position}`,
        );
      }
      if (base < 0 || position < 0 || position > 0xffff_ffff) {
        this.lastError = 87; // ERROR_INVALID_PARAMETER
        return 0xffff_ffff;
      }
      file.position = position;
      this.pushFastFilePosition(handle, file);
      if (highPtr) this.writeU32(highPtr, Math.floor(position / 0x1_0000_0000));
      this.lastError = 0;
      return position >>> 0;
    }
    protected closeFile(handle: number): boolean {
      const file = this.fileHandles.get(handle);
      if (!file) return false;
      this.flushFile(file);
      this.unmirroredReads.delete(handle);
      this.fileHandles.delete(handle);
      this.freeFileHandles.push(handle);
      const entry = this.fastFileEntry(handle);
      if (entry !== null) this.zero(entry, FAST_FILE_ENTRY_BYTES);
      if (file.mirror) {
        if (!file.sharedMirror) {
          this.freeAllocation(file.mirror);
          this.fileMirrorBytes = Math.max(0, this.fileMirrorBytes - file.size);
        }
      }
      return true;
    }
    protected flushFile(file: FileState): void {
      if (!file.writable || !file.dirty) return;
      file.dirty = false;
      this.notifyFileWrite(file.path, file.bytes.subarray(0, file.size));
    }
    protected notifyFileWrite(path: string, bytes: Uint8Array): void {
      this.options.onFileWrite?.(path, bytes.slice());
    }
    /**
     * Mirror on open, including writable handles because native code often opens read/write but only reads. On first guest write, demoteFileMirror restores the canonical path.
     */
    protected mirrorFile(handle: number, file: FileState): void {
      if (!this.options.enableFastFileMirror) return;
      // Guest fast reads cannot fetch pages or report missing ranges; keep provider-backed files on the checked path.
      if (this.rangeBackedFiles.has(file.path)) return;
      // Bink 1.x reads tiny blocks from .bik files extracted from MIX; without mirrors, the YR main menu measured
      // about 7700 ReadFile calls/500ms. Keep the archive allowlist for huge MIX files, but permit video leaf files
      // in the same guest fast table to avoid Worker/COM1 round trips for each decoded block.
      if (this.fastFileMirrorFiles && !this.fastFileMirrorFiles.has(file.path) && !file.path.endsWith('.bik')) return;
      const entry = this.fastFileEntry(handle);
      if (entry === null) return;
      if (!file.writable && this.fastFileMirrorBase && this.fastFileMirrorTop > this.fastFileMirrorBase) {
        const cached = this.sharedFileMirrors.get(file.path);
        if (cached && cached.size === file.size) {
          file.mirror = cached.ptr;
          file.sharedMirror = true;
          this.publishFastFileMirror(entry, file, cached.ptr);
          return;
        }
      }
      if (file.size + this.fileMirrorBytes > this.fastFileMirrorLimit) {
        const warningKey = `budget:${file.path}`;
        if (file.size > 1024 * 1024 && !this.warnedFileMirrorSkips.has(warningKey)) {
          this.warnedFileMirrorSkips.add(warningKey);
          console.info(
            `[VM files] 镜像跳过（超预算）${file.path}：${file.size} 字节（已用 ${this.fileMirrorBytes}/${this.fastFileMirrorLimit}）`,
          );
        }
        return;
      }
      // RA2.MIX alone is about 269MiB. Copying it into the ordinary heap per handle both crosses
      // Blowfish.dll's fixed 0x11000000 mapping and repeatedly moves hundreds of MiB
      // on MIX reopen. Cache permanently by normalized path in a separate high-address region; read-only handles share content
      // but each stores position in its own FAST_FILE_ENTRY.
      if (!file.writable && this.fastFileMirrorBase && this.fastFileMirrorTop > this.fastFileMirrorBase) {
        const aligned = (Math.max(1, file.size) + 15) & ~15;
        const mirror = (this.nextFastFileMirror + 15) & ~15;
        if (mirror + aligned <= this.fastFileMirrorTop) {
          if (file.size) this.memory.write_memory(file.bytes.subarray(0, file.size), mirror);
          this.nextFastFileMirror = mirror + aligned;
          this.sharedFileMirrors.set(file.path, { ptr: mirror, size: file.size });
          file.mirror = mirror;
          file.sharedMirror = true;
          // The guest mirror becomes the canonical read-only archive snapshot; release the large host array returned by the provider,
          // or files such as RA2.MIX occupy both guest RAM and JS heap and can cause OOM when opening campaign movies.
          this.files.delete(file.path);
          file.bytes = new Uint8Array();
          this.fileMirrorBytes += file.size;
          this.publishFastFileMirror(entry, file, mirror);
          if (file.size > 1024 * 1024) {
            console.info(
              `[VM files] 已缓存大文件 ${file.path}：${file.size} 字节 @0x${mirror.toString(16)}（已用 ${this.fileMirrorBytes}/${this.fastFileMirrorLimit}）`,
            );
          }
          return;
        }
        const warningKey = `region:${file.path}`;
        if (file.size > 1024 * 1024 && !this.warnedFileMirrorSkips.has(warningKey)) {
          this.warnedFileMirrorSkips.add(warningKey);
          console.info(`[VM files] 大文件镜像区不足 ${file.path}：${file.size} 字节`);
        }
        return;
      }
      // Allocate mirrors from the game heap and return them on handle close instead of reserving address space permanently;
      // allocation failure under address pressure falls back to hypercall reads for that file.
      const mirror = this.alloc(Math.max(1, file.size), false);
      if (!mirror) {
        const warningKey = `heap:${file.path}`;
        if (file.size > 1024 * 1024 && !this.warnedFileMirrorSkips.has(warningKey)) {
          this.warnedFileMirrorSkips.add(warningKey);
          console.info(`[VM files] 镜像跳过（堆分配失败）${file.path}：${file.size} 字节`);
        }
        return;
      }
      if (file.size) this.memory.write_memory(file.bytes.subarray(0, file.size), mirror);
      file.mirror = mirror;
      this.fileMirrorBytes += file.size;
      this.publishFastFileMirror(entry, file, mirror);
      if (file.size > 1024 * 1024) {
        console.info(
          `[VM files] 已镜像 ${file.path}：${file.size} 字节（已用 ${this.fileMirrorBytes}/${this.fastFileMirrorLimit}）`,
        );
      }
    }
    /**
     * Demote mirrored handles on guest writes: recover the latest guest position, free the mirror, and clear the table entry; subsequent access uses canonical-byte hypercalls.
     */
    protected demoteFileMirror(handle: number, file: FileState): void {
      if (!file.mirror) return;
      if (file.size > 1024 * 1024) {
        console.info(`[VM files] 镜像降级 ${file.path}：客体写入，退回 hypercall 路径`);
      }
      this.pullFastFilePosition(handle, file);
      if (file.sharedMirror && file.bytes.length < file.size) {
        file.bytes = this.memory.read_memory(file.mirror, file.size).slice();
        this.sharedFileMirrors.delete(file.path);
        this.storeFile(file.path, file.bytes);
      }
      const entry = this.fastFileEntry(handle);
      if (entry !== null) this.zero(entry, FAST_FILE_ENTRY_BYTES);
      if (!file.sharedMirror) {
        this.freeAllocation(file.mirror);
        this.fileMirrorBytes = Math.max(0, this.fileMirrorBytes - file.size);
      }
      file.mirror = undefined;
      file.sharedMirror = false;
    }
    protected pullFastFilePosition(handle: number, file: FileState): void {
      const entry = file.mirror ? this.fastFileEntry(handle) : null;
      if (entry !== null) file.position = this.readU32(entry + 8);
    }
    protected pushFastFilePosition(handle: number, file: FileState): void {
      const entry = file.mirror ? this.fastFileEntry(handle) : null;
      if (entry !== null) this.writeU32(entry + 8, file.position);
    }
    protected fastFileEntry(handle: number): number | null {
      const index = (handle >>> 0) - FAST_FILE_HANDLE_BASE;
      return index >= 0 && index < FAST_FILE_TABLE_ENTRIES ? FAST_FILE_TABLE + index * FAST_FILE_ENTRY_BYTES : null;
    }
    protected publishFastFileMirror(entry: number, file: FileState, mirror: number): void {
      this.writeU32(entry, mirror);
      this.writeU32(entry + 4, file.size);
      this.writeU32(entry + 8, file.position);
      this.writeU32(entry + 12, 1);
    }
    protected allocateFileHandle(): number {
      return this.freeFileHandles.pop() ?? this.nextFileHandle++;
    }
    protected alloc(size: number, zero: boolean): number {
      if (size <= 0) size = 1;
      const aligned = Math.ceil(size / 16) * 16;
      if (!Number.isSafeInteger(aligned) || aligned <= 0) {
        this.lastError = 8;
        return 0;
      }
      let ptr = 0;
      const freeIndex = this.freeBlocks.findIndex((block) => block.size >= aligned);
      if (freeIndex >= 0) {
        const block = this.freeBlocks[freeIndex]!;
        ptr = block.ptr;
        block.ptr += aligned;
        block.size -= aligned;
        if (!block.size) this.freeBlocks.splice(freeIndex, 1);
      } else {
        // The heap grows upward from 0x500000; skip VirtualAlloc reservations as barriers.
        // Iterate Map directly without spreading into arrays; GlobalAlloc runs tens of thousands of times per second.
        ptr = this.nextHeap;
        for (let guard = 0; guard < 128; guard++) {
          let blocked = false;
          for (const [base, region] of this.virtualRegions) {
            if (ptr < base + region.size && base < ptr + aligned) {
              ptr = base + region.size;
              blocked = true;
              break;
            }
          }
          if (!blocked) break;
        }
        // MEM_RELEASE regions live in a separate virtual free list and may lie above nextHeap. When heap growth
        // claims such a range, remove it from that list or later VirtualAlloc could allocate it again.
        // wemu avoids this through separate mutually exclusive arenas; enforce the equivalent here.
        this.trimVirtualFreeBlocks(ptr, ptr + aligned);
        this.trimFreeBlocks(ptr, ptr + aligned);
        this.nextHeap = ptr + aligned;
        this.peakHeap = Math.max(this.peakHeap, this.nextHeap);
      }
      if (ptr < this.heapBase || ptr + aligned > this.heapTop) {
        this.lastError = 8; // ERROR_NOT_ENOUGH_MEMORY
        return 0;
      }
      this.allocations.set(ptr, aligned);
      if (zero) this.zero(ptr, aligned);
      return ptr;
    }
    protected realloc(oldPtr: number, size: number, zero: boolean): number {
      if (!oldPtr) return this.alloc(size, zero);
      const oldSize = this.allocations.get(oldPtr) ?? 0;
      const aligned = Math.ceil(Math.max(1, size) / 16) * 16;
      if (oldSize && aligned <= oldSize) {
        if (aligned < oldSize) {
          this.allocations.set(oldPtr, aligned);
          this.addFreeBlock(oldPtr + aligned, oldSize - aligned);
        }
        return oldPtr;
      }
      const ptr = this.alloc(size, zero);
      if (!ptr) return 0;
      if (oldSize) this.memory.write_memory(this.memory.read_memory(oldPtr, Math.min(oldSize, size)), ptr);
      this.freeAllocation(oldPtr);
      return ptr;
    }
    protected freeAllocation(ptr: number): boolean {
      const size = this.allocations.get(ptr);
      if (size === undefined) return false;
      this.allocations.delete(ptr);
      this.addFreeBlock(ptr, size);
      return true;
    }
    protected addFreeBlock(ptr: number, size: number): void {
      this.addBlock(this.freeBlocks, ptr, size);
    }
    protected addBlock(blocks: Array<{ ptr: number; size: number }>, ptr: number, size: number): void {
      if (size <= 0) return;
      // Keep free blocks address-sorted: binary-search insertion and merge only neighbors, avoiding a full sort
      // and scan on every free in the heavy GlobalAlloc/GlobalFree path.
      let low = 0;
      let high = blocks.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (blocks[mid]!.ptr < ptr) low = mid + 1;
        else high = mid;
      }
      let entryPtr = ptr;
      let entrySize = size;
      if (low > 0 && blocks[low - 1]!.ptr + blocks[low - 1]!.size === ptr) {
        const previous = blocks[low - 1]!;
        entryPtr = previous.ptr;
        entrySize = previous.size + size;
        blocks.splice(low - 1, 1);
        low -= 1;
      }
      while (low < blocks.length && blocks[low]!.ptr === entryPtr + entrySize) {
        entrySize += blocks[low]!.size;
        blocks.splice(low, 1);
      }
      blocks.splice(low, 0, { ptr: entryPtr, size: entrySize });
    }
    protected addVirtualFreeBlock(ptr: number, size: number): void {
      this.addBlock(this.virtualFreeBlocks, ptr, size);
    }
    /** Reservations stay disjoint from heap allocations. NULL bases use Windows' 64 KiB
     * allocation granularity and page-rounded sizes, as required by native CRT pool metadata.
     * Recommits preserve live bytes; decommit clears content while retaining the reservation.
     */
    protected virtualAlloc(requested: number, size: number): number {
      const alignment = requested ? 16 : 4096;
      const aligned = Math.ceil(Math.max(1, size) / alignment) * alignment;
      if (requested) {
        const end = requested + aligned;
        // Committing an already committed range preserves its live bytes. New reservations
        // and decommitted ranges are already zeroed at their respective lifecycle boundaries.
        for (const [base, region] of this.virtualRegions) {
          if (requested >= base && end <= base + region.size) {
            return requested;
          }
        }
        // Fixed addresses outside reservations create in-arena regions, as in wemu alloc_at; reject out-of-bounds requests.
        if (requested < this.virtualBase || end > this.heapTop) {
          this.warnVirtual(requested, '固定地址超出堆 arena 界，VirtualAlloc 已拒绝');
          this.lastError = 487; // ERROR_INVALID_ADDRESS
          return 0;
        }
        // Reject overlap with live heap allocations or existing reservations instead of silently aliasing them.
        for (const [ptr, liveSize] of this.allocations) {
          if (requested < ptr + liveSize && ptr < end) {
            this.warnVirtual(requested, '与活动堆分配重叠，VirtualAlloc 已拒绝');
            this.lastError = 487; // ERROR_INVALID_ADDRESS
            return 0;
          }
        }
        for (const [base, region] of this.virtualRegions) {
          if (requested < base + region.size && base < end) {
            this.warnVirtual(requested, '与已有 VirtualAlloc 保留区重叠');
            this.lastError = 487;
            return 0;
          }
        }
        this.trimFreeBlocks(requested, end);
        this.trimVirtualFreeBlocks(requested, end);
        this.virtualRegions.set(requested, { size: aligned });
        this.zero(requested, aligned);
        return requested;
      }
      const base = this.findVirtualBase(aligned);
      if (!base) {
        this.lastError = 8; // ERROR_NOT_ENOUGH_MEMORY
        return 0;
      }
      // Reservations may intersect either free list; remove overlaps so later HeapAlloc or
      // VirtualAlloc cannot reuse the same addresses. NULL reservations previously omitted this step, risking double allocation.
      this.trimFreeBlocks(base, base + aligned);
      this.trimVirtualFreeBlocks(base, base + aligned);
      this.virtualRegions.set(base, { size: aligned });
      this.zero(base, aligned);
      return base;
    }
    /** MEM_RELEASE frees an entire reservation; MEM_DECOMMIT retains it and zeroes content only. */
    protected virtualFree(addr: number, size: number, type: number): boolean {
      const entry = [...this.virtualRegions.entries()].find(
        ([base, region]) => addr >= base && addr < base + region.size,
      );
      if (!entry) {
        this.warnVirtual(addr, 'VirtualFree 的地址不在任何保留区内');
        return false;
      }
      const [base, region] = entry;
      if ((type & 0x8000) !== 0) {
        // MEM_RELEASE
        if (addr !== base) {
          this.warnVirtual(addr, 'MEM_RELEASE 地址不是保留区基址');
          return false;
        }
        this.virtualRegions.delete(base);
        // wemu RELEASE uses try_free to return regions solely to the virtual arena for later
        // VirtualAlloc, never the heap free list. retrotick does not reclaim even RELEASE allocations;
        // follow wemu here to avoid address exhaustion in long sessions.
        this.addVirtualFreeBlock(base, region.size);
        return true;
      }
      // wemu recognizes MEM_DECOMMIT only here; reject types that are neither RELEASE nor DECOMMIT.
      if ((type & 0x4000) === 0) {
        this.warnVirtual(addr, 'VirtualFree 类型既非 MEM_RELEASE 也非 MEM_DECOMMIT');
        return false;
      }
      const decommitEnd = addr + Math.max(0, size);
      if (decommitEnd > base + region.size) {
        this.warnVirtual(addr, 'MEM_DECOMMIT 范围超出保留区');
        return false;
      }
      // Guest memory cannot truly become nonresident; zeroing prevents reads of stale decommitted data.
      this.zero(addr, Math.max(0, decommitEnd - addr));
      return true;
    }
    /**
     * NULL reservation: first reuse MEM_RELEASE regions high-to-low, approximating Windows top-down reuse; otherwise scan downward from the virtual-arena top.
     */
    protected findVirtualBase(size: number): number {
      let reuseBase = 0;
      for (const block of this.virtualFreeBlocks) {
        const top = Math.floor((block.ptr + block.size - size) / 0x10000) * 0x10000;
        if (block.size >= size && top >= block.ptr && top > reuseBase) reuseBase = top;
      }
      if (reuseBase) {
        // Allocation-granularity alignment may leave free ranges on both sides.
        this.trimVirtualFreeBlocks(reuseBase, reuseBase + size);
        return reuseBase;
      }
      let base = Math.floor((this.virtualTop - size) / 0x10000) * 0x10000;
      while (base >= this.virtualBase && base + size <= this.virtualTop) {
        let blocked = false;
        for (const [ptr, liveSize] of this.allocations) {
          if (base < ptr + liveSize && ptr < base + size) {
            base = Math.floor((ptr - size) / 0x10000) * 0x10000;
            blocked = true;
          }
        }
        for (const [regionBase, region] of this.virtualRegions) {
          if (base < regionBase + region.size && regionBase < base + size) {
            base = Math.floor((regionBase - size) / 0x10000) * 0x10000;
            blocked = true;
          }
        }
        if (!blocked) return base;
      }
      return 0;
    }
    /** Remove [base, end) from the heap free list to prevent later HeapAlloc reuse. */
    protected trimFreeBlocks(base: number, end: number): void {
      this.trimBlocks(this.freeBlocks, base, end);
    }
    /** Remove [base, end) from the VirtualAlloc free list to prevent later VirtualAlloc reuse. */
    protected trimVirtualFreeBlocks(base: number, end: number): void {
      this.trimBlocks(this.virtualFreeBlocks, base, end);
    }
    protected trimBlocks(blocks: Array<{ ptr: number; size: number }>, base: number, end: number): void {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i]!;
        const blockEnd = block.ptr + block.size;
        if (end <= block.ptr || blockEnd <= base) continue; // No intersection.
        if (base <= block.ptr && blockEnd <= end) {
          blocks.splice(i, 1); // The entire block is covered.
        } else if (block.ptr < base && end < blockEnd) {
          blocks.splice(i, 1, { ptr: block.ptr, size: base - block.ptr }, { ptr: end, size: blockEnd - end });
        } else if (base <= block.ptr) {
          block.ptr = end;
          block.size = blockEnd - end;
        } else {
          block.size = base - block.ptr;
        }
      }
    }
    protected warnVirtual(address: number, detail: string): void {
      if (this.warnedVirtual.has(address)) return;
      this.warnedVirtual.add(address);
      console.warn(`[VM memory] 0x${address.toString(16)}：${detail}`);
    }
    protected getDriveType(rootPathPtr: number): number {
      // Win32 allows NULL for the current directory's volume; this layer's current directory is on C:.
      if (!rootPathPtr) return this.driveTypes.get('C') ?? DRIVE_NO_ROOT_DIR;
      const root = this.readCString(rootPathPtr).trim();
      const drive = /^([a-z]):(?:[\\/]|$)/i.exec(root)?.[1]?.toUpperCase();
      if (!drive) return DRIVE_NO_ROOT_DIR;
      return this.driveTypes.get(drive) ?? DRIVE_NO_ROOT_DIR;
    }
    protected writeSystemTime(ptr: number, local: boolean): void {
      if (!ptr) return;
      const date = new Date(this.clock.wallNow());
      const values = local
        ? [
            date.getFullYear(),
            date.getMonth() + 1,
            date.getDay(),
            date.getDate(),
            date.getHours(),
            date.getMinutes(),
            date.getSeconds(),
            date.getMilliseconds(),
          ]
        : [
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            date.getUTCDay(),
            date.getUTCDate(),
            date.getUTCHours(),
            date.getUTCMinutes(),
            date.getUTCSeconds(),
            date.getUTCMilliseconds(),
          ];
      this.writeSystemTimeFields(ptr, values);
    }
    /** SYSTEMTIME is eight consecutive WORDs: year, month, weekday, day, hour, minute, second, milliseconds. */
    protected writeSystemTimeFields(ptr: number, values: readonly number[]): void {
      const bytes = new Uint8Array(16);
      for (let i = 0; i < values.length; i++) {
        bytes[i * 2] = values[i]! & 0xff;
        bytes[i * 2 + 1] = values[i]! >>> 8;
      }
      this.memory.write_memory(bytes, ptr);
    }
    protected readSystemTimeFields(ptr: number): SystemTimeFields {
      return {
        year: this.readU16(ptr),
        month: this.readU16(ptr + 2),
        weekday: this.readU16(ptr + 4),
        day: this.readU16(ptr + 6),
        hour: this.readU16(ptr + 8),
        minute: this.readU16(ptr + 10),
        second: this.readU16(ptr + 12),
        milliseconds: this.readU16(ptr + 14),
      };
    }
    /** The date/time formatting APIs treat a NULL SYSTEMTIME as "now", resolved in the host's local timezone. */
    protected localSystemTimeFields(): SystemTimeFields {
      const date = new Date(this.clock.wallNow());
      return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        weekday: date.getDay(),
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        milliseconds: date.getMilliseconds(),
      };
    }
    /**
     * Expand a Win32 date/time picture: quoted or backslash-escaped literals pass through verbatim, while a run of
     * the same token letter selects a field width. GetDateFormatA and GetTimeFormatA differ only in the token set.
     */
    protected expandPicture(
      picture: string,
      isToken: (ch: string) => boolean,
      field: (ch: string, run: number) => string,
    ): string {
      let out = '';
      let i = 0;
      while (i < picture.length) {
        const ch = picture[i]!;
        // Keep DBCS pairs intact even when the trail byte is an ASCII format token.
        if (ch.charCodeAt(0) >= 0x81 && ch.charCodeAt(0) <= 0xfe) {
          out += picture.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === "'") {
          if (picture[i + 1] === "'") {
            out += "'"; // '' escapes a single quote.
            i += 2;
            continue;
          }
          i++;
          while (i < picture.length && picture[i] !== "'") out += picture[i++]!;
          i++; // Skip the closing quote; an unterminated literal simply ends the picture.
          continue;
        }
        if (ch === '\\' && i + 1 < picture.length) {
          out += picture[i + 1]!;
          i += 2;
          continue;
        }
        if (isToken(ch)) {
          let run = 1;
          while (picture[i + run] === ch) {
            run++;
          }
          out += field(ch, run);
          i += run;
          continue;
        }
        out += ch;
        i++;
      }
      return out;
    }
    /** Expand one date picture letter: d[dd|ddd|dddd], M[MM|MMM|MMMM], y[yy|yyyy] and g (era). */
    protected dateField(ch: string, run: number, date: SystemTimeFields): string {
      switch (ch.toLowerCase()) {
        case 'd':
          if (run >= 4) return WEEKDAY_LONG_NAMES[date.weekday] ?? '';
          if (run === 3) return WEEKDAY_SHORT_NAMES[date.weekday] ?? '';
          return padNumber(date.day, run === 2 ? 2 : 1);
        case 'm':
          if (run >= 4) return MONTH_LONG_NAMES[date.month - 1] ?? '';
          if (run === 3) return MONTH_SHORT_NAMES[date.month - 1] ?? '';
          return padNumber(date.month, run === 2 ? 2 : 1);
        case 'y':
          if (run >= 4) return padNumber(date.year, 4);
          return run === 2 ? padNumber(date.year % 100, 2) : String(date.year % 100);
        default:
          return 'AD'; // 'g': the shim only carries the Gregorian era.
      }
    }
    /** Expand one time picture letter: h/H[hh|HH], m[mm], s[ss] and t|tt for the AM/PM marker. */
    protected timeField(ch: string, run: number, time: SystemTimeFields): string {
      const hour = ch === 'H' ? time.hour : time.hour % 12 || 12;
      switch (ch.toLowerCase()) {
        case 'h':
          return padNumber(hour, run >= 2 ? 2 : 1);
        case 'm':
          return padNumber(time.minute, run >= 2 ? 2 : 1);
        case 's':
          return padNumber(time.second, run >= 2 ? 2 : 1);
        default:
          return time.hour < 12 ? (run >= 2 ? 'AM' : 'A') : run >= 2 ? 'PM' : 'P';
      }
    }
    /** GetDateFormatA mirrors GetTimeFormatA's buffer protocol: return the required size including the NUL. */
    protected writeLocaleString(buffer: number, cch: number, value: string): number {
      const required = value.length + 1;
      if (cch === 0) {
        this.lastError = 0;
        return required;
      }
      if (!buffer || cch < required) {
        this.lastError = ERROR_INSUFFICIENT_BUFFER;
        return 0;
      }
      this.memory.write_memory(Uint8Array.from([...Array.from(value, (ch) => ch.charCodeAt(0)), 0]), buffer);
      this.lastError = 0;
      return required;
    }
    /** Format pictures are guest bytes, not decoded Unicode; output must retain the guest's code page. */
    private readLocalePicture(pointer: number): string {
      const bytes = this.readBytes(pointer, 256);
      const end = bytes.indexOf(0);
      return String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end));
    }
    /**
     * GetDateFormatA honors the picture string RA2 supplies for its save-slot labels; a NULL format falls back to
     * the invariant short/long patterns.
     */
    protected getDateFormatA(flags: number, datePtr: number, formatPtr: number, buffer: number, cch: number): number {
      const date = datePtr ? this.readSystemTimeFields(datePtr) : this.localSystemTimeFields();
      // GetDateFormat ignores the time half of SYSTEMTIME and derives the weekday itself.
      const calendarDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
      if (
        date.year < 1601 ||
        date.year > 30827 ||
        calendarDate.getUTCFullYear() !== date.year ||
        calendarDate.getUTCMonth() !== date.month - 1 ||
        calendarDate.getUTCDate() !== date.day ||
        cch < 0
      ) {
        this.lastError = 87;
        return 0;
      }
      date.weekday = calendarDate.getUTCDay();
      const picture = formatPtr
        ? this.readLocalePicture(formatPtr)
        : flags & DATE_LONGDATE
          ? 'dddd, MMMM d, yyyy'
          : flags & DATE_YEARMONTH
            ? 'MMMM yyyy'
            : 'M/d/yyyy'; // DATE_SHORTDATE and dwFlags == 0 share the invariant short pattern.
      const value = this.expandPicture(
        picture,
        (ch) => 'dMyg'.includes(ch),
        (ch, run) => this.dateField(ch, run, date),
      );
      return this.writeLocaleString(buffer, cch, value);
    }
    /** GetTimeFormatA mirrors GetDateFormatA with the TIME_ flags; the save screen formats date and time together. */
    protected getTimeFormatA(flags: number, timePtr: number, formatPtr: number, buffer: number, cch: number): number {
      const time = timePtr ? this.readSystemTimeFields(timePtr) : this.localSystemTimeFields();
      // GetTimeFormat ignores date fields, which callers may leave uninitialized.
      if (time.hour > 23 || time.minute > 59 || time.second > 59 || cch < 0) {
        this.lastError = 87;
        return 0;
      }
      let picture: string;
      if (formatPtr) {
        picture = this.readLocalePicture(formatPtr);
      } else {
        const twentyFourHour = (flags & TIME_FORCE24HOURFORMAT) !== 0;
        picture = twentyFourHour ? 'HH' : 'h';
        if (!(flags & TIME_NOMINUTESORSECONDS)) picture += ':mm';
        if (!(flags & (TIME_NOSECONDS | TIME_NOMINUTESORSECONDS))) picture += ':ss';
        if (!twentyFourHour && !(flags & TIME_NOTIMEMARKER)) picture += ' tt';
      }
      const value = this.expandPicture(
        picture,
        (ch) => 'hHmst'.includes(ch),
        (ch, run) => this.timeField(ch, run, time),
      );
      return this.writeLocaleString(buffer, cch, value);
    }
    /** Read the two 32-bit halves of a guest FILETIME as one unsigned 64-bit value. */
    protected readFileTimeValue(ptr: number): bigint {
      return BigInt(this.readU32(ptr)) | (BigInt(this.readU32(ptr + 4)) << 32n);
    }
    protected writeFileTimeValue(ptr: number, value: bigint): void {
      this.writeU32(ptr, Number(value & 0xffff_ffffn));
      this.writeU32(ptr + 4, Number((value >> 32n) & 0xffff_ffffn));
    }
    /** FILETIME -> host Date; null when the value falls outside JavaScript's representable range. */
    protected fileTimeToDate(value: bigint): Date | null {
      const unixMilliseconds =
        Number(value / FILETIME_TICKS_PER_MILLISECOND) - Number(FILETIME_UNIX_EPOCH / FILETIME_TICKS_PER_MILLISECOND);
      if (!Number.isFinite(unixMilliseconds)) return null;
      const date = new Date(unixMilliseconds);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    /** Inverse of systemTimeToFileTime, writing UTC fields: RA2 save listings compare these after conversion. */
    protected fileTimeToSystemTime(fileTime: number, systemTime: number): boolean {
      if (!fileTime || !systemTime) {
        this.lastError = 87; // ERROR_INVALID_PARAMETER
        return false;
      }
      const value = this.readFileTimeValue(fileTime);
      const date = value < 0x8000_0000_0000_0000n ? this.fileTimeToDate(value) : null;
      if (!date) {
        this.lastError = 87;
        return false;
      }
      this.writeSystemTimeFields(systemTime, [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDay(),
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
        date.getUTCMilliseconds(),
      ]);
      this.lastError = 0;
      return true;
    }
    /** Win32 FileTimeToLocalFileTime uses the current timezone bias, matching GetTimeZoneInformation. */
    protected fileTimeToLocalFileTime(fileTime: number, localFileTime: number): boolean {
      if (!fileTime || !localFileTime) {
        this.lastError = 87;
        return false;
      }
      const value = this.readFileTimeValue(fileTime);
      const bias =
        BigInt(new Date(this.clock.wallNow()).getTimezoneOffset()) * 60_000n * FILETIME_TICKS_PER_MILLISECOND;
      const local = value - bias;
      if (local < 0n || local > 0xffff_ffff_ffff_ffffn) {
        this.lastError = 87;
        return false;
      }
      this.writeFileTimeValue(localFileTime, local);
      this.lastError = 0;
      return true;
    }
    /** CompareFileTime returns -1/0/1; unsigned FILETIME ordering matches chronological ordering. */
    protected compareFileTime(left: number, right: number): number {
      if (!left || !right) {
        this.lastError = 87;
        return 0;
      }
      const a = this.readFileTimeValue(left);
      const b = this.readFileTimeValue(right);
      return a < b ? 0xffff_ffff : a > b ? 1 : 0;
    }
    /** Pack a FILETIME (UTC) into packed FAT date/time WORDs; no timezone conversion, as RtlTimeToTimeFields does. */
    protected fileTimeToDosDateTime(fileTime: number, fatDate: number, fatTime: number): boolean {
      if (!fileTime) {
        this.lastError = 87;
        return false;
      }
      const date = this.fileTimeToDate(this.readFileTimeValue(fileTime));
      const year = date?.getUTCFullYear() ?? 0;
      if (!date || year < 1980 || year > 2107) {
        this.lastError = 87;
        return false;
      }
      if (fatDate) {
        const packed = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
        this.memory.write_memory([packed & 0xff, (packed >>> 8) & 0xff], fatDate);
      }
      if (fatTime) {
        const packed = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
        this.memory.write_memory([packed & 0xff, (packed >>> 8) & 0xff], fatTime);
      }
      this.lastError = 0;
      return true;
    }
    /** Inverse of fileTimeToDosDateTime: FAT date/time fields are decoded as UTC, then range-checked. */
    protected dosDateTimeToFileTime(fatDate: number, fatTime: number, fileTime: number): boolean {
      if (!fileTime) {
        this.lastError = 87;
        return false;
      }
      const year = 1980 + ((fatDate >> 9) & 0x7f);
      const month = (fatDate >> 5) & 0x0f;
      const day = fatDate & 0x1f;
      const hour = (fatTime >> 11) & 0x1f;
      const minute = (fatTime >> 5) & 0x3f;
      const second = (fatTime & 0x1f) * 2;
      if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
        this.lastError = 87;
        return false;
      }
      const unixMilliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
      const normalized = new Date(unixMilliseconds);
      if (
        normalized.getUTCFullYear() !== year ||
        normalized.getUTCMonth() !== month - 1 ||
        normalized.getUTCDate() !== day
      ) {
        this.lastError = 87;
        return false;
      }
      this.writeFileTimeValue(
        fileTime,
        BigInt(unixMilliseconds) * FILETIME_TICKS_PER_MILLISECOND + FILETIME_UNIX_EPOCH,
      );
      this.lastError = 0;
      return true;
    }
    /** GetFileTime reports the per-path FILETIMEs shared with SetFileTime and FindFirstFileA. */
    protected getFileTime(handle: number, creation: number, access: number, written: number): boolean {
      const file = this.fileHandles.get(handle);
      if (!file) {
        this.lastError = 6; // ERROR_INVALID_HANDLE
        return false;
      }
      const times = this.fileTimes.get(file.path);
      if (!times) {
        this.lastError = 2; // ERROR_FILE_NOT_FOUND
        return false;
      }
      if (creation) this.writeFileTimeValue(creation, times.created);
      if (access) this.writeFileTimeValue(access, times.accessed);
      if (written) this.writeFileTimeValue(written, times.written);
      this.lastError = 0;
      return true;
    }
    /** SetFileTime updates only the non-NULL fields, as Win32 does. */
    protected setFileTime(handle: number, creation: number, access: number, written: number): boolean {
      const file = this.fileHandles.get(handle);
      if (!file) {
        this.lastError = 6;
        return false;
      }
      const now = this.guestNowFileTime();
      const times = this.fileTimes.get(file.path) ?? { created: now, accessed: now, written: now };
      if (creation) times.created = this.readFileTimeValue(creation);
      if (access) times.accessed = this.readFileTimeValue(access);
      if (written) {
        times.written = this.readFileTimeValue(written);
        this.guestFileTimeOverrides.add(file.path);
      }
      this.fileTimes.set(file.path, times);
      this.lastError = 0;
      return true;
    }
    /** BY_HANDLE_FILE_INFORMATION (52 bytes); the file index is the handle so callers can compare identities. */
    protected getFileInformationByHandle(handle: number, information: number): boolean {
      const file = this.fileHandles.get(handle);
      if (!file || !information) {
        this.lastError = file ? 87 : 6;
        return false;
      }
      const times = this.fileTimes.get(file.path);
      this.zero(information, 52);
      this.writeU32(information, 0x80); // FILE_ATTRIBUTE_NORMAL
      this.writeFileTimeValue(information + 4, times?.created ?? 0n);
      this.writeFileTimeValue(information + 12, times?.accessed ?? 0n);
      this.writeFileTimeValue(information + 20, times?.written ?? 0n);
      this.writeU32(information + 28, (this.options.volumeSerial ?? 0x2001_0701) >>> 0);
      this.writeU32(information + 32, Math.floor(file.size / 0x1_0000_0000));
      this.writeU32(information + 36, file.size >>> 0);
      this.writeU32(information + 40, 1); // nNumberOfLinks
      this.writeU32(information + 44, 0); // nFileIndexHigh
      this.writeU32(information + 48, handle >>> 0); // nFileIndexLow
      this.lastError = 0;
      return true;
    }
    protected systemTimeToFileTime(systemTime: number, fileTime: number): boolean {
      if (!systemTime || !fileTime) {
        this.lastError = 87; // ERROR_INVALID_PARAMETER
        return false;
      }
      const year = this.readU16(systemTime);
      const month = this.readU16(systemTime + 2);
      const day = this.readU16(systemTime + 6);
      const hour = this.readU16(systemTime + 8);
      const minute = this.readU16(systemTime + 10);
      const second = this.readU16(systemTime + 12);
      const milliseconds = this.readU16(systemTime + 14);
      if (
        year < 1601 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        milliseconds > 999
      ) {
        this.lastError = 87;
        return false;
      }
      const unixMilliseconds = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
      const normalized = new Date(unixMilliseconds);
      if (
        !Number.isFinite(unixMilliseconds) ||
        normalized.getUTCFullYear() !== year ||
        normalized.getUTCMonth() !== month - 1 ||
        normalized.getUTCDate() !== day ||
        normalized.getUTCHours() !== hour ||
        normalized.getUTCMinutes() !== minute ||
        normalized.getUTCSeconds() !== second ||
        normalized.getUTCMilliseconds() !== milliseconds
      ) {
        this.lastError = 87;
        return false;
      }
      const value = BigInt(unixMilliseconds) * 10_000n + 116_444_736_000_000_000n;
      this.writeU32(fileTime, Number(value & 0xffff_ffffn));
      this.writeU32(fileTime + 4, Number((value >> 32n) & 0xffff_ffffn));
      this.lastError = 0;
      return true;
    }
  };
}
