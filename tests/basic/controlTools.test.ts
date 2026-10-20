import { expect, it, vi, afterEach } from 'vitest';
import { observationDelta, monitor, waitForBattle } from '@ra2vm/control/monitor';
import { placeBuilding, visiblePlacementBlockers } from '@ra2vm/control/placeBuilding';
import { ControlClient, NativeCommandError } from '@ra2vm/control/client';
import type { BattleObservation } from '@ra2vm/control/contracts';
// Route promise timers through the fake scheduler too; otherwise fake Date.now()
// never advances while node:timers/promises keeps sleeping in real time.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}));
const state = (extra: Partial<BattleObservation> = {}): BattleObservation => ({
  sessionId: 'battle',
  frame: 100,
  perspective: 'viewport',
  player: 0,
  cash: 1000,
  sidebarTab: 0,
  viewport: { x: 0, y: 0, width: 800, height: 600 },
  production: [],
  sidebar: [],
  entities: [],
  ...extra,
});
const entity = {
  id: 'tank',
  kind: 'vehicle' as const,
  owner: 0,
  health: 300,
  type: 'MTNK',
  cell: { x: 4, y: 4 },
  position: { x: 1024, y: 1024, z: 0 },
  screen: { x: 10, y: 10 },
};
afterEach(() => vi.useRealTimers());

it('binds the first ready session before an observation can race with another completed battle', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request')
    .mockResolvedValueOnce({ pageId: 'page', runtime: { page: '', battlefield: { ready: true, sessionId: 'battle' } } })
    .mockResolvedValue({
      pageId: 'page',
      runtime: {
        page: 'GUI:MultiplayerScore',
        battlefield: { ready: false },
        battleResult: { sessionId: 'other', frame: 10, player: 0, outcome: 'victory', source: 'native-game-loop' },
      },
    });
  vi.spyOn(client, 'observe').mockRejectedValue(new Error('Battlefield is not active'));
  const events: unknown[] = [];
  await monitor(client, { durationMs: 1000 }, (e) => events.push(e));
  expect(events).toMatchObject([{ event: 'session-changed', sessionId: 'other' }]);
  expect(events[0]).not.toHaveProperty('outcome');
});

it('tries another site only after a confirmed native placement rejection', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'look').mockResolvedValue(
    state({ production: [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: false }] }),
  );
  const command = vi
    .spyOn(client, 'command')
    .mockRejectedValueOnce(new NativeCommandError('rejected-site', 'rejected'))
    .mockRejectedValueOnce(new Error('transport outcome unknown'));
  const events: unknown[] = [];
  await expect(
    placeBuilding(
      client,
      {
        sessionId: 'battle',
        type: 'GAPOWR',
        cells: [
          { x: 4, y: 4 },
          { x: 5, y: 5 },
          { x: 6, y: 6 },
        ],
      },
      (e) => events.push(e),
    ),
  ).rejects.toThrow('outcome unknown');
  expect(command).toHaveBeenCalledTimes(2);
  expect(events).toEqual([
    { event: 'placement-rejected', type: 'GAPOWR', cell: { x: 4, y: 4 }, commandId: 'rejected-site' },
  ]);
});
it('reports loss of sight as leftView, and never carries memory across sessions', () => {
  const before = state({ entities: [entity] });
  expect(observationDelta(before, state())).toMatchObject({ leftView: ['tank'], damaged: [] });
  expect(observationDelta(before, state({ entities: [{ ...entity, cell: { x: 6, y: 4 } }] })).moved).toEqual([
    { id: 'tank', from: { x: 4, y: 4 }, to: { x: 6, y: 4 } },
  ]);
  expect(observationDelta(before, state({ sessionId: 'other', entities: [{ ...entity, health: 100 }] }))).toMatchObject(
    { reset: true, leftView: [], damaged: [] },
  );
  expect(observationDelta(before, state({ entities: [{ ...entity, health: 150 }] })).damaged).toEqual([
    { id: 'tank', type: 'MTNK', health: 150, lost: 150, cell: entity.cell },
  ]);
});
it('stops monitoring on the score screen without inferring victory', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request').mockResolvedValue({
    pageId: '1',
    phase: 'running',
    runtime: { page: 'GUI:MultiplayerScore', battlefield: { ready: false } },
  });
  const observe = vi.spyOn(client, 'observe');
  const events: unknown[] = [];
  await monitor(client, {}, (e) => events.push(e));
  expect(observe).not.toHaveBeenCalled();
  expect(events).toMatchObject([{ event: 'not-in-battle', outcome: 'unknown' }]);
});

