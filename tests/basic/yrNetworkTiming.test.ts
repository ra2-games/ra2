import { expect, it, vi } from 'vitest';
import { installYrLanTiming } from '../../src/games/yr/networkTiming';
import { createGuestMemory } from '../helpers/guestMemory';

// From SHA-256-verified YR 1.001; public tests do not depend on a private EXE.
const fixtures = [
  [0x5b6546, [185, 5, 0, 0, 0, 59, 198, 137, 13, 84, 181, 168, 0]],
  [0x5baec5, [184, 5, 0, 0, 0, 137, 21, 96, 235, 168, 0, 139, 21, 76, 178, 168, 0, 59, 214, 163, 84, 181, 168, 0]],
  [0x5dd2d8, [184, 5, 0, 0, 0, 59, 206, 163, 84, 181, 168, 0]],
  [0x5dd498, [184, 5, 0, 0, 0, 59, 207, 163, 84, 181, 168, 0]],
] as const;
const negotiationFixtures = [
  [0x6476bf, [246, 193, 127, 15, 133, 186, 4, 0, 0]],
  [0x647ba7, [160, 132, 237, 168, 0, 132, 192, 15, 133, 130, 3, 0, 0]],
] as const;
const allocateCode = () => 0x100000;
const allFixtures = [...fixtures, ...negotiationFixtures];
it('YR 四处安装独立跳板，重复安装失败；不匹配的指令拒绝安装', () => {
  const memory = createGuestMemory();
  for (const [address, bytes] of allFixtures) memory.write_memory([...bytes], address);
  for (const [address, bytes] of fixtures) expect([...memory.read_memory(address, bytes.length)]).toEqual([...bytes]);
  expect(installYrLanTiming(memory, allocateCode)).toBe(true);
  for (const [address, bytes] of fixtures) {
    const expected: number[] = [...bytes];
    expected.splice(0, 5, 0xe8, ...[0, 8, 16, 24].map((shift) => ((0x100000 - address - 5) >>> shift) & 255));
    expect([...memory.read_memory(address, bytes.length)]).toEqual(expected);
  }
  expect(() => installYrLanTiming(memory, allocateCode)).toThrow('签名');
});
it('最后一个 YR 签名损坏也不能留下部分补丁', () => {
  const memory = createGuestMemory();
  for (const [address, bytes] of allFixtures) memory.write_memory([...bytes], address);
  memory.write_memory([0], fixtures[3][0]);
  expect(() => installYrLanTiming(memory, allocateCode)).toThrow('签名');
  for (const [address] of fixtures) expect(memory.read_memory(address + 1, 1)[0]).toBe(5);
});

it('协商指令只缩短报告和计算周期，保留帧读取与条件跳转', () => {
  const memory = createGuestMemory();
  for (const [address, bytes] of allFixtures) memory.write_memory([...bytes], address);
  installYrLanTiming(memory, allocateCode);
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
    expect(() => installYrLanTiming(memory, allocateCode)).toThrow('签名');
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
  expect(() => installYrLanTiming(memory, allocate)).toThrow('动态 stub');
  for (const [address, bytes] of allFixtures)
    expect([...memory.read_memory(address, bytes.length)]).toEqual([...bytes]);
});
