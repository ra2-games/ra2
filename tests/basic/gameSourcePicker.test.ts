import '../helpers/chineseLocale';
import { afterEach, expect, it, vi } from 'vitest';
import { GAME_MANIFESTS } from '../../src/games/manifest';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import { ProgressiveGameFileProvider } from '../../src/adapter/progressiveFiles';
import { createGameSourcePicker, restoreCachedGameSource } from '../../src/ui/pages/game/gameSourcePicker';
import {
  saveImportedResources,
  loadImportedResources,
  clearImportedResources,
} from '../../src/platform/browser/files/importedResources';
import { type SupportedGameId } from '../../src/games/catalog';
import type { GameFileProvider } from '../../src/resources/contracts';
const mocks = vi.hoisted(() => ({ load: vi.fn(), validate: vi.fn(), extract: vi.fn() }));
vi.mock('../../src/utils/archive/archiveExtract', () => ({ extractArchiveFiles: mocks.extract }));
vi.mock('../../src/adapter/gameArchiveLayers', () => ({ openGameArchive: mocks.load }));
vi.mock('../../src/resources/discovery/discoverGameSources', () => ({ validateGameDirectory: mocks.validate }));
vi.mock('../../src/adapter/cachedGameFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapter/cachedGameFiles')>()),
  clearCachedImportedGameFiles: vi.fn(),
  restoreCachedFileProvider: vi.fn(),
}));
vi.mock('../../src/platform/browser/files/importedResources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/platform/browser/files/importedResources')>()),
  saveImportedResources: vi.fn(),
  loadImportedResources: vi.fn().mockResolvedValue({}),
  clearImportedResources: vi.fn(),
}));
vi.mock('../../src/platform/browser/files/directoryAccess', () => ({
  rememberPreferredGame: vi.fn(),
  loadPreferredGame: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
it('opens the picker for an absent cache without reporting a read failure', async () => {
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockResolvedValue(null);
  await expect(restoreCachedGameSource()).resolves.toBeNull();
});
it('surfaces the failing file when a required cached Blob cannot be read', async () => {
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockImplementation(async (gameId) =>
    gameId === 'ra2'
      ? ({
          hasKnownFile: () => true,
          readPrefix: vi.fn().mockRejectedValue(new DOMException('unreadable', 'NotReadableError')),
        } as never)
      : null,
  );
  await expect(restoreCachedGameSource()).rejects.toThrow('ra2/game.exe：unreadable');
});

it('imports Mental Omega nested files and persists its player-supplied executable', async () => {
  prepare(['mo']);
  const names = [
    ...GAME_MANIFESTS.mo.playerRequired.map((entry) => entry.name),
    'INI/BattleClient.ini',
    'Resources/GameOptions.ini',
    'MapsMO/Standard/one.map',
    'MapsMO/Standard/two.map',
  ];
  const files = names.map((path) => {
    const file = new File([Uint8Array.of(7)], path.split('/').pop()!);
    Object.defineProperty(file, 'webkitRelativePath', { value: 'MentalOmega/' + path });
    return file;
  });
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importFolder(files);
  expect(picker.getSnapshot().games).toEqual(['mo']);
  expect(selected).not.toHaveBeenCalled();
  await picker.chooseGame('mo');
  expect(selected).toHaveBeenCalledWith({ game: { id: 'mo' } });
  const provider = mocks.validate.mock.calls[0]![0] as GameFileProvider;
  expect(await provider.read('MapsMO/Standard/one.map')).toEqual(Uint8Array.of(7));
  expect(await provider.read('MapsMO/Standard/two.map')).toEqual(Uint8Array.of(7));
  expect(await provider.read('Resources/GameOptions.ini')).toEqual(Uint8Array.of(7));
  const persisted = vi.mocked(saveImportedResources).mock.calls[0]![0].original.files;
  expect(persisted.get('gamemd.exe')).toEqual(Uint8Array.of(7));
  expect(persisted.has('ini/battleclient.ini')).toBe(true);
});
function prepare(ids: SupportedGameId[]) {
  const files = new Map(
    ids.flatMap((id) =>
      GAME_MANIFESTS[id].playerRequired.map((file) => [file.name.toLowerCase(), new Uint8Array([1])] as const),
    ),
  );
  const provider = new SessionGameFileProvider('test', files);
  mocks.load.mockResolvedValue(provider);
  mocks.validate.mockImplementation(async (_provider: GameFileProvider, game: SupportedGameId) => [
    { game: { id: game } },
  ]);
  return provider;
}
it('does not offer the shared YR executable from a complete MO archive', async () => {
  prepare(['mo', 'ra2']);
  const picker = createGameSourcePicker(vi.fn());
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().games).toEqual(['mo', 'ra2']);
});
it('does not fall back to YR when MO markers exist but its package is incomplete', async () => {
  const base = prepare(['mo']);
  base.files.delete('expandmo95.mix');
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(selected).not.toHaveBeenCalled();
  expect(picker.getSnapshot().games).toEqual([]);
  expect(picker.getSnapshot().missing.mo).toContain('expandmo95.mix');
  expect(picker.getSnapshot().replaced).toContain('yr');
});
it.each(['ra2', 'yr'] as const)(
  'single-version %s resources require explicit selection and retain the executable',
  async (game) => {
    const provider = prepare([game]);
    const selected = vi.fn(),
      picker = createGameSourcePicker(selected);
    picker.beginPick();
    await picker.importArchive(new Blob() as File);
    expect(picker.getSnapshot().games).toEqual([game]);
    expect(selected).not.toHaveBeenCalled();
    expect(mocks.validate).not.toHaveBeenCalled();
    await picker.chooseGame(game);
    expect(selected).toHaveBeenCalledWith({ game: { id: game } });
    expect(mocks.validate).toHaveBeenCalledWith(provider, game);
    expect(
      vi.mocked(saveImportedResources).mock.calls[0]![0].original.files.get(game === 'ra2' ? 'game.exe' : 'gamemd.exe'),
    ).toEqual(new Uint8Array([1]));
  },
);
it('双版本先显示选择，选择后才校验 EXE，重复点击不重复启动', async () => {
  prepare(['ra2', 'yr']);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().games).toEqual(['ra2', 'yr']);
  mocks.load.mock.calls[0]![2]('后台提取中');
  expect(picker.getSnapshot().description).toBe('');
  expect(selected).not.toHaveBeenCalled();
  await picker.chooseGame('yr');
  await picker.chooseGame('ra2');
  expect(selected).toHaveBeenCalledTimes(1);
  expect(selected).toHaveBeenCalledWith({ game: { id: 'yr' } });
});
it('缺件不启动；销毁取消待选的后台解压', async () => {
  prepare([]);
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().missing.ra2).toContain('game.exe');
  expect(selected).not.toHaveBeenCalled();
  const base = prepare(['ra2', 'yr']),
    abort = vi.fn();
  mocks.load.mockResolvedValue(new ProgressiveGameFileProvider('pending', new Set(base.files.keys()), abort));
  const importing = picker.importArchive(new Blob() as File);
  await vi.waitFor(() => expect(picker.getSnapshot().hasResources).toBe(true));
  picker.dispose();
  await importing;
  expect(abort).toHaveBeenCalledTimes(1);
  await picker.chooseGame('yr');
  expect(selected).not.toHaveBeenCalled();
});

