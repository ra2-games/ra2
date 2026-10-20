import { selectNativeLauncher } from '../shared/nativeLauncher';
import type { GameSource } from '../source';

/** Choose from the supplied installation, without identifying or approving an EXE sample. */
export async function withRa2NativeLauncher(source: GameSource): Promise<GameSource> {
  if (source.game.id !== 'ra2') return source;
  return selectNativeLauncher(source, 'ra2.exe', 'ra2.lcf');
}
