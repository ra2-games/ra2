import { withGameResolutionOverride } from '../../src/games/resolution';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { V86 } from 'v86';
import { DRIVE_CDROM, DRIVE_FIXED } from '../../src/vm86/win32';
import { VmCore } from '../../src/adapter/vmCore';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { gameVmConfiguration } from '../../src/games/vmConfiguration';
import type { VmStatus } from '../../src/app/session/runtimeEvents';
import { InstallationFiles, silentAudio } from './helpers/installationFiles';
import { executableCorpus } from './helpers/executableCorpus';
import { REPO_ROOT, resolveGameDir } from './helpers/gameDir';
import { patchSessionIni, sessionIniName } from './helpers/sessionIni';

const cdMode = process.env.VM_CORPUS_CD;
if (process.env.VM_CORPUS_CD && !['absent', 'mounted'].includes(process.env.VM_CORPUS_CD))
  throw new Error('VM_CORPUS_CD must be absent or mounted');

// Runs serially with actual game resources; static discovery alone is not gameplay acceptance.
it.each(executableCorpus())(
  `starts and advances a native skirmish (${cdMode ?? 'production drive configuration'}): $label`,
  async (entry) => {
    const original = SUPPORTED_GAMES.find((g) => g.id === entry.gameId)!;
    const game = cdMode
      ? { ...original, driveTypes: cdMode === 'absent' ? { C: DRIVE_FIXED } : { C: DRIVE_FIXED, D: DRIVE_CDROM } }
      : original;
    const files = new InstallationFiles(resolveGameDir(entry.gameId), true);
    await files.write(game.executable, entry.bytes.slice());
    // Direct battle startup is the subject; the four-minute first-run intro ([Intro] Play=yes) would only consume the
    // 60-second frame deadline. The overlay stays in this provider's memory.
    const ini = sessionIniName(entry.gameId);
    await files.write(ini, patchSessionIni((await files.read(ini)) ?? new Uint8Array(), { playIntro: false }));
    let status: VmStatus | undefined;
    let frames = 0;
    const core = new VmCore(
      {
        onStatus: (s) => {
          status = s;
        },
        onFrame: () => {
          frames++;
        },
      },
      await withGameResolutionOverride({ game, files, executableBytes: entry.bytes }, { width: 800, height: 600 }),
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
    const waitForFrame = async (minimum: number) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (status && ['error', 'blocked', 'exited'].includes(status.phase)) throw new Error(status.detail);
        const sample = await core.getGamePerformance();
        if (sample && sample.frame >= minimum) return sample.frame;
        await delay(100);
      }
      throw new Error(`Native frame did not reach ${minimum}: ${status?.detail}`);
    };
    try {
      await core.start();
      const first = await waitForFrame(30);
      expect(core.setGameSpeedFlag(4)).toBe(4);
      const second = await waitForFrame(first + 90);
      expect(second).toBeGreaterThan(first);
      expect(frames).toBeGreaterThan(1);
      console.log(`${entry.label}: native frame ${first} -> ${second}, presented ${frames}`);
    } finally {
      await core.destroy();
    }
  },
  240_000,
);
