import { expect, it } from 'vitest';
import { call32, finish, le32, PROGRAM, push32, store32, withGuestMachine } from '../../helpers/guestMachine';

it('executes CRT initializers in the guest, skips null slots and preserves cdecl caller cleanup', async () => {
  await withGuestMachine(async (m) => {
    const table = 0x300100;
    const result = 0x300200;
    const first = PROGRAM + 0x1000;
    const last = PROGRAM + 0x1100;
    const init = m.api('_initterm', 0, undefined, 'MSVCRT.DLL');
    m.write(table, first);
    // A later callback is installed by the first initializer, not by the host.
    m.code(first, [...store32(table + 8, last), ...store32(result, 17), 0xc3]);
    m.code(last, [0x83, 0x05, ...le32(result), 3, 0xc3]);
    m.code(PROGRAM, [
      0x89,
      0x25,
      ...le32(result + 4),
      ...push32(table + 12),
      ...push32(table),
      ...call32(init),
      0x83,
      0xc4,
      8,
      0x89,
      0x25,
      ...le32(result + 8),
      ...finish,
    ]);
    await m.run();
    expect(m.read(result)).toBe(20);
    expect(m.read(result + 8)).toBe(m.read(result + 4));
  });
});
