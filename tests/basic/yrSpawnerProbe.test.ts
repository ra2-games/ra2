import { describe, expect, it, vi } from 'vitest';
import {
  installYrSpawnerProbe,
  YR_SPAWNER_PROBE_EXE_SHA256 as hash,
  YR_SPAWNER_PROBE_SITE as site,
} from '../../src/games/yr/spawnerProbe';
import { PeImageProbe } from '../../src/vm86/peProbe';
import { createGuestMemory } from '../helpers/guestMemory';
import { withGuestMachine, PROGRAM, le32, finish } from '../helpers/guestMachine';

// Reference instruction fixtures keep this diagnostic ABI regression independent of game files.
const original = [
  0x8b, 0x35, 0xd0, 0xc1, 0x81, 0, 0xb9, 0xfe, 0xff, 0xff, 0xff, 0xe8, 0xdb, 0xb8, 0xdb, 0xff, 0x6a, 0x28, 0xe8, 0x3b,
  0xb6, 0x10, 0, 0x83,
];
const scratch = 0x90000;
describe('YR Spawner 客体探针', () => {
  it('错误版本和字节拒绝安装，不分配、不写入', () => {
    const memory = createGuestMemory();
    const reserve = vi.fn(() => scratch);
    expect(() => installYrSpawnerProbe(memory, 'ra2', reserve)).toThrow('哈希');
    expect(() => installYrSpawnerProbe(memory, hash, reserve)).toThrow('签名');
    expect(reserve).not.toHaveBeenCalled();
  });
  it('非参考哈希只接受映像中唯一且位于探针点的完整签名', () => {
    const code = (placements: readonly number[]) => {
      const base = site - 0x100;
      const bytes = new Uint8Array(0x400);
      for (const address of placements) bytes.set(original, address - base);
      return new PeImageProbe([{ address: base, mappedSize: bytes.length, bytes, characteristics: 0x60000020 }]);
    };
    const reserve = vi.fn(() => scratch);
    for (const image of [null, code([]), code([site + 0x40]), code([site, site + 0x40])]) {
      const memory = createGuestMemory();
      memory.write_memory(original, site);
      expect(() => installYrSpawnerProbe(memory, 'other', reserve, image)).toThrow('哈希');
    }
    expect(reserve).not.toHaveBeenCalled();
    const memory = createGuestMemory();
    memory.write_memory(original, site);
    installYrSpawnerProbe(memory, 'other', () => scratch, code([site]));
    expect(memory.read_memory(site + 6, 18)).toEqual(new Uint8Array(original.slice(6)));
    // Image evidence never replaces the live-byte check.
    expect(() => installYrSpawnerProbe(createGuestMemory(), 'other', reserve, code([site]))).toThrow('签名');
  });
  it('只替换完整六字节，拒绝重装、重叠或非桩区分配', () => {
    const memory = createGuestMemory();
    memory.write_memory(original, site);
    expect(() => installYrSpawnerProbe(memory, hash, () => site)).toThrow('桩区');
    expect(() => installYrSpawnerProbe(memory, hash, () => 0xc0000)).toThrow('桩区');
    expect(() => installYrSpawnerProbe(memory, hash, () => scratch + 1)).toThrow('桩区');
    memory.write_memory([1], scratch);
    expect(() => installYrSpawnerProbe(memory, hash, () => scratch)).toThrow('占用');
    expect(memory.read_memory(site, 24)).toEqual(new Uint8Array(original));
    memory.write_memory([0], scratch);
    installYrSpawnerProbe(memory, hash, () => scratch);
    expect(memory.read_memory(site + 6, 18)).toEqual(new Uint8Array(original.slice(6)));
    expect(() => installYrSpawnerProbe(memory, hash, () => scratch + 96)).toThrow('已安装');
  });
  it('真实 x86：命中两次，保留所有通用寄存器、标志、栈，重放原 ESI 读取', async () => {
    await withGuestMachine(async (m) => {
      m.code(site, original);
      const probe = installYrSpawnerProbe(m.memory, hash, () => scratch);
      m.write(0x81c1d0, 0x12345678);
      const result = 0x310000;
      // The continuation saves the complete pushfd/pushad context; pops restore register changes made during copying.
      m.code(site + 6, [
        0x9c,
        0x60,
        0x89,
        0xe6,
        0xbf,
        ...le32(result),
        0xb9,
        ...le32(9),
        0xfc,
        0xf3,
        0xa5,
        0x61,
        0x9d,
        0xc3,
      ]);
      const code = [0xfa];
      for (const [opcode, value] of [
        [0xb8, 11],
        [0xb9, 22],
        [0xba, 33],
        [0xbb, 44],
        [0xbd, 55],
        [0xbe, 66],
        [0xbf, 77],
      ]) {
        code.push(opcode!, ...le32(value!));
      }
      code.push(0x39, 0xc0, 0xf9); // cmp eax,eax / stc: CF, ZF, and PF are 1
      code.push(0x89, 0x25, ...le32(result + 40), 0x9c, 0x8f, 0x05, ...le32(result + 44));
      for (let i = 0; i < 2; i++) code.push(0xe8, ...le32(site - (PROGRAM + code.length + 5)));
      code.push(...finish);
      m.code(PROGRAM, code);
      await m.run();
      expect(m.read(probe.countAddress)).toBe(2);
      expect(m.read(probe.stackAddress)).toBe(m.read(result + 40) - 4);
      expect([0, 1, 2, 4, 5, 6, 7].map((i) => m.read(result + i * 4))).toEqual([77, 0x12345678, 55, 44, 33, 22, 11]);
      expect(m.read(result + 12)).toBe(m.read(result + 40) - 8);
      expect(m.read(result + 32)).toBe(m.read(result + 44));
    });
  });
});