it.each(['victory', 'defeat', 'unknown'] as const)(
  'reports retained native %s even when monitoring starts after the battle',
  async (outcome) => {
    const client = new ControlClient(15180, 'test');
    const result = { sessionId: 'battle', frame: 1234, player: 2, outcome, source: 'native-game-loop' };
    vi.spyOn(client, 'request').mockResolvedValue({
      pageId: 'page',
      phase: 'running',
      failure: null,
      runtime: { page: 'GUI:MultiplayerScore', battlefield: { ready: false }, battleResult: result },
    });
    const events: unknown[] = [];
    await monitor(client, { durationMs: 1000 }, (e) => events.push(e));
    expect(events).toMatchObject([{ event: 'battle-ended', outcome, result }]);
  },
);

it.each([false, true])('preserves a native outcome across status/observe teardown races (%s)', async (race) => {
  const client = new ControlClient(15180, 'test');
  const result = { sessionId: 'battle', frame: 1234, player: 0, outcome: 'defeat', source: 'native-game-loop' };
  const active = { pageId: 'page', runtime: { page: '', battlefield: { ready: true } } };
  const ended = { pageId: 'page', runtime: { page: '', battlefield: { ready: false }, battleResult: result } };
  vi.spyOn(client, 'request').mockResolvedValueOnce(active).mockResolvedValue(ended);
  const observe = vi.spyOn(client, 'observe');
  if (race) observe.mockRejectedValue(new Error('Battlefield is not active'));
  else observe.mockResolvedValue(state());
  const events: unknown[] = [];
  await monitor(client, { durationMs: 1000, intervalMs: 250 }, (e) => events.push(e));
  expect(events.at(-1)).toMatchObject({ event: 'battle-ended', outcome: 'defeat', result });
});

it.each(['page', 'battle'] as const)(
  'does not attribute another %s result to the monitored match',
  async (replacement) => {
    const client = new ControlClient(15180, 'test');
    vi.spyOn(client, 'request')
      .mockResolvedValueOnce({ pageId: 'page', runtime: { page: '', battlefield: { ready: true } } })
      .mockResolvedValue({
        pageId: replacement === 'page' ? 'replacement' : 'page',
        runtime: {
          page: 'GUI:MultiplayerScore',
          battlefield: { ready: false },
          battleResult: {
            sessionId: 'replacement',
            frame: 123,
            player: 0,
            outcome: 'victory',
            source: 'native-game-loop',
          },
        },
      });
    vi.spyOn(client, 'observe').mockResolvedValue(state());
    const events: unknown[] = [];
    await monitor(client, { durationMs: 1000, intervalMs: 250 }, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ event: 'session-changed' });
    expect(events.at(-1)).not.toHaveProperty('outcome');
  },
);

it('returns immediately for an already ready product, with the current decision state', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request').mockResolvedValue({ runtime: { battlefield: { ready: true } } });
  const current = state({ production: [{ type: 'GAPILE', progress: 54, total: 54, onHold: false, suspended: true }] });
  const observe = vi.spyOn(client, 'observe').mockResolvedValue(current);
  const events: unknown[] = [];
  await monitor(client, { durationMs: 600000, stopOn: ['production-ready'] }, (e) => events.push(e));
  expect(observe).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toEqual({ event: 'monitor-finished', reason: 'production-ready', observation: current });
});

it('returns the last sampled sidebar and viewport when a monitor window expires without a trigger', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request').mockResolvedValue({ runtime: { battlefield: { ready: true } } });
  const current = state({
    frame: 120,
    sidebar: [{ type: 'GAPOWR', tab: 0, progress: 0, hasFactory: true, pending: false }],
    entities: [entity],
  });
  const observe = vi.spyOn(client, 'observe').mockResolvedValueOnce(state()).mockResolvedValue(current);
  const command = vi.spyOn(client, 'command');
  const events: unknown[] = [];
  const running = monitor(client, { durationMs: 500, intervalMs: 250 }, (event) => events.push(event));
  await vi.runAllTimersAsync();
  await running;
  expect(observe).toHaveBeenCalledTimes(2);
  expect(command).not.toHaveBeenCalled();
  expect(events.at(-1)).toEqual({
    event: 'monitor-finished',
    reason: 'duration',
    sessionId: 'battle',
    observation: current,
  });
});

