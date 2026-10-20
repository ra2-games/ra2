import type { SupportedGame } from './catalog';
import type { GameFileProvider } from '../resources/contracts';

export interface GameSource {
  /** Validated, user-provided bootstrap program. Recomputed by the game policy in either host mode. */
  nativeLauncher?: { game: SupportedGame; executableBytes: Uint8Array };
  game: SupportedGame;
  files: GameFileProvider;
  /** EXE bytes already read during detection, avoiding duplicate disk reads through File System Access. */
  executableBytes: Uint8Array;
  /** Additional startup files scoped to the game root; mount after the Worker rediscovers the game. */
  additionalFiles?: ReadonlyMap<string, Uint8Array>;
  /** Game-generated launch configuration, separate from validated user map add-ons. */
  sessionFiles?: ReadonlyMap<string, Uint8Array>;
}
