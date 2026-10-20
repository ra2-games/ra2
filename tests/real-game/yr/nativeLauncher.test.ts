import { RA2_YR_RESOURCE_POLICY } from '../../../src/games/shared/resourcePolicy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { V86 } from 'v86';
import { VmCore } from '../../../src/adapter/vmCore';
import { supportedGame } from '../../../src/games/catalog';
import { gameVmConfiguration } from '../../../src/games/vmConfiguration';
import { InstallationFiles, silentAudio } from '../helpers/installationFiles';
import { gameResourceExe, REPO_ROOT, resolveGameDir } from '../helpers/gameDir';
import { patchSessionIni } from '../helpers/sessionIni';
import type { VmStatus } from '../../../src/app/session/runtimeEvents';

it('runs the supplied launcher and reaches the native YR menu through real guest IPC', async () => {
  const game = supportedGame('yr');
  const files = new InstallationFiles(resolveGameDir('yr'), true);
  await files.write(
    'ra2md.ini',
    patchSessionIni((await files.read('ra2md.ini')) ?? new Uint8Array(), { playIntro: false }),
  );
  const configuration = gameVmConfiguration(game);
  const completed: string[] = [];
  let status: VmStatus | undefined;
  let page = '';
  let frames = 0;
  const core = new VmCore(
    {
      onStatus: (value) => {
        status = value;
      },
      onShellPage: (value) => {
        page = value;
      },
      onFrame: () => {
        frames++;
      },
    },
    {
      game,
      files,
      executableBytes: new Uint8Array(readFileSync(gameResourceExe('yr'))),
    },
    {
      ...configuration,
      createShim: (memory, options, hooks) => {
        const shim = configuration.createShim(memory, options, hooks);
        const dispatch = shim.dispatch.bind(shim);
        shim.dispatch = (call) => {
          const result = dispatch(call);
          if (
            result?.eax &&
            [
              'KERNEL32.DLL!CreateFileMappingA',
              'KERNEL32.DLL!MapViewOfFileEx',
              'USER32.DLL!PostThreadMessageA',
            ].includes(call.imported.key)
          ) {
            completed.push(`${options?.moduleName}:${call.imported.key}`);
          }
          if (result?.createProcess) completed.push(`${options?.moduleName}:CreateProcess request`);
          return result;
        };
        return shim;
      },
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
    const deadline = Date.now() + 60_000;
    while (!page.toLowerCase().includes('mainmenu') && Date.now() < deadline) {
      if (status && ['error', 'blocked', 'exited'].includes(status.phase)) throw new Error(status.detail);
      await delay(50);
    }
    expect(page.toLowerCase(), status?.detail).toContain('mainmenu');
    expect(frames).toBeGreaterThan(0);
    expect(completed).toContain('ra2md.exe:CreateProcess request');
    expect(completed).toContain('ra2md.exe:KERNEL32.DLL!CreateFileMappingA');
    expect(completed).toContain('ra2md.exe:KERNEL32.DLL!MapViewOfFileEx');
    expect(completed).toContain('ra2md.exe:USER32.DLL!PostThreadMessageA');
    expect(completed).toContain('gamemd.exe:KERNEL32.DLL!MapViewOfFileEx');
  } finally {
    await core.destroy();
  }
}, 120_000);

it.each(['ra2md.exe', 'ra2md.lcf'])('rejects a legacy installation missing %s', async (missing) => {
  const files = new InstallationFiles(resolveGameDir('yr'), true);
  const originalRead = files.read.bind(files);
  files.read = async (path) => (path.toLowerCase() === missing.toLowerCase() ? null : originalRead(path));
  await expect(
    RA2_YR_RESOURCE_POLICY.prepareSource({
      game: supportedGame('yr'),
      files,
      executableBytes: new Uint8Array(readFileSync(gameResourceExe('yr'))),
    }),
  ).rejects.toThrow();
});

// Admission is not startup acceptance: this legacy sample did not reach its main
// menu without the data file. Leave that decision to its unchanged native code.
it('admits missing optional ConquerMD.dat without supplying replacement data', async () => {
  const files = new InstallationFiles(resolveGameDir('yr'), true);
  const read = files.read.bind(files);
  files.read = async (path) => (path.toLowerCase() === 'conquermd.dat' ? null : read(path));
  const source = await RA2_YR_RESOURCE_POLICY.prepareSource({
    game: supportedGame('yr'),
    files,
    executableBytes: new Uint8Array(readFileSync(gameResourceExe('yr'))),
  });
  expect(source.nativeLauncher?.game.executable).toBe('ra2md.exe');
  expect(await source.files.read('ConquerMD.dat')).toBeNull();
});