it('folder import offers explicit selection regardless of filename case', async () => {
  prepare(['yr']);
  const files = GAME_MANIFESTS.yr.playerRequired.map((entry) => {
    const file = new File([new Uint8Array([1])], entry.name.toUpperCase());
    Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/' + entry.name });
    return file;
  });
  const selected = vi.fn(),
    picker = createGameSourcePicker(selected);
  await picker.importFolder(files);
  expect(selected).not.toHaveBeenCalled();
  await picker.chooseGame('yr');
  expect(selected).toHaveBeenCalledWith({ game: { id: 'yr' } });
  expect(mocks.load).not.toHaveBeenCalled();
});

it('rejects a bundle without its executable and does not restore legacy resource-only caches', async () => {
  const base = prepare(['ra2']);
  base.files.delete('game.exe');
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().missing.ra2).toContain('game.exe');
  expect(selected).not.toHaveBeenCalled();
  expect(mocks.validate).not.toHaveBeenCalled();
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockResolvedValue(base as never);
  await expect(restoreCachedGameSource()).resolves.toBeNull();
  expect(mocks.validate).not.toHaveBeenCalled();
});

it('restores the exact cached bundle provider, including its executable', async () => {
  const base = prepare(['ra2']);
  const { restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  vi.mocked(restoreCachedFileProvider).mockImplementation(async (id) => (id === 'ra2' ? (base as never) : null));
  await expect(restoreCachedGameSource()).resolves.toEqual({ game: { id: 'ra2' } });
  expect(mocks.validate).toHaveBeenCalledWith(base, 'ra2');
});

it('retains imported resources but refuses to launch when the supplied executable fails validation', async () => {
  prepare(['ra2']);
  mocks.validate.mockRejectedValue(new Error('Invalid package executable'));
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  await picker.chooseGame('ra2');
  expect(picker.getSnapshot().error).toContain('Invalid package executable');
  expect(selected).not.toHaveBeenCalled();
  expect(saveImportedResources).toHaveBeenCalledTimes(1);
});

it.each(['ra2', 'yr'] as const)(
  'persists %s installation settings unchanged alongside the executable',
  async (game) => {
    const base = prepare([game]);
    const name = game === 'ra2' ? 'ra2.ini' : 'ra2md.ini';
    const bytes = new TextEncoder().encode('[Intro]\r\nPlay=no\r\n');
    base.files.set(name, bytes);
    const selected = vi.fn();
    const picker = createGameSourcePicker(selected);
    await picker.importArchive(new Blob() as File);
    await picker.chooseGame(game);
    expect(vi.mocked(saveImportedResources).mock.calls[0]![0].original.files.get(name)).toEqual(bytes);
    expect(selected).toHaveBeenCalledTimes(1);
  },
);

it('clears import progress on failure and ignores reports after disposal', async () => {
  const picker = createGameSourcePicker(vi.fn());
  let report!: (value: { completedFiles: number; totalFiles: number | null }) => void;
  let reject!: (error: Error) => void;
  mocks.load.mockImplementation((_file, _game, _status, progress) => {
    report = progress;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  const pending = picker.importArchive(new Blob() as File);
  report({ completedFiles: 1, totalFiles: 3 });
  expect(picker.getSnapshot().progress).toEqual({ completedFiles: 1, totalFiles: 3 });
  reject(new Error('broken archive'));
  await pending;
  expect(picker.getSnapshot()).toMatchObject({ progress: null, busy: false, error: 'broken archive' });
  picker.dispose();
  report({ completedFiles: 3, totalFiles: 3 });
  expect(picker.getSnapshot().progress).toBeNull();
});

it('preserves the previous selection when a replacement file dialog is canceled', async () => {
  prepare(['yr']);
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  picker.beginPick();
  picker.cancelPick();
  expect(picker.getSnapshot().games).toEqual(['yr']);
  await picker.chooseGame('yr');
  expect(selected).toHaveBeenCalledTimes(1);
});

function mockMoPackages() {
  const base = new Map([
    ['expandmo95.mix', Uint8Array.of(95)],
    ['expandmo96.mix', Uint8Array.of(96)],
    ['ini/battleclient.ini', Uint8Array.of(1)],
    ['movmo03.mix', new Uint8Array()],
  ]);
  const patch = new Map(
    GAME_MANIFESTS.mo.playerRequired
      .filter((entry) => !base.has(entry.name.toLowerCase()))
      .map((entry) => [entry.name.toLowerCase(), Uint8Array.of(3)]),
  );
  patch.set('ini/battleclient.ini', Uint8Array.of(6));
  mocks.extract.mockImplementation(async (file: File) => ({ files: file.name === 'base.zip' ? base : patch }));
  return { base, patch };
}

it('assembles MO in fixed base/patch order without modifying original YR or starting automatically', async () => {
  const original = prepare(['yr']);
  original.files.set('ra2.mix', Uint8Array.of(1));
  original.files.set('language.mix', Uint8Array.of(1));
  mockMoPackages();
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new Blob() as File);
  await picker.importMoPackages([new File([], 'patch.zip'), new File([], 'base.zip')]);
  expect(selected).not.toHaveBeenCalled();
  expect(picker.getSnapshot().games).toEqual(['mo', 'yr']);
  expect(original.files.has('ares.dll')).toBe(false);
  expect(mocks.validate).not.toHaveBeenCalled();
  await picker.chooseGame('mo');
  const assembled = mocks.validate.mock.calls[0]![0] as GameFileProvider;
  expect(await assembled.read('gamemd.exe')).toEqual(Uint8Array.of(1));
  expect(await assembled.read('ini/battleclient.ini')).toEqual(Uint8Array.of(6));
  expect(await assembled.read('movmo03.mix')).toEqual(new Uint8Array());
  expect(saveImportedResources).toHaveBeenLastCalledWith(
    expect.objectContaining({
      base: { label: 'base.zip', files: expect.any(Map) },
      patch: { label: 'patch.zip', files: expect.any(Map) },
    }),
  );
  expect(original.files.has('expandmo95.mix')).toBe(false);
});

it('keeps packages across base selection and supports replacing/removing only one package', async () => {
  const original = prepare(['yr']);
  original.files.set('ra2.mix', Uint8Array.of(1));
  original.files.set('language.mix', Uint8Array.of(1));
  mockMoPackages();
  const picker = createGameSourcePicker(vi.fn());
  await picker.importMoPackages([new File([], 'patch.zip')]);
  await picker.importArchive(new Blob() as File);
  expect(picker.getSnapshot().missing.mo).toContain('expandmo95.mix');
  await picker.importMoPackages([new File([], 'base.zip')]);
  expect(picker.getSnapshot().games).toContain('mo');
  await picker.removeMoPackage('base');
  expect(picker.getSnapshot().games).not.toContain('mo');
  expect(picker.getSnapshot().games).toContain('yr');
  expect(picker.getSnapshot().moPackages.patch).toBe('patch.zip');
  picker.dispose();
});

it('rejects unrecognized or duplicate packages atomically, retaining the previously imported packages', async () => {
  mockMoPackages();
  const picker = createGameSourcePicker(vi.fn());
  await picker.importMoPackages([new File([], 'base.zip')]);
  await picker.importMoPackages([new File([], 'patch.zip'), new File([], 'patch.zip')]);
  expect(picker.getSnapshot().error).toContain('同类');
  expect(picker.getSnapshot().moPackages).toEqual({ base: 'base.zip', patch: null, language: null });
  mocks.extract.mockResolvedValue({ files: new Map([['other.ini', Uint8Array.of(7)]]) });
  await picker.importMoPackages([new File([], 'unknown.zip')]);
  expect(picker.getSnapshot().error).toContain('无法识别');
  expect(picker.getSnapshot().moPackages.base).toBe('base.zip');
  picker.dispose();
});

it('rejects a package selected through the wrong slot without replacing imported resources', async () => {
  mockMoPackages();
  const picker = createGameSourcePicker(vi.fn());
  await picker.importMoPackages([new File([], 'base.zip')], 'base');
  await picker.importMoPackages([new File([], 'patch.zip')], 'base');
  expect(picker.getSnapshot().error).toContain('类型不匹配');
  expect(picker.getSnapshot().moPackages).toEqual({ base: 'base.zip', patch: null, language: null });
  await picker.importMoPackages([new File([], 'patch.zip')], 'patch');
  expect(picker.getSnapshot().moPackages.patch).toBe('patch.zip');
  picker.dispose();
});

it('cancels package extraction and ignores late results on disposal', async () => {
  let finish!: (result: { files: Map<string, Uint8Array> }) => void;
  let signal!: AbortSignal;
  mocks.extract.mockImplementation((_file, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const picker = createGameSourcePicker(vi.fn());
  const pending = picker.importMoPackages([new File([], 'base.zip')]);
  picker.dispose();
  expect(signal.aborted).toBe(true);
  finish({
    files: new Map([
      ['expandmo95.mix', Uint8Array.of(1)],
      ['expandmo96.mix', Uint8Array.of(2)],
    ]),
  });
  await pending;
  expect(picker.getSnapshot().moPackages).toEqual({ base: null, patch: null, language: null });
});

it('disables choices after progressive extraction fails instead of starting an incomplete package', async () => {
  const original = prepare(['yr']);
  const progressive = new ProgressiveGameFileProvider('pending', new Set(original.files.keys()));
  mocks.load.mockResolvedValue(progressive);
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  const importing = picker.importArchive(new Blob() as File);
  await vi.waitFor(() => expect(picker.getSnapshot().hasResources).toBe(true));
  progressive.finish(new Error('read failed'));
  await importing;
  expect(picker.getSnapshot().games).toEqual([]);
  expect(picker.getSnapshot().error).toContain('read failed');
  await picker.chooseGame('yr');
  expect(selected).not.toHaveBeenCalled();
});

it('persists a complete archive before launch and restores the preparation state without starting', async () => {
  const base = prepare(['ra2', 'yr']);
  base.files.set('movies01.mix', new Uint8Array());
  const selected = vi.fn();
  const first = createGameSourcePicker(selected);
  await first.importArchive(new File([], 'games.zip'));
  expect(saveImportedResources).toHaveBeenCalledTimes(1);
  const groups = vi.mocked(saveImportedResources).mock.calls[0]![0];
  expect(groups.original.files.get('movies01.mix')).toEqual(new Uint8Array());
  vi.mocked(loadImportedResources).mockResolvedValueOnce(groups);
  const restored = createGameSourcePicker(selected);
  await restored.restore();
  expect(restored.getSnapshot().games).toEqual(['ra2', 'yr']);
  expect(selected).not.toHaveBeenCalled();
  await restored.chooseGame('yr');
  expect(selected).toHaveBeenCalledTimes(1);
  const provider = mocks.validate.mock.calls.at(-1)![0] as GameFileProvider;
  expect(await provider.read('movies01.mix')).toEqual(new Uint8Array());
});

it('restores separate MO layers and their package labels before the original game is imported', async () => {
  mockMoPackages();
  const picker = createGameSourcePicker(vi.fn());
  await picker.importMoPackages([new File([], 'patch.zip'), new File([], 'base.zip')]);
  const groups = vi.mocked(saveImportedResources).mock.calls.at(-1)![0];
  vi.mocked(loadImportedResources).mockResolvedValueOnce(groups);
  const restored = createGameSourcePicker(vi.fn());
  await restored.restore();
  expect(restored.getSnapshot().moPackages).toEqual({ base: 'base.zip', patch: 'patch.zip', language: null });
  expect(restored.getSnapshot().games).toEqual([]);
  expect(restored.getSnapshot().moOriginalMissing.length).toBeGreaterThan(0);
});

it('clears imported layers and state, preserving the independent custom-map namespace', async () => {
  prepare(['yr']);
  const picker = createGameSourcePicker(vi.fn());
  await picker.importArchive(new File([], 'yr.zip'));
  await picker.clearCache();
  expect(clearImportedResources).toHaveBeenCalledTimes(1);
  const { clearCachedImportedGameFiles } = await import('../../src/adapter/cachedGameFiles');
  expect(clearCachedImportedGameFiles).toHaveBeenCalledWith(['ra2', 'yr', 'mo']);
  expect(picker.getSnapshot()).toMatchObject({
    games: [],
    hasResources: false,
    moPackages: { base: null, patch: null, language: null },
  });
});

it('surfaces persistence failures without reporting a saved package or launching', async () => {
  prepare(['ra2']);
  vi.mocked(saveImportedResources).mockRejectedValueOnce(new DOMException('storage full', 'QuotaExceededError'));
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.importArchive(new File([], 'ra2.zip'));
  expect(picker.getSnapshot()).toMatchObject({ busy: false, error: 'storage full' });
  expect(selected).not.toHaveBeenCalled();
});

it('offers explicit launch from a legacy lazy cache without mistaking its empty memory map for missing files', async () => {
  const base = prepare(['ra2']);
  const { CachedGameFileProvider, restoreCachedFileProvider } = await import('../../src/adapter/cachedGameFiles');
  const cached = new CachedGameFileProvider('ra2', [...base.files.keys()]);
  vi.spyOn(cached, 'readPrefix').mockImplementation((path, length) => base.readPrefix(path, length));
  vi.spyOn(cached, 'read').mockImplementation((path) => base.read(path));
  vi.mocked(restoreCachedFileProvider).mockImplementation(async (id) => (id === 'ra2' ? cached : null));
  mocks.validate.mockImplementation(async (files: GameFileProvider, game: SupportedGameId) => [
    { files, game: { id: game } },
  ]);
  vi.mocked(loadImportedResources).mockResolvedValueOnce(null);
  const selected = vi.fn();
  const picker = createGameSourcePicker(selected);
  await picker.restore();
  expect(picker.getSnapshot().games).toEqual(['ra2']);
  expect(selected).not.toHaveBeenCalled();
  await picker.chooseGame('ra2');
  expect(selected).toHaveBeenCalledWith({ files: cached, game: { id: 'ra2' } });
});

it('restores and removes an optional MO language layer without changing YR or launch requirements', async () => {
  const original = prepare(['yr']);
  original.files.set('ra2.mix', Uint8Array.of(1));
  original.files.set('language.mix', Uint8Array.of(1));
  const { patch } = mockMoPackages();
  patch.set('expandmo98.mix', Uint8Array.of(2));
  const picker = createGameSourcePicker(vi.fn());
  await picker.importArchive(new File([], 'yr.zip'));
  await picker.importMoPackages([new File([], 'base.zip'), new File([], 'patch.zip')]);
  mocks.extract.mockResolvedValueOnce({ files: new Map([['expandmo98.mix', Uint8Array.of(98)]]) });
  await picker.importMoPackages([new File([], 'chinese.rar')], 'language');
  const groups = vi.mocked(saveImportedResources).mock.calls.at(-1)![0];
  expect(groups.language.label).toBe('chinese.rar');
  vi.mocked(loadImportedResources).mockResolvedValueOnce(groups);
  const restored = createGameSourcePicker(vi.fn());
  await restored.restore();
  expect(restored.getSnapshot().moPackages.language).toBe('chinese.rar');
  expect(restored.getSnapshot().games).toContain('mo');
  await restored.chooseGame('mo');
  let assembled = mocks.validate.mock.calls.at(-1)![0] as GameFileProvider;
  expect(await assembled.read('expandmo98.mix')).toEqual(Uint8Array.of(98));
  expect(original.files.has('expandmo98.mix')).toBe(false);
  vi.mocked(loadImportedResources).mockResolvedValueOnce(groups);
  const withoutLanguage = createGameSourcePicker(vi.fn());
  await withoutLanguage.restore();
  await withoutLanguage.removeMoPackage('language');
  expect(withoutLanguage.getSnapshot().games).toContain('mo');
  expect(withoutLanguage.getSnapshot().moPackages.language).toBeNull();
  await withoutLanguage.chooseGame('mo');
  assembled = mocks.validate.mock.calls.at(-1)![0] as GameFileProvider;
  expect(await assembled.read('expandmo98.mix')).toEqual(Uint8Array.of(2));
  withoutLanguage.dispose();
  picker.dispose();
  restored.dispose();
});

it('applies a language pack to a complete MO import and rejects the wrong package slot', async () => {
  const original = prepare(['mo']);
  original.files.set('expandmo98.mix', Uint8Array.of(2));
  const picker = createGameSourcePicker(vi.fn());
  await picker.importArchive(new File([], 'mo.zip'));
  mocks.extract.mockResolvedValue({ files: new Map([['expandmo98.mix', Uint8Array.of(98)]]) });
  await picker.importMoPackages([new File([], 'language.rar')], 'patch');
  expect(picker.getSnapshot().error).toContain('类型不匹配');
  expect(picker.getSnapshot().moPackages.language).toBeNull();
  await picker.importMoPackages([new File([], 'language.rar')], 'language');
  await picker.chooseGame('mo');
  const assembled = mocks.validate.mock.calls.at(-1)![0] as GameFileProvider;
  expect(await assembled.read('expandmo98.mix')).toEqual(Uint8Array.of(98));
  expect(await original.read('expandmo98.mix')).toEqual(Uint8Array.of(2));
  picker.dispose();
});

it.each([false, true])('keeps the root MO launcher independent of folder enumeration order (%s)', async (reverse) => {
  prepare(['mo']);
  const records = GAME_MANIFESTS.mo.playerRequired.map((entry) => ({ path: entry.name, value: 1 }));
  records.push({ path: 'Map Editor/Syringe.exe', value: 9 });
  if (reverse) records.reverse();
  const files = records.map(({ path, value }) => {
    const file = new File([Uint8Array.of(value)], path.split('/').pop()!);
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Package/' + path });
    return file;
  });
  const picker = createGameSourcePicker(vi.fn());
  await picker.importFolder(files);
  await picker.chooseGame('mo');
  const provider = mocks.validate.mock.calls[0]![0] as GameFileProvider;
  expect(await provider.read('Syringe.exe')).toEqual(Uint8Array.of(1));
  picker.dispose();
});
