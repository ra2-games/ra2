import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_GAMES, type SupportedGameId } from '../../../src/games/catalog';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Game resource directory: use the actual installation directory registered in the catalog, with a parent-directory fallback for some worktrees.
 * VM_GAME_DIR overrides (relative to REPO_ROOT or absolute) support trimmed-package evidence: run e2e on temporary directories to identify the file set required for skirmish/multiplayer.
 */
export function resolveGameDir(gameId: SupportedGameId): string {
  const override = process.env.VM_GAME_DIR;
  if (override) return resolve(REPO_ROOT, override);
  const game = SUPPORTED_GAMES.find((item) => item.id === gameId);
  if (!game) throw new Error(`未知游戏: ${gameId}`);
  const candidates = [resolve(REPO_ROOT, 'game', game.folder), resolve(REPO_ROOT, '..', '..', 'game', game.folder)];
  return candidates.find(isDirectory) ?? candidates[0]!;
}

export function gameResourceExe(gameId: SupportedGameId): string {
  const game = SUPPORTED_GAMES.find((item) => item.id === gameId);
  if (!game) throw new Error(`未知游戏: ${gameId}`);
  const directory = resolveGameDir(gameId);
  return join(directory, game.executable);
}

/**
 * Real-game regressions require the original executable. A missing file fails the run instead of skipping the suite:
 * a skipped suite disappears from the report, so a green run would silently drop these regressions.
 * There is deliberately no opt-out switch, so every developer sees the same missing-resource failure.
 */
export function requireGameResources(gameId: SupportedGameId): void {
  const executable = gameResourceExe(gameId);
  if (!existsSync(executable)) {
    throw new Error(`真实游戏验收缺少 ${executable}；请配置 VM_GAME_DIR 或 game/ra2/`);
  }
}
