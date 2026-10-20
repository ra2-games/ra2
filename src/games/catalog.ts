import { DRIVE_FIXED } from '../vm86/win32';
import { RA2_ABI, ra2Win32ArgBytes } from './ra2/abi';
import { YR_ABI, yrWin32ArgBytes } from './yr/abi';
import type { ImportArgBytes } from '../vm86/pe';
import type { GameShimProfile } from '../vm86/shim/gameProfile';
import type { GameRuntimeHooks } from './runtimeHooks';
import type { GameSourceTransform } from './discovery';
import { RA2_SHIM_PROFILE } from './ra2/profile';
import { RA2_RUNTIME_HOOKS } from './ra2/runtimeHooks';
import { YR_SHIM_PROFILE } from './yr/profile';
import { YR_RUNTIME_HOOKS } from './yr/runtimeHooks';
import { createYrFrameReader } from './yr/performance';
import { YR_EXTENSION_ABI, yrExtensionArgBytes } from './yr/extensionAbi';

export type SupportedGameId = 'ra2' | 'yr' | 'mo';

/** Static game definition; contains no browser file handles or VM runtime state. */
export interface SupportedGame {
  id: SupportedGameId;
  title: string;
  executable: string;
  /** Files identifying variants sharing the same executable. */
  detectionFiles?: readonly string[];
  /** Command-line argument suffix passed to the guest; original switches belong in game configuration, not the generic Win32 layer. */
  commandLineArguments?: string;
  /** Original INI speed setting, with 0 fastest; override only the single-player startup default. */
  defaultGameSpeed?: number;
  /** Conventional subdirectory under the development asset root, also identifying parents containing multiple games. */
  folder: string;
  /** x86 ABI for static guest imports: stack-cleanup byte count for stdcall ret n. */
  argBytes: ImportArgBytes;
  abi: Readonly<Record<string, number>>;
  driveTypes?: Readonly<Record<string, number>>;
  smokeEntry?: number;
  smokeImports?: number;
  smokeFirstCall?: string;
  menuReadyGate?: boolean;
  guestMemoryBytes?: number;
  stackTop?: number;
  heapBase?: number;
  arenaTop?: number;
  fastFileMirrorBase?: number;
  fastFileMirrorTop?: number;
  /** Only these frequently used archives stay in the persistent mirror; synchronous providers still cache and read other files on demand. */
  fastFileMirrorFiles?: readonly string[];
  /** Explicit compatibility capabilities passed to Win32; the shared shim does not inspect game IDs. */
  shimProfile: GameShimProfile;
  runtimeHooks?: GameRuntimeHooks;
  /**
   * Files to mount synchronously before VM creation. initializeBeforeEntry only runs DLL entry points early; linkBeforeEntry requires a loadable DLL and connects the main module's IAT directly to its exports.
   */
  preloadFiles?: readonly {
    path: string;
    initializeBeforeEntry?: boolean;
    linkBeforeEntry?: boolean;
  }[];
  /** Very large archives requiring only a container index: mount this prefix while preserving the original logical file length. */
  sparseFilePrefixes?: Readonly<Record<string, number>>;
  sourceTransform?: GameSourceTransform;
  unsupportedExecutableReason?: (bytes: Uint8Array) => string | undefined;
}

