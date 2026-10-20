import { expect, it } from 'vitest';
import { makePlayerControlCode, playerActions } from '../../../src/games/shared/nativePlayerControl';
import { RA2_CONTROL_PROFILE } from '../../../src/games/ra2/control';
import { YR_CONTROL_PROFILE } from '../../../src/games/yr/control';
import { withGuestMachine, PROGRAM, call32, finish, le32, store32 } from '../../helpers/guestMachine';

it.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])(
  'dispatches $game player selection and click ABIs without constructing events',
  async (original) => {
    await withGuestMachine(async (m) => {
      const box = 0x310000,
        unit = box + 1024,
        target = unit + 2048,
        vtable = target + 2048,
        queue = vtable + 2048,
        out = queue + 256;
      const stub = PROGRAM + 0x4000,
        functions = stub + 4096;
      const profile = {
        ...original,
        localHouse: queue + 4,
        sidebar: { ...original.sidebar, instance: queue + 32, queueCount: queue },
        playerControl: { ...original.playerControl },
      };
      let at = functions;
      for (const [name, value] of Object.entries(profile.playerControl)) {
        if (typeof value === 'number') continue;
        profile.playerControl[name as 'select'] = { address: at, bytes: [] };
        m.code(at, [0xc3]);
        at += 128;
      }
      const p = profile.playerControl;
      const selected = queue + 8,
        selectedBeforeOrder = queue + 12,
        clicked = queue + 16,
        recipient = queue + 20;
      m.code(p.unselect.address, [...store32(selected, 0), 0xc3]);
      m.code(p.select.address, [0x89, 0x0d, ...le32(selected), 0xb8, ...le32(1), 0xc3]);
      for (const name of ['repairMode', 'sellMode'] as const) m.code(p[name].address, [0xc2, 4, 0]);
      const record = [0xff, 0x05, ...le32(queue), 0xa1, ...le32(selected), 0xa3, ...le32(selectedBeforeOrder)];
      for (const name of ['stop', 'guard', 'deploy', 'scatter'] as const) m.code(p[name].address, [...record, 0xc3]);
      const cellClick = at,
        objectClick = at + 64;
      for (const [address, args] of [
        [cellClick, 16],
        [objectClick, 12],
      ])
        m.code(address!, [
          ...record,
          0x89,
          0x0d,
          ...le32(recipient),
          0x8b,
          0x44,
          0x24,
          4,
          0xa3,
          ...le32(clicked),
          0xc2,
          args!,
          0,
        ]);
      profile.viewport = { ...original.viewport, floor: { address: at + 128, bytes: [] } };
      m.code(at + 128, [0xb8, ...le32(256), 0xc2, 4, 0]);
      m.code(p.isShrouded.address, [0xb8, ...le32(0x123401), 0xc3]);
      // Return a distinctive cursor value: the wrapper must forward the original
      // decision instead of substituting fixed movement/attack action numbers.
      m.code(p.decideAction.address, [0x8b, 0x44, 0x24, 12, 0xa3, ...le32(queue + 64), 0xb8, ...le32(91), 0xc2, 12, 0]);
      m.code(p.leftUp.address, [
        ...record,
        0x89,
        0x0d,
        ...le32(recipient),
        0x8b,
        0x44,
        0x24,
        16,
        0xa3,
        ...le32(clicked),
        0x8b,
        0x44,
        0x24,
        20,
        0xa3,
        ...le32(queue + 68),
        0x8b,
        0x44,
        0x24,
        12,
        0xa3,
        ...le32(queue + 72),
        0x8b,
        0x44,
        0x24,
        4,
        0xa3,
        ...le32(queue + 76),
        0xc2,
        20,
        0,
      ]);
      m.code(stub, makePlayerControlCode(stub, box, stub + 1536, profile));
      const code: number[] = [
        ...store32(queue + 4, 0x100000),
        ...store32(unit, vtable),
        ...store32(unit + original.uniqueId, 77),
        ...store32(unit + original.health, 100),
        ...store32(unit + original.owner, 0x100000),
        ...store32(unit + original.alive, 1),
        ...store32(unit + original.limbo, 0),
        ...store32(target + original.uniqueId, 88),
        ...store32(target + original.health, 100),
        ...store32(target + original.alive, 1),
        ...store32(target + original.limbo, 0),
        ...store32(vtable + p.selectSlot, p.select.address),
        ...store32(vtable + p.cellClickSlot, cellClick),
        ...store32(vtable + p.objectClickSlot, objectClick),
        ...store32(box + 20, unit),
        ...store32(box + 24, 77),
        ...store32(box + 28, target),
        ...store32(box + 32, 88),
      ];
      const actions = ['move', 'attack', 'attack-move', 'stop', 'guard', 'deploy', 'scatter'] as const;
      for (const [i, action] of actions.entries()) {
        const dest = out + i * 40;
        code.push(
          ...store32(queue, 0),
          ...store32(box + 16, playerActions[action]),
          0x89,
          0x25,
          ...le32(dest),
          ...call32(stub),
          0xa3,
          ...le32(dest + 4),
          0x89,
          0x25,
          ...le32(dest + 8),
          0xa1,
          ...le32(selectedBeforeOrder),
          0xa3,
          ...le32(dest + 12),
          0xa1,
          ...le32(clicked),
          0xa3,
          ...le32(dest + 16),
          0xa1,
          ...le32(queue),
          0xa3,
          ...le32(dest + 20),
        );
        for (let j = 0; j < 4; j++) code.push(0xa1, ...le32(queue + 64 + j * 4), 0xa3, ...le32(dest + 24 + j * 4));
      }
      // Recycled/dead objects and ownership changes must not reach the user command handler.
      const invalid = out + 512;
      for (const [i, [field, value]] of [
        [original.uniqueId, 78],
        [original.health, 0],
        [original.owner, 0x200000],
      ].entries()) {
        code.push(
          ...store32(unit + original.uniqueId, 77),
          ...store32(unit + original.health, 100),
          ...store32(unit + original.owner, 0x100000),
          ...store32(unit + field!, value!),
          ...store32(queue, 0),
          ...call32(stub),
          0xa3,
          ...le32(invalid + i * 8),
          0xa1,
          ...le32(queue),
          0xa3,
          ...le32(invalid + i * 8 + 4),
        );
      }
      m.code(PROGRAM, [...code, ...finish]);
      await m.run();
      for (const [i] of actions.entries()) {
        const dest = out + i * 40;
        expect(m.read(dest + 8)).toBe(m.read(dest));
        expect(m.read(dest + 4)).toBe(3);
        expect(m.read(dest + 12)).toBe(unit);
        expect(m.read(dest + 20)).toBe(1);
        if (i < 3) {
          expect(m.read(dest + 16)).toBe(91);
          expect(m.read(dest + 24)).toBe(1);
          expect(m.read(dest + 28)).toBe(1);
          expect(m.read(dest + 32)).toBe(i === 1 ? target : 0);
          expect(m.read(dest + 36)).toBe(box + 40);
        }
      }
      for (let i = 0; i < 3; i++) {
        expect(m.read(invalid + i * 8)).toBe(5);
        expect(m.read(invalid + i * 8 + 4)).toBe(0);
      }
      expect(m.read(recipient)).toBe(profile.sidebar.instance);
    });
  },
);

