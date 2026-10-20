/**
 * Win32Shim file-layer unit tests with fake guest memory: mounting/_lopen/_lread/_llseek/_lclose, CreateFileA dispositions and error codes, onFileWrite writeback, and guest fast-mirror tables.
 */
import { describe, expect, it, vi } from 'vitest';
import { FAST_FILE_ENTRY_BYTES, FAST_FILE_HANDLE_BASE, FAST_FILE_TABLE } from '../../src/vm86/shim/state';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeAsciiZ,
  writeU32,
  type FakeGuestMemory,
} from '../helpers/guestMemory';
import type { Win32Shim } from '../../src/games/win32Shim';

const INVALID = 0xffff_ffff;
/** Store test strings here, away from the low-address area used internally by the shim. */
const STR = 0x0010_0000;
const BUF = 0x0011_0000;
/** FILETIME counts 100ns intervals since 1601-01-01; the shim uses the same epoch constant. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
/** Scratch areas for FILETIME/SYSTEMTIME/DOS date-time/BY_HANDLE_FILE_INFORMATION round trips. */
const FT_A = 0x0012_0000;
const FT_B = 0x0012_0010;
const ST = 0x0012_0020;
const DOS_DATE = 0x0012_0030;
const DOS_TIME = 0x0012_0032;
const INFO = 0x0012_0100;
/** Format picture and formatted-output buffers for GetDateFormatA/GetTimeFormatA. */
const FMT = 0x0012_0040;
const FMT_OUT = 0x0012_0080;

function writeFileTime(memory: FakeGuestMemory, address: number, value: bigint): void {
  writeU32(memory, address, Number(value & 0xffff_ffffn));
  writeU32(memory, address + 4, Number((value >> 32n) & 0xffff_ffffn));
}
function readFileTime(memory: FakeGuestMemory, address: number): bigint {
  return BigInt(readU32(memory, address)) | (BigInt(readU32(memory, address + 4)) << 32n);
}
function fileTimeFromUnixMilliseconds(milliseconds: number): bigint {
  return BigInt(milliseconds) * 10_000n + FILETIME_UNIX_EPOCH;
}
function readU16(memory: FakeGuestMemory, address: number): number {
  const b = memory.read_memory(address, 2);
  return b[0]! | (b[1]! << 8);
}
/** SYSTEMTIME is eight consecutive WORDs; date 2024-06-07 is a Friday (weekday index 5). */
function writeSystemTimeFields(memory: FakeGuestMemory, address: number, values: readonly number[]): void {
  for (let i = 0; i < values.length; i++) {
    memory.write_memory([values[i]! & 0xff, (values[i]! >>> 8) & 0xff], address + i * 2);
  }
}
function readAsciiZ(memory: FakeGuestMemory, address: number, max = 64): string {
  const bytes = memory.read_memory(address, max);
  const end = bytes.indexOf(0);
  return String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end));
}

function lopen(shim: Win32Shim, memory: FakeGuestMemory, path: string, flags = 0): number {
  writeAsciiZ(memory, STR, path);
  return callShim(shim, 'KERNEL32.DLL!_lopen', [STR, flags]).eax;
}
function lread(shim: Win32Shim, handle: number, count: number): number {
  return callShim(shim, 'KERNEL32.DLL!_lread', [handle, BUF, count]).eax;
}

