import type { GameSource } from '../source';
import { inspectPe32 } from '../../vm86/peProbe';

/** Run the supplied injector itself; extension discovery and compatibility decisions remain native. */
export async function withMentalOmegaLauncher(source: GameSource): Promise<GameSource> {
  if (source.game.id !== 'mo') return source;
  const executableBytes = await source.files.read('Syringe.exe');
  if (!executableBytes?.length || !inspectPe32(executableBytes))
    throw new Error('Mental Omega requires the supplied PE32 Syringe.exe launcher');
  return {
    ...source,
    nativeLauncher: {
      executableBytes,
      game: {
        ...source.game,
        executable: 'Syringe.exe',
        commandLineArguments: `"${source.game.executable}" ${source.game.commandLineArguments ?? ''}`,
        runtimeHooks: undefined,
        stackTop: 0x00d00000,
        heapBase: 0x00d00000,
        arenaTop: 0x08000000,
        guestMemoryBytes: 384 * 1024 * 1024,
        preloadFiles: [],
        fastFileMirrorFiles: [],
        sparseFilePrefixes: {},
        fastFileMirrorBase: undefined,
        fastFileMirrorTop: undefined,
      },
    },
  };
}
