import { ControlClient, NativeCommandError } from '../client';
import { batch } from '../batch';
import { compactOutput } from '../output';
import { placeBuilding } from '../placeBuilding';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BattleEntity, BattleObservation } from '../contracts';
import type { PageStatus } from '../monitor';
import { setTimeout as sleep } from 'node:timers/promises';
// Explicit Allied strategy policy. All sensing and actions use the public player API.
const { values } = parseArgs({
  options: {
    channel: { type: 'string' },
    port: { type: 'string', default: '15180' },
    plan: { type: 'string' },
    log: { type: 'string' },
  },
});
if (!values.plan) throw Error('--plan is required');
const planInput: { waypoints: { x: number; y: number }[]; durationMs?: number } = JSON.parse(
  readFileSync(values.plan, 'utf8'),
);
const validCell = (cell: any) =>
  cell &&
  Number.isInteger(cell.x) &&
  Number.isInteger(cell.y) &&
  cell.x >= 0 &&
  cell.y >= 0 &&
  cell.x <= 511 &&
  cell.y <= 511;
if (
  !Array.isArray(planInput.waypoints) ||
  !planInput.waypoints.length ||
  planInput.waypoints.length > 16 ||
  !planInput.waypoints.every(validCell)
)
  throw Error('Provide 1..16 planned scouting waypoints');
const durationMs = planInput.durationMs ?? 600000;
if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 1200000)
  throw Error('durationMs must be 1000..1200000');
const c = new ControlClient(Number(values.port), values.channel ?? '');
const log = (v: Record<string, unknown>) => {
  console.log(JSON.stringify(compactOutput(v)));
  if (values.log) appendFileSync(values.log, JSON.stringify({ time: new Date().toISOString(), ...v }) + '\n');
};
let s!: BattleObservation;
const launchDeadline = performance.now() + 180000;
while (performance.now() < launchDeadline) {
  let p: PageStatus;
  try {
    p = await c.request<PageStatus>('ui.status');
  } catch {
    await sleep(100);
    continue;
  }
  if (p.runtime?.battlefield.ready) {
    s = await c.observe();
    if (s.entities.some((e) => e.owner === s.player && ['AMCV', 'GACNST'].includes(e.type))) break;
  }
  await sleep(100);
}
const mcv = s?.entities.find((e) => e.owner === s.player && e.type === 'AMCV');
if (!mcv)
  throw Error('This opening requires a visible undeployed Allied MCV; use direct battle control for an existing base');
const sid = s.sessionId,
  player = s.player,
  home = { x: mcv.cell.x - 1, y: mcv.cell.y - 1 };
let last: BattleObservation | undefined;
async function obs() {
  const v = await c.observe();
  if (v.sessionId !== sid) throw Error('Session replaced');
  last = v;
  return v;
}
async function cmd(action: string, p: Record<string, unknown>) {
  const r = await c.command(action, p, sid);
  log({ event: 'order', action, ...p, ...r });
  return r;
}
async function view(cell: { x: number; y: number }) {
  const v = await c.look({ cell }, sid);
  last = v;
  log({ event: 'look', cell, frame: v.frame, viewport: v.viewport, visible: v.entities.length });
  return v;
}
async function group(action: string, units: string[], p: { target?: string; cell?: { x: number; y: number } } = {}) {
  for (let offset = 0; offset < units.length; offset += 8) {
    const members = units.slice(offset, offset + 8);
    const result = await batch(c, { sessionId: sid, orders: members.map((unit) => ({ action, unit, ...p })) });
    log({ event: 'batch', ...result });
    if (action === 'attack' || action === 'attack-move')
      for (const entry of result.completed)
        intents.set(members[entry.index], action === 'attack' ? p.target! : `move:${waypoint}`);
    if (result.state === 'interrupted') {
      if (result.next === 'reobserve') throw new NativeCommandError('batch', 'rejected', result.error);
      throw Error(result.error);
    }
  }
}
const caps = await c.request<{ game: string }>('capabilities');
if (caps.game !== 'ra2') throw Error('This evaluated policy currently supports RA2 only');
if (mcv) {
  await cmd('deploy', { unit: mcv.id });
  await sleep(200);
  s = await obs();
  await group(
    'deploy',
    s.entities.filter((e) => e.owner === player && e.type === 'E1' && (e.health ?? 0) > 0).map((e) => e.id),
  );
}
const plan = ['GAPOWR', 'GAREFN', 'GAPILE', 'AMRADR', 'GAPOWR'];
let stage = 0,
  attempt = 0;
