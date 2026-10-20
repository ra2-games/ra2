import { expect, it } from 'vitest';
import { makeControlMailboxCode } from '../../../src/games/shared/nativeControl';
import { YR_CONTROL_PROFILE } from '../../../src/games/yr/control';
import { RA2_CONTROL_PROFILE } from '../../../src/games/ra2/control';
import { makeSidebarControlCode } from '../../../src/games/shared/nativeSidebarControl';
import { withGuestMachine, PROGRAM, call32, finish, le32, store32 } from '../../helpers/guestMachine';

it('dispatches player handlers with mailbox expiry while preserving registers and flags', async () => {
  await withGuestMachine(async (m) => {
    const box = 0x310000,
      frame = box + 512,
      house = frame + 4,
      called = frame + 8;
    const stub = PROGRAM + 0x2000,
      native = stub + 2304,
      continuation = stub + 256;
    const profile = {
      ...YR_CONTROL_PROFILE,
      frame,
      localHouse: house,
      hook: { address: continuation - 6, bytes: [0x90, 0x90, 0x90, 0x90, 0x90, 0x90] },
    };
    m.code(stub, makeControlMailboxCode(stub, box, profile));
    m.code(continuation, [0xc3]);
    m.code(native, [
      0xff,
      0x05,
      ...le32(called),
      0xa1,
      ...le32(box + 16),
      0xa3,
      ...le32(called + 4),
      0xa1,
      ...le32(called + 8),
      0xc3,
    ]);
    const code: number[] = [];
    const cases = [
      { state: 0, frame: 100, owner: 0x100000, accepted: 1, expected: 0, calls: 0 },
      { state: 1, frame: 100, owner: 0x100000, accepted: 1, expected: 3, calls: 1 },
      { state: 1, frame: 100, owner: 0x100000, accepted: 0, expected: 2, calls: 1 },
      { state: 1, frame: 401, owner: 0x100000, accepted: 1, expected: 4, calls: 0 },
      { state: 1, frame: 99, owner: 0x100000, accepted: 1, expected: 4, calls: 0 },
      { state: 1, frame: 100, owner: 0x200000, accepted: 1, expected: 4, calls: 0 },
    ];
    for (const [i, test] of cases.entries()) {
      const out = box + 1024 + i * 32;
      code.push(
        ...store32(box, test.state),
        ...store32(box + 4, 100),
        ...store32(box + 8, 0x100000),
        ...store32(box + 16, 0x12345609),
        ...store32(frame, test.frame),
        ...store32(house, test.owner),
        ...store32(called, 0),
        ...store32(called + 8, test.accepted + 2),
        0xb9,
        ...le32(0x55667788),
        0xba,
        ...le32(0x11223344),
        0x89,
        0x25,
        ...le32(out),
        0x31,
        0xc0,
        0xf9,
        0x9c,
        0x8f,
        0x05,
        ...le32(out + 4),
        ...call32(stub),
        0x89,
        0x25,
        ...le32(out + 8),
        0x9c,
        0x8f,
        0x05,
        ...le32(out + 12),
        0x89,
        0x0d,
        ...le32(out + 16),
        0x89,
        0x15,
        ...le32(out + 20),
        0xa1,
        ...le32(box),
        0xa3,
        ...le32(out + 24),
        0xa1,
        ...le32(called),
        0xa3,
        ...le32(out + 28),
      );
    }
    m.code(PROGRAM, [...code, ...finish]);
    await m.run();
    for (const [i, test] of cases.entries()) {
      const out = box + 1024 + i * 32;
      expect(m.read(out)).toBe(m.read(out + 8));
      expect(m.read(out + 4)).toBe(m.read(out + 12));
      expect(m.read(out + 16)).toBe(0x55667788);
      expect(m.read(out + 20)).toBe(0x11223344);
      expect(m.read(out + 24)).toBe(test.expected);
      expect(m.read(out + 28)).toBe(test.calls);
    }
    expect(m.read(called + 4)).toBe(0x12345609);
  });
});