describe('_lopen/_lread/_llseek/_lclose', () => {
  it('读挂载文件：顺序读、seek 后续读、EOF 归 0', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\data.bin', new Uint8Array([1, 2, 3, 4, 5]));
    const handle = lopen(shim, memory, 'C:\\GAME\\data.bin');
    expect(handle).not.toBe(INVALID);
    expect(lread(shim, handle, 3)).toBe(3);
    expect(memory.read_memory(BUF, 3)).toEqual(new Uint8Array([1, 2, 3]));
    // FILE_BEGIN seeks back to 1, then reads
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 1, 0]).eax).toBe(1);
    expect(lread(shim, handle, 2)).toBe(2);
    expect(memory.read_memory(BUF, 2)).toEqual(new Uint8Array([2, 3]));
    // FILE_END seeks to the end -> EOF
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 2]).eax).toBe(5);
    expect(lread(shim, handle, 1)).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [handle]).eax).toBe(0);
  });

  it('稀疏挂载保留完整逻辑长度，未提供的数据区按零读取', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('movies.mix', new Uint8Array([1, 2, 3, 4]), true, 100);
    const handle = lopen(shim, memory, 'movies.mix');
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 98, 0]).eax).toBe(98);
    expect(lread(shim, handle, 4)).toBe(2);
    expect(memory.read_memory(BUF, 2)).toEqual(new Uint8Array([0, 0]));
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 2]).eax).toBe(100);
  });

  it('稀疏挂载可在 ReadFile 前按区间补页而不分配完整容器', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('movies.mix', new Uint8Array([1, 2, 3, 4]), true, 10 * 1024 * 1024);
    shim.markFileRangeBacked('movies.mix');
    const handle = lopen(shim, memory, 'movies.mix');
    expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 3 * 1024 * 1024 + 7, 0]).eax).toBe(3 * 1024 * 1024 + 7);
    expect(shim.inspectFileReadRequest(handle, 4)).toEqual({
      path: 'movies.mix',
      offset: 2 * 1024 * 1024,
      length: 2 * 1024 * 1024,
      totalSize: 10 * 1024 * 1024,
    });
    shim.mountFileRange('movies.mix', 2 * 1024 * 1024, new Uint8Array(2 * 1024 * 1024).fill(0x5a));
    expect(shim.inspectFileReadRequest(handle, 4)).toBeNull();
    expect(lread(shim, handle, 4)).toBe(4);
    expect(memory.read_memory(BUF, 4)).toEqual(new Uint8Array([0x5a, 0x5a, 0x5a, 0x5a]));
  });

  it.each([false, true])(
    'rejects unavailable range-backed bytes before copying (fast mirrors=%s)',
    (enableFastFileMirror) => {
      const memory = createGuestMemory();
      const shim = createTestShim(memory, { enableFastFileMirror });
      shim.mountFile('paged.bin', new Uint8Array([1, 2]), true, 8);
      shim.markFileRangeBacked('paged.bin');
      const handle = lopen(shim, memory, 'paged.bin');
      const entry = FAST_FILE_TABLE + (handle - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
      expect(readU32(memory, entry)).toBe(0);
      memory.write_memory([0xcc, 0xcc, 0xcc, 0xcc], BUF);
      const countPtr = BUF + 16;
      writeU32(memory, countPtr, 99);
      expect(callShim(shim, 'KERNEL32.DLL!ReadFile', [handle, BUF, 4, countPtr, 0]).eax).toBe(0);
      expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(30);
      expect(readU32(memory, countPtr)).toBe(0);
      expect(lread(shim, handle, 4)).toBe(-1);
      expect(memory.read_memory(BUF, 4)).toEqual(new Uint8Array([0xcc, 0xcc, 0xcc, 0xcc]));
      expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 1]).eax).toBe(0);
      expect(lread(shim, handle, 0)).toBe(0);
      shim.mountFileRange('paged.bin', 2, new Uint8Array([3, 4, 5, 6, 7, 8]));
      expect(lread(shim, handle, 4)).toBe(4);
      expect(memory.read_memory(BUF, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(callShim(shim, 'KERNEL32.DLL!_llseek', [handle, 0, 2]).eax).toBe(8);
      expect(lread(shim, handle, 4)).toBe(0);
    },
  );

  it('打开缺失文件返回 HFILE_ERROR 并置 GetLastError=2', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    expect(lopen(shim, memory, 'C:\\GAME\\nope.bin')).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(2);
  });

  it('_lcreat 对虚拟目录失败（ERROR_ACCESS_DENIED）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeAsciiZ(memory, STR, 'C:\\GAME');
    expect(callShim(shim, 'KERNEL32.DLL!_lcreat', [STR, 0]).eax).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(5);
  });

  it('_lcreat + _lwrite 写回：关闭时 onFileWrite 收到完整内容', () => {
    const memory = createGuestMemory();
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const shim = createTestShim(memory, {
      onFileWrite: (path, bytes) => writes.push({ path, bytes }),
    });
    writeAsciiZ(memory, STR, 'C:\\GAME\\out.sav');
    const handle = callShim(shim, 'KERNEL32.DLL!_lcreat', [STR, 0]).eax;
    expect(handle).not.toBe(INVALID);
    memory.write_memory(new Uint8Array([9, 8, 7]), BUF);
    expect(callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, BUF, 3]).eax).toBe(3);
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [handle]).eax).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe('game/out.sav');
    expect(writes[0]!.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(shim.getMountedFileBytes('C:\\GAME\\out.sav')).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('只读句柄写入被拒绝（ERROR_ACCESS_DENIED）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\ro.bin', new Uint8Array([1]));
    const handle = lopen(shim, memory, 'C:\\GAME\\ro.bin', 0); // OF_READ
    memory.write_memory([2], BUF);
    // writeFile failure returns -1 (dispatch has not yet truncated to u32).
    expect(callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, BUF, 1]).eax).toBe(-1);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(5);
  });
});

