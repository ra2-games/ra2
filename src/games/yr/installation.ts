import { selectNativeLauncher } from '../shared/nativeLauncher';
import type { GameSource } from '../source';

/** Choose from the supplied installation, without identifying or approving an EXE sample. */
export async function withNativeLauncher(source: GameSource): Promise<GameSource> {
  if (source.game.id !== 'yr') return source;
  return selectNativeLauncher(source, 'ra2md.exe', 'ra2md.lcf');
}
