import { describe, expect, it } from 'vitest';
import {
  callShim,
  createGuestMemory,
  createTestShim,
  readU32,
  writeAsciiZ,
  writeU32,
  type FakeGuestMemory,
} from '../helpers/guestMemory';

const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;

function writeFileTime(memory: ReturnType<typeof createGuestMemory>, ptr: number, value: bigint): void {
  writeU32(memory, ptr, Number(value & 0xffff_ffffn));
  writeU32(memory, ptr + 4, Number(value >> 32n));
}

function readFileTime(memory: ReturnType<typeof createGuestMemory>, ptr: number): bigint {
  return BigInt(readU32(memory, ptr)) | (BigInt(readU32(memory, ptr + 4)) << 32n);
}

function readSystemTime(memory: ReturnType<typeof createGuestMemory>, ptr: number): number[] {
  const bytes = memory.read_memory(ptr, 16);
  return Array.from({ length: 8 }, (_, i) => bytes[i * 2]! | (bytes[i * 2 + 1]! << 8));
}

describe('KERNEL32 FILETIME 转换', () => {
  it('FileTimeToLocalFileTime 使用与 GetTimeZoneInformation 相同的宿主偏移', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const utc = FILETIME_UNIX_EPOCH + 1_700_000_000_000n * 10_000n;
    writeFileTime(memory, 0x3000, utc);

    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0x3000, 0x3010]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeZoneInformation', [0x3100]).eax).toBe(0);
    const bias = BigInt(readU32(memory, 0x3100) | 0);
    expect(readFileTime(memory, 0x3010)).toBe(utc - bias * 600_000_000n);
  });

  it('FileTimeToLocalFileTime 偏移越界时失败而不回绕', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeZoneInformation', [0x3100]).eax).toBe(0);
    const bias = readU32(memory, 0x3100) | 0;
    // Pick whichever end the host's bias pushes past: east of UTC overflows the top, west underflows below zero.
    // The old code masked the result into range and still reported success.
    writeFileTime(memory, 0x3000, bias <= 0 ? 0xffff_ffff_ffff_ffffn : 1n);
    writeFileTime(memory, 0x3010, 0xdead_beefn);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0x3000, 0x3010]).eax).toBe(bias === 0 ? 1 : 0);
    if (bias !== 0) expect(readFileTime(memory, 0x3010)).toBe(0xdead_beefn);
  });

  it('FileTimeToLocalFileTime 拒绝空指针', () => {
    const shim = createTestShim(createGuestMemory());
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0, 0x3010]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToLocalFileTime', [0x3000, 0]).eax).toBe(0);
  });

  it('FileTimeToSystemTime 与 SystemTimeToFileTime 往返一致，含星期几', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    // 2026-09-19 16:41:07.123, a Saturday.
    memory.write_memory(new Uint8Array(new Uint16Array([2026, 9, 0, 19, 16, 41, 7, 123]).buffer), 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!SystemTimeToFileTime', [0x3000, 0x3020]).eax).toBe(1);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToSystemTime', [0x3020, 0x3040]).eax).toBe(1);
    expect(readSystemTime(memory, 0x3040)).toEqual([2026, 9, 6, 19, 16, 41, 7, 123]);
  });

  it('FileTimeToSystemTime 拒绝符号位置位的 FILETIME', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeFileTime(memory, 0x3000, 0x8000_0000_0000_0000n);
    memory.write_memory(new Uint8Array(16).fill(0xa5), 0x3040);
    expect(callShim(shim, 'KERNEL32.DLL!FileTimeToSystemTime', [0x3000, 0x3040]).eax).toBe(0);
    expect(memory.read_memory(0x3040, 16)).toEqual(new Uint8Array(16).fill(0xa5));
  });
});

/** SYSTEMTIME: 2026-09-19 16:41:07.123, a Saturday. */
function writeSystemTime(memory: FakeGuestMemory, pointer: number): void {
  memory.write_memory(new Uint8Array(new Uint16Array([2026, 9, 0, 19, 16, 41, 7, 123]).buffer), pointer);
}

function readAscii(memory: FakeGuestMemory, pointer: number, max = 64): string {
  const bytes = memory.read_memory(pointer, max);
  const end = bytes.indexOf(0);
  return String.fromCharCode(...bytes.subarray(0, end < 0 ? bytes.length : end));
}