it.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])(
  'uses the $game sidebar ABI and rechecks cameo state before native Action',
  async (profile) => {
    await withGuestMachine(async (m) => {
      const box = 0x310000,
        strip = box + 512,
        selector = box + 1024,
        factory = box + 1536;
      const queue = box + 2048,
        captured = queue + 16,
        output = captured + 64;
      const stub = PROGRAM + 0x2000,
        ctor = stub + 1024,
        action = ctor + 64;
      const sidebar = {
        ...profile.sidebar,
        instance: factory + 256,
        queueCount: queue,
        constructor: { address: ctor, bytes: [] },
        action: { address: action, bytes: [] },
        setTab: { address: action + 128, bytes: [] },
      };
      m.code(stub, makeSidebarControlCode(stub, box, selector, sidebar, profile.factory.suspended));
      m.code(ctor, [0xc3]);
      m.code(sidebar.setTab.address, [
        0x8b,
        0x44,
        0x24,
        4, // native thiscall argument
        0xa3,
        ...le32(captured + 12),
        0x89,
        0x0d,
        ...le32(captured + 16),
        0xff,
        0x05,
        ...le32(captured + 20),
        0xc2,
        4,
        0,
      ]);
      m.code(action, [
        0xff,
        0x05,
        ...le32(queue), // native handler accepts one event
        0x8b,
        0x44,
        0x24,
        4,
        0xa3,
        ...le32(captured),
        0x8b,
        0x41,
        0x2c,
        0xa3,
        ...le32(captured + 4),
        0x8b,
        0x41,
        0x30,
        0xa3,
        ...le32(captured + 8),
        0xa1,
        ...le32(captured + 20),
        0xa3,
        ...le32(captured + 24), // tab activation must precede the cameo click
        0xb8,
        ...le32(1),
        0xc2,
        sidebar.modifierArgument ? 12 : 8,
        0,
      ]);
      const item = strip + sidebar.items + 3 * sidebar.itemSize;
      const cases = [
        { mode: 1, count: 4, rtti: 7, queued: 0, held: 0, phase: 0, expected: 3, calls: 1 },
        { mode: 1, count: 4, rtti: 7, queued: 0, held: 0, phase: 0, progress: 54, expected: 5, calls: 0 },
        {
          mode: 1,
          count: 4,
          rtti: 40,
          expectedRtti: 40,
          queued: 0,
          held: 0,
          phase: 0,
          progress: 54,
          expected: 3,
          calls: 1,
        },
        { mode: 1, count: 3, rtti: 7, queued: 0, held: 0, phase: 0, expected: 5, calls: 0 },
        { mode: 1, count: 4, rtti: 6, queued: 0, held: 0, phase: 0, expected: 5, calls: 0 },
        { mode: 1, count: 4, rtti: 7, queued: 128, held: 0, phase: 0, expected: 2, calls: 0 },
        { mode: 2, count: 4, rtti: 7, queued: 0, held: 1, phase: 0, expected: 5, calls: 0 },
        { mode: 2, count: 4, rtti: 7, queued: 0, held: 0, phase: 0, expected: 3, calls: 1 },
        { mode: 3, count: 4, rtti: 7, queued: 0, held: 0, phase: 0, expected: 1, calls: 1 },
        { mode: 3, count: 4, rtti: 7, queued: 0, held: 0, phase: 1, expected: 1, calls: 0 },
        { mode: 3, count: 4, rtti: 7, queued: 0, held: 1, phase: 1, expected: 3, calls: 1 },
        { mode: 1, count: 4, rtti: 7, queued: 0, held: 0, phase: 0, tab: 4, expected: 5, calls: 0 },
      ];
      const code: number[] = [];
      for (const [i, c] of cases.entries()) {
        const out = output + i * 32;
        code.push(
          ...store32(captured + 20, 0),
          ...store32(captured + 24, 0),
          ...store32(box + 12, c.mode),
          ...store32(box + 128, strip),
          ...store32(box + 132, 3),
          ...store32(box + 136, c.expectedRtti ?? 7),
          ...store32(box + 140, 42),
          ...store32(box + 144, c.phase),
          ...store32(strip + sidebar.count, c.count),
          ...store32(strip + sidebar.topRow, 2),
          ...store32(strip + sidebar.tabIndex, c.tab ?? i % 4),
          ...store32(item, 42),
          ...store32(item + 4, c.rtti),
          ...store32(item + 12, factory),
          ...store32(factory + profile.factory.suspended, c.held),
          ...store32(factory + 0x24, c.progress ?? 0),
          ...store32(queue, c.queued),
          0x89,
          0x25,
          ...le32(out),
          ...call32(stub),
          0x89,
          0x25,
          ...le32(out + 4),
          0xa3,
          ...le32(out + 8),
          0xa1,
          ...le32(queue),
          0xa3,
          ...le32(out + 12),
          0xa1,
          ...le32(captured + 12),
          0xa3,
          ...le32(out + 16),
          0xa1,
          ...le32(captured + 20),
          0xa3,
          ...le32(out + 20),
          0xa1,
          ...le32(captured + 24),
          0xa3,
          ...le32(out + 24),
        );
      }
      m.code(PROGRAM, [...code, ...finish]);
      await m.run();
      for (const [i, c] of cases.entries()) {
        const out = output + i * 32;
        expect(m.read(out + 4)).toBe(m.read(out));
        expect(m.read(out + 8)).toBe(c.expected);
        expect(m.read(out + 12)).toBe(c.queued + c.calls);
        expect(m.read(out + 20)).toBe(c.calls);
        expect(m.read(out + 24)).toBe(c.calls);
        if (c.calls) expect(m.read(out + 16)).toBe(i % 4);
      }
      expect(m.read(captured)).toBe(16);
      expect(m.read(captured + 4)).toBe(strip);
      expect(m.read(captured + 8)).toBe(0xffffffff); // absolute 3 - top row 2 * 2
      expect(m.read(captured + 16)).toBe(sidebar.instance);
    });
  },
);

