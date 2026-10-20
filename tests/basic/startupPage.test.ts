import { describe, expect, it, vi } from 'vitest';
import { installRa2SkirmishStartup, installRa2LanStartup } from '../../src/games/ra2/startupPage';
import { installYrSkirmishStartup, installYrLanStartup } from '../../src/games/yr/startupPage';
import { createGuestMemory } from '../helpers/guestMemory';
import { withGuestMachine, PROGRAM, le32, finish } from '../helpers/guestMachine';

const scratch = 0x90000;
describe.each([
  {
    game: 'RA2 遭遇战',
    target: 11,
    site: 0x513762,
    install: installRa2SkirmishStartup,
    immediate: 0xbd,
    register: 0xe9,
    store: 0x2d,
  },
  {
    game: 'YR 遭遇战',
    target: 11,
    site: 0x52db12,
    install: installYrSkirmishStartup,
    immediate: 0xbe,
    register: 0xf1,
    store: 0x35,
  },
  {
    game: 'RA2 LAN',
    target: 3,
    site: 0x513762,
    install: installRa2LanStartup,
    immediate: 0xbd,
    register: 0xe9,
    store: 0x2d,
  },
  {
    game: 'YR LAN',
    target: 3,
    site: 0x52db12,
    install: installYrLanStartup,
    immediate: 0xbe,
    register: 0xf1,
    store: 0x35,
  },
])('$game 一次性启动导航', ({ site, install, immediate, register, store, target }) => {
  const original = [
    immediate,
    0x12,
    0,
    0,
    0,
    0xeb,
    0x0d,
    0x33,
    0xc9,
    0x83,
    0xf8,
    0x04,
    0x0f,
    0x94,
    0xc1,
    0x83,
    0xc1,
    0x10,
    0x8b,
    register,
  ];
  it('错误签名在分配前拒绝，不修改游戏', () => {
    const memory = createGuestMemory(),
      reserve = vi.fn(() => scratch);
    memory.write_memory(original, site);
    memory.write_memory([0], site);
    expect(() => install(memory, reserve)).toThrow('签名');
    expect(reserve).not.toHaveBeenCalled();
  });
  it('拒绝冲突、越界和重复安装，后续原生分支不变', () => {
    const memory = createGuestMemory();
    memory.write_memory(original, site);
    expect(() => install(memory, () => 0xc0000)).toThrow('越界');
    memory.write_memory([1], scratch);
    expect(() => install(memory, () => scratch)).toThrow('占用');
    memory.write_memory([0], scratch);
    install(memory, () => scratch);
    expect([...memory.read_memory(site + 5, 15)]).toEqual(original.slice(5));
    expect(() => install(memory, () => scratch + 48)).toThrow('重复');
  });
  it('真实 x86：首次选择目标、之后恢复18，标志和栈不变', async () => {
    await withGuestMachine(async (m) => {
      m.code(site, original);
      const state = install(m.memory, () => scratch);
      m.code(site + 5, [0xc3]);
      const result = 0x310000;
      const code = [0xfa, 0x31, 0xc0, 0xf9, 0x89, 0x25, ...le32(result), 0x9c, 0x8f, 0x05, ...le32(result + 4)];
      for (let i = 0; i < 2; i++) {
        code.push(0xe8, ...le32(site - (PROGRAM + code.length + 5)), 0x89, store, ...le32(result + 8 + i * 4));
      }
      code.push(0x89, 0x25, ...le32(result + 16), 0x9c, 0x8f, 0x05, ...le32(result + 20), ...finish);
      m.code(PROGRAM, code);
      await m.run();
      expect(m.read(result + 8)).toBe(target);
      expect(m.read(result + 12)).toBe(18);
      expect(m.read(state)).toBe(18);
      expect(m.read(result)).toBe(m.read(result + 16));
      expect(m.read(result + 4)).toBe(m.read(result + 20));
    });
  });
});