describe('CreateFileA disposition', () => {
  const ACCESS_READ = 0x8000_0000;
  function createFile(shim: Win32Shim, memory: FakeGuestMemory, path: string, disposition: number): number {
    writeAsciiZ(memory, STR, path);
    return callShim(shim, 'KERNEL32.DLL!CreateFileA', [STR, ACCESS_READ, 0, 0, disposition, 0, 0]).eax;
  }

  it('OPEN_EXISTING 缺失 → INVALID + 2；存在 → 句柄 + 0', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    expect(createFile(shim, memory, 'C:\\GAME\\none.bin', 3)).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(2);
    shim.mountFile('C:\\GAME\\yes.bin', new Uint8Array([1]));
    const handle = createFile(shim, memory, 'C:\\GAME\\yes.bin', 3);
    expect(handle).not.toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]).eax).toBe(1);
  });

  it('CREATE_NEW 已存在 → INVALID + 80；OPEN_ALWAYS 已存在 → 句柄 + 183', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\dup.bin', new Uint8Array([1]));
    expect(createFile(shim, memory, 'C:\\GAME\\dup.bin', 1)).toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(80); // ERROR_FILE_EXISTS
    const handle = createFile(shim, memory, 'C:\\GAME\\dup.bin', 4);
    expect(handle).not.toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(183); // ERROR_ALREADY_EXISTS
  });

  it('CREATE_ALWAYS 截断已存在文件', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { onFileWrite: () => {} });
    shim.mountFile('C:\\GAME\\trunc.bin', new Uint8Array([1, 2, 3]));
    const handle = createFile(shim, memory, 'C:\\GAME\\trunc.bin', 2);
    expect(handle).not.toBe(INVALID);
    expect(shim.getMountedFileBytes('C:\\GAME\\trunc.bin')).toEqual(new Uint8Array());
  });

  it('盘根路径探测返回可关闭的哑句柄（CD 检查兼容）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const handle = createFile(shim, memory, 'C:\\', 3);
    expect(handle).not.toBe(INVALID);
    expect(callShim(shim, 'KERNEL32.DLL!CloseHandle', [handle]).eax).toBe(1);
  });
});