it.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])(
  'dispatches $game native battle exit without selecting units and preserves its boolean result',
  async (original) => {
    await withGuestMachine(async (m) => {
      const box = 0x310000,
        queue = box + 1024,
        calls = queue + 4,
        result = calls + 4,
        out = result + 4;
      const stub = PROGRAM + 0x4000,
        native = stub + 4096;
      const profile = {
        ...original,
        sidebar: { ...original.sidebar, queueCount: queue },
        playerControl: { ...original.playerControl, exitBattle: { address: native, bytes: [] } },
      };
      m.code(native, [0xff, 0x05, ...le32(calls), 0xa1, ...le32(result), 0xc3]);
      m.code(stub, makePlayerControlCode(stub, box, stub + 1536, profile));
      const cases = [
        { queue: 0, result: 0x101, expected: 3, calls: 1 },
        { queue: 0, result: 0x100, expected: 5, calls: 1 },
        { queue: 128, result: 1, expected: 2, calls: 0 },
      ];
      const code: number[] = [...store32(box + 16, playerActions['exit-battle'])];
      for (const [i, test] of cases.entries()) {
        const dest = out + i * 16;
        code.push(
          ...store32(queue, test.queue),
          ...store32(result, test.result),
          ...store32(calls, 0),
          0x89,
          0x25,
          ...le32(dest),
          ...call32(stub),
          0xa3,
          ...le32(dest + 4),
          0x89,
          0x25,
          ...le32(dest + 8),
          0xa1,
          ...le32(calls),
          0xa3,
          ...le32(dest + 12),
        );
      }
      m.code(PROGRAM, [...code, ...finish]);
      await m.run();
      for (const [i, test] of cases.entries()) {
        expect(m.read(out + i * 16 + 4)).toBe(test.expected);
        expect(m.read(out + i * 16 + 8)).toBe(m.read(out + i * 16));
        expect(m.read(out + i * 16 + 12)).toBe(test.calls);
      }
    });
  },
);

