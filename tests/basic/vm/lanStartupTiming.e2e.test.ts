import { expect, it } from 'vitest';
import { makeLanStartupTiming } from '../../../src/games/shared/lanStartupTiming';
import { withGuestMachine, PROGRAM, call32, finish, le32, store32 } from '../../helpers/guestMachine';

it('真实 x86 开局桩遵守所有房间档位，保存寄存器、标志和栈，后续速度可覆盖', async () => {
  await withGuestMachine(async (m) => {
    const speed = 0x301000,
      fps = speed + 4,
      output = speed + 32,
      stub = PROGRAM + 0x2000;
    const cases = [0, 1, 2, 3, 4, 5, 6, -1, 7];
    const expected = [60, 45, 30, 20, 15, 12, 10, 30, 30];
    const code: number[] = [];
    for (const [variant, opcode] of [0xb8, 0xb9].entries()) {
      m.code(stub + variant * 128, makeLanStartupTiming(speed, fps, opcode, variant ? 2 : 3));
      for (const [index, value] of cases.entries()) {
        const dest = output + (variant * cases.length + index) * 32;
        code.push(
          ...store32(speed, value),
          0xb9,
          ...le32(0x11223344),
          0xba,
          ...le32(0x55667788),
          0x89,
          0x25,
          ...le32(dest + 16), // esp before
          0x31,
          0xc0,
          0xf9,
          0x9c,
          0x8f,
          0x05,
          ...le32(dest + 24), // Save ZF/CF
          ...call32(stub + variant * 128),
          0xa3,
          ...le32(dest),
          0x89,
          0x0d,
          ...le32(dest + 4),
          0x89,
          0x15,
          ...le32(dest + 8),
          0x89,
          0x25,
          ...le32(dest + 20),
          0x9c,
          0x8f,
          0x05,
          ...le32(dest + 28),
          0xa1,
          ...le32(fps),
          0xa3,
          ...le32(dest + 12),
        );
      }
    }
    code.push(...store32(fps, 20), ...finish);
    m.code(PROGRAM, code);
    await m.run();
    for (let variant = 0; variant < 2; variant++)
      for (let index = 0; index < cases.length; index++) {
        const dest = output + (variant * cases.length + index) * 32;
        expect(m.read(dest)).toBe(variant ? stub + 128 : 3);
        expect(m.read(dest + 4)).toBe(variant ? 2 : 0x11223344);
        expect(m.read(dest + 8)).toBe(0x55667788);
        expect(m.read(dest + 12)).toBe(expected[index]);
        expect(m.read(dest + 20)).toBe(m.read(dest + 16));
        expect(m.read(dest + 28)).toBe(m.read(dest + 24));
      }
    expect(m.read(fps)).toBe(20);
  });
});