describe('客体内快速镜像（fast _lread 表）', () => {
  it('配置档案 allowlist 时仍镜像 Bink 叶文件', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      enableFastFileMirror: true,
      fastFileMirrorFiles: ['langmd.mix'],
    });
    shim.mountFile('C:\\GAME\\ra2ts_l.bik', new Uint8Array([1, 2, 3, 4]));
    const handle = lopen(shim, memory, 'C:\\GAME\\ra2ts_l.bik');
    const entry = FAST_FILE_TABLE + (handle - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    expect(readU32(memory, entry + 12)).toBe(1);

    shim.mountFile('C:\\GAME\\not-listed.bin', new Uint8Array([1, 2, 3, 4]));
    const excluded = lopen(shim, memory, 'C:\\GAME\\not-listed.bin');
    const excludedEntry = FAST_FILE_TABLE + (excluded - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    expect(readU32(memory, excludedEntry + 12)).toBe(0);
  });

  it('打开即镜像：句柄表项记录镜像地址/大小/位置/就绪标志', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { enableFastFileMirror: true });
    shim.mountFile('C:\\GAME\\fast.bin', new Uint8Array([1, 2, 3, 4, 5]));
    const handle = lopen(shim, memory, 'C:\\GAME\\fast.bin');
    const entry = FAST_FILE_TABLE + (handle - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    const mirror = readU32(memory, entry);
    expect(mirror).toBeGreaterThanOrEqual(0x0070_0000); // Mirror allocated from the shim heap
    expect(readU32(memory, entry + 4)).toBe(5); // Size
    expect(readU32(memory, entry + 8)).toBe(0); // Position
    expect(readU32(memory, entry + 12)).toBe(1); // Ready
    expect(memory.read_memory(mirror, 5)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

    // Host _lread and guest fast stubs share the table's position.
    expect(lread(shim, handle, 2)).toBe(2);
    expect(readU32(memory, entry + 8)).toBe(2);

    // Closing releases the mirror and clears the table entry.
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [handle]).eax).toBe(0);
    expect(readU32(memory, entry + 12)).toBe(0);
  });

  it('客体写入时镜像降级回 hypercall 路径', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { enableFastFileMirror: true, onFileWrite: () => {} });
    shim.mountFile('C:\\GAME\\rw.bin', new Uint8Array([1, 2, 3, 4]));
    writeAsciiZ(memory, STR, 'C:\\GAME\\rw.bin');
    const handle = callShim(shim, 'KERNEL32.DLL!_lopen', [STR, 2]).eax; // OF_READWRITE
    const entry = FAST_FILE_TABLE + (handle - FAST_FILE_HANDLE_BASE) * FAST_FILE_ENTRY_BYTES;
    expect(readU32(memory, entry + 12)).toBe(1); // Mirrored
    memory.write_memory([9], BUF);
    expect(callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, BUF, 1]).eax).toBe(1);
    expect(readU32(memory, entry + 12)).toBe(0); // Mirror removed
    expect(shim.getMountedFileBytes('C:\\GAME\\rw.bin')).toEqual(new Uint8Array([9, 2, 3, 4]));
  });

  it('持久只读镜像释放宿主副本，重开和慢读仍以客体镜像为准', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, {
      enableFastFileMirror: true,
      fastFileMirrorBase: 0x00d0_0000,
      fastFileMirrorTop: 0x00e0_0000,
      fastFileMirrorLimit: 0x0010_0000,
    });
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    shim.mountFile('archive.mix', original, true);

    const first = lopen(shim, memory, 'archive.mix');
    expect(lread(shim, first, 3)).toBe(3);
    expect(memory.read_memory(BUF, 3)).toEqual(new Uint8Array([1, 2, 3]));
    expect(callShim(shim, 'KERNEL32.DLL!_lclose', [first]).eax).toBe(0);
    expect(shim.hasMountedFile('archive.mix')).toBe(true);

    const second = lopen(shim, memory, 'archive.mix');
    expect(lread(shim, second, 5)).toBe(5);
    expect(memory.read_memory(BUF, 5)).toEqual(original);
    expect(shim.getMountedFileBytes('archive.mix')).toEqual(original);
  });
});

