import { ARCHIVE_WANTED_NAMES, GAME_MANIFESTS } from './manifest';
import type { SupportedGameId } from './catalog';
import type { ArchiveDirectoryRule } from '../utils/archive/archiveExtractor';

/** Some RA2/YR installers flatten taunt audio; restore it using the original taunts-directory convention. */
export const GAME_ARCHIVE_DIRECTORY_RULES: readonly ArchiveDirectoryRule[] = [
  { directory: 'taunts/', basenamePattern: '^tau[a-z]{2}\\d{2}\\.wav$' },
];

/**
 * Use two layers rather than per-page partitions: required data and MOD overrides first, maps/movies/music/taunts later.
 * Optional does not mean discoverable later: publish the entire directory first, and never introduce MODs after original rules initialize.
 */
export function gameArchiveLayers(gameId?: SupportedGameId): {
  required: string[];
  startup: string[];
  wanted: string[];
} {
  if (!gameId) {
    const all = Object.keys(GAME_MANIFESTS).map((id) => gameArchiveLayers(id as SupportedGameId));
    // Without a selected game, publish the complete directory and use the union for startup; extract only files actually in the package.
    return {
      required: [],
      startup: [...new Set(all.flatMap((layer) => layer.startup))],
      wanted: [...ARCHIVE_WANTED_NAMES],
    };
  }
  const manifest = GAME_MANIFESTS[gameId];
  const required = manifest.playerRequired.map((file) => file.name.toLowerCase());
  const other = /^(?:maps\w*\.mix|movies\d+\.mix|movmd\d+\.mix|theme(?:md)?\.mix|subtitle(?:md)?\.txt|taunts\/)$/;
  const optional = manifest.playerOptional.map((file) => file.name.toLowerCase());
  // Preserve the archive allowlist so layering cannot silently discard resources; YR installations may still depend on
  // RA2 base data, so prepare it first when present without expanding the existing required manifest.
  const base = gameId === 'yr' ? GAME_MANIFESTS.ra2.playerRequired.map((file) => file.name.toLowerCase()) : [];
  return {
    required,
    startup: [...new Set([...required, ...base, ...optional.filter((name) => !other.test(name))])],
    wanted: [...ARCHIVE_WANTED_NAMES],
  };
}
