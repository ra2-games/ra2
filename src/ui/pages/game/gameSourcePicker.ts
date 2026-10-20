import { selectImportPaths } from '../../../utils/archive/selectImportPaths';
import { gameResourceAvailability } from '../../../games/resourceAvailability';
import {
  assembleMentalOmega,
  mentalOmegaPackageKind,
  MENTAL_OMEGA_ORIGINAL_FILES,
  type MentalOmegaPackageKind,
} from '../../../games/mentalOmega/installation';
import { t } from '../../shared/i18n/translate';
import { GAME_ARCHIVE_DIRECTORY_RULES } from '../../../games/archivePolicy';
import { SUPPORTED_GAMES, supportedGame, type SupportedGameId } from '../../../games/catalog';
import { loadPreferredGame, rememberPreferredGame } from '../../../platform/browser/files/directoryAccess';
import { validateGameDirectory } from '../../../resources/discovery/discoverGameSources';
import { type GameFileProvider } from '../../../resources/contracts';
import { type GameSource } from '../../../games/source';
import { SessionGameFileProvider } from '../../../platform/browser/files/sessionFiles';
import { extractArchiveFiles, type ArchiveExtractProgress } from '../../../utils/archive/archiveExtract';
import { openGameArchive } from '../../../adapter/gameArchiveLayers';
import { ProgressiveGameFileProvider, progressiveFilesOf } from '../../../adapter/progressiveFiles';
import {
  restoreCachedFileProvider,
  clearCachedImportedGameFiles,
  CachedGameFileProvider,
} from '../../../adapter/cachedGameFiles';
import {
  saveImportedResources,
  loadImportedResources,
  clearImportedResources,
  ImportedResourceFileProvider,
  type ImportedResources,
} from '../../../platform/browser/files/importedResources';
import { ARCHIVE_WANTED_NAMES, GAME_MANIFESTS, type GameManifest } from '../../../games/manifest';
import { createStore } from '../../shared/state/store';

export interface PickerState {
  description: string;
  error: string;
  busy: boolean;
  awaitingSelection: boolean;
  progress: ArchiveExtractProgress | null;
  games: SupportedGameId[];
  hasResources: boolean;
  missing: Partial<Record<SupportedGameId, string[]>>;
  replaced: SupportedGameId[];
  moPackages: Record<MentalOmegaPackageKind, string | null>;
  moOriginalMissing: string[];
  manifest: { manifest: GameManifest; present: ReadonlySet<string>; complete: boolean } | null;
}

