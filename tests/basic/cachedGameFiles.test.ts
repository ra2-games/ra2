import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearCachedImportedGameFiles,
  loadCachedGameFiles,
  saveCachedGameFiles,
  restoreCachedFileProvider,
} from '../../src/adapter/cachedGameFiles';

/** Mock only requests/cursors used by this module; browser reload regressions cover real IndexedDB transactions. */
function cache(initial = new Map<string, unknown>(), writeError?: DOMException, abortOnly = false) {
  const rows = initial;
  type Range = { lower: string; upper: string };
  const matches = (key: string, range: Range) => key >= range.lower && key <= range.upper;
  vi.stubGlobal('IDBKeyRange', { bound: (lower: string, upper: string) => ({ lower, upper }) });
  vi.stubGlobal('indexedDB', {
    open() {
      const request: any = {};
      request.result = {
        close() {},
        transaction(_store: string, mode?: string) {
          // Do not change persisted rows before a write transaction commits; quota failures preserve the entire old resource set, as real IDB does.
          const transactionRows = mode === 'readwrite' ? new Map(rows) : rows;
          const transaction: any = {
            objectStore() {
              return {
                delete(range: Range) {
                  const deletion: any = {};
                  queueMicrotask(() => {
                    for (const key of transactionRows.keys()) if (matches(key, range)) transactionRows.delete(key);
                    deletion.onsuccess?.();
                    setTimeout(() => {
                      if (writeError) {
                        transaction.error = writeError;
                        if (abortOnly) transaction.onabort?.();
                        else transaction.onerror?.();
                        return;
                      }
                      rows.clear();
                      for (const [key, value] of transactionRows) rows.set(key, value);
                      transaction.oncomplete?.();
                    }, 0);
                  });
                  return deletion;
                },
                put(bytes: Uint8Array, key: string) {
                  transactionRows.set(key, structuredClone(bytes));
                },
                getAllKeys(range: Range) {
                  const request: any = {};
                  queueMicrotask(() => {
                    request.result = [...rows.keys()].filter((key) => !range || matches(key, range));
                    request.onsuccess();
                  });
                  return request;
                },
                get(key: string) {
                  const request: any = {};
                  queueMicrotask(() => {
                    request.result = structuredClone(rows.get(key));
                    request.onsuccess();
                  });
                  return request;
                },
                openCursor(range: Range) {
                  const entries = [...rows].filter(([key]) => matches(key, range));
                  const cursor: any = {};
                  let index = 0;
                  const next = () =>
                    queueMicrotask(() => {
                      const entry = entries[index++];
                      cursor.result = entry
                        ? { key: entry[0], value: structuredClone(entry[1]), continue: next }
                        : null;
                      cursor.onsuccess();
                    });
                  next();
                  return cursor;
                },
              };
            },
          };
          return transaction;
        },
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
  return rows;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('导入资源缓存保持文件存在性', () => {
  it('整包超配额且不允许缩减资源时明确警告，并保留旧缓存', async () => {
    const error = new DOMException('资源超过配额', 'QuotaExceededError');
    const original = new Map<string, unknown>([
      ['yr/old.mix', new Uint8Array([9])],
      ['ra2/movies01.mix', new Uint8Array()],
    ]);
    const rows = cache(new Map(original), error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saveCachedGameFiles(
      'yr',
      new Map([
        ['ra2md.mix', new Uint8Array([1, 2])],
        ['movmd03.mix', new Uint8Array()],
      ]),
      [],
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[游戏文件] 存储配额不足：本次资源未缓存，保留原缓存；刷新后可能需要重新选择资源。',
      error,
    );
    expect(rows).toEqual(original);
    expect(await loadCachedGameFiles('yr')).toEqual(new Map([['old.mix', new Uint8Array([9])]]));
  });
  it('恢复只枚举目录，Blob 正文按片读取并兼容旧字节记录、空文件和子目录', async () => {
    cache(
      new Map<string, unknown>([
        ['ra2/movie.mix', new Blob([new Uint8Array([1, 2, 3, 4])])],
        ['ra2/old.mix', new Uint8Array([5, 6])],
        ['ra2/empty.mix', new Blob([])],
        ['ra2/taunts/a.wav', new Blob([new Uint8Array([7])])],
      ]),
    );
    const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
    const provider = (await restoreCachedFileProvider('ra2'))!;
    expect(provider.files.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(provider.hasKnownFile('MOVIE.MIX')).toBe(true);
    expect(await provider.readPrefix('movie.mix', 2)).toEqual({ bytes: new Uint8Array([1, 2]), totalSize: 4 });
    expect(await provider.readRange('movie.mix', 2, 1)).toEqual(new Uint8Array([3]));
    expect(await provider.read('old.mix')).toEqual(new Uint8Array([5, 6]));
    expect(await provider.read('empty.mix')).toEqual(new Uint8Array());
    expect(await provider.list('taunts')).toEqual(['a.wav']);
    read.mockRestore();
  });
  it('零字节电影 MIX 与普通资源完整往返，不丢占位文件', async () => {
    const rows = cache();
    const files = new Map([
      ['ra2.mix', new Uint8Array([1, 2, 3])],
      ['movies01.mix', new Uint8Array()],
      ['movies02.mix', new Uint8Array()],
    ]);
    await saveCachedGameFiles('ra2', files);
    expect(rows.has('ra2/movies01.mix')).toBe(true);
    expect(await loadCachedGameFiles('ra2')).toEqual(files);
  });
  it('只有空文件的资源集不是无缓存', async () => {
    cache();
    await saveCachedGameFiles('ra2', new Map([['MAPS01.MIX', new Uint8Array()]]));
    expect(await loadCachedGameFiles('ra2')).toEqual(new Map([['maps01.mix', new Uint8Array()]]));
  });
  it('重新导入只替换所选游戏，不保留旧文件或清掉其他游戏', async () => {
    const rows = cache(
      new Map([
        ['ra2/old.mix', new Uint8Array([9])],
        ['yr/movmd03.mix', new Uint8Array()],
      ]),
    );
    await saveCachedGameFiles('ra2', new Map([['movies01.mix', new Uint8Array()]]));
    expect(rows.has('ra2/old.mix')).toBe(false);
    expect(await loadCachedGameFiles('yr')).toEqual(new Map([['movmd03.mix', new Uint8Array()]]));
  });
  it('reselecting resources removes imported packages while keeping custom maps', async () => {
    const rows = cache(
      new Map([
        ['ra2/ra2.mix', new Blob([new Uint8Array([1])])],
        ['yr/ra2md.mix', new Blob([new Uint8Array([2])])],
        ['custom-ra2/map.mpr', new Blob([new Uint8Array([3])])],
      ]),
    );
    await clearCachedImportedGameFiles(['ra2', 'yr']);
    expect([...rows.keys()]).toEqual(['custom-ra2/map.mpr']);
  });
});

it('reports transaction aborts and retains the previous executable with its resources', async () => {
  const rows = cache(new Map([['ra2/game.exe', new Uint8Array([9])]]), new DOMException('aborted', 'AbortError'), true);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await saveCachedGameFiles('ra2', new Map([['game.exe', new Uint8Array([1])]]));
  expect(rows.get('ra2/game.exe')).toEqual(new Uint8Array([9]));
  expect(warn).toHaveBeenCalledWith('[游戏文件] 持久化导入文件失败', expect.any(DOMException));
});
