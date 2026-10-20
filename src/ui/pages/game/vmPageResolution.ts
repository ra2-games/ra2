/**
 * Local game-resolution preference persistence, extracted from page.ts.
 * Reuse storage keys/parsing from games/resolution, shared by page and toolbar actions.
 */
import { gameResolutionValue, parseGameResolution, type GameResolution } from '../../../games/resolution';
import type { SupportedGameId } from '../../../games/catalog';

const STORED_RESOLUTION_PREFIX = 'vm-resolution-';

export function loadStoredResolution(gameId: SupportedGameId): GameResolution | null {
  try {
    return parseGameResolution(window.localStorage.getItem(`${STORED_RESOLUTION_PREFIX}${gameId}`));
  } catch {
    return null;
  }
}

export function storeResolution(gameId: SupportedGameId, resolution: GameResolution | null): void {
  try {
    const key = `${STORED_RESOLUTION_PREFIX}${gameId}`;
    if (resolution) window.localStorage.setItem(key, gameResolutionValue(resolution));
    else window.localStorage.removeItem(key);
  } catch {
    // Persistence may be unavailable in private mode; safely fall back to the original INI after this restart.
  }
}
