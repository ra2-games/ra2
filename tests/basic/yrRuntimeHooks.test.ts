import { describe, expect, it } from 'vitest';
import { skipYrStartupMovies, writeYrGameSpeed } from '../../src/games/yr/runtimeHooks';
import { createGuestMemory, readU32, writeU32 } from '../helpers/guestMemory';

function writeCpuCalibration(memory: ReturnType<typeof createGuestMemory>): void {
  memory.write_memory(new Uint8Array([0x55, 0x8b, 0xec, 0x83, 0xec, 0x34, 0x53, 0x56]), 0x005a_bf70);
  memory.write_memory(new Uint8Array([0x3d, 0xe8, 0x03, 0x00, 0x00]), 0x005a_bfee);
  memory.write_memory(new Uint8Array([0x81, 0xfa, 0xe8, 0x03, 0x00, 0x00]), 0x005a_c006);
  memory.write_memory(new Uint8Array([0x83, 0xf8, 0x14]), 0x005a_c0a9);
}

describe('YR 运行态护栏', () => {
  it('YR 的启动钩子不修改 RA2 的测速地址', () => {
    const memory = createGuestMemory();
    writeCpuCalibration(memory);
    const original = memory.read_memory(0x005a_bf70, 0x200).slice();

    skipYrStartupMovies(memory);

    expect(memory.read_memory(0x005a_bf70, 0x200)).toEqual(original);
  });

  it('仅在已验证签名上跳过 YR EA_WWLOGO 并保留共同收尾', () => {
    const memory = createGuestMemory();
    const address = 0x0052_c5e0;
    memory.write_memory(new Uint8Array([0x8b, 0xd5, 0xb9, 0x20, 0x5f]), address);

    expect(skipYrStartupMovies(memory)).toBe(true);
    expect([...memory.read_memory(address, 5)]).toEqual([0xe9, 0x0e, 0x00, 0x00, 0x00]);
    expect(skipYrStartupMovies(memory)).toBe(true);

    memory.write_memory(new Uint8Array([0x90, 0x90, 0x90, 0x90, 0x90]), address);
    expect(skipYrStartupMovies(memory)).toBe(false);
  });

  it('按 YR 1.001 的 Settings 单例写回 GameSpeed 并拒绝脏指针', () => {
    const memory = createGuestMemory(160 * 1024 * 1024);
    const settings = 0x0014_0000;
    writeU32(memory, 0x0088_71e0, settings);
    writeU32(memory, settings + 0x14a0, 3);

    expect(writeYrGameSpeed(memory, 1)).toBe(1);
    expect(readU32(memory, settings + 0x14a0)).toBe(1);
    expect(writeYrGameSpeed(memory, 7)).toBeNull();
    writeU32(memory, 0x0088_71e0, 0xdead_beef);
    expect(writeYrGameSpeed(memory, 3)).toBeNull();
  });
});