it.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])(
  'passes native $game support targeting terrain and shroud through both UI handlers',
  async (original) => {
    await withGuestMachine(async (m) => {
      const box = 0x310000,
        queue = box + 0x1000,
        sidebar = box + 0x2000;
      const result = box + 0x4000,
        stub = PROGRAM + 0x4000,
        handlers = stub + 0x1000;
      const profile = {
        ...original,
        sidebar: { ...original.sidebar, instance: sidebar, queueCount: queue },
        viewport: { ...original.viewport, floor: { address: handlers, bytes: [] } },
        playerControl: {
          ...original.playerControl,
          isShrouded: { address: handlers + 64, bytes: [] },
          decideAction: { address: handlers + 128, bytes: [] },
          leftUp: { address: handlers + 256, bytes: [] },
        },
      };
      m.code(handlers, [0xb8, ...le32(256), 0xc2, 4, 0]);
      // Deliberately dirty upper EAX bits: the original function returns bool in AL.
      m.code(handlers + 64, [0xa1, ...le32(result), 0xc3]);
      m.code(handlers + 128, [0x8b, 0x44, 0x24, 12, 0xa3, ...le32(result + 4), 0xb8, ...le32(41), 0xc2, 12, 0]);
      m.code(handlers + 256, [
        0x8b,
        0x44,
        0x24,
        20,
        0xa3,
        ...le32(result + 8),
        0x8b,
        0x44,
        0x24,
        16,
        0xa3,
        ...le32(result + 12),
        0xff,
        0x05,
        ...le32(queue),
        0xc2,
        20,
        0,
      ]);
      m.code(stub, makePlayerControlCode(stub, box, handlers + 512, profile));
      m.write(sidebar + original.supportPowers!.selectedIndex, 0);
      m.write(box + 16, playerActions['target-power']);
      const code: number[] = [];
      for (const [i, shroud] of [0x123400, 0x123401].entries()) {
        const out = result + 64 + i * 32;
        code.push(
          ...store32(result, shroud),
          ...store32(queue, 0),
          0x89,
          0x25,
          ...le32(out),
          ...call32(stub),
          0xa3,
          ...le32(out + 4),
          0x89,
          0x25,
          ...le32(out + 8),
        );
        for (const [j, source] of [result + 4, result + 8, result + 12, box + 48].entries())
          code.push(0xa1, ...le32(source), 0xa3, ...le32(out + 12 + j * 4));
      }
      m.code(PROGRAM, [...code, ...finish]);
      await m.run();
      for (let i = 0; i < 2; i++) {
        const out = result + 64 + i * 32;
        expect(m.read(out + 8)).toBe(m.read(out));
        expect(m.read(out + 4)).toBe(3);
        expect(m.read(out + 12)).toBe(i);
        expect(m.read(out + 16)).toBe(i);
        expect(m.read(out + 20)).toBe(41);
        expect(m.read(out + 24)).toBe(256);
      }
    });
  },
);

