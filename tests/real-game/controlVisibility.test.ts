import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { V86 } from 'v86';
import { RA2_CONTROL_PROFILE } from '../../src/games/ra2/control';
import { YR_CONTROL_PROFILE } from '../../src/games/yr/control';
import { readU32 } from '../../src/games/shared/guestMemoryIO';
import { VmCore } from '../../src/adapter/vmCore';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import type { BattleObservation } from '@ra2vm/control/contracts';
import { gameVmConfiguration } from '../../src/games/vmConfiguration';
import { withGameResolutionOverride } from '../../src/games/resolution';
import { InstallationFiles, silentAudio } from './helpers/installationFiles';
import { REPO_ROOT, resolveGameDir } from './helpers/gameDir';

it.each([
  ['ra2', 'contact'],
  ['yr', 'contact'],
  ['ra2', 'height'],
] as const)(
  'restricts observations and targets to the native viewport without revealing shroud when moving the camera in %s (%s)',
  async (gameId, scenario) => {
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
    async function waitFor(predicate: (state: BattleObservation) => boolean) {
      const deadline = Date.now() + 60000;
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
        await delay(10);
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
      const profile = gameId === 'ra2' ? RA2_CONTROL_PROFILE : YR_CONTROL_PROFILE;
      const memory = (core as unknown as { emulator: V86 }).emulator;
      const u32 = (address: number) => readU32(memory, address);
      // Independent read-only oracle: these raw entities never enter the public control endpoint.
      function rawEntities() {
        return profile.arrays.flatMap((array) => {
          const count = u32(array.address + 16),
            vector = u32(array.address + 4);
          return Array.from({ length: count }, (_, i) => {
            const object = u32(vector + i * 4),
              owner = u32(object + profile.owner);
            return {
              object,
              id: String(u32(object + profile.uniqueId)),
              owner: owner ? u32(owner + profile.houseIndex) : -1,
              x: (u32(object + profile.location) | 0) >> 8,
              y: (u32(object + profile.location + 4) | 0) >> 8,
            };
          });
        });
      }
      expect(initial.perspective).toBe('viewport');
      expect(rawEntities().length).toBeGreaterThan(initial.entities.length);
      for (const entity of initial.entities) {
        expect(entity.screen.x).toBeGreaterThanOrEqual(0);
        expect(entity.screen.y).toBeGreaterThanOrEqual(0);
        expect(entity.screen.x).toBeLessThan(initial.viewport.width);
        expect(entity.screen.y).toBeLessThan(initial.viewport.height);
      }
      const hidden = rawEntities().find((e) => e.owner === 1 && !initial.entities.some((v) => v.id === e.id))!;
      expect(hidden).toBeDefined();
      expect(u32(profile.viewport.heightLevel)).toBe(104);
      const neighborTable = gameId === 'ra2' ? 0x851a70 : 0x89f688;
      expect(Array.from(memory.read_memory(neighborTable + 12, 4))).toEqual([1, 0, 1, 0]);
      const cells = u32(profile.viewport.cells);
      const enemyCell = u32(cells + 4 * (hidden.x + hidden.y * 512));
      expect(u32(enemyCell + 0x12c) & 8).toBe(0);
      let sequence = 0;
      async function command(action: string, extra: Record<string, unknown>) {
        const before = await observe();
        const params = {
          sessionId: before.sessionId,
          observedFrame: before.frame,
          commandId: `view-${++sequence}`,
          action,
          ...extra,
        };
        expect(await core.gameControl('command', params)).toMatchObject({ state: 'pending' });
        await waitFor((s) => s.frame > before.frame + 5);
        expect(await core.gameControl('commandStatus', params)).toMatchObject({ state: 'submitted' });
      }
      const tank = initial.entities.find((e) => e.owner === initial.player && e.type === 'MTNK')!;
      const mcv = initial.entities.find((e) => e.owner === initial.player && /MCV/.test(e.type))!;
      await expect(
        core.gameControl('command', {
          sessionId: initial.sessionId,
          observedFrame: (await observe()).frame,
          commandId: 'hidden-target',
          action: 'attack',
          unit: tank.id,
          target: hidden.id,
        }),
      ).rejects.toThrow('not visible');
      await command('camera', { cell: { x: hidden.x, y: hidden.y } });
      const away = await waitFor((s) => s.viewport.x !== initial.viewport.x || s.viewport.y !== initial.viewport.y);
      expect(away.entities.some((e) => e.id === hidden.id)).toBe(false);
      expect(away.entities.some((e) => e.id === tank.id || e.id === mcv.id)).toBe(false);
      expect(u32(enemyCell + 0x12c) & 8).toBe(0);
      await expect(
        core.gameControl('command', {
          sessionId: away.sessionId,
          observedFrame: away.frame,
          commandId: 'old-focus',
          action: 'camera',
          unit: tank.id,
        }),
      ).rejects.toThrow('not visible');
      await command('camera', { cell: mcv.cell });
      await waitFor((s) => s.entities.some((e) => e.id === mcv.id) && s.entities.some((e) => e.id === tank.id));
      await command('camera', { unit: tank.id });
      const restored = await waitFor((s) => s.entities.some((e) => e.id === tank.id));
      const current = restored.entities.find((e) => e.id === tank.id)!;
      await command('attack-move', { unit: tank.id, cell: { x: current.cell.x + 3, y: current.cell.y + 3 } });
      await waitFor((s) =>
        s.entities.some((e) => e.id === tank.id && (e.cell.x !== current.cell.x || e.cell.y !== current.cell.y)),
      );
      const rawTank = rawEntities().find((e) => e.id === tank.id)!;
      expect(u32(rawTank.object + (gameId === 'ra2' ? 0x4b4 : 0x5c4))).toBe(29);
      await command('stop', { unit: tank.id });
      // Advance the starting tanks together and keep their current position on camera.
      // Contact must be discovered by normal sight before a targeted attack is allowed.
      await command('deploy', { unit: mcv.id });
      const scouts = (await observe()).entities.filter((e) => e.owner === initial.player && e.type === 'MTNK');
      if (scenario === 'height') {
        // Original map terrain reproduces a physical fog cell with a visible
        // height-projected anchor. Read-only oracle data never enters the API.
        await command('move', { units: scouts.map((scout) => scout.id), cell: { x: 100, y: 105 } });
        const scaleBytes = memory.read_memory(profile.viewport.zScale, 8);
        const zScale = new DataView(scaleBytes.buffer, scaleBytes.byteOffset, 8).getFloat64(0, true);
        const deadline = Date.now() + 60000;
        let witnessed: string | undefined;
        let nextCamera = 0;
        while (Date.now() < deadline && !witnessed) {
          const state = await observe();
          const own = rawEntities().filter((e) => scouts.some((s) => s.id === e.id));
          for (const entity of own) {
            const object = entity.object;
            if (
              !u32(object + profile.health) ||
              memory.read_memory(object + profile.alive, 1)[0] !== 1 ||
              memory.read_memory(object + profile.limbo, 1)[0] ||
              memory.read_memory(object + profile.viewport.visible, 1)[0] !== 1
            )
              continue;
            // This regression witnesses level four, independently of odd-level
            // branch arithmetic covered by the asset-free boundary tests.
            if ((u32(object + profile.location + 8) | 0) !== 416) continue;
            const x = u32(object + profile.location) | 0;
            const y = u32(object + profile.location + 4) | 0;
            const sx = Math.trunc((30 * x - 30 * y) / 256) - state.viewport.x;
            const sy = Math.trunc((15 * x + 15 * y) / 256) - Math.trunc(416 * zScale + 0.5) - state.viewport.y;
            if (sx < 0 || sy < 0 || sx >= state.viewport.width || sy >= state.viewport.height) continue;
            const physical = u32(cells + 4 * (entity.x + 512 * entity.y));
            const projected = u32(cells + 4 * (entity.x - 2 + 512 * (entity.y - 2)));
            if (!physical || !projected || !(u32(projected + 0x12c) & 8)) continue;
            const fog = Array.from(memory.read_memory(projected + 0x120, 2));
            const groundFog = Array.from(memory.read_memory(physical + 0x120, 2));
            if (fog.some((v) => v !== 255) || groundFog.every((v) => v === 255)) continue;
            expect(
              state.entities.some((e) => e.id === entity.id),
              'Visible elevated tank must be observable',
            ).toBe(true);
            witnessed = entity.id;
          }
          if (!witnessed && Date.now() >= nextCamera && own.length) {
            await command('camera', { cell: { x: own[0]!.x, y: own[0]!.y } });
            nextCamera = Date.now() + 500;
          }
          await delay(20);
        }
        expect(witnessed, 'Original terrain must exercise the height visibility regression').toBeDefined();
        await command('stop', { unit: witnessed });
        return;
      }
      await command('attack-move', { units: scouts.map((scout) => scout.id), cell: { x: hidden.x, y: hidden.y } });
      const selectedCount = u32(profile.playerControl.selectionCount);
      const selectedVector = u32(profile.playerControl.selectionVector);
      const selectedIds = Array.from({ length: selectedCount }, (_, i) =>
        String(u32(u32(selectedVector + i * 4) + profile.uniqueId)),
      );
      expect(selectedIds.sort()).toEqual(scouts.map((scout) => scout.id).sort());
      for (const scout of scouts) {
        const native = rawEntities().find((e) => e.id === scout.id)!;
        expect(native, 'Each group member must survive initial dispatch').toBeDefined();
        // Attack-move is FootClass::MegaMission, while CurrentMission may be Move or Attack.
        expect(u32(native.object + (gameId === 'ra2' ? 0x4b4 : 0x5c4))).toBe(29);
      }
      let contact: BattleObservation | undefined;
      let lastCell = scouts[0]!.cell;
      const scoutingDeadline = Date.now() + 90000;
      const scoutingTrace: unknown[] = [];
      let traceAt = 0;
      let checkedDestination = false;
      while (Date.now() < scoutingDeadline) {
        const state = await observe();
        const friendly = state.entities.filter((e) => e.owner === state.player && e.type === 'MTNK');
        if (Date.now() >= traceAt) {
          traceAt = Date.now() + 10000;
          scoutingTrace.push({
            frame: state.frame,
            viewport: state.viewport,
            visible: friendly.map((e) => ({ id: e.id, cell: e.cell, health: e.health })),
            // Read-only test oracle, never supplied to the public controller.
            native: rawEntities()
              .filter((e) => scouts.some((s) => s.id === e.id))
              .map((e) => ({
                id: e.id,
                x: e.x,
                y: e.y,
                megaMission: u32(e.object + (gameId === 'ra2' ? 0x4b4 : 0x5c4)),
              })),
          });
        }
        if (friendly.length && state.entities.some((e) => e.owner === 1)) {
          contact = state;
          break;
        }
        const lead = friendly.sort(
          (a, b) =>
            Math.hypot(a.cell.x - hidden.x, a.cell.y - hidden.y) - Math.hypot(b.cell.x - hidden.x, b.cell.y - hidden.y),
        )[0];
        if (lead && (lead.cell.x !== lastCell.x || lead.cell.y !== lastCell.y)) {
          lastCell = lead.cell;
          await command('camera', { cell: lastCell });
        } else if (!lead && !checkedDestination) {
          // A followed scout can die while the remaining units leave the camera.
          // Look at the already-issued destination, without reading new hidden positions.
          checkedDestination = true;
          await command('camera', { cell: { x: hidden.x, y: hidden.y } });
        }
        await delay(10);
      }
      expect(
        contact,
        `Native scouts must reveal a target before testing attack: ${JSON.stringify({ target: hidden, scoutingTrace })}`,
      ).toBeDefined();
      // Exercise a reachable engagement, not array order (which can prefer a
      // distant construction yard while closer defenders kill the selected tank).
      const engagement = contact!.entities
        .filter((e) => e.owner === contact!.player && e.type === 'MTNK')
        .flatMap((attacker) =>
          contact!.entities
            .filter((e) => e.owner === 1)
            .map((target) => ({
              attacker,
              target,
              distance: Math.hypot(attacker.position.x - target.position.x, attacker.position.y - target.position.y),
            })),
        )
        .sort((a, b) => a.distance - b.distance)[0]!;
      const { attacker, target } = engagement;
      const rawTarget = rawEntities().find((e) => e.id === target.id)!;
      const health = u32(rawTarget.object + profile.health);
      await command('attack', { unit: attacker.id, target: target.id });
      try {
        await waitFor(() => {
          const current = rawEntities().find((e) => e.id === target.id);
          return !current || u32(current.object + profile.health) < health;
        });
      } catch (error) {
        throw new Error(`Native attack did not damage its observed target: ${JSON.stringify(engagement)}`, {
          cause: error,
        });
      }
    } finally {
      await core.destroy();
    }
  },
  240000,
);
