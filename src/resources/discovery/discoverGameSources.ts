import type { GameFileProvider } from '../contracts';
import type { GameSource } from '../../games/source';
import type { GameSourceTransformResult } from '../../games/discovery';
import { DEFAULT_GAME, SUPPORTED_GAMES, type SupportedGame, type SupportedGameId } from '../../games/catalog';
import { peImportKeys } from '../../vm86/pe';
import { ScopedGameFileProvider } from '../providers/scoped';
import { OverlayGameFileProvider } from '../providers/overlay';
/** Match the original discovery flow: filter MZ candidates here; the loader performs full PE validation. */
function isPortableExecutable(bytes: Uint8Array | null): bytes is Uint8Array {
  return !!bytes && bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a;
}

/** Case-insensitive filename substrings excluded from EXE auto-discovery, such as uninstallers and multiplayer clients. */
const EXCLUDED_EXECUTABLE_MARKERS = ['uninst', 'listenclient'];

/** Depth/count limits for recursive discovery in memory sources, protecting against ZIP-bomb-style directory trees. */
const DEEP_DISCOVERY_MAX_DEPTH = 12;
const DEEP_DISCOVERY_MAX_SCOPES = 2000;

/**
 * Discover game EXEs automatically: enumerate the root and each supported game's conventional subdirectory once, collect case-insensitive *.exe files, exclude EXCLUDED_EXECUTABLE_MARKERS, and check MZ magic as PE candidates. Classify known games by filename; unknown EXEs can also start with the default compatibility layer. Each game's sourceTransform identifies and unwraps installers/patches; the generic file layer contains no game names or hashes.
 */
export async function discoverGameSources(provider: GameFileProvider): Promise<GameSource[]> {
  type Candidate = {
    scope: string;
    executable: string;
    bytes: Uint8Array;
    game: SupportedGame;
    known: boolean;
    /** Files produced by game transformers override old same-named files in the underlying directory. */
    overlay?: ReadonlyMap<string, Uint8Array>;
    overlayLabel?: string;
  };
  const candidates: Candidate[] = [];
  const transformedByScope = new Map<string, { game: SupportedGame; result: GameSourceTransformResult }>();
  // RA2 and Yuri's Revenge share an installation directory; enumerate it once to avoid duplicate candidates.
  const scopes = [...new Set(['', ...SUPPORTED_GAMES.map((game) => game.folder)])];
  if (provider.deepDiscovery) {
    // Memory sources extracted from ZIP/installers have variable layouts; recursively enumerate subdirectories as candidate scopes,
    // then classify by filename/import table to locate each game. Limits guard against ZIP-bomb-style directory trees.
    const visited = new Set(scopes.map((scope) => scope.toLowerCase()));
    const pending = [...scopes];
    while (pending.length && visited.size < DEEP_DISCOVERY_MAX_SCOPES) {
      const scope = pending.pop()!;
      if (scope.split('/').length >= DEEP_DISCOVERY_MAX_DEPTH) continue;
      for (const name of (await provider.list(scope)) ?? []) {
        const child = scope ? `${scope}/${name}` : name;
        const key = child.toLowerCase();
        if (visited.has(key)) continue;
        visited.add(key);
        // Memory backends also return names when list receives a file path; distinguish files from directories using synchronous checks/reads,
        // since files need no recursive enumeration.
        const isFile = provider.hasKnownFile?.(child) ?? (await provider.read(child)) !== null;
        if (isFile) continue;
        scopes.push(child);
        pending.push(child);
      }
    }
  }
  for (const scope of scopes) {
    const scopedNames = new Set(((await provider.list(scope)) ?? []).map((name) => name.toLowerCase()));
    for (const name of (await provider.list(scope)) ?? []) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.exe') || EXCLUDED_EXECUTABLE_MARKERS.some((marker) => lower.includes(marker))) continue;
      const path = scope ? `${scope}/${name}` : name;
      const bytes = await provider.read(path);
      if (!isPortableExecutable(bytes)) continue;
      let transformed = false;
      for (const game of SUPPORTED_GAMES) {
        const result = await game.sourceTransform?.(bytes);
        if (!result) continue;
        transformedByScope.set(scope, { game, result });
        transformed = true;
        break;
      }
      if (transformed) continue;
      const game =
        SUPPORTED_GAMES.find(
          (entry) =>
            entry.executable.toLowerCase() === lower &&
            entry.detectionFiles?.length &&
            entry.detectionFiles.every((file) => scopedNames.has(file.toLowerCase())),
        ) ?? gameForExecutable(name, scope, bytes);
      if (game.unsupportedExecutableReason?.(bytes)) continue;
      candidates.push({
        scope,
        executable: name,
        bytes,
        game,
        known: SUPPORTED_GAMES.some((g) => matchesKnownExecutable(g, lower)) || game.abi !== DEFAULT_GAME.abi,
      });
    }
  }
  for (const [scope, transformed] of transformedByScope) {
    const { game, result } = transformed;
    const existing = candidates.find(
      (candidate) => candidate.scope === scope && candidate.executable.toLowerCase() === game.executable.toLowerCase(),
    );
    if (existing) {
      existing.bytes = result.executableBytes;
      existing.overlay = result.overlay;
      existing.overlayLabel = result.label;
      existing.game = game;
    } else {
      candidates.push({
        scope,
        executable: game.executable,
        bytes: result.executableBytes,
        game,
        known: true,
        overlay: result.overlay,
        overlayLabel: result.label,
      });
    }
  }
  // Sort known games first, then remaining entries stably by filename.
  // If executable aliases coexist in one directory, retain only the primary file specified by the registry. Lightweight RA2 packages contain
  // identical game.exe / ra2.exe / Red Alert 2.exe bytes, which should not appear three times.
  const selectedCandidates = candidates.filter(
    (candidate) =>
      candidate.executable.toLowerCase() === candidate.game.executable.toLowerCase() ||
      !candidates.some(
        (other) =>
          other !== candidate &&
          other.scope === candidate.scope &&
          other.game.id === candidate.game.id &&
          other.executable.toLowerCase() === candidate.game.executable.toLowerCase(),
      ),
  );
  selectedCandidates.sort((a, b) => Number(b.known) - Number(a.known) || a.executable.localeCompare(b.executable));
  const sources: GameSource[] = [];
  for (const candidate of selectedCandidates) {
    let files: GameFileProvider = candidate.scope ? new ScopedGameFileProvider(provider, candidate.scope) : provider;
    if (candidate.overlay)
      files = new OverlayGameFileProvider(files, candidate.overlay, `（${candidate.overlayLabel ?? '自动转换'}）`);
    sources.push({
      game: candidate.game,
      files,
      executableBytes: candidate.bytes,
    });
  }
  return sources;
}