it('does not return a duration decision state after the monitored session changes', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request').mockResolvedValue({ runtime: { battlefield: { ready: true } } });
  vi.spyOn(client, 'observe')
    .mockResolvedValueOnce(state())
    .mockResolvedValue(state({ sessionId: 'replacement' }));
  const events: unknown[] = [];
  const running = monitor(client, { durationMs: 1000, intervalMs: 250 }, (event) => events.push(event));
  await vi.runAllTimersAsync();
  await running;
  expect(events.at(-1)).toEqual({ event: 'session-changed', sessionId: 'replacement' });
  expect(events).not.toContainEqual(expect.objectContaining({ event: 'monitor-finished' }));
});

it('interrupts a requested monitor window when a visible owned unit takes damage', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request').mockResolvedValue({ runtime: { battlefield: { ready: true } } });
  const observe = vi
    .spyOn(client, 'observe')
    .mockResolvedValueOnce(state({ entities: [entity] }))
    .mockResolvedValue(state({ frame: 110, entities: [{ ...entity, health: 200 }] }));
  const events: unknown[] = [];
  const running = monitor(client, { durationMs: 30000, stopOn: ['damage'] }, (e) => events.push(e));
  await vi.runAllTimersAsync();
  await running;
  expect(observe).toHaveBeenCalledTimes(2);
  expect(events.at(-1)).toMatchObject({ event: 'monitor-finished', reason: 'damage', observation: { frame: 110 } });
});

it('reports whole-foundation visible overlaps without treating adjacent units as blockers', () => {
  const current = state({
    sidebar: [
      { type: 'GAPILE', tab: 0, progress: 54, hasFactory: true, pending: true, foundation: { width: 3, height: 2 } },
    ],
    entities: [
      entity,
      { ...entity, id: 'adjacent', cell: { x: 5, y: 4 } },
      { ...entity, id: 'yard', kind: 'building', cell: { x: 0, y: 2 }, foundation: { width: 3, height: 3 } },
    ],
  });
  expect(visiblePlacementBlockers(current, 'GAPILE', { x: 2, y: 3 })?.map((e) => e.id)).toEqual(['tank', 'yard']);
  expect(visiblePlacementBlockers(current, 'UNKNOWN', { x: 2, y: 3 })).toBeUndefined();
});
it('does not retry a consumed building whose result cannot be observed', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  const command = vi
    .spyOn(client, 'command')
    .mockResolvedValue({ state: 'submitted', commandId: '00000000-0000-0000-0000-000000000001' });
  vi.spyOn(client, 'look').mockResolvedValue(
    state({ production: [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: false }] }),
  );
  vi.spyOn(client, 'observe').mockResolvedValue(state({ frame: 180 }));
  const result = expect(
    placeBuilding(
      client,
      {
        sessionId: 'battle',
        type: 'GAPOWR',
        cells: [
          { x: 4, y: 4 },
          { x: 5, y: 5 },
        ],
      },
      () => {},
    ),
  ).rejects.toThrow('Product consumed');
  await vi.runAllTimersAsync();
  await result;
  expect(command.mock.calls.filter(([action]) => action === 'place')).toHaveLength(1);
});
it('confirms a new owned building, not the submitted receipt or an existing building', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'command').mockResolvedValue({
    state: 'submitted',
    commandId: '00000000-0000-0000-0000-000000000001',
  });
  const building = { ...entity, kind: 'building' as const, type: 'GAPOWR' };
  vi.spyOn(client, 'look').mockResolvedValue(
    state({
      entities: [building],
      production: [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: false }],
    }),
  );
  vi.spyOn(client, 'observe').mockResolvedValue(
    state({ frame: 180, entities: [building, { ...building, id: 'new' }] }),
  );
  const events: unknown[] = [];
  const promise = placeBuilding(client, { sessionId: 'battle', type: 'GAPOWR', cells: [{ x: 4, y: 4 }] }, (e) =>
    events.push(e),
  );
  await vi.runAllTimersAsync();
  expect(await promise).toMatchObject({ id: 'new' });
  expect(events.at(-1)).toMatchObject({ event: 'building-confirmed' });
});

