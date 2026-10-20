import { expect, it, vi } from 'vitest';
import { createCommandQueueReader } from '../../src/games/shared/commandQueue';
import { createRa2CommandQueueReader } from '../../src/games/ra2/commandQueue';
import { createYrCommandQueueReader } from '../../src/games/yr/commandQueue';
import { createGuestMemory, writeU32 } from '../helpers/guestMemory';

it('只读出队历史、环回与执行标记；超过观测范围的记录不伪装为完整日志', () => {
  const memory = createGuestMemory();
  const outgoing = 0x1000,
    scheduled = 0x10000;
  const reader = createCommandQueueReader(memory, { signatures: [], outgoing, scheduled })!;
  writeU32(memory, outgoing + 8, 1);
  writeU32(memory, scheduled + 8, 2);
  const put = (base: number, slot: number, executed: boolean) => {
    const address = base + 12 + slot * 111;
    memory.write_memory([9, Number(executed), 1], address);
    writeU32(memory, address + 3, 123);
    writeU32(memory, address + 7, 456);
    memory.write_memory([6], address + 11);
  };
  put(outgoing, 0, false);
  put(scheduled, 16383, true);
  put(scheduled, 10, true);
  const write = vi.spyOn(memory, 'write_memory');
  expect(reader()).toEqual([
    { queue: 'outgoing', slot: 0, frame: 123, house: 1, targetId: 456, targetType: 6, flags: 0, executed: false },
    { queue: 'scheduled', slot: 16383, frame: 123, house: 1, targetId: 456, targetType: 6, flags: 1, executed: true },
  ]);
  expect(write).not.toHaveBeenCalled();
  writeU32(memory, outgoing, 129);
  expect(reader()).toBeNull();
});
it('错误签名及短读不得发布命令记录', () => {
  const memory = createGuestMemory();
  expect(createRa2CommandQueueReader(memory)).toBeNull();
  expect(createYrCommandQueueReader(memory)).toBeNull();
  const reader = createCommandQueueReader(memory, {
    signatures: [],
    outgoing: 0,
    scheduled: 12,
  })!;
  vi.spyOn(memory, 'read_memory').mockReturnValue(new Uint8Array(3));
  expect(reader()).toBeNull();
});

it('执行位只读 bit0：保留高7位，不能遗漏本机栈上构造的合法事件', () => {
  const memory = createGuestMemory(),
    outgoing = 0x1000,
    scheduled = 0x10000;
  const reader = createCommandQueueReader(memory, { signatures: [], outgoing, scheduled })!;
  for (const flags of [0x80, 0x81, 0xfe, 0xff]) {
    writeU32(memory, outgoing + 8, 1);
    memory.write_memory([9, flags, 1], outgoing + 12);
    expect(reader()).toEqual([
      expect.objectContaining({ queue: 'outgoing', house: 1, flags, executed: (flags & 1) !== 0 }),
    ]);
  }
});
