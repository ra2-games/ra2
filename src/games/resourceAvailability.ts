import { SUPPORTED_GAMES, supportedGame, type SupportedGameId } from './catalog';
import { GAME_MANIFESTS } from './manifest';

export function gameResourceAvailability(names: ReadonlySet<string>, id: SupportedGameId) {
  const game = supportedGame(id);
  const replaced = SUPPORTED_GAMES.some(
    (other) =>
      other.id !== id &&
      other.executable.toLowerCase() === game.executable.toLowerCase() &&
      other.detectionFiles?.length &&
      other.detectionFiles.every((file) => names.has(file.toLowerCase())),
  );
  const missing = GAME_MANIFESTS[id].playerRequired
    .filter((file) => !names.has(file.name.toLowerCase()))
    .map((file) => file.name);
  return { available: !replaced && missing.length === 0, replaced, missing };
}