it('waits for building visibility after consumption without issuing another placement', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  const command = vi
    .spyOn(client, 'command')
    .mockResolvedValue({ state: 'submitted', commandId: '00000000-0000-0000-0000-000000000002' });
  vi.spyOn(client, 'look').mockResolvedValue(
    state({ production: [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: false }] }),
  );
  const building = { ...entity, kind: 'building' as const, type: 'GAPOWR', id: 'new' };
  vi.spyOn(client, 'observe')
    .mockResolvedValueOnce(state({ frame: 180 }))
    .mockResolvedValueOnce(state({ frame: 181 }))
    .mockResolvedValue(state({ frame: 182, entities: [building] }));
  const result = placeBuilding(
    client,
    {
      sessionId: 'battle',
      type: 'GAPOWR',
      cells: [
        { x: 4, y: 4 },
        { x: 5, y: 5 },
      ],
    },
    () => {},
  );
  await vi.runAllTimersAsync();
  expect(await result).toEqual(building);
  expect(command).toHaveBeenCalledTimes(1);
});

it('allows slow advancing simulation to settle without retrying before 60 frames', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  const pending = [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: true }];
  vi.spyOn(client, 'look').mockResolvedValue(state({ production: pending }));
  let frame = 100;
  const command = vi.spyOn(client, 'command').mockImplementation(async () => {
    if (command.mock.calls.length > 1) expect(frame).toBeGreaterThanOrEqual(160);
    return { state: 'submitted', commandId: '00000000-0000-0000-0000-000000000003' as const };
  });
  vi.spyOn(client, 'observe').mockImplementation(async () =>
    state({
      frame: ++frame,
      production: command.mock.calls.length === 1 ? pending : [],
      entities: command.mock.calls.length === 1 ? [] : [{ ...entity, id: 'new', type: 'GAPOWR', kind: 'building' }],
    }),
  );
  const result = placeBuilding(
    client,
    {
      sessionId: 'battle',
      type: 'GAPOWR',
      cells: [
        { x: 4, y: 4 },
        { x: 5, y: 5 },
      ],
    },
    () => {},
  );
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ id: 'new' });
  expect(command).toHaveBeenCalledTimes(2);
});

it('stops an unconsumed placement when simulation is stalled, without trying another site', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  const current = state({ production: [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: true }] });
  vi.spyOn(client, 'look').mockResolvedValue(current);
  vi.spyOn(client, 'observe').mockResolvedValue(current);
  const command = vi
    .spyOn(client, 'command')
    .mockResolvedValue({ state: 'submitted', commandId: '00000000-0000-0000-0000-000000000004' });
  const result = expect(
    placeBuilding(
      client,
      {
        sessionId: 'battle',
        type: 'GAPOWR',
        cells: [
          { x: 4, y: 4 },
          { x: 5, y: 5 },
        ],
      },
      () => {},
    ),
  ).rejects.toThrow('outcome unknown');
  await vi.runAllTimersAsync();
  await result;
  expect(command).toHaveBeenCalledTimes(1);
});

it('preserves a command ID after ambiguous submission failure without replaying it', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'observe').mockResolvedValue(state());
  const request = vi.spyOn(client, 'request').mockRejectedValue(new Error('transport timeout'));
  await expect(client.command('produce', { type: 'GAPOWR' }, 'battle')).rejects.toThrow('inspect commandStatus');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]).toMatchObject([
    'command',
    { sessionId: 'battle', action: 'produce', commandId: expect.any(String) },
  ]);
});

it('handles a native end-screen transition between status and observation', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request')
    .mockResolvedValueOnce({ runtime: { battlefield: { ready: true } } })
    .mockResolvedValueOnce({ runtime: { page: 'GUI:MultiplayerScore', battlefield: { ready: false } } });
  vi.spyOn(client, 'observe').mockRejectedValue(new Error('Battlefield is not active'));
  const events: unknown[] = [];
  await monitor(client, {}, (e) => events.push(e));
  expect(events).toMatchObject([{ event: 'battle-ended', outcome: 'unknown' }]);
});

