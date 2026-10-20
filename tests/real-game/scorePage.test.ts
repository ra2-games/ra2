import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { V86 } from 'v86';
import { VmCore } from '../../src/adapter/vmCore';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { gameVmConfiguration } from '../../src/games/vmConfiguration';
import { withGameResolutionOverride } from '../../src/games/resolution';
import { InstallationFiles, silentAudio } from './helpers/installationFiles';
import { REPO_ROOT, resolveGameDir } from './helpers/gameDir';
import type { BattleResult } from '@ra2vm/control/contracts';

it.each(['ra2', 'yr'] as const)(
  'reads original %s score labels after native defeat',
  async (gameId) => {
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
    try {
      await core.start();
      // Native AI completion depends on the original map/route and host throughput.
      // This bounds wall-clock waiting only; game speed and clocks remain unchanged.
      const deadline = Date.now() + 300000;
      let nextProgress = Date.now() + 30000;
      let status:
        | {
            page: string;
            controls: { id: number; text: string; displayText?: string }[];
            battlefield: { ready: boolean; sessionId?: string; frame?: number };
            battleResult: BattleResult | null;
          }
        | undefined;
      let sessionId: string | undefined;
      // Leave the starting army under native control. The opponent must end the match normally;
      // never seed defeat flags, change clocks, skip outcome checks or synthesize a score dialog.
      while (Date.now() < deadline) {
        if (failure) throw new Error(failure);
        status = (await core.gameControl('ui.status')) as typeof status;
        if (Date.now() >= nextProgress) {
          console.info(`${gameId} awaiting native score`, JSON.stringify(status));
          nextProgress = Date.now() + 30000;
        }
        if (status?.battlefield.ready) {
          sessionId ??= status.battlefield.sessionId;
          expect(status.battlefield.sessionId).toBe(sessionId);
          expect(status.battleResult).toBeNull();
        }
        if (status?.page === 'GUI:MultiplayerScore' && status.controls.some((c) => c.id === 1041 && c.displayText))
          break;
        await delay(250);
      }
      expect(status?.page, JSON.stringify(status)).toBe('GUI:MultiplayerScore');
      expect(sessionId).toBeTruthy();
      expect(status?.battleResult).toMatchObject({ sessionId, outcome: 'defeat', source: 'native-game-loop' });
      expect(status!.battleResult!.frame).toBeGreaterThan(0);
      const retainedResult = status!.battleResult;
      await delay(500);
      expect(await core.gameControl('ui.status')).toMatchObject({ battleResult: retainedResult });
      const controls = status!.controls;
      const label = (id: number) => controls.find((control) => control.id === id)?.displayText;
      expect(label(1684)).toBeTruthy();
      expect(label(1746)).toBeTruthy();
      expect(label(1002)).toMatch(/\d/);
      expect(label(1041)).toBeTruthy();
      expect(label(1042)).toBeTruthy();
      // Original score-row order is name, kills, losses, built, score.
      for (const id of [1049, 1699, 1701, 1702, 1050, 1700, 1703, 1704]) {
        expect(label(id), `score control ${id}`).toMatch(/^\d+$/);
      }
      expect(controls.find((control) => control.id === 1041)?.text).toBe('GUI:Blank');
      console.info(
        `${gameId} native score`,
        JSON.stringify(controls.filter((control) => control.displayText !== undefined)),
      );
    } finally {
      await core.destroy();
    }
  },
  330000,
);
