import { describe, expect, it } from 'vitest';
import {
  createSavePackage,
  hasPlayerSlotSaves,
  importSavePackage,
  listSavePaths,
  readSavePackage,
  summarizeSavePaths,
} from '../../src/adapter/saveTransfer';
import type { GameFileProvider } from '../../src/resources/contracts';

class MemorySaveProvider implements GameFileProvider {
  readonly label = 'test saves';
  readonly files = new Map<string, Uint8Array>();

  constructor(entries: Record<string, number[]> = {}) {
    for (const [path, bytes] of Object.entries(entries)) this.files.set(path, new Uint8Array(bytes));
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes.slice());
  }

  async flush(): Promise<void> {}

  async list(directory: string): Promise<string[]> {
    const prefix = directory ? `${directory}/` : '';
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash < 0 ? rest : rest.slice(0, slash));
    }
    return [...names];
  }
}

function packageBlob(path: string, data = 'AQID'): Blob {
  return new Blob(
    [
      JSON.stringify({
        format: 'ra2-vm-save',
        version: 1,
        gameId: 'ra2',
        createdAt: '2026-09-05T00:00:00.000Z',
        files: [{ path, data }],
      }),
    ],
    { type: 'application/json' },
  );
}

describe('saveTransfer', () => {
  it('导出和导入根目录、Save 目录存档时保持路径和字节', async () => {
    const source = new MemorySaveProvider({
      'ra2md.sav': [1, 2],
      'save/slot01.sav': [3, 4, 5],
      'not-a-save.txt': [9],
    });

    expect(await listSavePaths(source)).toEqual(['ra2md.sav', 'save/slot01.sav']);
    const archive = await createSavePackage(source, 'ra2');
    const summary = await readSavePackage(archive, 'ra2');
    expect(summary.files.map((entry) => [entry.path, [...entry.bytes]])).toEqual([
      ['ra2md.sav', [1, 2]],
      ['save/slot01.sav', [3, 4, 5]],
    ]);

    const target = new MemorySaveProvider();
    await importSavePackage(target, summary);
    expect([...target.files.entries()].map(([path, bytes]) => [path, [...bytes]])).toEqual([
      ['ra2md.sav', [1, 2]],
      ['save/slot01.sav', [3, 4, 5]],
    ]);
  });

  it('在校验原始字符串后拒绝穿越、绝对路径、嵌套路径和根目录非法扩展名', async () => {
    for (const path of [
      '../../slot.sav',
      'save/../slot.sav',
      'save/a/b.sav',
      '/slot.sav',
      '\\slot.sav',
      'C:slot.sav',
      'slot.exe',
    ]) {
      await expect(readSavePackage(packageBlob(path), 'ra2')).rejects.toThrow(/非法路径/);
    }

    await expect(readSavePackage(packageBlob('save/slot01.bin'), 'ra2')).resolves.toMatchObject({
      files: [{ path: 'save/slot01.bin', bytes: new Uint8Array([1, 2, 3]) }],
    });
  });

  it('拒绝错误游戏、重复路径、损坏数据和不可识别包', async () => {
    await expect(readSavePackage(packageBlob('slot.sav'), 'yr')).rejects.toThrow(/属于 ra2/);
    const duplicate = new Blob([
      JSON.stringify({
        format: 'ra2-vm-save',
        version: 1,
        gameId: 'ra2',
        createdAt: 'now',
        files: [
          { path: 'slot.sav', data: 'AQ==' },
          { path: 'slot.sav', data: 'Ag==' },
        ],
      }),
    ]);
    await expect(readSavePackage(duplicate, 'ra2')).rejects.toThrow(/重复路径/);
    await expect(readSavePackage(packageBlob('slot.sav', '%'), 'ra2')).rejects.toThrow(/Base64/);
    await expect(readSavePackage(new Blob(['not json']), 'ra2')).rejects.toThrow(/JSON/);
  });

  it('存档摘要和槽位判断只认合法路径', () => {
    const paths = ['slot.sav', 'save/slot01.bin', 'save/../bad.sav', 'readme.txt'];
    expect(hasPlayerSlotSaves(paths)).toBe(true);
    expect(summarizeSavePaths(paths)).toContain('slot.sav');
    expect(summarizeSavePaths(paths)).toContain('save/slot01.bin');
  });
});