it.each(['unavailable member', 'unavailable target'])(
  'reports current visible state without writes after %s',
  async (failure) => {
    const { orderGroup } = await import('@ra2vm/control/orderGroup');
    const client = new ControlClient(15180, 'test');
    const visible = state({ entities: [entity] });
    vi.spyOn(client, 'observe').mockResolvedValue(visible);
    const command = vi.spyOn(client, 'command');
    const events: unknown[] = [];
    const member = failure === 'unavailable member';
    await expect(
      orderGroup(
        client,
        {
          sessionId: 'battle',
          action: member ? 'guard' : 'attack',
          units: member ? ['tank', 'hidden'] : ['tank'],
          ...(member ? {} : { target: 'gone' }),
        },
        (e) => events.push(e),
      ),
    ).rejects.toThrow(member ? 'Every group member' : 'Target must be visible');
    expect(command).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        event: 'group-rejected',
        submitted: [],
        remaining: member ? ['tank', 'hidden'] : ['tank'],
        unavailable: member ? ['hidden'] : [],
        ...(member ? {} : { unavailableTarget: 'gone' }),
        next: 'reobserve',
        observation: visible,
      },
    ]);
  },
);

it('submits one native group intent rather than sequential unit commands', async () => {
  const { orderGroup } = await import('@ra2vm/control/orderGroup');
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'observe').mockResolvedValue(state({ entities: [entity, { ...entity, id: 'second' }] }));
  const receipt = { state: 'submitted', commandId: '00000000-0000-0000-0000-000000000001' } as const;
  const command = vi.spyOn(client, 'command').mockResolvedValue(receipt);
  const events: unknown[] = [];
  expect(
    await orderGroup(client, { sessionId: 'battle', action: 'guard', units: ['tank', 'second'] }, (e) =>
      events.push(e),
    ),
  ).toEqual(receipt);
  expect(command).toHaveBeenCalledExactlyOnceWith('guard', { units: ['tank', 'second'] }, 'battle');
  expect(events).toEqual([{ event: 'group-submitted', action: 'guard', count: 2, ...receipt }]);
});

it.each(['rejected', 'unknown'])('does not replay a group after native %s', async (failure) => {
  const { orderGroup } = await import('@ra2vm/control/orderGroup');
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'observe').mockResolvedValue(state({ entities: [entity, { ...entity, id: 'second' }] }));
  const command = vi
    .spyOn(client, 'command')
    .mockRejectedValue(
      failure === 'rejected' ? new NativeCommandError('group-receipt', 'rejected') : new Error('outcome unknown'),
    );
  const events: unknown[] = [];
  await expect(
    orderGroup(client, { sessionId: 'battle', action: 'guard', units: ['tank', 'second'] }, (e) => events.push(e)),
  ).rejects.toThrow();
  expect(command).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({
    event: 'group-interrupted',
    units: ['tank', 'second'],
    state: failure,
    next: failure === 'rejected' ? 'reobserve' : 'inspect',
  });
  expect(events.at(-1)).not.toHaveProperty('submitted');
});

it('waits for native visibility refresh after a camera receipt', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'command').mockResolvedValue({
    state: 'submitted',
    commandId: '00000000-0000-0000-0000-000000000001',
  });
  vi.spyOn(client, 'observe')
    .mockResolvedValueOnce(state())
    .mockResolvedValueOnce(state({ frame: 100 }))
    .mockResolvedValue(state({ frame: 102, entities: [entity] }));
  const result = client.look({ cell: { x: 4, y: 4 } }, 'battle');
  await vi.runAllTimersAsync();
  expect((await result).entities).toEqual([entity]);
});

it('rejects an invented batch envelope before any operation and explains the native CLI shape', async () => {
  const { batch } = await import('@ra2vm/control/batch');
  const client = new ControlClient(15180, 'test');
  const observe = vi.spyOn(client, 'observe');
  const command = vi.spyOn(client, 'command');
  await expect(
    batch(client, { orders: [{ type: 'unit-order', unitIds: [7], order: 'move', cell: { x: 4, y: 5 } }] }),
  ).rejects.toThrow('Example orders: [{"action":"guard","unit":"VISIBLE_OWNED_ID"}]');
  expect(observe).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
});