const offsets = [
  [-2, 0],
  [-4, 2],
  [-2, 5],
  [3, 7],
  [-2, 8],
  [3, 10],
  [6, 10],
  [4, 0],
  [0, -4],
  [-5, -2],
  [5, 4],
  [0, 8],
];
const used = new Set<string>();
const route: { x: number; y: number }[] = planInput.waypoints.map((cell) => ({ ...cell }));
const searchCenter = { ...route.at(-1)! };
let raid = false,
  waypoint = 0,
  front = { ...home },
  lastTrain = 0;
const intents = new Map<string, string>(),
  repairs = new Set<string>();
let emptyFront = 0;
const deadline = performance.now() + durationMs;
let ended = false;
let searchPasses = 0;
let consecutiveRejections = 0;
try {
  for (let cycle = 0; performance.now() < deadline; cycle++) {
    try {
      const ui = await c.request<PageStatus>('ui.status');
      if (!ui.runtime?.battlefield.ready) {
        log({ event: 'native-ended', ui });
        ended = true;
        break;
      }
      s = await view(home);
      const own = s.entities.filter((e) => e.owner === player && (e.health ?? 0) > 0),
        buildings = own.filter((e) => e.kind === 'building');
      const threats = s.entities.filter((e) => e.owner === 1 && e.kind !== 'building');
      for (const b of buildings) {
        const max =
          ({ GACNST: 1000, GAPOWR: 750, GAREFN: 1000, GAPILE: 500, AMRADR: 600 } as Record<string, number>)[b.type] ??
          1000;
        if ((b.health ?? 0) >= max) repairs.delete(b.id);
        if ((b.health ?? 0) < max * 0.6 && !repairs.has(b.id) && s.cash > 300) {
          await cmd('repair', { unit: b.id });
          repairs.add(b.id);
        }
      }
      if (threats.length) {
        const target = threats.filter((e) => e.kind === 'vehicle')[0] ?? threats[0];
        const guards = own.filter((e) => ['MTNK', 'E1'].includes(e.type) && intents.get(e.id) !== target.id);
        try {
          await group(
            'attack',
            guards.map((e) => e.id),
            { target: target.id },
          );
          for (const u of guards) intents.set(u.id, target.id);
        } catch (e) {
          if (!(e instanceof NativeCommandError) || e.state !== 'rejected') throw e;
          log({ event: 'defense-reobserve', error: String(e) });
        }
      }
      const type = plan[stage];
      if (type) {
        const p = s.production.find((e) => e.type === type);
        if (p?.progress === p?.total && p) {
          let off: number[] | undefined;
          while (attempt < offsets.length) {
            const candidate = offsets[attempt++],
              key = candidate.join(',');
            if (!used.has(key)) {
              off = candidate;
              break;
            }
          }
          if (!off) throw Error(`Placement candidates exhausted for ${type}`);
          try {
            const building = await placeBuilding(
              c,
              { sessionId: sid, type, cells: [{ x: home.x + off[0], y: home.y + off[1] }] },
              (event) => log(event as Record<string, unknown>),
            );
            used.add(off.join(','));
            stage++;
            attempt = 0;
            log({ event: 'build', type, cell: building.cell });
          } catch (e) {
            if (!String(e).includes('No building confirmed')) throw e;
          }
        } else if (!p && s.sidebar.some((e) => e.type === type)) await cmd('produce', { type });
      }
      if (
        s.sidebar.some((e) => e.type === 'JUMPJET') &&
        !s.production.some((e) => e.type === 'JUMPJET') &&
        performance.now() - lastTrain > 1000 &&
        s.cash >= 650
      ) {
        await cmd('produce', { type: 'JUMPJET' });
        lastTrain = performance.now();
      }
      const localAir = own.filter((e) => e.type === 'JUMPJET');
      if (!raid && localAir.length >= 8) {
        raid = true;
        front = route[0];
        log({ event: 'raid-start', count: localAir.length });
      }
      if (raid) {
        const reinforcements = localAir.filter((e) => !intents.has(e.id));
        if (reinforcements.length) {
          await group(
            'attack-move',
            reinforcements.map((e) => e.id),
            { cell: route[waypoint] },
          );
          for (const u of reinforcements) intents.set(u.id, `move:${waypoint}`);
        }
        let field = await view(front);
        let flyers = field.entities.filter((e) => e.owner === player && e.type === 'JUMPJET' && (e.health ?? 0) > 0);
        if (!flyers.length) {
          field = await view(route[waypoint]);
          flyers = field.entities.filter((e) => e.owner === player && e.type === 'JUMPJET' && (e.health ?? 0) > 0);
        }
        if (flyers.length) {
          front = flyers[0].cell;
          const targets = field.entities.filter((e) => e.owner === 1);
          const priority = (e: BattleEntity) =>
            ['NASAM', 'FV', 'GACNST', 'GAWEAP', 'GAPILE', 'AMRADR', 'GAAIRC', 'GAPOWR', 'GAREFN'].indexOf(e.type);
          targets.sort((a, b) => (priority(a) < 0 ? 99 : priority(a)) - (priority(b) < 0 ? 99 : priority(b)));
          const target = targets[0];
          if (target) {
            emptyFront = 0;
            const fighters = flyers.filter((e) => intents.get(e.id) !== target.id);
            if (fighters.length) {
              try {
                await group(
                  'attack',
                  fighters.map((e) => e.id),
                  { target: target.id },
                );
                for (const u of fighters) intents.set(u.id, target.id);
                log({ event: 'engage', type: target.type, cell: target.cell, count: fighters.length });
              } catch (e) {
                if (!(e instanceof NativeCommandError) || e.state !== 'rejected') throw e;
                log({ event: 'front-reobserve', error: String(e) });
              }
            }
          } else {
            if (waypoint === route.length - 1 && ++emptyFront >= 3) {
              if (++searchPasses > 4) throw Error('Search plan exhausted; choose another explored route');
              const center = searchCenter;
              route.push(
                ...[
                  { x: 12, y: -10 },
                  { x: 15, y: 5 },
                  { x: 0, y: 15 },
                  { x: -15, y: 0 },
                ].map((d) => ({ x: center.x + d.x, y: center.y + d.y })),
              );
              waypoint++;
              emptyFront = 0;
              log({ event: 'search-expansion', waypoint, cell: route[waypoint] });
            }
            const arrived = flyers.filter(
              (e) => Math.hypot(e.cell.x - route[waypoint].x, e.cell.y - route[waypoint].y) < 5,
            );
            if (arrived.length >= Math.min(5, flyers.length) && waypoint < route.length - 1) {
              waypoint++;
              log({ event: 'advance', waypoint });
            }
            const movers = flyers.filter((e) => intents.get(e.id) !== `move:${waypoint}` && e.mission !== 1);
            if (movers.length) {
              await group(
                'attack-move',
                movers.map((e) => e.id),
                { cell: route[waypoint] },
              );
              for (const u of movers) intents.set(u.id, `move:${waypoint}`);
            }
          }
        }
      }
      if (cycle % 10 === 0)
        log({
          event: 'summary',
          cycle,
          frame: s.frame,
          cash: s.cash,
          stage,
          raid,
          waypoint,
          localAir: localAir.length,
          production: s.production,
          home: buildings.map((e) => [e.type, e.health]),
        });
      consecutiveRejections = 0;
      await sleep(400);
    } catch (e) {
      if (e instanceof NativeCommandError && e.state === 'rejected') {
        if (++consecutiveRejections > 2) throw Error('Repeated rejected control; inspect and revise the plan');
        log({ event: 'replan', reason: String(e) });
        await sleep(100);
        continue;
      }
      throw e;
    }
  }
  if (!ended) {
    log({ event: 'mission-paused', reason: 'duration' });
    process.exitCode = 2;
  }
} catch (e) {
  const ui = await c.request<PageStatus>('ui.status');
  if (!ui.runtime?.battlefield.ready) log({ event: 'native-ended', ui, pendingOutcome: String(e) });
  else {
    log({ event: 'controller-error', error: String(e), lastFrame: last?.frame });
    throw e;
  }
} finally {
  log({ event: 'controller-stopped' });
}
