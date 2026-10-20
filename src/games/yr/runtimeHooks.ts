import { resolveYrMovies } from './adaptivePatches';
import { createAdaptiveRuntimeHooks } from '../shared/adaptiveRuntimeHooks';
import type { GuestMemory } from '../../vm86/win32';
import { createYrControl } from './control';
import type { GameRuntimeHooks } from '../runtimeHooks';
import { writeGameSpeedFlag } from '../shared/gameSpeedFlag';
import { skipStartupMovieBlock } from '../shared/startupMovieSkip';
import { createYrFrameReader, YR_SETTINGS_SIGNATURE } from './performance';

const YR_STARTUP_MOVIE_BLOCK = 0x0052_c5e0;
const YR_STARTUP_MOVIE_CONTINUATION = 0x0052_c5f3;
const YR_STARTUP_MOVIE_SIGNATURE = [0x8b, 0xd5, 0xb9, 0x20, 0x5f] as const;
const YR_SETTINGS_POINTER = 0x0088_71e0;
const YR_GAME_SPEED_OFFSET = 0x14a0;

/** Accept only the original seven settings 0..6; see YR_SETTINGS_POINTER for the Settings singleton pointer and field offset. */
export function writeYrGameSpeed(memory: GuestMemory, value: number): number | null {
  return writeGameSpeedFlag(memory, YR_SETTINGS_POINTER, YR_GAME_SPEED_OFFSET, value);
}

/**
 * YR 1.001 unconditionally creates and plays EA_WWLOGO at 0x52c5e0; unlike RA2's WESTLOGO branch, it has no usable INI switch. Jump to 0x52c5f3 to retain native shared movie cleanup without creating the startup-movie window. Campaign briefings and in-game EVA windows use other call sites and remain unaffected.
 */
export function skipYrStartupMovies(memory: GuestMemory): boolean {
  return skipStartupMovieBlock(
    memory,
    YR_STARTUP_MOVIE_BLOCK,
    YR_STARTUP_MOVIE_CONTINUATION,
    YR_STARTUP_MOVIE_SIGNATURE,
  );
}

export const YR_RUNTIME_HOOKS: GameRuntimeHooks = Object.freeze({
  resolve(memory: GuestMemory, exe: Uint8Array): GameRuntimeHooks {
    return createAdaptiveRuntimeHooks(memory, exe, {
      label: 'YR',
      createControl: createYrControl,
      settingsSignature: YR_SETTINGS_SIGNATURE,
      menuRegister: 0xbe,
      initialSendRate: 2,
      createFrameReader: createYrFrameReader,
      patches: (layout) => [resolveYrMovies(layout.image)],
    });
  },
  createFrameReader: createYrFrameReader,
});
