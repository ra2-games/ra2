import { expect, it } from 'vitest';
import { RA2_CONTROL_PROFILE } from '../../../src/games/ra2/control';
import { YR_CONTROL_PROFILE } from '../../../src/games/yr/control';
import { makeBattleResultCode, readBattleResult } from '../../../src/games/shared/nativeBattleResult';
import { withGuestMachine, PROGRAM, call32, finish, le32, store32 } from '../../helpers/guestMachine';

it.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])(
  '$game result trampolines capture native outcomes, preserve the ABI and reset without host polling',
  async (profile) => {
    await withGuestMachine(async (m) => {
      const record = 0x310000,
        house = 0x320000,
        tick = PROGRAM + 0x4000,
        terminal = tick + 512,
        site = tick + 1024;
      const context = {
        ...profile,
        battleResult: { ...profile.battleResult!, terminal: { ...profile.battleResult!.terminal, address: site } },
      };
      m.code(tick, makeBattleResultCode(tick, record, context, false));
      m.code(terminal, makeBattleResultCode(terminal, record, context, true));
      m.code(site + context.battleResult.terminal.bytes.length, [0xc3]);
      const byte = (address: number, value: number) => [0xc6, 0x05, ...le32(address), value];
      const copy = (from: number, to: number) => [0xa1, ...le32(from), 0xa3, ...le32(to)];
      const code: number[] = [...store32(profile.localHouse, house), ...store32(house + profile.houseIndex, 3)];
      const cases = [
        [1, 0, 'victory'],
        [0, 1, 'defeat'],
        [0, 0, 'unknown'],
        [1, 1, 'unknown'],
        [2, 0, 'unknown'],
      ] as const;
      for (const [i, [win, lose]] of cases.entries()) {
        const out = 0x330000 + i * 128;
        code.push(
          ...store32(profile.frame, 100 + i),
          ...call32(tick),
          ...copy(record + 4, out + 24),
          ...copy(record + 8, out + 28),
          ...byte(profile.battleResult!.win, win),
          ...byte(profile.battleResult!.lose, lose),
          0xb9,
          ...le32(0x12345678),
          0xbb,
          ...le32(0x23456789),
          0x89,
          0x25,
          ...le32(out + 32), // esp before
          0x31,
          0xc0,
          0xf9,
          0x9c,
          0x8f,
          0x05,
          ...le32(out + 36), // flags before
          ...call32(terminal),
          0x89,
          0x25,
          ...le32(out + 40),
          0x9c,
          0x8f,
          0x05,
          ...le32(out + 44),
          0x89,
          0x0d,
          ...le32(out + 48),
          0x89,
          0x1d,
          ...le32(out + 52),
        );
        for (let offset = 0; offset < 24; offset += 4) code.push(...copy(record + offset, out + offset));
      }
      // A new normal iteration clears even an ended match whose frame was lower.
      code.push(
        ...store32(profile.frame, 200),
        ...call32(tick),
        ...copy(record, 0x340000),
        ...copy(record + 4, 0x340004),
      );
      // A restarted scenario with the same House address also changes generation.
      code.push(...store32(profile.frame, 1), ...call32(tick), ...copy(record, 0x340008));
      // Switching the local House does not carry the old player's result forward.
      code.push(
        ...store32(profile.localHouse, house + 0x1000),
        ...store32(house + 0x1000 + profile.houseIndex, 4),
        ...call32(tick),
      );
      m.code(PROGRAM, [...code, ...finish]);
      await m.run();
      for (const [i, [, , outcome]] of cases.entries()) {
        const out = 0x330000 + i * 128;
        expect(m.read(out)).toBe(i + 1);
        expect(readBattleResult(m.memory, out, 'battle')).toEqual({
          sessionId: 'battle',
          frame: 100 + i,
          player: 3,
          outcome,
          source: 'native-game-loop',
        });
        expect(m.read(out + 24)).toBe(1);
        expect(m.read(out + 28)).toBe(0);
        expect(m.read(out + 32)).toBe(m.read(out + 40));
        expect(m.read(out + 36)).toBe(m.read(out + 44));
        expect(m.read(out + 48)).toBe(0x12345678);
        expect(m.read(out + 52)).toBe(0x23456789);
      }
      expect(m.read(0x340000)).toBe(6);
      expect(m.read(0x340004)).toBe(1);
      expect(m.read(0x340008)).toBe(7);
      expect(m.read(record)).toBe(8);
      expect(readBattleResult(m.memory, record, 'new-battle')).toBeNull();
    });
  },
);