// Players supply executables with their local game bundles; runtime hooks resolve their native capabilities.
const ORIGINAL_GAMES: readonly SupportedGame[] = [
  {
    id: 'ra2',
    title: '红色警戒 2',
    executable: 'game.exe',
    commandLineArguments: '-SPEEDCONTROL',
    defaultGameSpeed: 0,
    folder: 'ra2',
    argBytes: ra2Win32ArgBytes,
    abi: RA2_ABI,
    shimProfile: RA2_SHIM_PROFILE,
    runtimeHooks: RA2_RUNTIME_HOOKS,
    driveTypes: {
      C: DRIVE_FIXED,
      // Expose the hard-drive installation only; do not fabricate optical media.
    },
    stackTop: 0x00d0_0000,
    heapBase: 0x00d0_0000,
    guestMemoryBytes: 640 * 1024 * 1024,
    arenaTop: 0x1000_0000,
    fastFileMirrorBase: 0x1200_0000,
    fastFileMirrorTop: 0x27f0_0000,
    fastFileMirrorFiles: ['ra2.mix', 'language.mix', 'subtitle.txt', 'game.fnt', 'maps01.mix'],
    preloadFiles: [{ path: 'config.txt' }, { path: 'Blowfish.dll' }, { path: 'BINKW32.DLL', linkBeforeEntry: true }],
    sparseFilePrefixes: { 'movies01.mix': 1024 * 1024, 'movies02.mix': 1024 * 1024 },
    smokeEntry: 0x0078_5aa0,
    smokeImports: 368,
    smokeFirstCall: 'KERNEL32.DLL!GetVersion',
  },
  {
    id: 'yr',
    title: '尤里的復仇',
    executable: 'gamemd.exe',
    commandLineArguments: '-SPEEDCONTROL',
    defaultGameSpeed: 0,
    folder: 'ra2',
    argBytes: yrWin32ArgBytes,
    abi: YR_ABI,
    shimProfile: YR_SHIM_PROFILE,
    runtimeHooks: YR_RUNTIME_HOOKS,
    driveTypes: {
      C: DRIVE_FIXED,
      // Expose the hard-drive installation only; do not fabricate optical media.
    },
    stackTop: 0x00d0_0000,
    heapBase: 0x00d0_0000,
    guestMemoryBytes: 640 * 1024 * 1024,
    arenaTop: 0x1000_0000,
    fastFileMirrorBase: 0x1200_0000,
    fastFileMirrorTop: 0x27f0_0000,
    fastFileMirrorFiles: ['ra2md.mix', 'langmd.mix', 'subtitlemd.txt', 'game.fnt', 'mapsmd03.mix'],
    preloadFiles: [{ path: 'config.txt' }, { path: 'Blowfish.dll' }, { path: 'BINKW32.DLL', linkBeforeEntry: true }],
    sparseFilePrefixes: {
      'movies01.mix': 1024 * 1024,
      'movies02.mix': 1024 * 1024,
      'movmd03.mix': 1024 * 1024,
    },
  },
];

// Share the YR machine layout, but not its original-game image patches.
export const SUPPORTED_GAMES: readonly SupportedGame[] = [
  ...ORIGINAL_GAMES,
  {
    ...ORIGINAL_GAMES[1]!,
    id: 'mo',
    title: '心灵终结 3.3.6',
    folder: 'mo',
    detectionFiles: ['Ares.dll', 'expandmo99.mix'],
    // Ares owns the startup-movie hook; use its switch instead of overlapping it
    // with the original YR image patch.
    commandLineArguments: '-SPAWN -CD -SPEEDCONTROL -NOLOGO',
    abi: YR_EXTENSION_ABI,
    argBytes: yrExtensionArgBytes,
    runtimeHooks: { createFrameReader: createYrFrameReader },
    guestMemoryBytes: 2048 * 1024 * 1024,
    heapBase: 0x30000000,
    arenaTop: 0x60000000,
    // Syringe discovers, checks, initializes and injects supplied extensions itself.
    preloadFiles: [...ORIGINAL_GAMES[1]!.preloadFiles!],
  },
];

export const DEFAULT_GAME = SUPPORTED_GAMES[0]!;

export function isSupportedGameId(value: string): value is SupportedGameId {
  return SUPPORTED_GAMES.some((game) => game.id === value);
}

export function supportedGame(id: SupportedGameId): SupportedGame {
  const game = SUPPORTED_GAMES.find((candidate) => candidate.id === id);
  if (!game) throw new Error(`未知游戏: ${id}`);
  return game;
}
