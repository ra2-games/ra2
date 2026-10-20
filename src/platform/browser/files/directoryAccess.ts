import type { GameFileProvider } from '../../../resources/contracts';
import { ScopedGameFileProvider } from '../../../resources/providers/scoped';
import { OverlayGameFileProvider } from '../../../resources/providers/overlay';
import { isSupportedGameId, type SupportedGameId } from '../../../games/catalog';
import { DirectoryGameFileProvider } from './directory';

/**
 * Unwrap Scoped/Overlay providers to obtain the directory backend's FileSystemDirectoryHandle; return null for development HTTP/memory backends. In Worker mode, the main thread uses this to construct init.
 */
export function directoryHandleOf(provider: GameFileProvider): FileSystemDirectoryHandle | null {
  if (provider instanceof DirectoryGameFileProvider) return provider.handle;
  if (provider instanceof ScopedGameFileProvider || provider instanceof OverlayGameFileProvider) {
    return directoryHandleOf(provider.parent);
  }
  return null;
}

/**
 * Collect memory overlays (online-package files) above the directory backend, innermost to outermost, with later layers overriding earlier ones as in Overlay reads. Return null if there is no directory backend; callers serialize pure session providers as a whole instead.
 */
export function collectDirectoryOverlays(provider: GameFileProvider): ReadonlyMap<string, Uint8Array>[] | null {
  if (provider instanceof OverlayGameFileProvider) {
    const inner = collectDirectoryOverlays(provider.parent);
    if (!inner) return null;
    inner.push(provider.overlays);
    return inner;
  }
  if (provider instanceof ScopedGameFileProvider) return collectDirectoryOverlays(provider.parent);
  if (provider instanceof DirectoryGameFileProvider) return [];
  return null;
}

/** Return the current provider chain's actual directory scope relative to the authorized root. */
export function directoryScopeOf(provider: GameFileProvider): string {
  if (provider instanceof ScopedGameFileProvider) {
    const parentScope = directoryScopeOf(provider.parent);
    return parentScope && provider.scope ? `${parentScope}/${provider.scope}` : provider.scope || parentScope;
  }
  if (provider instanceof OverlayGameFileProvider) return directoryScopeOf(provider.parent);
  return '';
}

/** Forget the last directory so the player can choose another after native game exit. */
export async function forgetGameDirectory(): Promise<void> {
  window.localStorage.removeItem(PREFERRED_GAME_KEY);
}

export function rememberPreferredGame(game: SupportedGameId): void {
  window.localStorage.setItem(PREFERRED_GAME_KEY, game);
}

export function loadPreferredGame(): SupportedGameId | null {
  const value = window.localStorage.getItem(PREFERRED_GAME_KEY);
  return value !== null && isSupportedGameId(value) ? value : null;
}

const PREFERRED_GAME_KEY = 'ra2-vm-preferred-game';