it('executes a batch sequentially and stops without replay after rejection', async () => {
  const { batch } = await import('@ra2vm/control/batch');
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'observe').mockResolvedValue(state());
  const calls: string[] = [];
  vi.spyOn(client, 'command').mockImplementation(async (action, _extra, session) => {
    expect(session).toBe('battle');
    calls.push(action);
    if (action === 'attack') throw new NativeCommandError('inspect-this-receipt', 'rejected');
    return { state: 'submitted', commandId: '00000000-0000-0000-0000-000000000001' as const };
  });
  const result = await batch(client, {
    orders: [{ action: 'produce', type: 'E1' }, { action: 'attack' }, { action: 'move' }],
  });
  expect(calls).toEqual(['produce', 'attack']);
  expect(result).toMatchObject({ state: 'interrupted', failed: 1, remaining: 1 });
  expect(result.completed).toHaveLength(1);
  expect(result.error).toContain('inspect-this-receipt');
});

it('keeps target IDs and failure evidence while compacting protocol metadata', async () => {
  const { compactOutput } = await import('@ra2vm/control/output');
  expect(
    compactOutput({
      sessionId: 'uuid',
      entities: [entity],
      commandId: '00000000-0000-0000-0000-000000000003',
      error: 'Inspect receipt xyz',
    }),
  ).toEqual({
    entities: [{ id: 'tank', kind: 'vehicle', owner: 0, health: 300, type: 'MTNK', cell: { x: 4, y: 4 } }],
    error: 'Inspect receipt xyz',
    session: 'uuid',
  });
});

it.each([200, 422])(
  'confirms a delivered HTTP %s validation error through its same-session receipt without replaying the write',
  async (status) => {
    const client = new ControlClient(15180, 'test');
    vi.spyOn(client, 'observe').mockResolvedValue(state());
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unit unavailable or not owned by player' }), { status }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { state: 'unknown' } })));
    try {
      await expect(client.command('move', { unit: 'gone', cell: { x: 4, y: 4 } }, 'battle')).rejects.toMatchObject({
        state: 'rejected',
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      const requests = fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
      expect(requests.map((r) => r.method)).toEqual(['command', 'commandStatus']);
      expect(requests[0].params.commandId).toBe(requests[1].params.commandId);
      expect(requests[1].params.sessionId).toBe('battle');
    } finally {
      fetch.mockRestore();
    }
  },
);

it.each([409, 504])(
  'keeps HTTP %s transport failures uncertain even if their text resembles a rejection',
  async (status) => {
    const client = new ControlClient(15180, 'test');
    vi.spyOn(client, 'observe').mockResolvedValue(state());
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Target is not visible in the current viewport' }), { status }),
      );
    try {
      await expect(client.command('attack', { unit: 'tank', target: 'gone' }, 'battle')).rejects.toThrow(
        'inspect commandStatus',
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  },
);

it('yields when a local support power finishes charging, without issuing an order', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request').mockResolvedValue({ runtime: { battlefield: { ready: true } } });
  const power = { type: 'AmericanParaDropSpecial', tab: 1, ready: false, onHold: false, requiresTarget: true };
  const charged = state({ frame: 110, supportPowers: [{ ...power, ready: true }], targetingPower: null });
  vi.spyOn(client, 'observe')
    .mockResolvedValueOnce(state({ supportPowers: [power] }))
    .mockResolvedValue(charged);
  const command = vi.spyOn(client, 'command');
  const events: unknown[] = [];
  const running = monitor(client, { durationMs: 30000, stopOn: ['support-ready'] }, (e) => events.push(e));
  await vi.runAllTimersAsync();
  await running;
  expect(events[0]).toMatchObject({ event: 'observation', supportPowers: [power] });
  expect(events.at(-1)).toEqual({ event: 'monitor-finished', reason: 'support-ready', observation: charged });
  expect(command).not.toHaveBeenCalled();
});

it('waits through menu/loading and returns the first observation without gameplay writes', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  const request = vi
    .spyOn(client, 'request')
    .mockResolvedValueOnce({ phase: 'running', runtime: { page: 'GUI:SkirmishGame', battlefield: { ready: false } } })
    .mockResolvedValue({ phase: 'running', runtime: { battlefield: { ready: true } } });
  const current = state({ frame: 1 });
  const observe = vi.spyOn(client, 'observe').mockResolvedValue(current);
  const command = vi.spyOn(client, 'command');
  const waiting = waitForBattle(client, { timeoutMs: 5000 });
  await vi.runAllTimersAsync();
  expect(await waiting).toEqual({ event: 'battle-ready', observation: current });
  expect(observe).toHaveBeenCalledTimes(1);
  expect(request.mock.calls.every(([method]) => method === 'ui.status')).toBe(true);
  expect(command).not.toHaveBeenCalled();
});

it('reports readiness timeout and runtime failure without starting or replacing a match', async () => {
  vi.useFakeTimers();
  const client = new ControlClient(15180, 'test');
  const request = vi.spyOn(client, 'request').mockResolvedValue({ phase: 'running' });
  const waiting = expect(waitForBattle(client, { timeoutMs: 500 })).rejects.toThrow('readiness timeout');
  await vi.runAllTimersAsync();
  await waiting;
  expect(request.mock.calls.every(([method]) => method === 'ui.status')).toBe(true);
  request.mockResolvedValue({ phase: 'blocked', failure: 'Missing original resources' });
  await expect(waitForBattle(client, {})).rejects.toThrow('Missing original resources');
});

it('does not conceal an observation failure in a still-active battle', async () => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'request').mockResolvedValue({ phase: 'running', runtime: { battlefield: { ready: true } } });
  vi.spyOn(client, 'observe').mockRejectedValue(new Error('Invalid native viewport'));
  await expect(waitForBattle(client, {})).rejects.toThrow('Invalid native viewport');
});

