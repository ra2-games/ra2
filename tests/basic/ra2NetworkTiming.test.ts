import { expect, it, vi } from 'vitest';
import { installRa2LanTiming } from '../../src/games/ra2/networkTiming';
import { createGuestMemory } from '../helpers/guestMemory';

// Offline instruction fixtures from RA2 1.006; no game-file downloads required.
const fixtures = [
  [0x597ba6, [185, 5, 0, 0, 0, 59, 198, 137, 13, 100, 213, 163, 0]],
  [0x59c4ef, [184, 5, 0, 0, 0, 137, 21, 24, 11, 164, 0, 139, 21, 172, 210, 163, 0, 59, 214, 163, 100, 213, 163, 0]],
  [0x5bde16, [184, 5, 0, 0, 0, 59, 206, 163, 100, 213, 163, 0]],
  [0x5bdfd0, [184, 5, 0, 0, 0, 59, 207, 163, 100, 213, 163, 0]],
] as const;
const negotiationFixtures = [
  [0x623bcf, [246, 193, 127, 15, 133, 186, 4, 0, 0]],
  [0x6240b7, [160, 44, 13, 164, 0, 132, 192, 15, 133, 130, 3, 0, 0]],
] as const;
const allocateCode = () => 0x100000;
const allFixtures = [...fixtures, ...negotiationFixtures];
it('四条 LAN 初始化跳板保留相邻指令和重复安装保护', () => {
  const m = createGuestMemory();
  for (const [address, bytes] of allFixtures) m.write_memory([...bytes], address);
  expect(installRa2LanTiming(m, allocateCode)).toBe(true);
  for (const [address, bytes] of fixtures) {
    const expected: number[] = [...bytes];
    expected.splice(0, 5, 0xe8, ...[0, 8, 16, 24].map((shift) => ((0x100000 - address - 5) >>> shift) & 255));
    expect([...m.read_memory(address, bytes.length)]).toEqual(expected);
  }
  expect(() => installRa2LanTiming(m, allocateCode)).toThrow('签名');
});
it('YR/未知映像不修改，最后一个签名损坏也不能留下部分补丁', () => {
  const m = createGuestMemory();
  for (const [address, bytes] of allFixtures) m.write_memory([...bytes], address);
  m.write_memory([0], fixtures[3][0]);
  expect(() => installRa2LanTiming(m, allocateCode)).toThrow('签名');
  expect(m.read_memory(fixtures[0][0] + 1, 1)[0]).toBe(5);
});

it('协商指令只缩短报告和计算周期，保留帧读取与条件跳转', () => {
  const memory = createGuestMemory();
  for (const [address, bytes] of allFixtures) memory.write_memory([...bytes], address);
  installRa2LanTiming(memory, allocateCode);
  for (const [index, [address, bytes]] of negotiationFixtures.entries()) {
    const expected: number[] = [...bytes];
    if (index === 0) expected[2] = 31;
    else expected.splice(5, 2, 168, 63);
    expect([...memory.read_memory(address, bytes.length)]).toEqual(expected);
  }
});
it('任一协商签名损坏必须拒绝全部修改，包括已有发送间隔', () => {
  for (const [badAddress] of negotiationFixtures) {
    const memory = createGuestMemory();
    for (const [address, bytes] of allFixtures) memory.write_memory([...bytes], address);
    memory.write_memory([0], badAddress);
    expect(() => installRa2LanTiming(memory, allocateCode)).toThrow('签名');
    for (const [address, bytes] of allFixtures) {
      if (address !== badAddress) expect([...memory.read_memory(address, bytes.length)]).toEqual([...bytes]);
    }
  }
});

it('代码分配失败时不安装任何入口或协商修改', () => {
  const memory = createGuestMemory();
  for (const [address, bytes] of allFixtures) memory.write_memory([...bytes], address);
  const allocate = vi.fn(() => {
    throw new Error('动态 stub 区不足');
  });
  expect(() => installRa2LanTiming(memory, allocate)).toThrow('动态 stub');
  for (const [address, bytes] of allFixtures)
    expect([...memory.read_memory(address, bytes.length)]).toEqual([...bytes]);
});