/** Resource-import service: accepts files/versions and publishes state; the React hook owns file-picker lifetime. */
export function createGameSourcePicker(resolve: (source: GameSource) => void) {
  let disposed = false;
  const state: PickerState = {
    description: '',
    error: '',
    busy: false,
    awaitingSelection: false,
    progress: null,
    manifest: null,
    games: [],
    hasResources: false,
    missing: {},
    replaced: [],
    moPackages: { base: null, patch: null, language: null },
    moOriginalMissing: [...MENTAL_OMEGA_ORIGINAL_FILES],
  };
  const store = createStore({ ...state });
  let pendingSource: GameFileProvider | null = null;
  let sourceNames = new Set<string>();
  const packages: Record<MentalOmegaPackageKind, ReadonlyMap<string, Uint8Array | Blob>> = {
    base: new Map(),
    patch: new Map(),
    language: new Map(),
  };
  let packageController: AbortController | null = null;
  let pendingArchive: ProgressiveGameFileProvider | null = null;
  const refreshChoices = () => {
    state.hasResources = pendingSource !== null;
    state.games = [];
    state.missing = {};
    state.replaced = [];
    const addonNames = [...packages.base.keys(), ...packages.patch.keys()].filter(
      (name) => !(MENTAL_OMEGA_ORIGINAL_FILES as readonly string[]).includes(name),
    );
    const moNames = new Set([...sourceNames, ...addonNames]);
    for (const id of Object.keys(GAME_MANIFESTS) as SupportedGameId[]) {
      const result = gameResourceAvailability(id === 'mo' ? moNames : sourceNames, id);
      if (result.available) state.games.push(id);
      if (result.replaced) state.replaced.push(id);
      state.missing[id] = result.missing;
    }
    state.moOriginalMissing = MENTAL_OMEGA_ORIGINAL_FILES.filter((name) => !sourceNames.has(name));
  };
  const publish = () => {
    if (!disposed) store.set({ ...state });
  };
  const setButtonsDisabled = (disabled: boolean): void => {
    state.busy = disabled;
    if (!disabled) state.progress = null;
    publish();
  };
  const presentNames = (names: Iterable<string>): Set<string> => new Set([...names].map((name) => name.toLowerCase()));
  const renderManifest = (manifest: GameManifest, present: ReadonlySet<string>, complete: boolean): void => {
    state.manifest = { manifest, present, complete };
    publish();
  };
  const use = async (load: () => Promise<GameFileProvider | null>, gameId?: SupportedGameId) => {
    state.awaitingSelection = false;
    state.error = '';
    state.progress = null;
    publish();
    setButtonsDisabled(true);
    try {
      const base = await load();
      if (disposed) {
        if (base) progressiveFilesOf(base)?.cancel();
        return;
      }
      // null means canceled selection, such as closing the archive dialog; silently return to the panel using AbortError semantics.
      if (!base) throw new DOMException(t('已取消'), 'AbortError');
      if (gameId) await runImport(base, gameId);
      else {
        const names = presentNames(
          base instanceof ProgressiveGameFileProvider ? base.inventory : ((await base.list('')) ?? []),
        );
        if (pendingSource && pendingSource !== base) progressiveFilesOf(pendingSource)?.cancel();
        pendingSource = base;
        sourceNames = names;
        refreshChoices();
        state.description = '';
        publish();
        // Only publish a restorable snapshot after every archive layer has finished.
        if (base instanceof ProgressiveGameFileProvider) {
          try {
            await base.completion;
          } catch (error) {
            state.games = [];
            throw error;
          }
        }
        if (disposed) return;
        await persistImports();
      }
    } catch (reason) {
      if ((reason as DOMException)?.name !== 'AbortError') {
        state.error = reason instanceof Error ? reason.message : String(reason);
        publish();
      }
    } finally {
      setButtonsDisabled(false);
    }
  };
  /**
   * Manifest gate: require the package executable alongside its resources, then render the manifest. Return null for missing required files while retaining the checklist.
   */
  const manifestGate = async (
    base: GameFileProvider,
    archiveNames: ReadonlySet<string>,
    gameId: SupportedGameId,
  ): Promise<GameFileProvider | null> => {
    const manifest = GAME_MANIFESTS[gameId];
    const present = new Set(archiveNames);
    const missing = manifest.playerRequired
      .filter((file) => !present.has(file.name.toLowerCase()))
      .map((file) => file.name);
    const complete = missing.length === 0;
    renderManifest(manifest, present, complete);
    if (!complete) {
      state.description =
        t('{0} 缺少必需文件：{1}。', supportedGame(gameId).title, missing.join('、')) +
        t('请重新选择包含这些文件的资源。');
      state.error = state.description;
      publish();
      return null;
    }
    state.description = t('必需文件已集齐，正在启动…');
    publish();
    return base;
  };

  const importedGroup = async (provider: GameFileProvider) => {
    if (provider instanceof ImportedResourceFileProvider) return provider.imported;
    if (provider instanceof SessionGameFileProvider && !(provider instanceof CachedGameFileProvider))
      return { label: provider.label, files: provider.files };
    // Migrate a legacy lazy provider without dropping its files when another layer is added.
    const files = new Map<string, Blob>();
    for (const path of sourceNames) {
      const bytes = await provider.read(path);
      if (disposed) throw new DOMException(t('已取消'), 'AbortError');
      if (bytes === null) throw new Error(t('缓存游戏资源不可读：{0}：{1}', path, 'Missing record'));
      files.set(path, new Blob([bytes as BlobPart]));
    }
    return { label: provider.label, files };
  };

  const persistImports = async () => {
    if (disposed) return;
    const groups: ImportedResources = {};
    if (pendingSource) groups.original = await importedGroup(pendingSource);
    for (const kind of ['base', 'patch', 'language'] as const) {
      if (state.moPackages[kind]) groups[kind] = { label: state.moPackages[kind]!, files: packages[kind] };
    }
    if (disposed) return;
    state.description = t('正在保存资源缓存…');
    publish();
    await saveImportedResources(groups);
    state.description = '';
    publish();
  };

  /** Finish import through the manifest gate; once complete, verify the executable and start, otherwise remain on the panel. */
  const runImport = async (base: GameFileProvider, gameId: SupportedGameId): Promise<void> => {
    try {
      const present =
        base instanceof ProgressiveGameFileProvider
          ? presentNames(base.inventory)
          : base instanceof CachedGameFileProvider
            ? sourceNames
            : base instanceof ImportedResourceFileProvider
              ? presentNames(base.imported.files.keys())
              : base instanceof SessionGameFileProvider
                ? presentNames(base.files.keys())
                : // Directory providers derive their manifest from the selected directory,
                  // or a fixed empty manifest permanently traps complete resources in the picker and prevents browser regressions from starting.
                  presentNames((await base.list('')) ?? []);
      const provider = await manifestGate(base, present, gameId);
      if (!provider) {
        progressiveFilesOf(base)?.cancel();
        return;
      }
      const source = (await validateGameDirectory(provider, gameId))[0]!;
      if (disposed) {
        progressiveFilesOf(base)?.cancel();
        return;
      }
      rememberPreferredGame(source.game.id);
      disposed = true;
      resolve(source);
    } catch (error) {
      progressiveFilesOf(base)?.cancel();
      throw error;
    }
  };

  // Write parsing/reading progress text into the panel description.
  const onStatus = (message: string): void => {
    if (!disposed && state.busy) {
      state.description = message;
      publish();
    }
  };
  const onProgress = (progress: ArchiveExtractProgress): void => {
    if (disposed || !state.busy) return;
    state.progress = progress;
    publish();
  };
  /**
   * Parse the selected archive. Reuse late change events by restarting the full use flow if the pending selection was already canceled, restoring disabled-button/error behavior. The manifest gate runs inside use.
   */
  const processArchiveFile = async (file: File): Promise<GameFileProvider | null> => {
    onStatus(t('正在解析归档目录并准备启动层…'));
    const provider = await openGameArchive(file, undefined, onStatus, onProgress);
    pendingArchive = provider instanceof ProgressiveGameFileProvider ? provider : null;
    return provider;
  };
  /** Read manifest-required files from the selected directory, handling late change like archives; the manifest gate runs in use. */
  const processFolderFiles = (files: File[]): Promise<GameFileProvider | null> =>
    (async () => {
      // Read only manifest-required files; match basenames at any depth.
      const wanted = presentNames(ARCHIVE_WANTED_NAMES);
      const wantedDirs = [...wanted].filter((name) => name.endsWith('/'));
      const extracted = new Map<string, Uint8Array>();
      const archives: File[] = [];
      const readBytes = async (file: File): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());
      const relative = (file: File) =>
        file.webkitRelativePath.split('/').slice(1).join('/').toLowerCase() || file.name.toLowerCase();
      const keyOf = (rel: string) => {
        const name = rel.split('/').at(-1)!;
        return wanted.has(name) ? name : wanted.has(rel) || wantedDirs.some((dir) => rel.startsWith(dir)) ? rel : null;
      };
      // Root installation files dominate editor/client copies, independent of FileList order.
      const selected = selectImportPaths(files, relative, keyOf);
      for (const [name, file] of selected) extracted.set(name, await readBytes(file));
      for (const file of files)
        if (keyOf(relative(file)) === null && /\.(zip|rar|7z|exe)$/i.test(file.name)) archives.push(file);
      // Also recursively extract archives such as installers found inside directories, using the same 7z-wasm Worker;
      // ordinary EXEs such as launcher copies are not archives, so skip failed attempts.
      for (const archive of archives.slice(0, 8)) {
        state.progress = null;
        onStatus(t('正在解压目录内归档：{0} …', archive.name));
        try {
          const result = await extractArchiveFiles(await readBytes(archive), {
            wanted: [...ARCHIVE_WANTED_NAMES],
            directoryRules: GAME_ARCHIVE_DIRECTORY_RULES,
            onStatus,
            onProgress,
          });
          for (const [name, entryBytes] of result.files) if (!extracted.has(name)) extracted.set(name, entryBytes);
        } catch (error) {
          console.warn(t('[游戏文件] 目录内归档无法解析，跳过'), archive.name, error);
        }
      }
      onStatus(t('目录读取完成：{0} 个所需文件。', extracted.size));
      return new SessionGameFileProvider(t('本地目录'), extracted);
    })();
  return {
    ...store,
    async restore() {
      if (disposed || state.busy) return;
      setButtonsDisabled(true);
      try {
        const groups = await loadImportedResources();
        if (disposed) return;
        if (groups?.original) {
          pendingSource = new ImportedResourceFileProvider(groups.original);
          sourceNames = presentNames(groups.original.files.keys());
        }
        if (groups) {
          for (const kind of ['base', 'patch', 'language'] as const) {
            if (!groups[kind]) continue;
            const files = groups[kind].files;
            if (disposed) return;
            packages[kind] = files;
            state.moPackages = { ...state.moPackages, [kind]: groups[kind].label };
          }
        } else {
          // Keep old complete imports usable; new snapshots never choose a game or start its VM.
          const legacy = await restoreCachedGameSource();
          if (disposed) return;
          if (legacy) {
            pendingSource = legacy.files;
            sourceNames = presentNames(await listResourcePaths(legacy.files));
          }
        }
        refreshChoices();
      } catch (error) {
        if (!disposed) state.error = error instanceof Error ? error.message : String(error);
      } finally {
        setButtonsDisabled(false);
      }
    },
    async clearCache() {
      if (disposed || state.busy) return;
      state.error = '';
      setButtonsDisabled(true);
      try {
        await clearCachedImportedGameFiles(SUPPORTED_GAMES.map((game) => game.id));
        await clearImportedResources();
        if (disposed) return;
        if (pendingSource) progressiveFilesOf(pendingSource)?.cancel();
        pendingSource = null;
        sourceNames = new Set();
        packages.base = new Map();
        packages.patch = new Map();
        packages.language = new Map();
        state.moPackages = { base: null, patch: null, language: null };
        state.manifest = null;
        refreshChoices();
        state.description = t('资源缓存已清除，存档和自定义地图已保留。');
      } catch (error) {
        if (!disposed) state.error = error instanceof Error ? error.message : String(error);
      } finally {
        setButtonsDisabled(false);
      }
    },
    beginPick() {
      if (disposed || state.busy) return;
      state.error = '';
      state.progress = null;
      state.awaitingSelection = true;
      setButtonsDisabled(true);
    },
    chooseGame(gameId: SupportedGameId) {
      if (disposed || state.busy || !pendingSource || !state.games.includes(gameId)) return;
      const original = pendingSource;
      return use(async () => {
        if (gameId !== 'mo' || (!packages.base.size && !packages.patch.size && !packages.language.size))
          return original;
        const progressive = progressiveFilesOf(original);
        if (progressive) await progressive.completion;
        // A complete imported MO directory can be supplemented by a newer patch too.
        const baseFiles = sourceNames.has('expandmo99.mix')
          ? new Map([...(await importedGroup(original)).files, ...packages.base])
          : packages.base;
        const files = await assembleMentalOmega(
          original,
          await materializeFiles(baseFiles),
          await materializeFiles(packages.patch),
          await materializeFiles(packages.language),
        );
        return new SessionGameFileProvider('Mental Omega', files);
      }, gameId);
    },
    async removeMoPackage(kind: MentalOmegaPackageKind) {
      if (disposed || state.busy) return;
      packages[kind] = new Map();
      state.moPackages = { ...state.moPackages, [kind]: null };
      refreshChoices();
      state.error = '';
      setButtonsDisabled(true);
      try {
        await persistImports();
      } catch (error) {
        if (!disposed) state.error = error instanceof Error ? error.message : String(error);
      } finally {
        setButtonsDisabled(false);
      }
    },
    async importMoPackages(files: File[], expectedKind?: MentalOmegaPackageKind) {
      if (disposed || (state.busy && !state.awaitingSelection)) return;
      state.awaitingSelection = false;
      state.error = '';
      setButtonsDisabled(true);
      const controller = new AbortController();
      packageController = controller;
      const staged = new Map<MentalOmegaPackageKind, { name: string; files: Map<string, Uint8Array> }>();
      try {
        for (const file of files) {
          const result = await extractArchiveFiles(file, {
            wanted: [...ARCHIVE_WANTED_NAMES],
            directoryRules: GAME_ARCHIVE_DIRECTORY_RULES,
            signal: controller.signal,
            onStatus,
            onProgress,
          });
          if (disposed) return;
          const kind = mentalOmegaPackageKind(new Set(result.files.keys()));
          if (!kind) throw new Error(t('无法识别 MO 基础包、补丁或语言包：{0}', file.name));
          if (expectedKind && kind !== expectedKind) throw new Error(t('所选文件类型不匹配，请使用对应的添加包按钮。'));
          if (staged.has(kind)) throw new Error(t('一次只能选择一个同类扩展包。'));
          staged.set(kind, { name: file.name, files: result.files });
        }
        for (const [kind, value] of staged) {
          packages[kind] = value.files;
          state.moPackages = { ...state.moPackages, [kind]: value.name };
        }
        refreshChoices();
        await persistImports();
      } catch (error) {
        if (!disposed) state.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (packageController === controller) packageController = null;
        setButtonsDisabled(false);
      }
    },
    cancelPick() {
      state.awaitingSelection = false;
      setButtonsDisabled(false);
    },
    importArchive(file: File) {
      return use(() => processArchiveFile(file));
    },
    importFolder(files: File[]) {
      return use(() => processFolderFiles(files));
    },
    dispose() {
      disposed = true;
      packageController?.abort();
      pendingArchive?.cancel();
      if (pendingSource) progressiveFilesOf(pendingSource)?.cancel();
      pendingSource = null;
    },
  };
}

