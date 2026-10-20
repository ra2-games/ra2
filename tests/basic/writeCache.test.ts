import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionGameFileProvider } from '../../src/platform/browser/files/sessionFiles';
import { readGuestFileSearch } from '../../src/adapter/fileSearch';
import { IndexedDbWriteCache } from '../../src/platform/browser/files/writeCache';

/** Each get independently structured-clones its result, modeling IndexedDB read ownership rather than a shared-memory cache. */
function database(rows: Map<string, ArrayBuffer | Uint8Array>) {
  const returned: Array<ArrayBuffer | Uint8Array | undefined> = [];
  let failure: Error | null = null;
  const writes: Array<{ succeed(): void; commit(): void; abort(error?: Error): void; error(error: Error): void }> = [];
  vi.stubGlobal('indexedDB', {
    open() {
      const request: any = {
        result: {
          transaction() {
            const transaction: any = {
              objectStore() {
                return {
                  put(value: ArrayBuffer, key: string) {
                    const request: any = {};
                    writes.push({
                      succeed: () => request.onsuccess?.(),
                      commit: () => {
                        rows.set(key, structuredClone(value));
                        transaction.oncomplete?.();
                      },
                      abort: (error) => {
                        transaction.error = error ?? null;
                        transaction.onabort?.();
                      },
                      error: (error) => {
                        transaction.error = error;
                        transaction.onerror?.();
                      },
                    });
                    return request;
                  },
                  getAllKeys() {
                    const keys: any = {};
                    queueMicrotask(() => {
                      keys.result = [...rows.keys()];
                      keys.onsuccess();
                    });
                    return keys;
                  },
                  get(key: string) {
                    const read: any = {};
                    queueMicrotask(() => {
                      if (failure) {
                        read.error = failure;
                        read.onerror();
                        return;
                      }
                      read.result = structuredClone(rows.get(key));
                      returned.push(read.result);
                      read.onsuccess();
                    });
                    return read;
                  },
                };
              },
            };
            return transaction;
          },
        },
      };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  });
  return {
    returned,
    writes,
    fail(error: Error | null) {
      failure = error;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('写回缓存读取的独占缓冲', () => {
  it.each(['buffer', 'view'] as const)('%s 记录无需再次复制，修改和转移后不污染后续读取', async (format) => {
    const original = new Uint8Array([99, 1, 2, 3, 88]);
    const stored = format === 'view' ? original.subarray(1, 4) : original.slice(1, 4).buffer;
    const fake = database(new Map([['slot.sav', stored]]));
    const cache = new IndexedDbWriteCache();
    const first = (await cache.read('slot.sav'))!;
    expect([...first]).toEqual([1, 2, 3]);
    const result = fake.returned[0]!;
    expect(first.buffer).toBe(result instanceof Uint8Array ? result.buffer : result);
    if (result instanceof Uint8Array) expect(first.byteOffset).toBe(result.byteOffset);
    first[0] = 77;
    structuredClone(first, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);
    expect(await cache.read('slot.sav')).toEqual(new Uint8Array([1, 2, 3]));
    expect([...original]).toEqual([99, 1, 2, 3, 88]);
  });

  it('空文件、已知缺失、索引过期后的缺失与读取异常保持区别', async () => {
    const rows = new Map<string, ArrayBuffer | Uint8Array>([
      ['empty.sav', new ArrayBuffer(0)],
      ['removed.sav', new Uint8Array([1])],
    ]);
    const fake = database(rows);
    const cache = new IndexedDbWriteCache();
    expect(await cache.read('empty.sav')).toEqual(new Uint8Array());
    expect(await cache.read('missing.sav')).toBeNull();
    rows.delete('removed.sav');
    expect(await cache.read('removed.sav')).toBeNull();
    const error = new Error('读取失败');
    fake.fail(error);
    await expect(cache.read('empty.sav')).rejects.toBe(error);
    fake.fail(null);
    expect(await cache.read('empty.sav')).toEqual(new Uint8Array());
  });
});

describe('写回事务提交', () => {
  it('请求成功仍等待提交，提交后才更新索引并可恢复零字节文件', async () => {
    const rows = new Map<string, ArrayBuffer | Uint8Array>();
    const fake = database(rows);
    const cache = new IndexedDbWriteCache();
    await cache.keys();
    const saved = vi.fn();
    const writing = cache.write('empty.sav', new Uint8Array()).then(saved);
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    fake.writes[0]!.succeed();
    await Promise.resolve();
    expect(saved).not.toHaveBeenCalled();
    expect(cache.hasKnownKey('empty.sav')).toBe(false);
    fake.writes[0]!.commit();
    await writing;
    expect(saved).toHaveBeenCalledOnce();
    expect(cache.hasKnownKey('empty.sav')).toBe(true);
    expect(await new IndexedDbWriteCache().read('empty.sav')).toEqual(new Uint8Array());
  });

  it.each(['abort', 'error', 'abort-without-error'] as const)(
    '请求成功后 %s 必须拒绝，不能发布新文件',
    async (kind) => {
      const fake = database(new Map());
      const cache = new IndexedDbWriteCache();
      await cache.keys();
      const writing = cache.write('lost.sav', new Uint8Array([1]));
      const rejected = expect(writing).rejects.toThrow(kind === 'abort-without-error' ? '中止' : 'quota');
      await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
      fake.writes[0]!.succeed();
      if (kind === 'error') fake.writes[0]!.error(new Error('quota'));
      else fake.writes[0]!.abort(kind === 'abort' ? new Error('quota') : undefined);
      await rejected;
      expect(cache.hasKnownKey('lost.sav')).toBe(false);
      expect(await cache.read('lost.sav')).toBeNull();
    },
  );
});

describe('会话文件恢复契约', () => {
  it('完整/前缀/范围读取遵循同一优先级，保留空文件和嵌套目录枚举', async () => {
    database(
      new Map([
        ['save/slot.sav', new Uint8Array([1, 2, 3])],
        ['empty.sav', new Uint8Array()],
        ['overlap.sav', new Uint8Array([9])],
      ]),
    );
    const provider = new SessionGameFileProvider('恢复', new Map([['overlap.sav', new Uint8Array([4, 5])]]));
    for (const [path, expected] of [
      ['SAVE/SLOT.SAV', [1, 2, 3]],
      ['empty.sav', []],
      ['overlap.sav', [4, 5]],
    ] as const) {
      const bytes = new Uint8Array(expected);
      expect(await provider.read(path)).toEqual(bytes);
      expect(await provider.readPrefix(path, 1)).toEqual({ bytes: bytes.slice(0, 1), totalSize: bytes.length });
      expect(await provider.readRange(path, 1, 1)).toEqual(bytes.slice(1, 2));
      expect(provider.hasKnownFile(path)).toBe(true);
    }
    expect(await provider.list('')).toContain('save');
    expect(await readGuestFileSearch(provider, 'save/*.sav')).toEqual([{ path: 'save/slot.sav', size: 3 }]);
    expect(await provider.read('absent.sav')).toBeNull();
    expect(await provider.readPrefix('absent.sav', 1)).toBeNull();
    expect(await provider.readRange('absent.sav', 0, 1)).toBeNull();
  });

  it('持久化读取失败必须拒绝，不能转换为不存在', async () => {
    const fake = database(new Map([['slot.sav', new Uint8Array([1])]]));
    const provider = new SessionGameFileProvider('恢复', new Map());
    fake.fail(new Error('读取失败'));
    await expect(provider.read('slot.sav')).rejects.toThrow('读取失败');
    await expect(provider.readPrefix('slot.sav', 1)).rejects.toThrow('读取失败');
    await expect(provider.readRange('slot.sav', 0, 1)).rejects.toThrow('读取失败');
  });
});
