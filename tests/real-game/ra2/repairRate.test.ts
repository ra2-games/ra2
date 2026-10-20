import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { V86 } from 'v86';
import { VmCore } from '../../../src/adapter/vmCore';
import type { VmStatus } from '../../../src/app/session/runtimeEvents';
import { supportedGame } from '../../../src/games/catalog';
import { gameVmConfiguration } from '../../../src/games/vmConfiguration';
import { RA2_SETTINGS_SIGNATURE } from '../../../src/games/ra2/performance';
import { resolveNativeLayout } from '../../../src/games/shared/nativeLayout';
import { readU32 } from '../../../src/games/shared/guestMemoryIO';
import { InstallationFiles, silentAudio } from '../helpers/installationFiles';
import { gameResourceExe, REPO_ROOT, resolveGameDir } from '../helpers/gameDir';
import { patchSessionIni } from '../helpers/sessionIni';

it('keeps the native RepairRate unchanged when host mouse messages enter an advancing battle', async () => {
  const game = supportedGame('ra2');
  const files = new InstallationFiles(resolveGameDir('ra2'), true);
  const executableBytes = new Uint8Array(readFileSync(gameResourceExe('ra2')));
  await files.write(
    'ra2.ini',
    patchSessionIni((await files.read('ra2.ini')) ?? new Uint8Array(), { playIntro: false }),
  );
  let vm!: V86;
  let status: VmStatus | undefined;
  const core = new VmCore(
    { onStatus: (value) => (status = value) },
    { game, files, executableBytes },
    {
      ...gameVmConfiguration(game),
      startupPage: 'battle',
      fetchBytes: async () => new Uint8Array(readFileSync(join(REPO_ROOT, 'src/vm86/boot.bin'))),
      scheduleFrame: (emit) => setImmediate(emit),
      deferFrameSnapshot: true,
      fastFileRead: true,
      audio: silentAudio,
      createEmulator: (options) =>
        (vm = new V86({ ...options, wasm_path: join(REPO_ROOT, 'node_modules/v86/build/v86.wasm') })),
    },
  );
  const waitFrame = async (minimum: number) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (status && ['error', 'blocked', 'exited'].includes(status.phase)) throw new Error(status.detail);
      const sample = await core.getGamePerformance();
      if (sample && sample.frame >= minimum) return sample.frame;
      await delay(50);
    }
    throw new Error(`Native battle did not reach frame ${minimum}: ${status?.detail}`);
  };
  try {
    await core.start();
    const frame = await waitFrame(120);
    const layout = resolveNativeLayout(vm, executableBytes, {
      settingsSignature: RA2_SETTINGS_SIGNATURE,
      menuRegister: 0xbd,
    });
    expect(layout?.repair, 'read-only repair-rate discovery').toBeTruthy();
    const repair = layout!.repair!;
    const rules = readU32(vm, repair.pointer);
    expect(rules).toBeGreaterThan(0);
    const address = rules + repair.offset;
    const before = vm.read_memory(address, 8).slice();
    const rate = new DataView(before.buffer, before.byteOffset, 8).getFloat64(0, true);
    console.log(`Native RepairRate at frame ${frame}: ${rate}`);
    // No rules or game objects are fabricated. These are ordinary host input messages;
    // inspect synchronously before the guest can process them, then require native simulation to continue.
    for (const message of [0x200, 0x201, 0x202]) {
      core.postMessage(message, message === 0x201 ? 1 : 0, 0x00010001);
      expect(vm.read_memory(address, 8)).toEqual(before);
    }
    await waitFrame(frame + 120);
    expect(vm.read_memory(address, 8)).toEqual(before);
  } finally {
    await core.destroy();
  }
}, 120_000);
