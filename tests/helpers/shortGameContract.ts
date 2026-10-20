import { describe, expect, it } from 'vitest';
import { patchRa2ShortGame } from '../../src/games/ra2/shortGame';
import { skipYrStartupMovies } from '../../src/games/yr/runtimeHooks';
import { createGuestMemory } from './guestMemory';
import { call32, finish, le32, PROGRAM, store32, withGuestMachine } from './guestMachine';

/** Unit tests and real EXE tests share assertions, differing only in instruction sources; public CI neither reads nor downloads games. */
export function describeShortGameContract(readBytes: (address: number, size: number) => Uint8Array): void {
  const address = 0x4e4a9c;
  const original = Uint8Array.from(readBytes(address, 55));
  describe('RA2 快速游戏完整基地车列表补丁', () => {
    it.each([
      { name: '美国', counts: [1, 0, 0], buildings: 0, expected: 1 },
      { name: '苏联', counts: [0, 1, 0], buildings: 0, expected: 1 },
      { name: '中国第三项', counts: [0, 0, 1], buildings: 0, expected: 1 },
      { name: '多种基地车累计', counts: [2, 3, 4], buildings: 0, expected: 1 },
      { name: '基地车与建筑全无仍判负', counts: [0, 0, 0], buildings: 0, expected: 0 },
      { name: '展开为建筑后仍存活', counts: [0, 0, 0], buildings: 1, expected: 1 },
      { name: '空列表安全判负', counts: [], buildings: 0, expected: 0 },
    ])('真实 x86 执行：$name', async ({ counts, buildings, expected }) => {
      await withGuestMachine(async (m) => {
        const house = 0x100000,
          rules = 0x110000,
          list = 0x120000,
          counters = 0x130000,
          result = 0x300100;
        m.write(0x839848, rules);
        m.write(rules + 0x9d4, list);
        m.write(rules + 0x9e0, counts.length);
        m.write(house + 0x230, buildings);
        m.write(house + 0x5434, counters);
        m.write(house + 0x5438, counts.length);
        counts.forEach((value, index) => {
          const type = 0x140000 + index * 0x1000;
          m.write(list + index * 4, type);
          m.write(type + 0xb90, index);
          m.write(counters + index * 4, value);
        });
        // Execute the patch and caller-provided continuation for building/defeat branches; place test sentinels only at the two branch endpoints.
        m.code(address, readBytes(address, 0x4e4aeb - address));
        expect(patchRa2ShortGame(m.memory)).toBe(true);
        m.code(0x4e4b72, [...store32(result, 1), 0xc3]);
        m.code(0x4e4b64, [...store32(result, 0), 0xc3]);
        m.code(PROGRAM, [
          0xfa,
          0xbe,
          ...le32(house),
          0x89,
          0x25,
          ...le32(result + 4),
          ...call32(address),
          0x89,
          0x25,
          ...le32(result + 8),
          0x89,
          0x3d,
          ...le32(result + 12),
          ...finish,
        ]);
        await m.run();
        expect(m.read(result)).toBe(expected);
        expect(m.read(result + 8)).toBe(m.read(result + 4));
        expect(m.read(result + 12)).toBe(counts.reduce((a, b) => a + b, 0));
      });
    });

    it('只改目标 55 字节，可重复调用，后续建筑与判败分支保持不变', () => {
      const memory = createGuestMemory();
      memory.write_memory(readBytes(address - 16, 96), address - 16);
      const before = memory.read_memory(address - 16, 96).slice();
      expect(patchRa2ShortGame(memory)).toBe(true);
      expect(memory.read_memory(address, 55)).not.toEqual(original);
      expect(memory.read_memory(address - 16, 16)).toEqual(before.subarray(0, 16));
      expect(memory.read_memory(address + 55, 25)).toEqual(before.subarray(71));
      const patched = memory.read_memory(address, 55).slice();
      expect(patchRa2ShortGame(memory)).toBe(true);
      expect(memory.read_memory(address, 55)).toEqual(patched);
    });

    it.each([0, 20, 54])('任意签名位置 %s 不匹配时完全不写入', (offset) => {
      const memory = createGuestMemory();
      const altered = original.slice();
      altered[offset] ^= 1;
      memory.write_memory(altered, address);
      expect(patchRa2ShortGame(memory)).toBe(false);
      expect(memory.read_memory(address, 55)).toEqual(altered);
    });

    it('YR 启动钩子不应用 RA2 补丁', () => {
      const memory = createGuestMemory();
      memory.write_memory(original, address);
      skipYrStartupMovies(memory);
      expect(memory.read_memory(address, 55)).toEqual(original);
    });
  });
}
