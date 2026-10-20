import { afterEach, expect, it, vi } from 'vitest';
import { buildPlan } from '@ra2vm/control/buildPlan';
import { ControlClient } from '@ra2vm/control/client';
import { placeBuilding } from '@ra2vm/control/placeBuilding';
import type { BattleObservation } from '@ra2vm/control/contracts';
vi.mock('@ra2vm/control/placeBuilding', () => ({ placeBuilding: vi.fn() }));
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
const step = { type: 'GAPOWR', cells: [{ x: 4, y: 4 }] };
const state = (type?: string, progress = 54): BattleObservation => ({
  sessionId: 'match',
  frame: 100,
  player: 0,
  cash: 1000,
  perspective: 'viewport',
  sidebarTab: 0,
  viewport: { x: 0, y: 0, width: 800, height: 600 },
  entities: [],
  sidebar: [],
  production: type ? [{ type, progress, total: 54, onHold: false, suspended: false }] : [],
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
it('reuses in-progress production and confirms placement before starting the next prerequisite', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  const observe = vi.spyOn(client, 'observe');
  observe
    .mockResolvedValueOnce(state())
    .mockResolvedValueOnce(state('GAPOWR', 20))
    .mockResolvedValueOnce(state('GAPOWR', 20))
    .mockResolvedValueOnce(state('GAPOWR'))
    .mockResolvedValueOnce(state())
    .mockResolvedValueOnce(state('GAREFN'));
  const effects: string[] = [];
  vi.mocked(placeBuilding).mockImplementation(async (_client, params) => {
    effects.push(`place:${params.type}`);
    return { id: String(params.type) } as never;
  });
  vi.spyOn(client, 'command').mockImplementation(async (_action, params) => {
    effects.push(`produce:${params.type}`);
    return { state: 'submitted', commandId: '00000000-0000-0000-0000-000000000001' };
  });
  const result = buildPlan(client, { steps: [step, { ...step, type: 'GAREFN' }] }, () => {});
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ state: 'completed', completed: [{ type: 'GAPOWR' }, { type: 'GAREFN' }] });
  expect(effects).toEqual(['place:GAPOWR', 'produce:GAREFN', 'place:GAREFN']);
});
it('returns an unfinished step at its deadline without duplicating production or placing early', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'observe').mockResolvedValue(state('GAPOWR', 10));
  const command = vi.spyOn(client, 'command');
  const result = buildPlan(client, { durationMs: 1000, steps: [step] }, () => {});
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ state: 'waiting', index: 0, completed: [] });
  expect(command).not.toHaveBeenCalled();
  expect(placeBuilding).not.toHaveBeenCalled();
});
it('stops an uncertain placement without starting the next building', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'observe').mockResolvedValue(state('GAPOWR'));
  const command = vi.spyOn(client, 'command');
  vi.mocked(placeBuilding).mockRejectedValue(new Error('Product consumed but building not confirmed'));
  expect(await buildPlan(client, { steps: [step, { ...step, type: 'GAREFN' }] }, () => {})).toMatchObject({
    state: 'interrupted',
    index: 0,
    next: 'inspect',
    completed: [],
  });
  expect(command).not.toHaveBeenCalled();
});
it('validates every candidate before any read or write', async () => {
  const client = new ControlClient(15180, 'test');
  const observe = vi.spyOn(client, 'observe');
  await expect(buildPlan(client, { steps: [step, { ...step, cells: [{ x: -1, y: 4 }] }] }, () => {})).rejects.toThrow(
    'candidate cells',
  );
  expect(observe).not.toHaveBeenCalled();
});

it('does not expire production waiting when the wall clock jumps forward', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  let reads = 0;
  vi.spyOn(client, 'observe').mockImplementation(async () => state('GAPOWR', ++reads < 5 ? 20 : 54));
  vi.mocked(placeBuilding).mockResolvedValue({ id: 'new' } as never);
  const result = buildPlan(client, { durationMs: 2000, steps: [step] }, () => {});
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ state: 'completed', completed: [{ building: 'new' }] });
});
