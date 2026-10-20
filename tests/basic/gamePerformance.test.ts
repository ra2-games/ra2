import { expect, it, vi } from 'vitest';
import { GamePerformanceMeter } from '../../src/adapter/gamePerformance';
import { createRa2FrameReader } from '../../src/games/ra2/performance';
import { createYrFrameReader } from '../../src/games/yr/performance';
import { writeU32 } from '../helpers/guestMemory';
import { summarizeGamePerformance } from '../helpers/gamePerformance';

import { frameCounterImage } from '../fixture/frameCounterImage';

const readers = { ra2: createRa2FrameReader, yr: createYrFrameReader };
it.each(['ra2', 'yr'] as const)(
  'detects %s after code/data movement without a hash and never writes guest memory',
  (game) => {
    for (const [base, shift] of [
      [0x400000, 0],
      [0x600000, 0x40],
    ]) {
      const fixture = frameCounterImage(game, base, shift);
      const { memory, exe } = fixture;
      const write = vi.spyOn(memory, 'write_memory');
      const reader = readers[game](memory, exe);
      expect(reader?.()).toEqual({ frame: 321, gameSpeed: 2, sessionSpeed: 3, requestedFps: 45 });
      expect(write).not.toHaveBeenCalled();
      expect(readers[game === 'ra2' ? 'yr' : 'ra2'](memory, exe)).toBeNull();
      writeU32(memory, fixture.frame, 351);
      expect(reader?.()?.frame).toBe(351);
      exe[0x88] ^= 1; // COFF timestamp changes file identity but not executable structure.
      expect(readers[game](memory, exe)?.()?.frame).toBe(351);
    }
  },
);

it.each([
  ['different frame writeback', (f: Fixture) => f.patchWord(f.sites.frame + 16, f.frame + 4)],
  ['conflicting session references', (f: Fixture) => f.patchWord(f.sites.settings + 8, f.session + 4)],
  ['conflicting FPS references', (f: Fixture) => f.patchWord(f.sites.timing + 2, f.fps + 4)],
  [
    'counter in code',
    (f: Fixture) => {
      f.patchWord(f.sites.frame + 2, f.base + 0x1800);
      f.patchWord(f.sites.frame + 16, f.base + 0x1800);
    },
  ],
  ['aliased counters', (f: Fixture) => f.patchWord(f.sites.speed + 8, f.frame)],
  ['unaligned counter', (f: Fixture) => f.patchWord(f.sites.speed + 8, f.speed + 1)],
  ['call outside code', (f: Fixture) => f.patchWord(f.sites.frame + 29, 0x7fffffff)],
  ['wrong FPS label', (f: Fixture) => f.patch(f.base + 0x3000, [0x58])],
  ['wrong timing division', (f: Fixture) => f.patch(f.sites.timing + 0x6b, [30])],
  ['duplicate frame loop', (f: Fixture) => f.patch(f.base + 0x1500, f.memory.read_memory(f.sites.frame, 54))],
  ['duplicate labelled display', (f: Fixture) => f.patch(f.base + 0x1500, f.memory.read_memory(f.sites.display, 25))],
  ['changed live instructions', (f: Fixture) => f.memory.write_memory([0x90], f.sites.frame)],
] as const)('rejects %s', (_name, mutate) => {
  for (const game of ['ra2', 'yr'] as const) {
    const f = frameCounterImage(game);
    mutate(f);
    expect(readers[game](f.memory, f.exe)).toBeNull();
  }
});
type Fixture = ReturnType<typeof frameCounterImage>;

it('ignores instruction-like data and unrelated formatting calls, but requires the counter loop in code', () => {
  const f = frameCounterImage('ra2');
  f.patch(f.base + 0x2500, f.memory.read_memory(f.sites.frame, 54));
  f.patch(f.base + 0x1500, f.memory.read_memory(f.sites.display, 25));
  f.patchWord(f.base + 0x150c, f.base + 0x3050);
  expect(createRa2FrameReader(f.memory, f.exe)?.()?.frame).toBe(321);
  f.patch(f.sites.frame, [0x90]);
  expect(createRa2FrameReader(f.memory, f.exe)).toBeNull();
});

it('returns unavailable for short or failed live reads, including failures after detection', () => {
  const f = frameCounterImage('ra2');
  const reader = createRa2FrameReader(f.memory, f.exe)!;
  const read = vi.spyOn(f.memory, 'read_memory').mockReturnValue(new Uint8Array(3));
  expect(reader()).toBeNull();
  expect(createRa2FrameReader(f.memory, f.exe)).toBeNull();
  read.mockImplementation(() => {
    throw new Error('unmapped');
  });
  expect(reader()).toBeNull();
  expect(createRa2FrameReader(f.memory, f.exe)).toBeNull();
});
const counters = (frame: number) => ({ frame, gameSpeed: 0, sessionSpeed: 0, requestedFps: 60 });
it('目标 60 不冒充实际 FPS；停滞为零，菜单/重置/同时间不产生假峰值', () => {
  const meter = new GamePerformanceMeter();
  expect(meter.sample(counters(10), 100, true).logicFps).toBeNull();
  expect(meter.sample(counters(40), 1100, true).logicFps).toBe(30);
  expect(meter.sample(counters(40), 2100, true).logicFps).toBe(0);
  expect(meter.sample(counters(1), 3100, true).status).toBe('reset');
  expect(meter.sample(counters(2), 3100, true).logicFps).toBeNull();
  expect(meter.sample(counters(3), 3200, false).status).toBe('inactive');
  expect(meter.sample(counters(4), 3300, true).status).toBe('baseline');
});
it('按实际窗口时长加权，预热不足返回不可用，重置使报告失效', () => {
  const meter = new GamePerformanceMeter();
  const samples = [
    [0, 0],
    [30, 1000],
    [150, 3000],
    [150, 4000],
    [150, 5000],
  ].map(([frame, at]) => meter.sample(counters(frame!), at!, true));
  expect(summarizeGamePerformance(samples)).toMatchObject({
    logicFps: 30,
    windowFpsP05: 0,
    maxObservedStallMs: 2000,
    valid: true,
  });
  expect(summarizeGamePerformance(samples, 30000)).toBeNull();
  samples.push(meter.sample(counters(0), 6000, true));
  expect(summarizeGamePerformance(samples)).toMatchObject({ valid: false, invalidWindows: 1 });
});
