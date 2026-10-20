/** ScaledClock unit tests: continuity across speed changes, clamping, and host-delay conversion. */
import { describe, expect, it } from 'vitest';
import { normalizeGameClockRate, ScaledClock } from '../../src/vm86/clock';
import { callShim, createGuestMemory, createTestShim } from '../helpers/guestMemory';

/** Manually advanced host clock. */
function fakeClock(start = 10_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('ScaledClock', () => {
  it('运行时钟从 0 开始，墙钟保留宿主纪元', () => {
    const host = fakeClock();
    const clock = new ScaledClock(host.now);
    expect(clock.now()).toBe(0);
    expect(clock.wallNow()).toBe(10_000);
    host.advance(1000);
    expect(clock.now()).toBe(1_000);
    expect(clock.wallNow()).toBe(11_000);
  });

  it('倍率切换瞬间客体时间不跳变、不倒退', () => {
    const host = fakeClock();
    const clock = new ScaledClock(host.now);
    host.advance(1000);
    clock.setRate(2);
    const atSwitch = clock.now();
    expect(atSwitch).toBe(1_000);
    host.advance(1000);
    expect(clock.now()).toBe(3_000); // Advance at 2x
    clock.setRate(0.5);
    expect(clock.now()).toBe(3_000); // Continuous at the switch point
    host.advance(1000);
    expect(clock.now()).toBe(3_500);
  });

  it('多次切换后累计值等于分段之和', () => {
    const host = fakeClock(0);
    const clock = new ScaledClock(host.now);
    host.advance(100); // 1× → +100
    clock.setRate(4);
    host.advance(100); // 4× → +400
    clock.setRate(0.25);
    host.advance(400); // 0.25× → +100
    expect(clock.now()).toBe(600);
  });

  it('倍率钳制在 [0.25, 8]，非法输入回 1', () => {
    expect(normalizeGameClockRate(100)).toBe(8);
    expect(normalizeGameClockRate(0)).toBe(0.25);
    expect(normalizeGameClockRate(Number.NaN)).toBe(1);
    expect(normalizeGameClockRate(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizeGameClockRate(2)).toBe(2);
  });

  it('toHostDelay 按倍率换算，非正数/非有限值归 0', () => {
    const host = fakeClock();
    const clock = new ScaledClock(host.now);
    clock.setRate(4);
    expect(clock.toHostDelay(1000)).toBe(250);
    expect(clock.toGuestDelay(250)).toBe(1000);
    clock.setRate(0.5);
    expect(clock.toHostDelay(1000)).toBe(2000);
    expect(clock.toGuestDelay(2000)).toBe(1000);
    expect(clock.toHostDelay(0)).toBe(0);
    expect(clock.toHostDelay(-5)).toBe(0);
    expect(clock.toHostDelay(Number.NaN)).toBe(0);
    expect(clock.toGuestDelay(Number.NaN)).toBe(0);
  });

  it('单调运行时钟与墙钟使用独立纪元', () => {
    const host = fakeClock(1_000);
    const clock = new ScaledClock(host.now, () => 50_000);
    host.advance(250);
    expect(clock.now()).toBe(250);
    expect(clock.wallNow()).toBe(50_250);
  });
});

describe('KERNEL32 时间结构写回（RA2 增补，原 clockSmoke）', () => {
  // RA2's home page reads local SYSTEMTIME and TIME_ZONE_INFORMATION consecutively. Both must be registered
  // in the ABI table and write their complete Win32 structures back to guest memory.
  it('GetLocalTime/GetTimeZoneInformation 把 Win32 结构完整写回客体内存', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { firstDynamicId: 1 });
    const view = new DataView(memory.bytes.buffer);

    const localTime = 0x3000;
    expect(callShim(shim, 'KERNEL32.DLL!GetLocalTime', [localTime], 0x2000).eax).toBe(0);
    expect(view.getUint16(localTime, true), 'GetLocalTime 未写入有效年份').toBeGreaterThanOrEqual(2020);
    expect(view.getUint16(localTime + 2, true)).toBeGreaterThanOrEqual(1);
    expect(view.getUint16(localTime + 2, true)).toBeLessThanOrEqual(12);
    expect(view.getUint16(localTime + 6, true)).toBeGreaterThanOrEqual(1);
    expect(view.getUint16(localTime + 6, true)).toBeLessThanOrEqual(31);

    const zoneInfo = 0x3100;
    memory.bytes.fill(0xa5, zoneInfo, zoneInfo + 172);
    const expectedBias = new Date().getTimezoneOffset();
    expect(callShim(shim, 'KERNEL32.DLL!GetTimeZoneInformation', [zoneInfo], 0x2000).eax).toBe(0);
    expect(view.getInt32(zoneInfo, true)).toBe(expectedBias);
    expect(
      memory.bytes.subarray(zoneInfo + 4, zoneInfo + 172).every((byte) => byte === 0),
      'TIME_ZONE_INFORMATION 未完整初始化',
    ).toBe(true);
  });

  it('SystemTimeToFileTime 按 UTC 转换并拒绝非法日期', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const view = new DataView(memory.bytes.buffer);
    const systemTime = 0x3200;
    const fileTime = 0x3220;
    const values = [2024, 2, 4, 29, 12, 34, 56, 789];
    values.forEach((value, index) => view.setUint16(systemTime + index * 2, value, true));
    expect(callShim(shim, 'KERNEL32.DLL!SystemTimeToFileTime', [systemTime, fileTime]).eax).toBe(1);
    const actual = BigInt(view.getUint32(fileTime, true)) | (BigInt(view.getUint32(fileTime + 4, true)) << 32n);
    const expected = BigInt(Date.UTC(2024, 1, 29, 12, 34, 56, 789)) * 10_000n + 116_444_736_000_000_000n;
    expect(actual).toBe(expected);

    view.setUint16(systemTime + 2, 2, true);
    view.setUint16(systemTime + 6, 30, true);
    expect(callShim(shim, 'KERNEL32.DLL!SystemTimeToFileTime', [systemTime, fileTime]).eax).toBe(0);
    expect(callShim(shim, 'KERNEL32.DLL!GetLastError', []).eax).toBe(87);
  });
});