describe('KERNEL32 日期/时间格式化', () => {
  it.each([
    ['GetDateFormatA', "yyyy 'year' MM 'month' dd ''", "2026 year 09 month 19 '"],
    ['GetTimeFormatA', "HH 'hours' mm 'minutes' ss ''", "16 hours 41 minutes 07 '"],
    ['GetTimeFormatA', 'hH hhHH', '416 0416'],
  ])('%s preserves quoted literals and token case in %s', (api, picture, expected) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTime(memory, 0x3000);
    writeAsciiZ(memory, 0x3200, picture);
    expect(callShim(shim, `KERNEL32.DLL!${api}`, [0x400, 0, 0x3000, 0x3200, 0x3100, 64]).eax).toBe(expected.length + 1);
    expect(readAscii(memory, 0x3100)).toBe(expected);
  });

  it.each([
    ['GetDateFormatA', 'y'],
    ['GetDateFormatA', 'M'],
    ['GetTimeFormatA', 'H'],
    ['GetTimeFormatA', 'm'],
  ])('%s keeps a DBCS trail byte equal to %s literal', (api, trail) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTime(memory, 0x3000);
    const pair = [0x81, trail.charCodeAt(0)];
    const suffix = api === 'GetDateFormatA' ? 'yyyy' : 'HH';
    const expected = [...pair, 32, ...Array.from(api === 'GetDateFormatA' ? '2026' : '16', (c) => c.charCodeAt(0)), 0];
    memory.write_memory([...pair, 32, ...Array.from(suffix, (c) => c.charCodeAt(0)), 0], 0x3200);
    memory.write_memory(new Uint8Array(32).fill(0xa5), 0x3100);
    const args = [0x400, 0, 0x3000, 0x3200, 0x3100, expected.length];
    expect(callShim(shim, `KERNEL32.DLL!${api}`, args).eax).toBe(expected.length);
    expect([...memory.read_memory(0x3100, expected.length)]).toEqual(expected);
    expect(memory.read_memory(0x3100 + expected.length, 1)[0]).toBe(0xa5);
  });

  it.each([
    [0, '4:41:07 PM'],
    [1, '4 PM'],
    [2, '4:41 PM'],
    [4, '4:41:07'],
    [8, '16:41:07'],
    [9, '16'],
    [10, '16:41'],
  ])('honors default time flags 0x%s', (flags, expected) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTime(memory, 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x400, flags, 0x3000, 0, 0x3100, 64]).eax).toBe(
      expected.length + 1,
    );
    expect(readAscii(memory, 0x3100)).toBe(expected);
  });

  it.each(['GetDateFormatA', 'GetTimeFormatA'])(
    '%s rejects negative capacity and preserves output on short buffers',
    (api) => {
      const memory = createGuestMemory();
      const shim = createTestShim(memory);
      writeSystemTime(memory, 0x3000);
      const invoke = (buffer: number, capacity: number) =>
        callShim(shim, `KERNEL32.DLL!${api}`, [0x400, 0, 0x3000, 0, buffer, capacity]).eax;
      const required = invoke(0, 0);
      expect(required).toBeGreaterThan(1);
      memory.write_memory(new Uint8Array(64).fill(0xa5), 0x3100);
      expect(invoke(0x3100, -1)).toBe(0);
      expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(87);
      // Guest stack arguments arrive as unsigned DWORDs even though cch is a signed Win32 int.
      expect(invoke(0x3100, 0xffffffff)).toBe(0);
      expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(87);
      expect(invoke(0x3100, required - 1)).toBe(0);
      expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(122);
      expect(memory.read_memory(0x3100, 64)).toEqual(new Uint8Array(64).fill(0xa5));
      expect(invoke(0x3100, required)).toBe(required);
      expect(memory.read_memory(0x3100 + required - 1, 2)).toEqual(Uint8Array.from([0, 0xa5]));
    },
  );

  it('formats time while ignoring uninitialized date fields', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    memory.write_memory(new Uint8Array(new Uint16Array([0, 0, 0, 0, 16, 41, 7, 0]).buffer), 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x0400, 0x8, 0x3000, 0, 0x3100, 64]).eax).toBe(9);
    expect(readAscii(memory, 0x3100)).toBe('16:41:07');
    writeAsciiZ(memory, 0x3200, 'HH:mm:ss yyyy/MMMM/dd');
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x0400, 0, 0x3000, 0x3200, 0x3100, 64]).eax).toBeGreaterThan(
      0,
    );
    expect(readAscii(memory, 0x3100)).toBe('16:41:07 yyyy/MMMM/dd');
  });

  it('formats dates while ignoring uninitialized time fields and correcting the weekday', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    memory.write_memory(
      new Uint8Array(new Uint16Array([2026, 9, 0xffff, 19, 0xffff, 0xffff, 0xffff, 0xffff]).buffer),
      0x3000,
    );
    writeAsciiZ(memory, 0x3200, 'yyyy/MM/dd ddd');
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0, 0x3000, 0x3200, 0x3100, 64]).eax).toBe(15);
    expect(readAscii(memory, 0x3100)).toBe('2026/09/19 Sat');
    writeAsciiZ(memory, 0x3200, 'yyyy/MM/dd HH:mm:ss');
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0, 0x3000, 0x3200, 0x3100, 64]).eax).toBeGreaterThan(
      0,
    );
    expect(readAscii(memory, 0x3100)).toBe('2026/09/19 HH:mm:ss');
  });

  it.each([
    [2026, 2, 31],
    [2025, 2, 29],
    [1900, 2, 29],
    [2026, 4, 31],
  ])('rejects nonexistent dates %i/%i/%i without writing output', (year, month, day) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    memory.write_memory(new Uint8Array(new Uint16Array([year, month, 0, day, 0, 0, 0, 0]).buffer), 0x3000);
    memory.write_memory(new Uint8Array(64).fill(0xa5), 0x3100);
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0, 0x3000, 0, 0x3100, 64]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(87);
    expect(memory.read_memory(0x3100, 64)).toEqual(new Uint8Array(64).fill(0xa5));
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0, 0x3000, 0, 0, 0]).eax).toBe(0);
  });

  it.each([2000, 2024])('accepts leap day in %i', (year) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    memory.write_memory(new Uint8Array(new Uint16Array([year, 2, 0, 29, 0, 0, 0, 0]).buffer), 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0, 0x3000, 0, 0x3100, 64]).eax).toBe(10);
    expect(readAscii(memory, 0x3100)).toBe(`2/29/${year}`);
  });

  it.each([
    [24, 0, 0],
    [0, 60, 0],
    [0, 0, 60],
  ])('rejects invalid time %i:%i:%i', (hour, minute, second) => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    memory.write_memory(new Uint8Array(new Uint16Array([0, 0, 0, 0, hour, minute, second, 0]).buffer), 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x0400, 0x8, 0x3000, 0, 0x3100, 64]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError').eax).toBe(87);
  });

  it('GetDateFormatA 默认短日期，返回含结尾符的长度', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTime(memory, 0x3000);
    // LOCALE_USER_DEFAULT, DATE_SHORTDATE, no picture.
    const written = callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0x1, 0x3000, 0, 0x3100, 64]).eax;
    expect(readAscii(memory, 0x3100)).toBe('9/19/2026');
    expect(written).toBe('9/19/2026'.length + 1);
  });

  it('GetTimeFormatA 24 小时制标志与 TIME_NOSECONDS', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTime(memory, 0x3000);
    callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x0400, 0x8, 0x3000, 0, 0x3100, 64]);
    expect(readAscii(memory, 0x3100)).toBe('16:41:07');
    callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x0400, 0xa, 0x3000, 0, 0x3100, 64]);
    expect(readAscii(memory, 0x3100)).toBe('16:41');
  });

  it('formats named date fields and 12-hour time while retaining GBK bytes', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTime(memory, 0x3000);
    // Retain the original GBK bytes for 日 alongside formatted ASCII fields.
    memory.write_memory(
      Uint8Array.from([
        ...'ddd dd'.split('').map((c) => c.charCodeAt(0)),
        0xc8,
        0xd5,
        0x20,
        ...'MMM yy'.split('').map((c) => c.charCodeAt(0)),
        0,
      ]),
      0x3200,
    );
    callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0, 0x3000, 0x3200, 0x3100, 64]);
    expect([...memory.read_memory(0x3100, 16)]).toEqual([
      ...'Sat 19'.split('').map((c) => c.charCodeAt(0)),
      0xc8,
      0xd5,
      0x20,
      ...'Sep 26'.split('').map((c) => c.charCodeAt(0)),
      0,
    ]);
    writeAsciiZ(memory, 0x3200, 'hh:mm tt');
    callShim(shim, 'KERNEL32.DLL!GetTimeFormatA', [0x0400, 0, 0x3000, 0x3200, 0x3100, 64]);
    expect(readAscii(memory, 0x3100)).toBe('04:41 PM');
  });

  it('容量为 0 时只返回所需长度，容量不足时失败且不写入', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeSystemTime(memory, 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0x1, 0x3000, 0, 0, 0]).eax).toBe(10);
    memory.write_memory(new Uint8Array(16).fill(0xa5), 0x3100);
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0x1, 0x3000, 0, 0x3100, 4]).eax).toBe(0);
    expect(memory.read_memory(0x3100, 16)).toEqual(new Uint8Array(16).fill(0xa5));
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError', []).eax).toBe(122); // ERROR_INSUFFICIENT_BUFFER
  });

  it('非法 SYSTEMTIME 被拒绝，空指针表示当前本地时间', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    memory.write_memory(new Uint8Array(new Uint16Array([2026, 13, 0, 19, 16, 41, 7, 0]).buffer), 0x3000);
    expect(callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0x1, 0x3000, 0, 0x3100, 64]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError', []).eax).toBe(87);
    // A null SYSTEMTIME means "now", which must still produce this year's date.
    callShim(shim, 'KERNEL32.DLL!GetDateFormatA', [0x0400, 0x1, 0, 0, 0x3100, 64]);
    expect(readAscii(memory, 0x3100).endsWith(String(new Date().getFullYear()))).toBe(true);
  });
});
