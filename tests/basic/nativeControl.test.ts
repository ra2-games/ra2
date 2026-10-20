import { describe, expect, it } from 'vitest';
import { createNativeControl } from '../../src/games/shared/nativeControl';
import { YR_CONTROL_PROFILE } from '../../src/games/yr/control';
import { RA2_CONTROL_PROFILE } from '../../src/games/ra2/control';
import { createGuestMemory, writeAsciiZ, writeU32 } from '../helpers/guestMemory';
import type { BattleObservation } from '@ra2vm/control/contracts';

describe.each([RA2_CONTROL_PROFILE, YR_CONTROL_PROFILE])('$game native control', (profile) => {
  function fixture() {
    const memory = createGuestMemory();
    for (const e of [
      profile.hook,
      profile.sidebar.constructor,
      profile.sidebar.action,
      profile.sidebar.setTab,
      profile.viewport.position,
      profile.viewport.floor,
      ...(profile.battleResult ? [profile.battleResult.terminal, ...profile.battleResult.evidence] : []),
      ...(profile.supportPowers
        ? [
            profile.supportPowers.canFire,
            profile.supportPowers.selectionEvidence,
            profile.supportPowers.targetingEvidence,
          ]
        : []),
      ...(profile.foundation ? [profile.foundation.widthEvidence, profile.foundation.heightEvidence] : []),
      ...Object.values(profile.playerControl).filter(
        (v): v is { address: number; bytes: readonly number[] } => typeof v !== 'number',
      ),
    ])
      memory.write_memory([...e.bytes], e.address);
    const house = 0x100000,
      unit = 0x110000,
      type = 0x120000,
      entries = 0x130000;
    writeU32(memory, profile.frame, 100);
    writeU32(memory, profile.localHouse, house);
    writeU32(memory, house + profile.houseIndex, 0);
    writeU32(memory, house + profile.cash, 1000);
    for (const [array, offset, object] of [
      [profile.arrays[0]!, 0, unit],
      [profile.types[0]!, 4, type],
    ] as const) {
      writeU32(memory, array.address + 4, entries + offset);
      writeU32(memory, array.address + 16, 1);
      writeU32(memory, entries + offset, object);
    }
    writeU32(memory, unit + profile.owner, house);
    writeU32(memory, unit + profile.uniqueId, 77);
    writeU32(memory, unit + profile.health, 1000);
    writeU32(memory, unit + profile.arrays[0]!.typeOffset, type);
    memory.write_memory([1], unit + profile.alive);
    writeAsciiZ(memory, type + 0x24, 'AMCV');
    const tactical = 0x140000,
      cells = 0x150000,
      cell = 0x160000;
    writeU32(memory, profile.viewport.tactical, tactical);
    writeU32(memory, profile.viewport.bounds + 8, 800);
    writeU32(memory, profile.viewport.bounds + 12, 600);
    writeU32(memory, tactical + 0xb0, -30);
    writeU32(memory, tactical + 0xb4, -30);
    writeU32(memory, profile.viewport.cells, cells);
    writeU32(memory, cells, cell);
    writeU32(memory, cell + 0x12c, 8);
    memory.write_memory([255, 255], cell + 0x120);
    memory.write_memory([1], unit + profile.viewport.visible);
    const scale = new Uint8Array(8);
    new DataView(scale.buffer).setFloat64(0, 0.143, true);
    memory.write_memory(scale, profile.viewport.zScale);
    writeU32(memory, profile.viewport.heightLevel, 104);
    const control = createNativeControl(memory, () => 0x80000, profile)!;
    const state = control.request('observe', undefined) as BattleObservation;
    return { memory, control, state, box: 0x80100, unit, house, tactical, cell };
  }

  it('publishes a bounded group table only after every member passes current-view validation', () => {
    const { memory, control, state, unit, box } = fixture();
    const request = { sessionId: state.sessionId, observedFrame: state.frame, commandId: 'group', action: 'guard' };
    for (const units of [[], ['77', '77'], ['77', 'hidden'], Array.from({ length: 65 }, (_, i) => String(i))]) {
      expect(() => control.request('command', { ...request, units })).toThrow();
      expect(new DataView(memory.read_memory(box, 4).slice().buffer).getUint32(0, true)).toBe(0);
    }
    expect(() => control.request('command', { ...request, units: ['77'], unit: '77' })).toThrow('do not combine');
    expect(() => control.request('command', { ...request, action: 'repair', units: ['77'] })).toThrow('unit action');
    expect(control.request('command', { ...request, units: ['77'] })).toMatchObject({ state: 'pending' });
    const payload = new DataView(memory.read_memory(box + 16, 112).slice().buffer);
    expect(payload.getUint32(52, true)).toBe(1);
    const table = payload.getUint32(56, true);
    expect(table).toBe(0x80000 + 7168);
    const group = new DataView(memory.read_memory(table, 512).slice().buffer);
    expect(group.getUint32(0, true)).toBe(unit);
    expect(group.getUint32(4, true)).toBe(77);
    expect(group.getUint32(8, true)).toBe(0);
  });

  it('retains the native result without dereferencing released House memory and resets its session', () => {
    const { control, memory, state, house } = fixture();
    const record = 0x80000 + 8192;
    expect(control.battleResult!()).toBeNull();
    writeU32(memory, record + 4, 2);
    writeU32(memory, record + 8, 2);
    writeU32(memory, record + 12, 999);
    writeU32(memory, record + 16, 3);
    writeU32(memory, profile.localHouse, 0);
    expect(control.battleResult!()).toEqual({
      sessionId: state.sessionId,
      frame: 999,
      player: 3,
      outcome: 'defeat',
      source: 'native-game-loop',
    });
    // The native loop advances generation even if no host observed the intervening match.
    writeU32(memory, record, 2);
    writeU32(memory, record + 4, 1);
    writeU32(memory, profile.localHouse, house);
    expect(control.battleResult!()).toBeNull();
    const next = control.request('observe', undefined) as BattleObservation;
    expect(next.sessionId).not.toBe(state.sessionId);
    control.dispose();
    expect(() => control.battleResult!()).toThrow('destroyed');
  });

  it('keeps commands bound when the first native iteration follows the first host observation', () => {
    const { control, memory, state, box } = fixture();
    const params = {
      sessionId: state.sessionId,
      observedFrame: state.frame,
      commandId: 'first',
      action: 'guard',
      unit: '77',
    };
    expect(control.request('command', params)).toMatchObject({ state: 'pending' });
    writeU32(memory, 0x80000 + 8192, 1);
    writeU32(memory, box, 3);
    expect(control.request('commandStatus', params)).toMatchObject({ state: 'submitted' });
    expect((control.request('observe', undefined) as BattleObservation).sessionId).toBe(state.sessionId);
  });

  it('requires loaded instruction evidence before allocating or writing', () => {
    const memory = createGuestMemory();
    const reserve = () => {
      throw new Error('Must not allocate');
    };
    expect(createNativeControl(memory, reserve, profile)).toBeNull();
    expect(memory.bytes.some(Boolean)).toBe(false);
    const evidence = [
      profile.hook,
      profile.sidebar.constructor,
      profile.sidebar.action,
      profile.sidebar.setTab,
      profile.viewport.position,
      profile.viewport.floor,
      ...(profile.battleResult ? [profile.battleResult.terminal, ...profile.battleResult.evidence] : []),
      ...(profile.supportPowers
        ? [
            profile.supportPowers.canFire,
            profile.supportPowers.selectionEvidence,
            profile.supportPowers.targetingEvidence,
          ]
        : []),
      ...(profile.foundation ? [profile.foundation.widthEvidence, profile.foundation.heightEvidence] : []),
      ...Object.values(profile.playerControl).filter(
        (v): v is { address: number; bytes: readonly number[] } => typeof v !== 'number',
      ),
    ];
    for (const missing of evidence) {
      const candidate = createGuestMemory();
      for (const entry of evidence) candidate.write_memory([...entry.bytes], entry.address);
      candidate.write_memory([missing.bytes[0]! ^ 0xff], missing.address);
      expect(createNativeControl(candidate, reserve, profile)).toBeNull();
    }
  });

  it('requires an actual native cameo and reports native rejection without replaying the command', () => {
    const { control, memory, state, box, house } = fixture();
    const request = {
      sessionId: state.sessionId,
      observedFrame: state.frame,
      commandId: 'production',
      action: 'produce',
      type: 'AMCV',
    };
    expect(control.request('catalog', undefined)).toEqual([]);
    expect(() => control.request('command', request)).toThrow('native sidebar');
    expect(memory.read_memory(box, 4)).toEqual(new Uint8Array(4));
    const layout = profile.sidebar;
    const item = layout.strips + layout.items;
    writeU32(memory, layout.strips + layout.count, 1);
    writeU32(memory, item, 0);
    writeU32(memory, item + 4, 40);
    expect(control.request('catalog', undefined)).toEqual([{ type: 'AMCV', kind: 'vehicle', index: 0, rtti: 40 }]);
    expect(control.request('command', request)).toMatchObject({ state: 'pending' });
    expect(memory.read_memory(box + 12, 4)).toEqual(new Uint8Array([1, 0, 0, 0]));
    expect(memory.read_memory(house + profile.cash, 4)).toEqual(new Uint8Array([232, 3, 0, 0]));
    writeU32(memory, box, 5);
    expect(control.request('commandStatus', request)).toMatchObject({ state: 'rejected' });
    expect(control.request('command', request)).toMatchObject({ state: 'rejected' });
    expect(memory.read_memory(box, 4)).toEqual(new Uint8Array(4));
  });

  it('exposes bounded foundation dimensions only for visible owned buildings and available cameos', () => {
    const { control, memory, unit, house } = fixture();
    const layout = profile.foundation!;
    const buildings = profile.arrays.find((a) => a.kind === 'building')!;
    const types = profile.types.find((a) => a.kind === 'building')!;
    writeU32(memory, profile.arrays[0]!.address + 16, 0);
    writeU32(memory, buildings.address + 4, 0x130000);
    writeU32(memory, buildings.address + 16, 1);
    writeU32(memory, unit + buildings.typeOffset, 0x120000);
    writeU32(memory, types.address + 4, 0x130004);
    writeU32(memory, types.address + 16, 1);
    writeAsciiZ(memory, 0x120024, 'GAPILE');
    writeU32(memory, 0x120000 + layout.typeOffset, 2);
    writeU32(memory, layout.widths + 8, 3);
    writeU32(memory, layout.heights + 8, 2);
    const observe = () => control.request('observe', undefined) as BattleObservation;
    expect(observe().entities[0]?.foundation).toEqual({ width: 3, height: 2 });
    expect(observe().sidebar).toEqual([]);
    writeU32(memory, profile.sidebar.strips + profile.sidebar.count, 1);
    writeU32(memory, profile.sidebar.strips + profile.sidebar.items + 4, types.rtti);
    expect(observe().sidebar[0]?.foundation).toEqual({ width: 3, height: 2 });
    writeU32(memory, unit + profile.owner, house + 0x1000);
    writeU32(memory, house + 0x1000 + profile.houseIndex, 1);
    expect(observe().entities[0]).not.toHaveProperty('foundation');
    memory.write_memory([0], unit + profile.viewport.visible);
    expect(observe().entities).toEqual([]);
    writeU32(memory, 0x120000 + layout.typeOffset, layout.count);
    expect(observe().sidebar[0]?.foundation).toBeUndefined();
  });

  it('omits dying objects still marked alive and rejects their unit orders', () => {
    const { control, memory, state, unit, box } = fixture();
    for (const health of [0, -1]) {
      writeU32(memory, unit + profile.health, health >>> 0);
      expect((control.request('observe', undefined) as BattleObservation).entities).toEqual([]);
      expect(() =>
        control.request('command', {
          sessionId: state.sessionId,
          observedFrame: state.frame,
          commandId: `dead-${health}`,
          action: 'move',
          unit: '77',
          cell: { x: 1, y: 1 },
        }),
      ).toThrow('Unit unavailable');
      expect(memory.read_memory(box, 4)).toEqual(new Uint8Array(4));
    }
  });

  it('submits exit without a selected unit and retains receipts after native battle teardown', () => {
    const { control, memory, state, box, unit, house } = fixture();
    writeU32(memory, unit + profile.health, 0);
    const request = {
      sessionId: state.sessionId,
      observedFrame: state.frame,
      commandId: 'exit',
      action: 'exit-battle',
    };
    for (const invalid of [
      { unit: '77' },
      { type: 'AMCV' },
      { cell: { x: 0, y: 0 } },
      { sessionId: 'stale' },
      { observedFrame: -500 },
    ]) {
      expect(() => control.request('command', { ...request, ...invalid })).toThrow();
      expect(memory.read_memory(box, 4)).toEqual(new Uint8Array(4));
    }
    expect(control.request('capabilities', undefined)).toMatchObject({
      actions: expect.arrayContaining(['exit-battle']),
    });
    expect(control.request('command', request)).toMatchObject({ state: 'pending' });
    expect(control.request('command', request)).toMatchObject({ state: 'pending' });
    expect(memory.read_memory(box + 16, 4)).toEqual(new Uint8Array([11, 0, 0, 0]));
    expect(() => control.request('command', { ...request, commandId: 'second' })).toThrow('busy');
    writeU32(memory, box, 3);
    writeU32(memory, profile.localHouse, 0);
    writeU32(memory, profile.frame, 0);
    expect(() => control.request('observe', undefined)).toThrow('Battle not ready');
    expect(control.request('commandStatus', request)).toMatchObject({ state: 'submitted' });
    expect(control.request('commandStatus', { ...request, commandId: 'absent' })).toMatchObject({ state: 'unknown' });
    expect(() => control.request('commandStatus', { ...request, sessionId: 'stale' })).toThrow('sessionId');
    // A newly observed native battle still invalidates the old receipts.
    writeU32(memory, profile.localHouse, house);
    writeU32(memory, profile.frame, 1);
    control.request('observe', undefined);
    expect(() => control.request('commandStatus', request)).toThrow('sessionId');
    control.dispose();
    expect(() => control.request('commandStatus', request)).toThrow('destroyed');
  });

  it('rejects stale, malformed and non-owned orders without publishing; duplicates never write another event', () => {
    const { control, memory, state, box, unit, house } = fixture();
    const request = {
      sessionId: state.sessionId,
      observedFrame: state.frame,
      commandId: 'one',
      action: 'deploy',
      unit: '77',
    };
    expect(state.entities[0]).toMatchObject({ id: '77', type: 'AMCV', health: 1000 });
    for (const invalid of [{ sessionId: 'old' }, { observedFrame: -500 }, { unit: 'missing' }, { action: 'toString' }])
      expect(() => control.request('command', { ...request, ...invalid })).toThrow();
    writeU32(memory, unit + profile.owner, house + 0x1000);
    writeU32(memory, house + 0x1000 + profile.houseIndex, 1);
    const opponent = (control.request('observe', undefined) as BattleObservation).entities[0]!;
    expect(opponent).not.toHaveProperty('mission');
    expect(opponent).not.toHaveProperty('health');
    expect(() => control.request('command', request)).toThrow('owned');
    writeU32(memory, unit + profile.owner, house);
    expect(memory.read_memory(box, 4)).toEqual(new Uint8Array(4));
    expect(control.request('command', request)).toMatchObject({ state: 'pending' });
    expect(() => control.request('command', { ...request, commandId: 'two' })).toThrow('busy');
    writeU32(memory, box, 3);
    expect(control.request('command', request)).toMatchObject({ state: 'submitted' });
    expect(memory.read_memory(box, 4)).toEqual(new Uint8Array(4));
    expect(() => control.request('command', { ...request, action: 'stop' })).toThrow('different');
    writeU32(memory, profile.frame, 50);
    expect(() => control.request('command', request)).toThrow('sessionId');
    control.dispose();
    expect(() => control.request('observe', undefined)).toThrow('destroyed');
  });

  it('never exposes off-screen, shrouded, fogged, undetected cloaked or disguised opponents, including guessed IDs', () => {
    const { memory, control, state, unit, house, cell, tactical, box } = fixture();
    const enemy = house + 0x1000;
    writeU32(memory, enemy + profile.houseIndex, 1);
    writeU32(memory, unit + profile.owner, enemy);
    const observe = () => control.request('observe', undefined) as BattleObservation;
    expect(observe().entities).toHaveLength(1);
    for (const hide of [
      () => {
        writeU32(memory, tactical + 0xb0, 10000);
        return () => writeU32(memory, tactical + 0xb0, -30);
      },
      () => {
        writeU32(memory, cell + 0x12c, 0);
        return () => writeU32(memory, cell + 0x12c, 8);
      },
      () => {
        memory.write_memory([254], cell + 0x121);
        return () => memory.write_memory([255], cell + 0x121);
      },
      () => {
        writeU32(memory, unit + profile.viewport.cloak, 2);
        return () => writeU32(memory, unit + profile.viewport.cloak, 0);
      },
      () => {
        memory.write_memory([1], unit + profile.viewport.disguised);
        return () => memory.write_memory([0], unit + profile.viewport.disguised);
      },
    ]) {
      const restore = hide();
      expect(observe()).toMatchObject({ perspective: 'viewport', entities: [] });
      expect(() =>
        control.request('command', {
          sessionId: state.sessionId,
          observedFrame: state.frame,
          commandId: 'hidden',
          action: 'camera',
          unit: '77',
        }),
      ).toThrow('not visible');
      expect(memory.read_memory(box, 4)).toEqual(new Uint8Array(4));
      restore();
      expect(observe().entities).toHaveLength(1);
    }
    writeU32(memory, unit + profile.viewport.cloak, 2);
    memory.write_memory([1, 0], cell + 0x7c);
    expect(observe().entities).toHaveLength(1);
  });

  it.each([416, 312, -520])('uses projected fog cells at height %i and physical cloak sensors', (z) => {
    const { memory, control, unit, house, tactical, cell } = fixture();
    const cells = 0x150000;
    const projected = 0x170000;
    const neighbor = 0x171000;
    const offset = Math.trunc(Math.trunc(z / 104) / 2) + (z % 208 ? 1 : 0);
    writeU32(memory, unit + profile.location, 20 * 256);
    writeU32(memory, unit + profile.location + 4, 20 * 256);
    writeU32(memory, unit + profile.location + 8, z);
    writeU32(memory, tactical + 0xb4, 300);
    writeU32(memory, cells + 4 * (20 + 512 * 20), cell);
    writeU32(memory, cells + 4 * (20 - offset + 512 * (20 - offset)), projected);
    writeU32(memory, projected + 0x12c, 8);
    memory.write_memory([255, 255], projected + 0x120);
    memory.write_memory([4, 4], cell + 0x120);
    const observe = () => (control.request('observe', undefined) as BattleObservation).entities;
    expect(observe()).toHaveLength(1);
    memory.write_memory([254], projected + 0x121);
    expect(observe()).toHaveLength(0);
    memory.write_memory([255, 255], cell + 0x120);
    expect(observe()).toHaveLength(0);
    memory.write_memory([255], projected + 0x121);
    writeU32(memory, unit + profile.owner, house + 0x1000);
    writeU32(memory, house + 0x1000 + profile.houseIndex, 1);
    writeU32(memory, unit + profile.viewport.cloak, 2);
    memory.write_memory([1, 0], projected + 0x7c);
    expect(observe()).toHaveLength(0);
    memory.write_memory([1, 0], cell + 0x7c);
    expect(observe()).toHaveLength(1);
    if (z % 208) {
      writeU32(memory, cells + 4 * (21 - offset + 512 * (21 - offset)), neighbor);
      writeU32(memory, projected + 0x12c, 0);
      expect(observe()).toHaveLength(0);
      writeU32(memory, neighbor + 0x12c, 8);
      memory.write_memory([255, 255], neighbor + 0x120);
      expect(observe()).toHaveLength(1);
    }
    writeU32(memory, profile.viewport.heightLevel, 0);
    expect(observe).toThrow('Invalid viewport height level');
  });

  it('rejects a previously visible attack target after panning away, without revealing whether a guessed target exists', () => {
    const { memory, control, state, unit, house } = fixture();
    const target = unit + 0x1000;
    memory.write_memory(new Uint8Array(memory.read_memory(unit, 0x800)), target);
    writeU32(memory, target + profile.uniqueId, 88);
    writeU32(memory, target + profile.owner, house + 0x1000);
    writeU32(memory, house + 0x1000 + profile.houseIndex, 1);
    writeU32(memory, 0x130004, target);
    writeU32(memory, profile.arrays[0]!.address + 16, 2);
    // Preserve the type vector, which otherwise shares the second fixture slot.
    writeU32(memory, profile.types[0]!.address + 4, 0x130008);
    writeU32(memory, 0x130008, 0x120000);
    const request = {
      sessionId: state.sessionId,
      observedFrame: state.frame,
      commandId: 'attack',
      action: 'attack',
      unit: '77',
      target: '88',
    };
    memory.write_memory([0], target + profile.viewport.visible);
    expect(() => control.request('command', request)).toThrow('Target is not visible');
    expect(() => control.request('command', { ...request, target: '999' })).toThrow('Target is not visible');
    memory.write_memory([1], target + profile.viewport.visible);
    writeU32(memory, target + profile.location, 10000);
    expect(() => control.request('command', request)).toThrow('Target is not visible');
    writeU32(memory, target + profile.location, 0);
    expect(control.request('command', request)).toMatchObject({ state: 'pending' });
  });

  it('fails closed when the viewport is unavailable and never accepts a debug observation override', () => {
    const { memory, control, tactical } = fixture();
    writeU32(memory, tactical + 0xb0, 10000);
    expect(control.request('observe', { perspective: 'debug' })).toMatchObject({
      perspective: 'viewport',
      entities: [],
    });
    writeU32(memory, profile.viewport.tactical, 0);
    expect(() => control.request('observe', undefined)).toThrow('Viewport unavailable');
  });

  it('reads production identity from the native cameo instead of probing unrelated object layouts', () => {
    const { memory, control, house, unit } = fixture();
    const layout = profile.sidebar;
    const item = layout.strips + layout.items;
    const factory = 0x170000;
    writeU32(memory, layout.strips + layout.count, 1);
    writeU32(memory, item, 0);
    writeU32(memory, item + 4, 40);
    writeU32(memory, item + 0x0c, factory);
    writeU32(memory, factory + profile.factory.owner, house);
    writeU32(memory, factory + profile.factory.object, unit);
    writeU32(memory, factory + 0x24, 27);
    memory.write_memory([1], unit + profile.limbo);
    writeU32(memory, unit + profile.arrays[0]!.typeOffset, 0);
    expect((control.request('observe', undefined) as BattleObservation).production).toEqual([
      { type: 'AMCV', progress: 27, total: 54, onHold: false, suspended: false },
    ]);
  });

  it.each([1, 2, 3])('uses only the local house sensor during cloak state %i', (cloak) => {
    const { memory, control, unit, house, cell, tactical } = fixture();
    const enemy = house + 0x1000;
    writeU32(memory, house + profile.houseIndex, 7);
    writeU32(memory, enemy + profile.houseIndex, 1);
    writeU32(memory, unit + profile.owner, enemy);
    writeU32(memory, unit + profile.viewport.cloak, cloak);
    const observe = () => (control.request('observe', undefined) as BattleObservation).entities;
    // Neither player zero nor the target owner's sensors grant vision to player seven.
    memory.write_memory([1, 0, 1, 0], cell + 0x7c);
    expect(observe()).toEqual([]);
    // Native counts are words, so a nonzero high byte must count as detection too.
    memory.write_memory([0, 1], cell + 0x7c + 7 * 2);
    expect(observe()).toHaveLength(1);
    expect(observe()[0]).not.toHaveProperty('health');
    expect(observe()[0]).not.toHaveProperty('mission');
    for (const [address, hidden, visible] of [
      [unit + profile.viewport.visible, 0, 1],
      [cell + 0x12c, 0, 8],
      [cell + 0x120, 254, 255],
      [cell + 0x121, 254, 255],
      [unit + profile.viewport.disguised, 1, 0],
    ]) {
      memory.write_memory([hidden!], address!);
      expect(observe()).toEqual([]);
      memory.write_memory([visible!], address!);
      expect(observe()).toHaveLength(1);
    }
    writeU32(memory, tactical + 0xb0, 10000);
    expect(observe()).toEqual([]);
    writeU32(memory, tactical + 0xb0, -30);
    memory.write_memory([0, 0], cell + 0x7c + 7 * 2);
    expect(observe()).toEqual([]);
    // The 24-house sensor array must never spill into the adjacent disguise-sensor array.
    writeU32(memory, house + profile.houseIndex, 24);
    memory.write_memory([1, 0], cell + 0xac);
    expect(observe()).toEqual([]);
  });

  it('rechecks cloak ownership instead of retaining previously visible private data', () => {
    const { memory, control, unit, house } = fixture();
    writeU32(memory, unit + profile.viewport.cloak, 2);
    const observe = () => (control.request('observe', undefined) as BattleObservation).entities;
    expect(observe()[0]).toMatchObject({ id: '77', health: 1000 });
    writeU32(memory, house + 0x1000 + profile.houseIndex, 1);
    writeU32(memory, unit + profile.owner, house + 0x1000);
    expect(observe()).toEqual([]);
    writeU32(memory, unit + profile.owner, house);
    expect(observe()[0]).toMatchObject({ id: '77', health: 1000 });
  });
});
