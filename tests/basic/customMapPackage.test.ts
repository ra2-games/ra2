import { describe, expect, it } from 'vitest';
import { archiveExtensionKey } from '../../src/utils/archive/archiveFileKey';
import { mountCustomMapFiles, prepareDynamicMaps, validateCustomMapFiles } from '../../src/adapter/customMapPackage';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import { SUPPORTED_GAMES } from '../../src/games/catalog';

const bytes = (value: number) => new Uint8Array([value]);

describe('自定义地图包', () => {
  it('动态挂载只新增地图、忽略 CSF，并保持旧文件内容', async () => {
    const base = new SessionGameFileProvider('本体', new Map([['old.mpr', bytes(1)]]));
    const { provider, result } = await prepareDynamicMaps(
      base,
      new Map([
        ['OLD.MPR', bytes(2)],
        ['new.yrm', bytes(3)],
        ['ra2.csf', bytes(4)],
      ]),
    );
    expect(result).toEqual({ attached: ['new.yrm'], existing: ['old.mpr'] });
    expect(await provider.read('old.mpr')).toEqual(bytes(1));
    expect(await provider.read('new.yrm')).toEqual(bytes(3));
    expect(await provider.list('')).not.toContain('ra2.csf');
    const second = await prepareDynamicMaps(provider, new Map([['next.mpr', bytes(5)]]));
    expect(await second.provider.list('')).toEqual(expect.arrayContaining(['old.mpr', 'new.yrm', 'next.mpr']));
  });

  it('空集或只有 CSF 的热挂载不撤销当前文件', async () => {
    const base = new SessionGameFileProvider('本体', new Map([['old.mpr', bytes(1)]]));
    expect((await prepareDynamicMaps(base, new Map())).provider).toBe(base);
    expect((await prepareDynamicMaps(base, new Map([['ra2.csf', bytes(2)]]))).provider).toBe(base);
  });
  it.each(['Maps/DEMO.MPR', 'maps\\DEMO.YRM', '语言/RA2MD.CSF'])('探索任意子目录并忽略扩展名大小写：%s', (path) => {
    expect(archiveExtensionKey(path, ['.csf', '.yrm', '.mpr'])).toBe(path.split(/[\\/]/).at(-1)!.toLowerCase());
  });

  it.each(['../../map.mpr', '/map.yrm', 'C:\\map.yrm', 'maps/../map.csf', 'map.yrm.exe', 'game.exe', 'rules.ini'])(
    '拒绝不允许的路径或文件：%s',
    (path) => {
      expect(archiveExtensionKey(path, ['.csf', '.yrm', '.mpr'])).toBeNull();
    },
  );

  it('拒绝空包、空文件和不同子目录的同名文件', () => {
    expect(() => validateCustomMapFiles(new Map())).toThrow('没有找到');
    expect(() => validateCustomMapFiles(new Map([['a.mpr', new Uint8Array()]]))).toThrow('无效');
    expect(() =>
      validateCustomMapFiles(
        new Map([
          ['a/x.mpr', bytes(1)],
          ['b/X.MPR', bytes(2)],
        ]),
      ),
    ).toThrow('同名');
  });

  it('保留本体文本并枚举两类地图，不修改本体文件和持久包字节', async () => {
    const base = new SessionGameFileProvider('本体', new Map([['ra2md.csf', bytes(1)]]));
    const additions = new Map([
      ['Ra2MD.CSF', bytes(2)],
      ['dir/a.mpr', bytes(3)],
      ['b.yrm', bytes(4)],
    ]);
    const mounted = mountCustomMapFiles(
      { game: SUPPORTED_GAMES[0]!, files: base, executableBytes: bytes(0) },
      additions,
    );
    expect(await mounted.files.list('')).toEqual(expect.arrayContaining(['ra2md.csf', 'a.mpr', 'b.yrm']));
    expect(await mounted.files.read('RA2MD.CSF')).toEqual(bytes(1));
    expect(await mounted.files.read('a.mpr')).toEqual(bytes(3));
    await mounted.files.write('a.mpr', bytes(9));
    expect(await base.read('a.mpr')).toBeNull();
    expect(await base.read('ra2md.csf')).toEqual(bytes(1));
    expect(additions.get('dir/a.mpr')).toEqual(bytes(3));
    expect(additions.get('Ra2MD.CSF')).toEqual(bytes(2));
  });

  it('只有 CSF 的旧缓存不会创建覆盖层，也不会新增可枚举文件', async () => {
    const source = {
      game: SUPPORTED_GAMES[0]!,
      files: new SessionGameFileProvider('本体', new Map()),
      executableBytes: bytes(0),
    };
    expect(mountCustomMapFiles(source, new Map([['CUSTOM.CSF', bytes(1)]]))).toBe(source);
  });
});