it.each(['success', 'rejection', 'replacement'] as const)(
  'runs placement follow-up with confirmed prerequisite and stops on %s',
  async (outcome) => {
    vi.useFakeTimers();
    const client = new ControlClient(15180, 'test');
    const ready = state({ production: [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: false }] });
    const building = { ...entity, id: 'new', kind: 'building' as const, type: 'GAPOWR' };
    const confirmed = state({ frame: 180, entities: [building] });
    vi.spyOn(client, 'look').mockResolvedValue(ready);
    const observe = vi
      .spyOn(client, 'observe')
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(confirmed)
      .mockResolvedValue(outcome === 'replacement' ? state({ sessionId: 'other' }) : confirmed);
    const events: unknown[] = [];
    const command = vi.spyOn(client, 'command').mockImplementation(async (action, params) => {
      if (action !== 'place') {
        expect(events).toContainEqual(expect.objectContaining({ event: 'building-confirmed' }));
        expect(observe).toHaveBeenCalledTimes(3);
      }
      if (outcome === 'rejection' && params.type === 'MTNK') throw new NativeCommandError('reject', 'rejected');
      return { state: 'submitted', commandId: '00000000-0000-0000-0000-000000000003' };
    });
    const pending = placeBuilding(
      client,
      {
        sessionId: 'battle',
        type: 'GAPOWR',
        cells: [{ x: 4, y: 4 }],
        afterOrders: [
          { action: 'produce', type: 'GAPILE' },
          { action: 'produce', type: 'MTNK' },
          { action: 'produce', type: 'E1' },
        ],
      },
      (e) => events.push(e),
    );
    const checked =
      outcome === 'success'
        ? expect(pending).resolves.toEqual(building)
        : expect(pending).rejects.toThrow(outcome === 'replacement' ? 'Session changed' : 'follow-up interrupted');
    await vi.runAllTimersAsync();
    await checked;
    expect(command.mock.calls.map(([action, params]) => (action === 'place' ? 'place' : params.type))).toEqual(
      outcome === 'success'
        ? ['place', 'GAPILE', 'MTNK', 'E1']
        : outcome === 'rejection'
          ? ['place', 'GAPILE', 'MTNK']
          : ['place'],
    );
    if (outcome === 'rejection')
      expect(events.at(-1)).toMatchObject({
        event: 'placement-followup',
        state: 'interrupted',
        failed: 1,
        remaining: 1,
        completed: [{ index: 0, action: 'produce' }],
      });
  },
);

