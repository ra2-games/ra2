import { inspectPe32 } from '../../vm86/peProbe';
import { OverlayGameFileProvider } from '../../resources/providers/overlay';
import type { GameSource } from '../source';

/** Mount user-supplied launcher configuration and execute its unchanged program in a separate guest. */
export async function mountNativeLauncher(
  source: GameSource,
  launcher: Uint8Array,
  executableName: string,
  configurationName: string,
): Promise<GameSource> {
  const configuration = await source.files.read(configurationName);
  if (!configuration?.length) throw new Error('Native launcher configuration became unavailable');
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[`C:\\GAME\\${configurationName}`, configuration]]),
      ' (native launcher)',
      true,
    ),
    nativeLauncher: {
      executableBytes: launcher,
      game: {
        ...source.game,
        executable: executableName,
        runtimeHooks: undefined,
        commandLineArguments: '-SPEEDCONTROL',
        preloadFiles: [],
        fastFileMirrorFiles: [],
        sparseFilePrefixes: {},
        guestMemoryBytes: 64 * 1024 * 1024,
        arenaTop: 62 * 1024 * 1024,
        fastFileMirrorBase: undefined,
        fastFileMirrorTop: undefined,
      },
    },
  };
}

/** A partial launcher installation is an error, never a reason to retry direct entry. */
export async function selectNativeLauncher(
  source: GameSource,
  executableName: string,
  configurationName: string,
): Promise<GameSource> {
  const launcher = await source.files.read(executableName);
  const configuration = await source.files.read(configurationName);
  // Direct execution is an attempt, not a compatibility or authorization verdict.
  // Any native demand for a launcher, installation data or authorization remains active.
  if (launcher === null && configuration === null) return source;
  if (!launcher?.length) throw new Error(`Native launcher is missing or empty: ${executableName}`);
  if (!configuration?.length)
    throw new Error(`Native launcher configuration is missing or empty: ${configurationName}`);
  if (!inspectPe32(launcher)) throw new Error(`Unsupported or invalid PE32 launcher: ${executableName}`);
  return mountNativeLauncher(source, launcher, executableName, configurationName);
}
