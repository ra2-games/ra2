import type { SupportedGame, SupportedGameId } from './catalog';
import { ra2YrVmConfiguration } from './shared/vmConfiguration';

// Register runtime factories by selected game; shared implementations are explicit choices, never fallbacks for unknown games.
const runtimeFactories = {
  ra2: ra2YrVmConfiguration,
  yr: ra2YrVmConfiguration,
  mo: ra2YrVmConfiguration,
} satisfies Record<SupportedGameId, typeof ra2YrVmConfiguration>;

/** Main thread and Worker assemble locally from identical game definitions; factories never cross threads. */
export function gameVmConfiguration(
  game: Pick<SupportedGame, 'id'>,
  ...options: Parameters<typeof ra2YrVmConfiguration>
): ReturnType<typeof ra2YrVmConfiguration> {
  return runtimeFactories[game.id](...options);
}