it('rejects malformed placement follow-up before moving the camera or placing', async () => {
  const client = new ControlClient(15180, 'test');
  const look = vi.spyOn(client, 'look');
  const command = vi.spyOn(client, 'command');
  await expect(
    placeBuilding(
      client,
      {
        sessionId: 'battle',
        type: 'GAPOWR',
        cells: [{ x: 4, y: 4 }],
        afterOrders: [{ action: 'produce', sessionId: 'other' }],
      },
      () => {},
    ),
  ).rejects.toThrow('IDs are managed');
  expect(look).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
});

it.each(['rejected', 'uncertain'] as const)('never runs follow-up after %s placement', async (outcome) => {
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'look').mockResolvedValue(
    state({ production: [{ type: 'GAPOWR', progress: 54, total: 54, onHold: false, suspended: false }] }),
  );
  const command = vi
    .spyOn(client, 'command')
    .mockRejectedValue(outcome === 'rejected' ? new NativeCommandError('reject', 'rejected') : new Error('uncertain'));
  await expect(
    placeBuilding(
      client,
      {
        sessionId: 'battle',
        type: 'GAPOWR',
        cells: [{ x: 4, y: 4 }],
        afterOrders: [{ action: 'produce', type: 'GAPILE' }],
      },
      () => {},
    ),
  ).rejects.toThrow();
  expect(command).toHaveBeenCalledTimes(1);
  expect(command.mock.calls[0][0]).toBe('place');
});

it('continues caller-declared independent orders after confirmed rejection and reports noncontiguous completions', async () => {
  const { batch } = await import('@ra2vm/control/batch');
  const client = new ControlClient(15180, 'test');
  vi.spyOn(client, 'observe').mockResolvedValue(state());
  const command = vi
    .spyOn(client, 'command')
    .mockRejectedValueOnce(new NativeCommandError('lost-attacker', 'rejected'))
    .mockResolvedValueOnce({ state: 'submitted', commandId: '00000000-0000-0000-0000-000000000001' })
    .mockResolvedValueOnce({ state: 'submitted', commandId: '00000000-0000-0000-0000-000000000002' });
  const result = await batch(client, {
    onRejected: 'continue',
    orders: [
      { action: 'attack', unit: 'gone', target: 'enemy' },
      { action: 'deploy', units: ['visible-a', 'visible-b'] },
      { action: 'produce', type: 'MTNK' },
    ],
  });
  expect(command.mock.calls.map(([action]) => action)).toEqual(['attack', 'deploy', 'produce']);
  expect(result).toMatchObject({
    state: 'completed-with-rejections',
    rejected: [{ index: 0, commandId: 'lost-attacker' }],
    completed: [{ index: 1 }, { index: 2 }],
  });
});

it.each(['unknown', 'session changed', 'queue-full'])(
  'stops independent orders on %s even after a confirmed rejection',
  async (failure) => {
    const { batch } = await import('@ra2vm/control/batch');
    const client = new ControlClient(15180, 'test');
    vi.spyOn(client, 'observe').mockResolvedValue(state());
    const command = vi
      .spyOn(client, 'command')
      .mockRejectedValueOnce(new NativeCommandError('first', 'rejected'))
      .mockRejectedValueOnce(
        failure === 'session changed' ? new Error(failure) : new NativeCommandError('second', failure),
      );
    const result = await batch(client, {
      onRejected: 'continue',
      orders: [{ action: 'attack' }, { action: 'deploy' }, { action: 'produce' }],
    });
    expect(command).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'interrupted',
      failed: 1,
      remaining: 1,
      next: 'inspect',
      completed: [],
      rejected: [{ index: 0 }],
    });
  },
);

it('validates rejection policy before any batch operation', async () => {
  const { batch } = await import('@ra2vm/control/batch');
  const client = new ControlClient(15180, 'test');
  const observe = vi.spyOn(client, 'observe');
  await expect(batch(client, { onRejected: 'ignore', orders: [{ action: 'guard' }] })).rejects.toThrow('onRejected');
  expect(observe).not.toHaveBeenCalled();
});
