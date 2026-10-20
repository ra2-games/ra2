import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { V86 } from 'v86';
import { VmCore } from '../../src/adapter/vmCore';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import type { BattleObservation } from '@ra2vm/control/contracts';
import { gameVmConfiguration } from '../../src/games/vmConfiguration';
import { withGameResolutionOverride } from '../../src/games/resolution';
import { InstallationFiles, silentAudio } from './helpers/installationFiles';
import { REPO_ROOT, resolveGameDir } from './helpers/gameDir';

it.each((['ra2', 'yr'] as const).flatMap((gameId) => ['orders', 'support'].map((scenario) => ({ gameId, scenario }))))(
  'executes $scenario through player handlers in original $gameId',
  async ({ gameId, scenario }) => {
    const game = SUPPORTED_GAMES.find((g) => g.id === gameId)!;
    const files = new InstallationFiles(resolveGameDir(gameId), true);
    const executableBytes = (await files.read(game.executable))!;
    if (!executableBytes) throw new Error(`Original ${gameId} executable missing`);
    let failure = '';
    const core = new VmCore(
      {
        onStatus: (status) => {
          if (['error', 'blocked', 'exited'].includes(status.phase)) failure = status.detail;
        },
      },
      await withGameResolutionOverride({ game, files, executableBytes }, { width: 800, height: 600 }),
      {
        ...gameVmConfiguration(game),
        startupPage: 'battle',
        fetchBytes: async () => new Uint8Array(readFileSync(join(REPO_ROOT, 'src/vm86/boot.bin'))),
        scheduleFrame: (emit) => setImmediate(emit),
        deferFrameSnapshot: true,
        fastFileRead: true,
        audio: silentAudio,
        createEmulator: (options) =>
          new V86({ ...options, wasm_path: join(REPO_ROOT, 'node_modules/v86/build/v86.wasm') }),
      },
    );
    const observe = () => core.gameControl('observe') as Promise<BattleObservation>;
    async function waitFor(predicate: (state: BattleObservation) => boolean, timeout = 60000) {
      const deadline = Date.now() + timeout;
      let state: BattleObservation | undefined;
      let error: unknown;
      while (Date.now() < deadline) {
        if (failure) throw new Error(failure);
        try {
          state = await observe();
          if (predicate(state)) return state;
        } catch (e) {
          error = e;
        }
        await delay(100);
      }
      throw new Error(
        `Battle control timeout: ${String(error)} ${JSON.stringify(state && { ...state, entities: state.entities.filter((e) => e.owner === state.player) })}`,
      );
    }
    try {
      await core.start();
      expect(await core.gameControl('capabilities')).toMatchObject({ supported: true });
      const initial = await waitFor(
        (s) => s.frame >= 30 && s.entities.some((e) => e.owner === s.player && /MCV/.test(e.type)),
      );
      expect(initial.player).toBeLessThan(8);
      expect(initial.cash).toBeGreaterThan(0);
      let sequence = 0;
      async function command(action: string, extra: Record<string, unknown>) {
        const observed = await observe();
        const request = {
          sessionId: observed.sessionId,
          observedFrame: observed.frame,
          commandId: `order-${++sequence}`,
          action,
          ...extra,
        };
        try {
          expect(await core.gameControl('command', request)).toMatchObject({ state: 'pending' });
        } catch (error) {
          console.log(gameId, 'failed-command', JSON.stringify({ request, observed }));
          throw error;
        }
        await waitFor((s) => s.frame > observed.frame + 5);
        const receipt = (await core.gameControl('commandStatus', request)) as { state: string };
        expect(action === 'place' ? ['submitted', 'rejected'] : ['submitted']).toContain(receipt.state);
        if (['produce', 'suspend', 'cancel'].includes(action)) {
          const state = await observe();
          expect(state.sidebarTab).toBe(state.sidebar.find((item) => item.type === extra.type)!.tab);
        }
        return request;
      }
      const unavailable = async (type: string) => {
        const s = await observe();
        const cash = s.cash;
        await expect(
          core.gameControl('command', {
            sessionId: s.sessionId,
            observedFrame: s.frame,
            commandId: `unavailable-${type}-${s.frame}`,
            action: 'produce',
            type,
          }),
        ).rejects.toThrow('native sidebar');
        const after = await waitFor((next) => next.frame > s.frame + 10);
        expect(after.cash).toBe(cash);
        expect(after.production).toEqual([]);
      };
      await unavailable('GAPOWR'); // No construction yard: the native sidebar cannot offer production.
      const tank = initial.entities.find((e) => e.owner === initial.player && e.type === 'MTNK')!;
      expect(tank).toBeDefined();
      await command('move', { unit: tank.id, cell: { x: tank.cell.x + 3, y: tank.cell.y + 3 } });
      await waitFor((s) =>
        s.entities.some((e) => e.id === tank.id && (e.cell.x !== tank.cell.x || e.cell.y !== tank.cell.y)),
      );
      await command('stop', { unit: tank.id });
      await waitFor((s) => s.entities.some((e) => e.id === tank.id && [5, 13].includes(e.mission ?? -1)));
      await command('guard', { unit: tank.id });
      for (const defender of initial.entities.filter(
        (e) => e.owner === initial.player && e.type === 'MTNK' && e.id !== tank.id,
      ))
        await command('guard', { unit: defender.id });
      await waitFor((s) => s.entities.some((e) => e.id === tank.id && e.mission === 11));
      const mcv = initial.entities.find((e) => e.owner === initial.player && /MCV/.test(e.type))!;
      const beforeDeploy = await observe();
      const params = {
        sessionId: beforeDeploy.sessionId,
        observedFrame: beforeDeploy.frame,
        commandId: 'deploy-mcv',
        action: 'deploy',
        unit: mcv.id,
      };
      expect(await core.gameControl('command', params)).toMatchObject({ state: 'pending' });
      const deployed = await waitFor(
        (s) =>
          !s.entities.some((e) => e.id === mcv.id) &&
          s.entities.some((e) => e.owner === s.player && /CNST/.test(e.type)) &&
          s.sidebar.some((item) => item.type === 'GAPOWR'),
      );
      expect(deployed.frame).toBeGreaterThan(initial.frame);
      expect(await core.gameControl('commandStatus', params)).toMatchObject({ state: 'submitted' });
      expect(await core.gameControl('command', params)).toMatchObject({ state: 'submitted' });
      expect(await core.gameControl('catalog')).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'GAPOWR' })]),
      );
      await unavailable('GATECH'); // No prerequisites; must not create a hidden product or charge money.
      await command('produce', { type: 'GAPOWR' });
      const visible = await waitFor((s) =>
        s.sidebar.some((item) => item.type === 'GAPOWR' && item.hasFactory && item.progress > 0),
      );
      expect(visible.production.some((p) => p.type === 'GAPOWR')).toBe(true);
      const ready = await waitFor((s) => s.production.some((p) => p.type === 'GAPOWR' && p.progress === p.total));
      expect(ready.cash).toBeLessThan(initial.cash);
      const yard = ready.entities.find((e) => e.owner === ready.player && /CNST/.test(e.type))!;
      expect(yard.foundation).toEqual({ width: 4, height: 4 });
      expect(ready.sidebar.find((item) => item.type === 'GAPOWR')?.foundation).toEqual({ width: 2, height: 2 });
      let placed = false;
      for (const [dx, dy] of [
        [3, 0],
        [0, 3],
        [-2, 0],
        [0, -2],
        [3, 1],
        [1, 3],
        [-2, 1],
        [1, -2],
        [-2, -2],
      ]) {
        await command('place', { type: 'GAPOWR', cell: { x: yard.cell.x + dx!, y: yard.cell.y + dy! } });
        const after = await observe();
        await waitFor((s) => s.frame > after.frame + 30);
        const result = await observe();
        if (result.entities.some((e) => e.owner === result.player && e.type === 'GAPOWR')) {
          placed = true;
          break;
        }
      }
      expect(placed, 'Native placement must create a power plant; invalid occupied cells may be rejected').toBe(true);
      async function construct(type: string) {
        const start = await observe();
        console.log(
          gameId,
          'construct',
          type,
          JSON.stringify({
            frame: start.frame,
            cash: start.cash,
            buildings: start.entities.filter((e) => e.owner === start.player && e.kind === 'building'),
            sidebar: start.sidebar.map((item) => item.type),
          }),
        );
        await waitFor((s) => s.sidebar.some((item) => item.type === type));
        await command('produce', { type });
        const ready = await waitFor((s) => s.production.some((p) => p.type === type && p.progress === p.total));
        const before = new Set(
          ready.entities.filter((e) => e.owner === ready.player && e.type === type).map((e) => e.id),
        );
        const bases = ready.entities.filter((e) => e.owner === ready.player && e.kind === 'building');
        for (const base of bases) {
          for (const [dx, dy] of [
            [3, 0],
            [0, 3],
            [-3, 0],
            [0, -3],
            [3, 2],
            [2, 3],
            [-3, 2],
            [2, -3],
            [-3, -3],
            [4, 0],
            [0, 4],
            [-4, 0],
            [0, -4],
            [4, 3],
            [3, 4],
            [-4, 3],
            [3, -4],
          ]) {
            const cell = { x: base.cell.x + dx!, y: base.cell.y + dy! };
            await command('camera', { cell });
            await command('place', { type, cell });
            const after = await observe();
            const next = await waitFor((s) => s.frame > after.frame + 20);
            if (
              !next.production.some((p) => p.type === type) &&
              next.entities.some(
                (e) =>
                  e.owner === next.player &&
                  e.type === type &&
                  !before.has(e.id) &&
                  Math.hypot(e.cell.x - cell.x, e.cell.y - cell.y) <= 3,
              )
            )
              return;
          }
        }
        throw new Error(`Native placement did not create ${type}`);
      }
      async function train(type: string) {
        const before = await observe();
        const ids = new Set(before.entities.map((e) => e.id));
        await command('produce', { type });
        await waitFor((s) => s.sidebar.some((item) => item.type === type && item.hasFactory && item.progress > 0));
        const trained = await waitFor((s) =>
          s.entities.some((e) => e.owner === s.player && e.type === type && !ids.has(e.id)),
        );
        const unit = trained.entities.find((e) => e.owner === trained.player && e.type === type && !ids.has(e.id))!;
        expect(unit.kind).not.toBe('building');
        expect(unit.health).toBeGreaterThan(0);
        return unit;
      }
      await construct('GAPILE');
      const infantry = await train('E1');
      await command('move', { unit: infantry.id, cell: { x: yard.cell.x + 7, y: yard.cell.y + 7 } });
      await waitFor((s) =>
        s.entities.some((e) => e.id === infantry.id && (e.cell.x !== infantry.cell.x || e.cell.y !== infantry.cell.y)),
      );
      await construct('GAREFN');
      if (scenario === 'support') {
        // Exercise a naturally charged support power through the same sidebar and map UI.
        // No charge timers, resources, events or game speed are changed by this regression.
        await construct('GAPOWR');
        await construct('AMRADR');
        const charging = await waitFor((s) => !!s.supportPowers?.length);
        const paradrop = charging.supportPowers!.find((p) => /ParaDrop/i.test(p.type));
        expect(paradrop, 'American airfield must expose its native paradrop cameo').toBeDefined();
        expect(paradrop!.ready).toBe(false);
        const early = {
          sessionId: charging.sessionId,
          observedFrame: charging.frame,
          commandId: 'early-paradrop',
          action: 'select-power',
          type: paradrop!.type,
        };
        await core.gameControl('command', early);
        await waitFor((s) => s.frame > charging.frame + 5);
        expect(await core.gameControl('commandStatus', early)).toMatchObject({ state: 'rejected' });
        // Recharge is native simulation time; the wall deadline only bounds the test.
        const charged = await waitFor((s) => !!s.supportPowers?.find((p) => p.type === paradrop!.type)?.ready, 180000);
        await command('select-power', { type: paradrop!.type });
        const selectedPower = await observe();
        expect(selectedPower.targetingPower).toBe(paradrop!.type);
        expect(selectedPower.sidebarTab).toBe(paradrop!.tab);
        await command('camera', { cell: yard.cell });
        const beforeDrop = await observe();
        const existingInfantry = new Set(
          beforeDrop.entities.filter((e) => e.owner === beforeDrop.player && e.type === 'E1').map((e) => e.id),
        );
        await command('target-power', { type: paradrop!.type, cell: { x: yard.cell.x + 6, y: yard.cell.y + 6 } });
        await waitFor((s) => !s.supportPowers?.find((p) => p.type === paradrop!.type)?.ready);
        const delivered = await waitFor(
          (s) =>
            s.entities.filter((e) => e.owner === s.player && e.type === 'E1' && !existingInfantry.has(e.id)).length >=
            8,
        );
        expect(delivered.frame).toBeGreaterThan(charged.frame);
        console.log(gameId, 'paradrop-confirmed', { chargedFrame: charged.frame, deliveredFrame: delivered.frame });
        return;
      }
      await construct('GAWEAP');
      const reinforcement = await train('MTNK');
      await command('move', { unit: reinforcement.id, cell: { x: yard.cell.x + 8, y: yard.cell.y + 8 } });
      await waitFor((s) =>
        s.entities.some(
          (e) => e.id === reinforcement.id && (e.cell.x !== reinforcement.cell.x || e.cell.y !== reinforcement.cell.y),
        ),
      );
      await train('MTNK'); // A second unit must be produced, not mistaken for the first completed product.
      await command('produce', { type: 'GAPILL' }); // W: defense, distinct from ordinary buildings on Q.
      await waitFor((s) => s.production.some((p) => p.type === 'GAPILL' && p.progress > 0));
      await command('cancel', { type: 'GAPILL' });
      await waitFor((s) => !s.production.some((p) => p.type === 'GAPILL'));
      await command('produce', { type: 'GAPOWR' });
      await waitFor((s) => s.production.some((p) => p.type === 'GAPOWR' && p.progress > 0 && p.progress < p.total));
      await command('suspend', { type: 'GAPOWR' });
      const paused = await observe();
      expect(paused.production.find((p) => p.type === 'GAPOWR')?.suspended).toBe(true);
      const progress = paused.production.find((p) => p.type === 'GAPOWR')!.progress;
      const later = await waitFor((s) => s.frame > paused.frame + 60);
      expect(later.production.find((p) => p.type === 'GAPOWR')!.progress).toBe(progress);
      await command('cancel', { type: 'GAPOWR' });
      await waitFor((s) => !s.production.some((p) => p.type === 'GAPOWR'));
      await waitFor((s) => s.sidebar.some((item) => item.type === 'GAPOWR' && !item.hasFactory && !item.pending));
      // Cancel an actively building product through the native suspend-then-cancel path.
      await command('produce', { type: 'GAPOWR' });
      await waitFor((s) => s.production.some((p) => p.type === 'GAPOWR' && p.progress > 0 && p.progress < p.total));
      await command('cancel', { type: 'GAPOWR' });
      await waitFor((s) => !s.production.some((p) => p.type === 'GAPOWR'));
      await command('camera', { cell: yard.cell });
      const beforeScatter = (await observe()).entities.find((e) => e.id === tank.id)!;
      await command('scatter', { unit: tank.id });
      await waitFor((s) =>
        s.entities.some(
          (e) => e.id === tank.id && (e.cell.x !== beforeScatter.cell.x || e.cell.y !== beforeScatter.cell.y),
        ),
      );
      const beforeAdvance = (await observe()).entities.find((e) => e.id === tank.id)!;
      await command('attack-move', {
        unit: tank.id,
        cell: { x: beforeAdvance.cell.x + 3, y: beforeAdvance.cell.y + 3 },
      });
      await waitFor((s) =>
        s.entities.some(
          (e) => e.id === tank.id && (e.cell.x !== beforeAdvance.cell.x || e.cell.y !== beforeAdvance.cell.y),
        ),
      );
      await command('camera', { cell: yard.cell });
      const power = (await observe()).entities.find((e) => e.owner === initial.player && e.type === 'GAPOWR')!;
      // Ordinary player attack clicks must not become force-fire on owned buildings.
      const friendly = await observe();
      const attack = {
        sessionId: friendly.sessionId,
        observedFrame: friendly.frame,
        commandId: 'friendly-attack',
        action: 'attack',
        unit: tank.id,
        target: power.id,
      };
      await core.gameControl('command', attack);
      await waitFor((s) => s.frame > friendly.frame + 5);
      expect(await core.gameControl('commandStatus', attack)).toMatchObject({ state: 'rejected' });
      expect((await observe()).entities.find((e) => e.id === power.id)!.health).toBe(power.health);
      const repairFrame = await observe();
      const repair = {
        ...attack,
        commandId: 'healthy-repair',
        observedFrame: repairFrame.frame,
        action: 'repair',
        unit: power.id,
      };
      await core.gameControl('command', repair);
      await waitFor((s) => s.frame > repairFrame.frame + 5);
      expect(await core.gameControl('commandStatus', repair)).toMatchObject({ state: 'rejected' });
      await command('sell', { unit: power.id });
      await waitFor((s) => !s.entities.some((e) => e.id === power.id));
    } finally {
      await core.destroy();
    }
  },
  600000,
);
