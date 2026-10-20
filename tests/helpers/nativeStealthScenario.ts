import { expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BattleEntity, BattleObservation } from '@ra2vm/control/contracts';
import type { networkAiControl } from './networkAiControl';

type Control = Awaited<ReturnType<typeof networkAiControl>>;
type Cell = BattleEntity['cell'];

/** Produce original units through the real sidebar; never seed units, funds, visibility or clocks. */
export async function nativeStealthScenario(control: Control, pages: Page[], output: string, scenario: string) {
  if (!['mirage', 'cloak', 'both'].includes(scenario)) throw new Error('Unknown native stealth scenario');
  const own = (state: BattleObservation, type: string) =>
    state.entities.filter((e) => e.owner === state.player && e.type === type);
  async function wait(
    index: number,
    predicate: (state: BattleObservation) => boolean,
    reason: string,
    timeout = 180000,
  ) {
    let state: BattleObservation | undefined;
    await expect
      .poll(
        async () => {
          state = await control.observe(index);
          return predicate(state);
        },
        { timeout, message: reason, intervals: [1000] },
      )
      .toBe(true);
    return state!;
  }
  const initial = await control.observe(0);
  const yard = own(initial, 'GACNST')[0];
  expect(yard, 'Scenario requires the original Allied production chain').toBeDefined();
  const bases: BattleEntity[] = [yard!];
  async function terrain(center: Cell, water: boolean): Promise<Cell[]> {
    const worker = pages[0]!.workers().find((w) => w.url().includes('/vmWorker.ts'))!;
    return worker.evaluate((params) => (globalThis as any).__ra2VisibleTerrain(params), { center, water });
  }
  async function construct(type: string) {
    console.log('Native construction', type);
    await control.command(0, 'produce', { type });
    await wait(
      0,
      (s) => s.production.some((p) => p.type === type && p.progress === p.total),
      `${type} must finish natively`,
    );
    const candidates: Cell[] = [];
    if (type === 'GAYARD') {
      for (const base of bases) {
        await control.command(0, 'camera', { cell: base.cell });
        candidates.push(...(await terrain(base.cell, true)));
      }
      // A naval foundation can straddle shore tiles; try native placement around remembered bases too.
      // These coordinates reveal no terrain through the oracle, and the game must accept the complete foundation.
      for (const delta of [6, 4, 8, 10, -6, -4, -8, -10]) {
        for (const base of [...bases].reverse()) {
          for (const [dx, dy] of [
            [delta, 0],
            [0, delta],
            [delta, 2],
            [2, delta],
            [delta, delta],
          ]) {
            candidates.push({ x: base.cell.x + dx!, y: base.cell.y + dy! });
          }
        }
      }
    } else {
      // Try nearby foundations around every known building before widening the search.
      for (const delta of [3, -2, -3, 2, 4, -4, 5, -5, 6, -6]) {
        for (const base of bases) {
          for (const [dx, dy] of [
            [delta, 0],
            [0, delta],
            [delta, 2],
            [2, delta],
            [delta, delta],
          ]) {
            candidates.push({ x: base.cell.x + dx!, y: base.cell.y + dy! });
          }
        }
      }
    }
    const seen = new Set<string>();
    for (const cell of candidates) {
      const key = `${cell.x},${cell.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await control.command(0, 'camera', { cell });
      } catch (error) {
        if (String((error as { stdout?: string }).stdout).includes('Camera cell is outside the map')) continue;
        throw error;
      }
      const before = new Set(own(await control.observe(0), type).map((e) => e.id));
      await control.command(0, 'place', { type, cell });
      const sample = await control.observe(0);
      const placed = await wait(0, (s) => s.frame > sample.frame + 30, 'Placement must advance simulation', 30000);
      const building = own(placed, type).find((e) => !before.has(e.id));
      if (building) {
        bases.push(building);
        console.log('Native building placed', type, building.cell);
        return building;
      }
    }
    throw new Error(`No native legal placement found for ${type}`);
  }
  await construct('GAPOWR');
  await construct('GAREFN');
  await construct('GAPILE');
  await construct('GAWEAP');
  await construct('GAPOWR');
  await construct('AMRADR');
  await construct('GATECH');
  const modes = scenario === 'both' ? ['cloak', 'mirage'] : [scenario];
  const enemyHome = await control.observe(1);
  const homeScout = own(enemyHome, 'MTNK')[0]!;
  expect(homeScout).toBeDefined();
  for (const mode of modes) {
    const scenario = mode;
    const factory = scenario === 'mirage' ? bases.find((e) => e.type === 'GAWEAP')! : await construct('GAYARD');
    await control.command(0, 'camera', { cell: factory.cell });
    const type = scenario === 'mirage' ? 'MGTK' : 'DLPH';
    await control.command(0, 'produce', { type });
    const trained = await wait(0, (s) => own(s, type).length > 0, `${type} must leave its real factory`);
    let unit = own(trained, type)[0]!;
    console.log('Native stealth unit trained', type, unit.id, unit.cell);
    // A native read-only oracle proves that absence is concealment rather than a missing/spawned test object.
    const probe = async (index: number, id: string) => {
      const worker = pages[index]!.workers().find((w) => w.url().includes('/vmWorker.ts'))!;
      return worker.evaluate((target) => (globalThis as any).__ra2StealthProbe(target), id);
    };
    await expect
      .poll(
        async () => {
          const state = await probe(0, unit.id);
          return Boolean(state && (scenario === 'mirage' ? state.disguised : state.cloak === 2));
        },
        { timeout: 60000, message: 'New unit must finish leaving its factory and conceal naturally' },
      )
      .toBe(true);
    unit = own(await control.observe(0), type).find((e) => e.id === unit.id)!;
    expect(unit).toBeDefined();
    const enemyState = await control.observe(1);
    const scout = own(enemyState, 'MTNK')[0]!;
    expect(scout).toBeDefined();
    // Select only explored terrain visible to the unit's owner; native pathfinding still has to reach it.
    // Mirage observers stay beyond its weapon range. Neither scenario borrows an opposing sensor.
    await control.command(0, 'camera', { cell: unit.cell });
    const ground = (await terrain(unit.cell, false))
      .filter((cell) => {
        const distance = Math.hypot(cell.x - unit.cell.x, cell.y - unit.cell.y);
        return distance < 7.5 && (scenario !== 'mirage' || distance > 7);
      })
      .filter((cell) =>
        initial.entities
          .filter((e) => e.owner === initial.player && e.kind !== 'building')
          .every((e) => Math.hypot(cell.x - e.cell.x, cell.y - e.cell.y) > 6),
      );
    ground.sort(
      (a, b) => Math.hypot(a.x - scout.cell.x, a.y - scout.cell.y) - Math.hypot(b.x - scout.cell.x, b.y - scout.cell.y),
    );
    expect(ground.length, 'An explored land approach must exist within native sight range').toBeGreaterThan(0);
    const destination = ground[0]!;
    await control.command(1, 'move', { unit: scout.id, cell: destination });
    await control.command(1, 'camera', { cell: unit.cell });
    await wait(1, (s) => s.entities.some((e) => e.id === scout.id), 'Scout must arrive in the target viewport', 180000);
    let evidence: any;
    await expect
      .poll(
        async () => {
          evidence = await probe(1, unit.id);
          writeFileSync(
            join(output, `native-${scenario}.json`),
            JSON.stringify({ phase: 'waiting', evidence, observer: await control.observe(1) }, null, 2),
          );
          return Boolean(
            evidence &&
              evidence.revealed &&
              evidence.cellVisible &&
              evidence.inside &&
              (scenario === 'mirage' ? evidence.disguised : evidence.cloak === 2 && evidence.sensorCount === 0),
          );
        },
        {
          timeout: 120000,
          message: 'Original unit must be concealed in an explored on-screen cell',
          intervals: [1000],
        },
      )
      .toBe(true);
    const observer = await control.observe(1);
    expect(observer.entities.some((e) => e.id === unit.id)).toBe(false);
    // Rejection is checked through the same public command path as ordinary combat.
    expect(observer.entities.some((e) => e.id === scout.id)).toBe(true);
    await expect(control.command(1, 'attack', { unit: scout.id, target: unit.id })).rejects.toMatchObject({
      stdout: expect.stringContaining('Target is not visible'),
    });
    writeFileSync(
      join(output, `native-${scenario}.json`),
      JSON.stringify({ phase: 'passed', evidence, observer }, null, 2),
    );
    await pages[1]!.screenshot({ path: join(output, `native-${scenario}.png`) });
    console.log('Original concealed-unit observation and target rejection passed', scenario);
    if (modes.length > 1 && mode !== modes.at(-1)) {
      await control.command(1, 'move', { unit: scout.id, cell: homeScout.cell });
      await control.command(1, 'camera', { cell: homeScout.cell });
      await wait(
        1,
        (s) =>
          s.entities.some(
            (e) => e.id === scout.id && Math.hypot(e.cell.x - homeScout.cell.x, e.cell.y - homeScout.cell.y) <= 1,
          ),
        'Scout must return before the next concealment scenario',
      );
      await control.command(1, 'stop', { unit: scout.id });
    }
  }
}