function matchesKnownExecutable(game: SupportedGame, lowerName: string): boolean {
  return game.executable.toLowerCase() === lowerName;
}

/** Classify known games by filename, then import-table coverage; finally fall back to RA2. */
function gameForExecutable(name: string, scope: string, bytes: Uint8Array): SupportedGame {
  const lower = name.toLowerCase();
  const known = SUPPORTED_GAMES.find((game) => matchesKnownExecutable(game, lower));
  if (known) return known.executable.toLowerCase() === lower ? known : { ...known, executable: name };
  const scoped = SUPPORTED_GAMES.find((game) => game.folder.toLowerCase() === scope.toLowerCase());
  if (scoped) return { ...scoped, executable: name };
  // Custom-named modified EXEs: directly selecting a game directory makes the scope the root;
  // if neither filename nor directory matches, classify by RA2/YR ABI coverage of its imports.
  const imports = peImportKeys(bytes);
  const byImports =
    imports.length > 0
      ? SUPPORTED_GAMES.find((game) => game !== DEFAULT_GAME && coversAllImports(game, imports))
      : undefined;
  if (byImports) return { ...byImports, executable: name };
  return {
    id: DEFAULT_GAME.id,
    title: name.replace(/\.exe$/i, ''),
    executable: name,
    folder: scope,
    argBytes: DEFAULT_GAME.argBytes,
    abi: DEFAULT_GAME.abi,
    shimProfile: DEFAULT_GAME.shimProfile,
    runtimeHooks: DEFAULT_GAME.runtimeHooks,
  };
}

/** Whether the compatibility ABI table covers every import key in the EXE. */
function coversAllImports(game: SupportedGame, imports: readonly string[]): boolean {
  return imports.every((key) => game.abi[key] !== undefined);
}

export async function validateGameDirectory(
  provider: GameFileProvider,
  preferredGame?: SupportedGameId,
): Promise<GameSource[]> {
  const sources = await discoverGameSources(provider);
  if (preferredGame) {
    const selected = sources.find((source) => source.game.id === preferredGame);
    if (selected) return [selected];
    const game = SUPPORTED_GAMES.find((item) => item.id === preferredGame);
    if (game?.unsupportedExecutableReason) {
      const bytes = await provider.read(game.executable);
      const reason = bytes && game.unsupportedExecutableReason(bytes);
      if (reason) throw new Error(reason);
    }
    throw new Error(`文件夹“${provider.label}”中未找到 ${game?.title ?? preferredGame} 的主程序`);
  }
  if (!sources.length) {
    throw new Error(`文件夹“${provider.label}”中未找到可运行的游戏 EXE（*.exe，卸载/联机客户端除外）`);
  }
  return sources;
}
