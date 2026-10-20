import { expect, it } from 'vitest';
import { buildGuestHook } from '../../../src/vm86/guestHooks';
import { withGuestMachine, PROGRAM, le32, finish } from '../../helpers/guestMachine';

it.each([false, true])('native hook restores registers/flags and branches (redirect=%s)', async (redirect) => {
  await withGuestMachine(async (m) => {
    const stub = PROGRAM + 0x1000;
    const callback = PROGRAM + 0x2000;
    const continuation = PROGRAM + 0x3000;
    const result = 0x300100;
    const expected = Uint8Array.from([0x83, 0xc3, 1, 0x90, 0x90]); // add ebx,1
    m.code(PROGRAM, [
      0xbb,
      ...le32(20),
      0xf9,
      0xe9,
      ...le32(stub - (PROGRAM + 11)),
      ...expected,
      0x89,
      0x1d,
      ...le32(result),
      ...finish,
    ]);
    m.code(
      stub,
      buildGuestHook(stub, { address: PROGRAM + 11, displaced: 5, expected, exports: ['test'] }, [callback]),
    );
    // Read the cdecl frame, replace EBX, and preserve incoming carry.
    m.code(callback, [
      0x8b,
      0x44,
      0x24,
      4,
      0xc7,
      0x40,
      24,
      ...le32(40),
      0xb8,
      ...le32(redirect ? continuation : 0),
      0xc3,
    ]);
    m.code(continuation, [0x89, 0x1d, ...le32(result), 0x9c, 0x58, 0xa3, ...le32(result + 4), ...finish]);
    await m.run();
    expect(m.read(result)).toBe(redirect ? 40 : 41);
    if (redirect) expect(m.read(result + 4) & 1).toBe(1);
  });
});
