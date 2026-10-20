import { expect, it } from 'vitest';
import { GUEST_THREAD_LIMIT } from '../../../src/vm86/pe';
import { call32, finish, le32, PROGRAM, push32, withGuestMachine } from '../../helpers/guestMachine';

it('reuses exited guest threads beyond the slot limit with clean x87 state and bounded stacks', async () => {
  await withGuestMachine(async (m) => {
    const data = 0x310000,
      worker = PROGRAM + 0x20000;
    const create = m.api('CreateThread', 24),
      wait = m.api('WaitForSingleObject', 8),
      close = m.api('CloseHandle', 4);
    const iterations = GUEST_THREAD_LIMIT * 3;
    const baseline = m.shim.inspectHeapState().liveBytes;
    m.write(data + 64, 0x0b7f);
    m.code(worker, [
      0xd9,
      0x35,
      ...le32(data + 16), // FNSTENV records the initial control and tag words.
      0xd9,
      0xe8,
      0xdb,
      0x1d,
      ...le32(data + 48), // FLD1; FISTP: execute x87, not just inspect saved bytes.
      0xd9,
      0x2d,
      ...le32(data + 64),
      0xd9,
      0xe8, // Leave a different control word and a nonempty x87 stack.
      0x31,
      0xc0,
      0xc2,
      4,
      0, // Returning invokes the production ExitThread trampoline.
    ]);
    const controlWords: number[] = [],
      tagWords: number[] = [],
      values: number[] = [],
      ids: number[] = [];
    m.afterCall = (call) => {
      if (call.imported.name === 'CreateThread') ids.push(m.read(data + 4));
      if (call.imported.name === 'WaitForSingleObject') {
        controlWords.push(m.read(data + 16) & 0xffff);
        tagWords.push(m.read(data + 24) & 0xffff);
        values.push(m.read(data + 48));
      }
    };
    const cycle = [
      ...push32(data + 4),
      ...push32(0),
      ...push32(0),
      ...push32(worker),
      ...push32(0x10000),
      ...push32(0),
      ...call32(create),
      0xa3,
      ...le32(data),
      ...push32(0xffffffff),
      0x50,
      ...call32(wait),
      0xff,
      0x35,
      ...le32(data),
      ...call32(close),
    ];
    m.code(PROGRAM, [...Array.from({ length: iterations }, () => cycle).flat(), ...finish]);
    await m.run();
    // Public thread IDs are slot index + 1; slot 0 belongs to the main thread.
    expect(ids).toEqual(new Array(iterations).fill(2));
    expect(controlWords).toEqual(new Array(iterations).fill(0x037f));
    expect(tagWords).toEqual(new Array(iterations).fill(0xffff));
    expect(values).toEqual(new Array(iterations).fill(1));
    expect(m.shim.inspectGuestThreads().filter((thread) => thread.terminated)).toHaveLength(1);
    expect(m.shim.inspectHeapState().liveBytes - baseline).toBe(0x10000);
  });
});
