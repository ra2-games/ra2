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

it.each([false, true])(
  'reaches the native RA2 menu through the supplied launcher (omit Conquer.dat: %s)',
  async (omitData) => {
    const game = supportedGame('ra2');
    const files = new InstallationFiles(resolveGameDir('ra2'), true);
    if (omitData) {
      const missing = (path: string) => path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() === 'conquer.dat';
      const read = files.read.bind(files);
      const prefix = files.readPrefix.bind(files);
      const range = files.readRange.bind(files);
      const list = files.list.bind(files);
      const known = files.hasKnownFile.bind(files);
      files.read = async (path) => (missing(path) ? null : read(path));
      files.readPrefix = async (path, length) => (missing(path) ? null : prefix(path, length));
      files.readRange = async (path, offset, length) => (missing(path) ? null : range(path, offset, length));
      files.list = async (directory) => (await list(directory)).filter((name) => !missing(name));
      files.hasKnownFile = (path) => !missing(path) && known(path);
    }

    await files.write(
      'ra2.ini',
      patchSessionIni((await files.read('ra2.ini')) ?? new Uint8Array(), { playIntro: false }),
    );
    const hasLauncherData = !!(await files.read('Conquer.dat'))?.length;
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
      { game, files, executableBytes: new Uint8Array(readFileSync(gameResourceExe('ra2'))) },
      {
        ...configuration,
        createShim: (memory, options, hooks) => {
          const shim = configuration.createShim(memory, options, hooks);
          const dispatch = shim.dispatch.bind(shim);
          shim.dispatch = (call) => {
            if (process.env.VM_TRACE) console.log(options?.moduleName, call.imported.key);
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
      expect(completed).toContain('ra2.exe:CreateProcess request');
      // The supplied launcher takes a different native branch when its optional data
      // is absent. Both cases must launch the real child and reach its main menu.
      for (const call of [
        'ra2.exe:KERNEL32.DLL!CreateFileMappingA',
        'ra2.exe:KERNEL32.DLL!MapViewOfFileEx',
        'ra2.exe:USER32.DLL!PostThreadMessageA',
        'game.exe:KERNEL32.DLL!MapViewOfFileEx',
      ]) {
        expect(completed.includes(call), call).toBe(hasLauncherData);
      }
    } finally {
      await core.destroy();
    }
  },
  120_000,
);

it.each(['ra2.exe', 'ra2.lcf'])('rejects a legacy installation missing %s', async (missing) => {
  const files = new InstallationFiles(resolveGameDir('ra2'), true);
  const originalRead = files.read.bind(files);
  files.read = async (path) => (path.toLowerCase() === missing.toLowerCase() ? null : originalRead(path));
  await expect(
    RA2_YR_RESOURCE_POLICY.prepareSource({
      game: supportedGame('ra2'),
      files,
      executableBytes: new Uint8Array(readFileSync(gameResourceExe('ra2'))),
    }),
  ).rejects.toThrow();
});