it.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])(
  'requires exact native $game group selection before invoking one player handler',
  async (original) => {
    await withGuestMachine(async (m) => {
      const box = 0x310000,
        first = box + 0x1000,
        second = box + 0x2000;
      const table = box + 0x3000,
        vtable = box + 0x4000,
        queue = box + 0x5000;
      const count = queue + 4,
        vector = queue + 8,
        members = queue + 64;
      const behavior = queue + 12,
        calls = queue + 16,
        out = queue + 256;
      const stub = PROGRAM + 0x4000,
        functions = stub + 0x2000;
      const profile = {
        ...original,
        localHouse: queue + 20,
        sidebar: { ...original.sidebar, queueCount: queue },
        playerControl: { ...original.playerControl, selectionCount: count, selectionVector: vector },
      };
      let at = functions;
      for (const [name, entry] of Object.entries(profile.playerControl)) {
        if (typeof entry === 'number') continue;
        profile.playerControl[name as 'select'] = { address: at, bytes: [] };
        m.code(at, [0xc3]);
        at += 128;
      }
      const p = profile.playerControl;
      for (const name of ['repairMode', 'sellMode'] as const) m.code(p[name].address, [0xc2, 4, 0]);
      m.code(p.unselect.address, [...store32(count, 0), 0xc3]);
      // Mode1 lies about success without adding members. Mode2 adds a foreign
      // pointer while retaining the requested count. Neither may dispatch.
      m.code(p.select.address, [
        0x83,
        0x3d,
        ...le32(behavior),
        1,
        0x74,
        32,
        0x83,
        0x3d,
        ...le32(behavior),
        2,
        0x75,
        5,
        0xb9,
        ...le32(first + 4),
        0xa1,
        ...le32(count),
        0x89,
        0x0c,
        0x85,
        ...le32(members),
        0xff,
        0x05,
        ...le32(count),
        0xb8,
        ...le32(1),
        0xc3,
      ]);
      m.code(p.guard.address, [0xff, 0x05, ...le32(calls), 0xff, 0x05, ...le32(queue), 0xc3]);
      m.code(stub, makePlayerControlCode(stub, box, stub + 0x1800, profile));
      const code = [
        ...store32(profile.localHouse, 0x100000),
        ...store32(vector, members),
        ...store32(vtable + p.selectSlot, p.select.address),
        ...store32(box + 16, playerActions.guard),
        ...store32(box + 16 + 52, 2),
        ...store32(box + 16 + 56, table),
        ...store32(table, first),
        ...store32(table + 4, 77),
        ...store32(table + 8, second),
        ...store32(table + 12, 88),
      ];
      for (const [object, id] of [
        [first, 77],
        [second, 88],
      ])
        code.push(
          ...store32(object!, vtable),
          ...store32(object! + original.uniqueId, id!),
          ...store32(object! + original.health, 100),
          ...store32(object! + original.owner, 0x100000),
          ...store32(object! + original.alive, 1),
          ...store32(object! + original.limbo, 0),
        );
      const cases = [
        { behavior: 0, id: 88, result: 3, calls: 1 },
        { behavior: 1, id: 88, result: 5, calls: 0 },
        { behavior: 2, id: 88, result: 5, calls: 0 },
        { behavior: 0, id: 89, result: 5, calls: 0 },
      ];
      for (const [i, test] of cases.entries()) {
        const dest = out + i * 20;
        code.push(
          ...store32(behavior, test.behavior),
          ...store32(second + original.uniqueId, test.id),
          ...store32(queue, 0),
          ...store32(calls, 0),
          0x89,
          0x25,
          ...le32(dest),
          ...call32(stub),
          0xa3,
          ...le32(dest + 4),
          0x89,
          0x25,
          ...le32(dest + 8),
          0xa1,
          ...le32(calls),
          0xa3,
          ...le32(dest + 12),
          0xa1,
          ...le32(count),
          0xa3,
          ...le32(dest + 16),
        );
      }
      m.code(PROGRAM, [...code, ...finish]);
      await m.run();
      for (const [i, test] of cases.entries()) {
        const dest = out + i * 20;
        expect(m.read(dest + 8)).toBe(m.read(dest));
        expect(m.read(dest + 4)).toBe(test.result);
        expect(m.read(dest + 12)).toBe(test.calls);
        if (i < 3) expect(m.read(dest + 16)).toBe(i === 0 ? 2 : 0);
      }
    });
  },
);