describe('FILETIME 族（保存游戏路径）', () => {
  it.each([
    [-480, Date.UTC(2026, 8, 21, 13, 48, 30)],
    [330, Date.UTC(2026, 8, 21, 0, 18, 30)],
    [0, Date.UTC(2026, 8, 21, 5, 48, 30)],
  ])('local save time uses the full timezone offset (%i minutes)', (offset, expected) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeFileTime(memory, FT_A, fileTimeFromUnixMilliseconds(Date.UTC(2026, 8, 21, 5, 48, 30)));
    const timezone = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(offset);
    try {
      expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [FT_A, FT_B]).eax).toBe(1);
      expect(readFileTime(memory, FT_B)).toBe(fileTimeFromUnixMilliseconds(expected));
    } finally {
      timezone.mockRestore();
    }
  });

  it('FileTimeToLocalFileTime uses the current host timezone bias', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const instant = Date.UTC(2024, 0, 15, 3, 4, 5);
    const utc = fileTimeFromUnixMilliseconds(instant);
    writeFileTime(memory, FT_A, utc);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [FT_A, FT_B]).eax).toBe(1);
    const localFieldsAsUtc = instant - new Date().getTimezoneOffset() * 60_000;
    expect(readFileTime(memory, FT_B)).toBe(fileTimeFromUnixMilliseconds(localFieldsAsUtc));
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(0);

    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0, FT_B]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(87);
  });

  it('CompareFileTime 返回 -1/0/1，且比较完整的 64 位值', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeFileTime(memory, FT_A, 1000n);
    writeFileTime(memory, FT_B, 2000n);
    expect(callShim(shim, 'KERNEL32.DLL!CompareFileTime', [FT_A, FT_B]).eax).toBe(0xffff_ffff);
    expect(callShim(shim, 'KERNEL32.DLL!CompareFileTime', [FT_B, FT_A]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!CompareFileTime', [FT_A, FT_A]).eax).toBe(0);

    // 高位参与比较：0x1_0000_0000 > 0xffff_ffff，只看低 32 位会得到错误结论。
    writeFileTime(memory, FT_A, 0x1_0000_0000n);
    writeFileTime(memory, FT_B, 0x0_ffff_ffffn);
    expect(callShim(shim, 'KERNEL32.DLL!CompareFileTime', [FT_A, FT_B]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!CompareFileTime', [FT_B, FT_A]).eax).toBe(0xffff_ffff);
  });

  it('FileTimeToSystemTime 与 SystemTimeToFileTime 往返一致', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const instant = Date.UTC(2024, 5, 7, 8, 9, 10, 123);
    writeFileTime(memory, FT_A, fileTimeFromUnixMilliseconds(instant));
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToSystemTime', [FT_A, ST]).eax).toBe(1);
    expect([
      readU16(memory, ST),
      readU16(memory, ST + 2),
      readU16(memory, ST + 6),
      readU16(memory, ST + 8),
      readU16(memory, ST + 10),
      readU16(memory, ST + 12),
      readU16(memory, ST + 14),
    ]).toEqual([2024, 6, 7, 8, 9, 10, 123]);
    expect(callShim(shim, 'KERNEL32.DLL!SystemTimeToFileTime', [ST, FT_B]).eax).toBe(1);
    expect(readFileTime(memory, FT_B)).toBe(fileTimeFromUnixMilliseconds(instant));
  });

  it('FileTimeToDosDateTime 与 DosDateTimeToFileTime 往返一致（2 秒分辨率）', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const instant = Date.UTC(2024, 5, 7, 8, 9, 10); // 偶数秒，避免 FAT 舍入
    writeFileTime(memory, FT_A, fileTimeFromUnixMilliseconds(instant));
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToDosDateTime', [FT_A, DOS_DATE, DOS_TIME]).eax).toBe(1);
    expect(readU16(memory, DOS_DATE)).toBe(((2024 - 1980) << 9) | (6 << 5) | 7);
    expect(readU16(memory, DOS_TIME)).toBe((8 << 11) | (9 << 5) | (10 >> 1));

    expect(
      callShim(shim, 'KERNEL32.DLL!DosDateTimeToFileTime', [readU16(memory, DOS_DATE), readU16(memory, DOS_TIME), FT_B])
        .eax,
    ).toBe(1);
    expect(readFileTime(memory, FT_B)).toBe(fileTimeFromUnixMilliseconds(instant));

    // 非法月份（0）被拒绝。
    expect(callShim(shim, 'KERNEL32.DLL!DosDateTimeToFileTime', [((2024 - 1980) << 9) | 7, 0, FT_B]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(87);
  });

  it('GetFileTime/SetFileTime 通过路径共享，且只更新非空字段', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\times.bin', new Uint8Array([1]));
    const handle = lopen(shim, memory, 'C:\\GAME\\times.bin');
    expect(handle).not.toBe(INVALID);

    expect(callShim(shim, 'KERNEL32.DLL!GetFileTime', [handle, FT_A, FT_B, INFO]).eax).toBe(1);
    const mounted = readFileTime(memory, FT_A);
    expect(mounted).toBeGreaterThan(0n);

    const custom = fileTimeFromUnixMilliseconds(Date.UTC(2001, 0, 2, 3, 4, 5));
    writeFileTime(memory, FT_B, custom);
    expect(callShim(shim, 'KERNEL32.DLL!SetFileTime', [handle, FT_B, 0, 0]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!GetFileTime', [handle, FT_A, FT_B, INFO]).eax).toBe(1);
    expect(readFileTime(memory, FT_A)).toBe(custom); // 已更新
    expect(readFileTime(memory, FT_B)).toBe(mounted); // 未传入的字段保持原值

    expect(callShim(shim, 'KERNEL32.DLL!GetFileTime', [0xdead, FT_A, FT_B, INFO]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(6); // ERROR_INVALID_HANDLE
  });

  it('GetFileInformationByHandle 报告 BY_HANDLE_FILE_INFORMATION 的大小与时间', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.mountFile('C:\\GAME\\info.bin', new Uint8Array([1, 2, 3, 4, 5]));
    const handle = lopen(shim, memory, 'C:\\GAME\\info.bin');
    expect(handle).not.toBe(INVALID);

    expect(callShim(shim, 'KERNEL32.DLL!GetFileInformationByHandle', [handle, INFO]).eax).toBe(1);
    expect(readU32(memory, INFO)).toBe(0x80); // FILE_ATTRIBUTE_NORMAL
    expect(readU32(memory, INFO + 28)).not.toBe(0); // dwVolumeSerialNumber
    expect(readU32(memory, INFO + 32)).toBe(0); // nFileSizeHigh
    expect(readU32(memory, INFO + 36)).toBe(5); // nFileSizeLow
    expect(readU32(memory, INFO + 40)).toBe(1); // nNumberOfLinks
    expect(readU32(memory, INFO + 48)).toBe(handle >>> 0); // nFileIndexLow
    expect(readFileTime(memory, INFO + 20)).toBeGreaterThan(0n); // ftLastWriteTime

    expect(callShim(shim, 'KERNEL32.DLL!GetFileInformationByHandle', [0xdead, INFO]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(6);
  });
});

describe('GetDateFormatA/GetTimeFormatA（保存日期标签）', () => {
  /** 2024-06-07 20:09:10.123, a Friday, shared by the format tests. */
  const DATE_VALUES = [2024, 6, 5, 7, 20, 9, 10, 123];

  function setup() {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTimeFields(memory, ST, DATE_VALUES);
    return { memory, shim };
  }

  it('按游戏传入的图片串格式化，引号与反斜杠字面量原样输出', () => {
    const { memory, shim } = setup();
    writeAsciiZ(memory, FMT, "MM'/'dd'/'yyyy");
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x400, 0, ST, FMT, FMT_OUT, 32]).eax).toBe(11);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('06/07/2024');
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(0);

    writeAsciiZ(memory, FMT, 'yyyy\\-MM');
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x400, 0, ST, FMT, FMT_OUT, 32]).eax).toBe(8);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('2024-06');
  });

  it('未提供图片串时按 DATE_ 标志回落到短/长日期', () => {
    const { memory, shim } = setup();
    // dwFlags == 0 与 DATE_SHORTDATE 使用同一短日期样式。
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x400, 0, ST, 0, FMT_OUT, 32]).eax).toBe(9);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('6/7/2024');

    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x400, 0x2, ST, 0, FMT_OUT, 32]).eax).toBe(21);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('Friday, June 7, 2024');
  });

  it('cchDate 为 0 返回所需长度，缓冲不足报 ERROR_INSUFFICIENT_BUFFER', () => {
    const { memory, shim } = setup();
    writeAsciiZ(memory, FMT, 'MM/dd/yyyy');
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x400, 0, ST, FMT, 0, 0]).eax).toBe(11);

    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x400, 0, ST, FMT, FMT_OUT, 10]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(122);

    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x400, 0, ST, FMT, FMT_OUT, 11]).eax).toBe(11);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('06/07/2024');
  });

  it('GetTimeFormatA 支持 12/24 小时制与 AM/PM 标记', () => {
    const { memory, shim } = setup();
    writeAsciiZ(memory, FMT, 'hh:mm:ss tt');
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x400, 0, ST, FMT, FMT_OUT, 32]).eax).toBe(12);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('08:09:10 PM');

    writeAsciiZ(memory, FMT, 'HH:mm');
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x400, 0, ST, FMT, FMT_OUT, 32]).eax).toBe(6);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('20:09');

    // TIME_FORCE24HOURFORMAT 抑制 AM/PM 标记。
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x400, 0x8, ST, 0, FMT_OUT, 32]).eax).toBe(9);
    expect(readAsciiZ(memory, FMT_OUT)).toBe('20:09:10');
  });
});
