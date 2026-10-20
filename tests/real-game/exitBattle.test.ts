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

it.each(['ra2', 'yr'] as const)(
  'exits an original %s battle through the native quit handler without replacing the VM',
  async (gameId) => {
    const game = SUPPORTED_GAMES.find((g) => g.id === gameId)!;
    const files = new InstallationFiles(resolveGameDir(gameId), true);
    const executableBytes = (await files.read(game.executable))!;
    if (!executableBytes) throw new Error(`Original ${gameId} executable missing`);
    let failure = '';
    let vmCreations = 0;
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
        createEmulator: (options) => {
          vmCreations++;
          return new V86({ ...options, wasm_path: join(REPO_ROOT, 'node_modules/v86/build/v86.wasm') });
        },
      },
    );
    try {
      await core.start();
      const readyDeadline = Date.now() + 60000;
      let initial: import('@ra2vm/control/contracts').BattleObservation | undefined;
      while (Date.now() < readyDeadline) {
        if (failure) throw new Error(failure);
        const status = (await core.gameControl('ui.status')) as { battlefield: { ready: boolean } };
        if (status.battlefield.ready) {
          initial = (await core.gameControl('observe')) as typeof initial;
          if (initial!.frame >= 30 && initial!.entities.some((e) => e.owner === initial!.player)) break;
        }
        await delay(100);
      }
      expect(initial?.entities.some((entity) => entity.owner === initial!.player)).toBe(true);
      expect(await core.gameControl('capabilities')).toMatchObject({
        actions: expect.arrayContaining(['exit-battle']),
      });
      const request = {
        sessionId: initial!.sessionId,
        observedFrame: initial!.frame,
        commandId: 'exit-test',
        action: 'exit-battle',
      };
      expect(await core.gameControl('command', request)).toMatchObject({ state: 'pending' });
      // Identical retries must never emit a second native exit event.
      expect(await core.gameControl('command', request)).toMatchObject({ state: 'pending' });
      const deadline = Date.now() + 30000;
      let status: { phase: string; page: string; battlefield: { ready: boolean } } | undefined;
      let receipt: { state: string } | undefined;
      while (Date.now() < deadline) {
        if (failure) throw new Error(failure);
        receipt = (await core.gameControl('commandStatus', request)) as typeof receipt;
        status = (await core.gameControl('ui.status')) as typeof status;
        if (status!.page && !status!.battlefield.ready) break;
        await delay(100);
      }
      expect(receipt).toMatchObject({ state: 'submitted' });
      expect(status, 'native exit must leave a running VM on a menu or score page').toMatchObject({
        phase: 'running',
        battlefield: { ready: false },
      });
      expect(status!.page).toBe('GUI:SkirmishGame');
      // Leaving through the quit handler is not proof of victory or defeat.
      expect(status).toMatchObject({ battleResult: { sessionId: initial!.sessionId, outcome: 'unknown' } });
      expect(await core.gameControl('commandStatus', request)).toMatchObject({ state: 'submitted' });
      await expect(core.gameControl('command', { ...request, commandId: 'exit-again' })).rejects.toThrow(
        'Battlefield is not active',
      );
      await delay(500);
      expect(await core.gameControl('ui.status')).toMatchObject({ page: 'GUI:SkirmishGame', phase: 'running' });
      expect(vmCreations).toBe(1);
      // The same core/control instance remains usable for status and capabilities.
      expect(await core.gameControl('capabilities')).toMatchObject({ supported: true });
    } finally {
      await core.destroy();
    }
  },
  120000,
);