it.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])(
  'runs $game camera calls on the game thread with balanced thiscall arguments',
  async (profile) => {
    const { makeCameraControlCode } = await import('../../../src/games/shared/nativeViewport');
    await withGuestMachine(async (m) => {
      const stub = PROGRAM + 0x2000,
        box = 0x310000,
        state = box + 512,
        out = state + 32;
      const floor = stub + 3000,
        position = floor + 128,
        continuation = position + 128;
      const viewport = {
        ...profile.viewport,
        map: 0x123400,
        tactical: state + 8,
        floor: { address: floor, bytes: [] },
        position: { address: position, bytes: [] },
      };
      const layout = {
        ...profile,
        viewport,
        frame: state,
        localHouse: state + 4,
        hook: { address: continuation - 6, bytes: [0x90, 0x90, 0x90, 0x90, 0x90, 0x90] },
      };
      m.code(stub, makeControlMailboxCode(stub, box, layout));
      m.code(stub + 2048, makeCameraControlCode(stub + 2048, box, viewport));
      m.code(continuation, [0xc3]);
      m.code(floor, [
        0x89,
        0x0d,
        ...le32(out),
        0x8b,
        0x44,
        0x24,
        4,
        0xa3,
        ...le32(out + 4),
        0xb8,
        ...le32(208),
        0xc2,
        4,
        0,
      ]);
      m.code(position, [0x89, 0x0d, ...le32(out + 8), 0x8b, 0x44, 0x24, 4, 0xa3, ...le32(out + 12), 0xc2, 4, 0]);
      m.code(PROGRAM, [
        ...store32(box, 1),
        ...store32(box + 4, 100),
        ...store32(box + 8, 0x120000),
        ...store32(box + 12, 4),
        ...store32(box + 16, 20000),
        ...store32(box + 20, 30000),
        ...store32(state, 100),
        ...store32(state + 4, 0x120000),
        ...store32(state + 8, 0x130000),
        0x89,
        0x25,
        ...le32(out + 16),
        ...call32(stub),
        0x89,
        0x25,
        ...le32(out + 20),
        ...finish,
      ]);
      await m.run();
      expect(m.read(box)).toBe(3);
      expect(m.read(out)).toBe(viewport.map);
      expect(m.read(out + 8)).toBe(0x130000);
      expect(m.read(out + 4)).toBe(box + 16);
      expect(m.read(out + 12)).toBe(box + 16);
      expect(m.read(box + 24)).toBe(208);
      expect(m.read(out + 16)).toBe(m.read(out + 20));
    });
  },
);
