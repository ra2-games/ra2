import type { SupportedGameId } from '../../../src/games/catalog';
import {
  gameResolutionIni,
  patchGameResolutionIni,
  patchIniSection,
  type GameResolution,
} from '../../../src/games/resolution';

/**
 * Session-only INI settings a regression depends on. Coordinates recorded at 1440x900 and timeouts that exclude the
 * four-minute first-run intro must not depend on the developer's RA2.INI/RA2MD.INI (a Steam installation ships
 * 640x480 with [Intro] Play=yes). The installation is never modified; only the bytes the guest opens are overlaid.
 */
export interface SessionIniOptions {
  resolution?: GameResolution;
  playIntro?: boolean;
}

export function sessionIniName(gameId: SupportedGameId): string {
  return gameResolutionIni(gameId);
}

export function patchSessionIni(bytes: Uint8Array, options: SessionIniOptions): Uint8Array {
  let patched = options.resolution ? patchGameResolutionIni(bytes, options.resolution) : bytes;
  if (options.playIntro !== undefined) {
    patched = patchIniSection(patched, 'Intro', [['Play', options.playIntro ? 'yes' : 'no']]);
  }
  return patched;
}

/** Click routes in the menu regressions were recorded in this native coordinate space. */
export const RECORDED_ROUTE_RESOLUTION: GameResolution = { width: 1440, height: 900 };
