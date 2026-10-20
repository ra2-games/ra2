import { describe, expect, it, vi } from 'vitest';
import { installRa2BattleStartup } from '../../src/games/ra2/battleStartup';
import { installYrBattleStartup } from '../../src/games/yr/battleStartup';
import { createGuestMemory } from '../helpers/guestMemory';
import { withGuestMachine, PROGRAM, le32, finish } from '../helpers/guestMachine';

const signature = [0x8b, 0x44, 0x24, 4, 0x3d, 0x17, 6, 0, 0, 0x74, 0x22];
describe.each([
  {
    game: 'ra2' as const,
    install: installRa2BattleStartup,
    site: 0x683c79,
    handler: 0x6829f0,
    navigation: 0x513762,
    mov: 0xbd,
    reg: 0xe9,
  },
  {
    game: 'yr' as const,
    install: installYrBattleStartup,
    site: 0x6ae34e,
    handler: 0x6acee0,
    navigation: 0x52db12,
    mov: 0xbe,
    reg: 0xf1,
  },
])('$game 一次性原生开局', ({ install, site, handler, navigation, mov, reg }) => {
  const nav = [mov, 18, 0, 0, 0, 0xeb, 0x0d, 0x33, 0xc9, 0x83, 0xf8, 4, 0x0f, 0x94, 0xc1, 0x83, 0xc1, 0x10, 0x8b, reg];
  it('签名、桩区冲突和重复安装必须拒绝', () => {
    const memory = createGuestMemory();
    memory.write_memory(signature, site);
    memory.write_memory(nav, navigation);
    const reserve = vi.fn(() => 0x90000);
    memory.write_memory([0], site);
    expect(() => install(memory, reserve)).toThrow('签名');
    expect(reserve).not.toHaveBeenCalled();
    memory.write_memory(signature, site);
    expect(() => install(memory, () => 0xbfff0)).toThrow('越界');
    memory.write_memory([1], 0x90000);
    expect(() => install(memory, reserve)).toThrow('占用');
    memory.write_memory([0], 0x90000);
    expect(() => install(memory, reserve)).toThrow('重叠');
    let next = 0x90000;
    install(memory, (size) => {
      const base = next;
      next += size;
      return base;
    });
    expect(() => install(memory, reserve)).toThrow('重复');
    expect([...memory.read_memory(site + 9, 2)]).toEqual(signature.slice(9));
  });
  it('真实 x86：只调用一次，fastcall 参数正确，恢复寄存器并重放原始比较', async () => {
    await withGuestMachine(async (m) => {
      m.code(site, signature);
      m.code(navigation, nav);
      let next = 0x90000;
      const state = install(m.memory, (size) => {
        const base = next;
        next += size;
        return base;
      });
      const result = 0x310000;
      m.code(handler, [
        0xff,
        0x05,
        ...le32(result),
        0x89,
        0x0d,
        ...le32(result + 4),
        0x89,
        0x15,
        ...le32(result + 8),
        0x8b,
        0x44,
        0x24,
        4,
        0xa3,
        ...le32(result + 12),
        0x8b,
        0x44,
        0x24,
        8,
        0xa3,
        ...le32(result + 16),
        0x31,
        0xc9,
        0x31,
        0xd2,
        0xc2,
        8,
        0,
      ]);
      m.code(site + 9, [0xc3]);
      const code = [
        0xbe,
        ...le32(0x12345678),
        0xb9,
        ...le32(0xabc),
        0xba,
        ...le32(0xdef),
        0x89,
        0x25,
        ...le32(result + 20),
      ];
      for (let i = 0; i < 2; i++) {
        code.push(0x68, ...le32(0x617));
        code.push(0xe8, ...le32(site - (PROGRAM + code.length + 5)));
        code.push(0x9c, 0x8f, 0x05, ...le32(result + 24 + i * 4), 0x83, 0xc4, 4);
      }
      code.push(
        0x89,
        0x25,
        ...le32(result + 32),
        0x89,
        0x0d,
        ...le32(result + 36),
        0x89,
        0x15,
        ...le32(result + 40),
        ...finish,
      );
      m.code(PROGRAM, code);
      await m.run();
      expect(m.read(result)).toBe(1);
      expect(m.read(result + 4)).toBe(0x12345678);
      expect(m.read(result + 8)).toBe(0x617);
      expect(m.read(result + 12)).toBe(0);
      expect(m.read(result + 16)).toBe(0);
      expect(m.read(result + 20)).toBe(m.read(result + 32));
      expect(m.read(result + 24) & 0x40).toBe(0x40);
      expect(m.read(result + 28) & 0x40).toBe(0x40);
      expect(m.read(result + 36)).toBe(0xabc);
      expect(m.read(result + 40)).toBe(0xdef);
      expect(m.read(state)).toBe(0);
    });
  });
});