/**
 * Restore a game source from the last imported IndexedDB file set. Return null for absent/incomplete caches; reject unreadable data so the page can show the failure instead of hiding it behind the picker.
 */
export async function restoreCachedGameSource(): Promise<GameSource | null> {
  const preferred = loadPreferredGame();
  const order = [preferred, ...SUPPORTED_GAMES.map((game) => game.id).filter((id) => id !== preferred)];
  for (const gameId of order) {
    if (!gameId) continue;
    const manifest = GAME_MANIFESTS[gameId];
    const cached = await restoreCachedFileProvider(gameId);
    if (!cached) continue;
    const missing = manifest.playerRequired.filter((file) => cached.hasKnownFile(file.name.toLowerCase()) !== true);
    if (missing.length) continue;
    // IndexedDB can still list a Blob whose backing data became unreadable after a page refresh.
    // Probe actual bytes before startup, and surface the failing file instead of silently reopening the picker.
    for (const file of manifest.playerRequired) {
      try {
        if ((await cached.readPrefix(file.name, 1)) === null) throw new Error('Cached record is missing');
      } catch (error) {
        throw new Error(
          t(
            '缓存游戏资源不可读：{0}：{1}',
            `${gameId}/${file.name}`,
            error instanceof Error ? error.message : String(error),
          ),
          { cause: error },
        );
      }
    }
    const sources = await validateGameDirectory(cached, gameId).catch(() => []);
    if (sources[0]) return sources[0];
  }
  return null;
}

async function materializeFiles(files: ReadonlyMap<string, Uint8Array | Blob>): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  for (const [path, bytes] of files)
    result.set(path, bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes);
  return result;
}

async function listResourcePaths(provider: GameFileProvider, directory = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const name of (await provider.list(directory)) ?? []) {
    const path = directory ? directory + '/' + name : name;
    if (provider.hasKnownFile?.(path) === true) paths.push(path);
    else paths.push(...(await listResourcePaths(provider, path)));
  }
  return paths;
}
