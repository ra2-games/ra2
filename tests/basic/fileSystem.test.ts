/**
 * Independent file-layer loopback tests (migrated from fileSystemSmoke).
 *
 * Without starting v86 or clicking any level, verify only:
 * 1. Win32Shim handles, offsets, and small reads/writes;
 * 2. File System Access backend serialized writes and immediate read-after-write;
 * 3. /game development backend IndexedDB persistence across instances;
 * 4. Mutual exclusion between VirtualAlloc reservations and the heap arena.
 *
 * This helps establish that file bytes survive the browser/Win32 boundary when map loading fails.
 */
import { describe, expect, it } from 'vitest';
import { DirectoryGameFileProvider } from '../../src/platform/browser/files/directory';
import { HttpGameFileProvider } from '../../src/platform/browser/files/http';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { ScopedGameFileProvider } from '../../src/resources/providers/scoped';
import { listSavePaths } from '../../src/adapter/saveTransfer';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

function expectBytes(actual: Uint8Array | null, expected: Uint8Array, label: string): void {
  expect(actual, `${label}: 应读到文件`).toBeTruthy();
  expect(actual ? [...actual] : null, `${label}: 文件字节不一致`).toEqual([...expected]);
}

/*
 * IndexedDB fake: implements only the open/create/get/put/getAllKeys operations used by HttpGameFileProvider.
 * Each script run gets a fresh database; providers using the same database name share a store.
 */

type FakeRequest<T = unknown> = {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
};

type FakeDatabase = {
  stores: Map<string, Map<string, ArrayBuffer>>;
  createObjectStore(name: string): void;
  transaction(
    name: string,
    mode?: 'readonly' | 'readwrite',
  ): {
    oncomplete?: () => void;
    objectStore(storeName: string): {
      get(key: string): FakeRequest<ArrayBuffer | undefined>;
      put(value: ArrayBuffer, key: string): FakeRequest<void>;
      getAllKeys(): FakeRequest<IDBValidKey[]>;
    };
  };
};

function asyncRequest<T>(result: T): FakeRequest<T> {
  return { result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
}

function installFakeIndexedDb(): { getCalls: number; getAllKeysCalls: number } {
  const metrics = { getCalls: 0, getAllKeysCalls: 0 };
  const databases = new Map<string, FakeDatabase>();
  const fakeIndexedDb = {
    open(name: string): FakeRequest<FakeDatabase> {
      const existing = databases.get(name);
      const database = existing ?? createFakeDatabase(metrics);
      if (!existing) databases.set(name, database);
      const request = asyncRequest(database);
      queueMicrotask(() => {
        if (!existing) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  // The DOM lib types globalThis.indexedDB as IDBFactory; this fake only implements open, so cast through unknown for the intersection type.
  (globalThis as unknown as { indexedDB: typeof fakeIndexedDb }).indexedDB = fakeIndexedDb;
  return metrics;
}

function createFakeDatabase(metrics: { getCalls: number; getAllKeysCalls: number }): FakeDatabase {
  const stores = new Map<string, Map<string, ArrayBuffer>>();
  return {
    stores,
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    transaction(name) {
      const store = stores.get(name);
      if (!store) throw new Error(`Fake IndexedDB store missing: ${name}`);
      const transaction: ReturnType<FakeDatabase['transaction']> = {
        objectStore() {
          return {
            get(key: string) {
              metrics.getCalls++;
              // IndexedDB get also performs structured cloning; do not expose the store's buffer directly,
              // or tests would mistake mutations/transfers of exclusively owned read results for database corruption.
              const request = asyncRequest(structuredClone(store.get(key)));
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
            put(value: ArrayBuffer, key: string) {
              const request = asyncRequest(undefined);
              // IndexedDB structured-clones ArrayBuffer values.  Do the same so
              // mutating the caller's Uint8Array cannot mutate the stored copy.
              const copy = value.slice(0);
              queueMicrotask(() => {
                request.onsuccess?.();
                queueMicrotask(() => {
                  store.set(key, copy);
                  transaction.oncomplete?.();
                });
              });
              return request;
            },
            getAllKeys() {
              metrics.getAllKeysCalls++;
              const request = asyncRequest([...store.keys()]);
              queueMicrotask(() => request.onsuccess?.());
              return request;
            },
          };
        },
      };
      return transaction;
    },
  };
}

describe('HttpGameFileProvider（IndexedDB 持久化）', () => {
  it('写后同实例读、flush 后跨实例读、缺失回退 HTTP、list 合并 IndexedDB 键', async () => {
    const idb = installFakeIndexedDb();
    const path = `Save/fs-smoke-${process.pid}.sav`;
    const first = new HttpGameFileProvider();
    const source = Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff);
    await first.write(path, source);
    source[0] = 0;
    expectBytes(
      await first.read(path),
      Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff),
      'Http 同实例',
    );
    await first.flush();

    // A new provider has no in-memory map.  This is the persistence boundary
    // that a browser reload exercises.
    const second = new HttpGameFileProvider();
    const persisted = await second.read(`save/FS-SMOKE-${process.pid}.SAV`);
    expectBytes(
      persisted,
      Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff),
      'Http 跨实例 IndexedDB',
    );
    if (persisted) persisted[1] = 0;
    expect((await second.read(path))?.[1], '读取结果必须是独立副本').toBe((1 * 37 + 11) & 0xff);
    if (persisted) {
      structuredClone(persisted, { transfer: [persisted.buffer] });
      expect(persisted.byteLength).toBe(0);
    }
    expectBytes(
      await second.read(path),
      Uint8Array.from({ length: 4097 }, (_, index) => (index * 37 + 11) & 0xff),
      '跨实例读结果 transfer 后不能损坏持久化记录',
    );

    // Missing development files still fall through to HTTP rather than being
    // reported as an empty persisted file.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('dir=gone')) return new Response(null, { status: 404 });
      return url.startsWith('/game/.list')
        ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 404 });
    };
    try {
      expect(await second.read(`missing/fs-smoke-${process.pid}.dat`)).toBe(null);
      // Saves go only to IndexedDB, not disk. list must merge IndexedDB keys, or the development build's
      // save export (listSavePaths enumeration) will omit the player's actual in-game saves.
      expect(await second.list('save')).toEqual([`fs-smoke-${process.pid}.sav`]);
      expect(await second.list('other')).toEqual([]);
      expect(await second.list('')).toEqual([]);
      expect(second.hasKnownFile(path)).toBe(true);
      expect(second.hasKnownFile(`missing/material-indexed.shp`)).toBe(false);
      expect(await second.read('gone/material.shp')).toBe(null);
      expect(second.hasKnownFile('gone/another.shp')).toBe(false);
      // Each provider enumerates persistent keys only once; missing assets inside MIX files should not each trigger a get.
      const getsBeforeMisses = idb.getCalls;
      await Promise.all(Array.from({ length: 100 }, (_, index) => second.read(`missing/material-${index}.shp`)));
      expect(idb.getCalls).toBe(getsBeforeMisses);
      // first and second each build one index, reused by repeated read/list calls.
      expect(idb.getAllKeysCalls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('跨 Provider 写入后，存档枚举会刷新 IndexedDB key 缓存', async () => {
    installFakeIndexedDb();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      return url.startsWith('/game/.list')
        ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(null, { status: 404 });
    };
    try {
      const main = new HttpGameFileProvider();
      const worker = new HttpGameFileProvider();
      expect(await listSavePaths(main)).toEqual([]);

      await worker.write('save/cross-provider.sav', new Uint8Array([4, 5, 6]));
      await worker.flush();

      expect(await listSavePaths(main)).toEqual(['save/cross-provider.sav']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('存档枚举会刷新动态目录清单缓存', async () => {
    installFakeIndexedDb();
    let fresh = false;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (!url.startsWith('/game/.list')) return new Response(null, { status: 404 });
      if (url.includes('dir=save')) {
        return new Response(fresh ? '["fresh.sav"]' : '[]', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('["save"]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const provider = new HttpGameFileProvider();
      expect(await listSavePaths(provider)).toEqual([]);
      fresh = true;
      expect(await listSavePaths(provider)).toEqual(['save/fresh.sav']);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

/* ------------------------------------------------------------------------- *
 * File System Access fake.  The writable deliberately pauses so that read()
 * can be checked while close() is still pending.
 * ------------------------------------------------------------------------- */

class FakeDirectory {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeDirectory | FakeFile>();
  entriesCalls = 0;

  constructor(readonly name: string) {}

  async *entries(): AsyncIterableIterator<[string, FakeDirectory | FakeFile]> {
    this.entriesCalls++;
    yield* this.children;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FakeDirectory(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    const existing = this.children.get(name);
    if (existing instanceof FakeFile) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FakeFile(name);
    this.children.set(name, created);
    return created;
  }
}

class FakeFile {
  readonly kind = 'file' as const;
  bytes = new Uint8Array();
  writeStarted: Promise<void> | null = null;
  private releaseWrite: (() => void) | null = null;

  constructor(readonly name: string) {}

  async getFile(): Promise<Blob> {
    return new Blob([this.bytes]);
  }

  async createWritable(): Promise<{
    write(data: ArrayBuffer): Promise<void>;
    close(): Promise<void>;
  }> {
    let started!: () => void;
    this.writeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releaseWrite = release;
    return {
      write: async (data) => {
        started();
        await gate;
        this.bytes = new Uint8Array(data.slice(0));
      },
      close: async () => {},
    };
  }

  release(): void {
    this.releaseWrite?.();
    this.releaseWrite = null;
  }
}

class FailingDirectory extends FakeDirectory {
  override async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectory) return existing;
    if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
    const created = new FailingDirectory(name);
    this.children.set(name, created);
    return created;
  }

  override async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFile> {
    if (options?.create && name.toLowerCase() === 'fail.sav') throw new Error('simulated disk failure');
    return super.getFileHandle(name, options);
  }
}

describe('DirectoryGameFileProvider（File System Access）', () => {
  it('写后立即读见快照、flush 等待 close、目录索引缓存、跨实例读、外部覆盖后读新内容', async () => {
    const root = new FakeDirectory('RA2');
    const provider = new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle);
    const bytes = Uint8Array.from({ length: 1025 }, (_, index) => index & 0xff);
    const pending = provider.write('Save/Delayed.SAV', bytes);
    for (let attempt = 0; attempt < 20 && !root.children.has('save'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const saveDirectory = root.children.get('save');
    expect(saveDirectory instanceof FakeDirectory, 'write 应创建 Save 目录').toBe(true);
    const file = (saveDirectory as FakeDirectory).children.get('delayed.sav');
    expect(file instanceof FakeFile, 'write 应创建存档文件').toBe(true);
    const fakeFile = file as FakeFile;
    await fakeFile.writeStarted;

    // The host write is intentionally blocked.  A load in this interval must
    // see the immutable snapshot instead of waiting behind FileSystemAccess.
    expectBytes(await provider.read('save/delayed.sav'), bytes, 'Directory 写后立即读');
    let flushed = false;
    const flush = provider.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed, 'flush 必须等待底层 close 完成').toBe(false);
    fakeFile.release();
    await pending;
    await flush;
    expect(flushed).toBe(true);
    expect(root.entriesCalls, '同一 provider 的根目录索引应缓存').toBe(1);
    const freshProvider = new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle);
    expectBytes(await freshProvider.read('SAVE/DELAYED.SAV'), bytes, 'Directory 跨实例');
    expect(root.entriesCalls, '新 provider 应重新建立自己的目录索引').toBe(2);
    // Discard the snapshot once persistence finishes: if Windows overwrites a save in the same page session, the next read
    // must see the new content. The old behavior always returned the VM's own snapshot, causing incorrect game state after loading.
    fakeFile.bytes = Uint8Array.from([0xaa, 0xbb]);
    expectBytes(await provider.read('SAVE/DELAYED.SAV'), fakeFile.bytes, 'Directory 外部覆盖后读');
  });

  it('失败写入不留永久脏快照、不毒化后续存档队列', async () => {
    // A failed write must not leave a permanent stale read snapshot and must not
    // poison the queue for a later save.
    const failingRoot = new FailingDirectory('FAIL');
    const failingProvider = new DirectoryGameFileProvider(failingRoot as unknown as FileSystemDirectoryHandle);
    await expect(failingProvider.write('Save/fail.sav', new Uint8Array([1]))).rejects.toThrow();
    expect(await failingProvider.read('Save/fail.sav')).toBe(null);
    const okay = failingProvider.write('Save/ok.sav', new Uint8Array([2]));
    for (let attempt = 0; attempt < 20 && !failingRoot.children.has('save'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const okayDirectory = failingRoot.children.get('save');
    expect(okayDirectory instanceof FakeDirectory).toBe(true);
    for (let attempt = 0; attempt < 20 && !(okayDirectory as FakeDirectory).children.has('ok.sav'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const okayFile = (okayDirectory as FakeDirectory).children.get('ok.sav');
    expect(okayFile instanceof FakeFile).toBe(true);
    const fakeOkayFile = okayFile as FakeFile;
    await fakeOkayFile.writeStarted;
    fakeOkayFile.release();
    await okay;

    expectBytes(await failingProvider.read('Save/ok.sav'), new Uint8Array([2]), '失败后队列继续');
  });

  it('跨 Provider 写入后，scoped 存档枚举会刷新目录索引', async () => {
    const root = new FakeDirectory('INSTALL');
    root.children.set('ra2', new FakeDirectory('ra2'));
    const main = new ScopedGameFileProvider(
      new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle),
      'ra2',
    );
    const worker = new ScopedGameFileProvider(
      new DirectoryGameFileProvider(root as unknown as FileSystemDirectoryHandle),
      'ra2',
    );

    expect(await main.list('save')).toBe(null);
    const pending = worker.write('save/cross-provider.sav', new Uint8Array([7, 8, 9]));
    const gameRoot = root.children.get('ra2');
    for (let attempt = 0; attempt < 20 && !(gameRoot as FakeDirectory).children.has('save'); attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const saveDirectory = (gameRoot as FakeDirectory).children.get('save');
    expect(saveDirectory instanceof FakeDirectory).toBe(true);
    for (
      let attempt = 0;
      attempt < 20 && !(saveDirectory as FakeDirectory).children.has('cross-provider.sav');
      attempt++
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const file = (saveDirectory as FakeDirectory).children.get('cross-provider.sav');
    expect(file instanceof FakeFile).toBe(true);
    await (file as FakeFile).writeStarted;
    (file as FakeFile).release();
    await pending;
    await worker.flush();

    expect(await listSavePaths(main)).toEqual(['save/cross-provider.sav']);
  });
});

/* ------------------------------------------------------------------------- *
 * Win32 file handles: use real stage-shaped bytes and read them in the same
 * 16-byte pattern seen in the slow trace.  No v86 or game screen is involved.
 * ------------------------------------------------------------------------- */

describe('Win32 文件句柄（_lopen/_lread/_llseek/_lwrite）', () => {
  const pathPtr = 0x1000;
  const bufferPtr = 0x4000;

  it('16 字节小块顺序读全文件、EOF 归 0；独立句柄独立偏移、负 seek 不越文件头', () => {
    const memory = createGuestMemory(32 * 1024 * 1024);
    const shim = createTestShim(memory);
    const dispatch = (key: string, args: number[]): number => callShim(shim, key, args).eax >>> 0;
    const source = Uint8Array.from({ length: 96 * 1024 + 37 }, (_, index) => (index * 13 + 5) & 0xff);
    const original = source.slice();
    shim.mountFile('stage11.stg', source);
    source[0] = 0;
    source[source.length - 1] = 0;
    writeAsciiZ(memory, pathPtr, 'C:\\STAGE11.STG');
    const handle = dispatch('KERNEL32.DLL!_lopen', [pathPtr, 0]);
    expect(handle, '_lopen 应找到挂载文件').not.toBe(0xffff_ffff);

    const actual = new Uint8Array(original.length);
    let offset = 0;
    while (offset < actual.length) {
      const requested = Math.min(16, actual.length - offset);
      const count = dispatch('KERNEL32.DLL!_lread', [handle, bufferPtr, requested]);
      expect(count, `_lread 16-byte chunk at ${offset}`).toBe(requested);
      actual.set(memory.read_memory(bufferPtr, count), offset);
      offset += count;
    }
    expect([...actual], 'Win32 小块读出的文件内容必须逐字节一致').toEqual([...original]);
    expect(dispatch('KERNEL32.DLL!_lread', [handle, bufferPtr, 16]), 'EOF 应返回 0').toBe(0);
    expect(dispatch('KERNEL32.DLL!_lclose', [handle])).toBe(0);

    // Independent handles must have independent positions; seek must accept a
    // signed 32-bit offset and SetFilePointer must publish the high dword.
    const second = dispatch('KERNEL32.DLL!_lopen', [pathPtr, 0]);
    expect(dispatch('KERNEL32.DLL!_llseek', [second, 0x8000_0000, 0]), '负 seek 不应越过文件头').toBe(0xffff_ffff);
    expect(dispatch('KERNEL32.DLL!_llseek', [second, 1234, 0])).toBe(1234);
    expect(dispatch('KERNEL32.DLL!_lread', [second, bufferPtr, 16])).toBe(16);
    expect([...memory.read_memory(bufferPtr, 16)]).toEqual([...original.subarray(1234, 1250)]);
    expect(dispatch('KERNEL32.DLL!_lclose', [second])).toBe(0);
  });

  it('_lcreat 小块写关闭时一次落盘；重挂载读回；OF_WRITE 原地重写后可读', () => {
    const memory = createGuestMemory(32 * 1024 * 1024);
    const createPathPtr = 0x2000;
    writeAsciiZ(memory, createPathPtr, 'Save\\fs-smoke.sav');
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const writer = createTestShim(memory, { onFileWrite: (path, value) => writes.push({ path, bytes: value }) });
    const create = (key: string, args: number[]): number => callShim(writer, key, args).eax >>> 0;
    const saveHandle = create('KERNEL32.DLL!_lcreat', [createPathPtr, 0]);
    for (let index = 0; index < 4096; index++) {
      memory.bytes[bufferPtr] = index & 0xff;
      expect(create('KERNEL32.DLL!_lwrite', [saveHandle, bufferPtr, 1])).toBe(1);
    }
    expect(writes.length, '小块写期间不应反复落盘').toBe(0);
    expect(create('KERNEL32.DLL!_lclose', [saveHandle])).toBe(0);
    expect(writes.length).toBe(1);
    expect(writes[0]!.bytes.length).toBe(4096);
    expect(writes[0]!.path).toBe('save/fs-smoke.sav');
    expect([...writes[0]!.bytes.subarray(0, 4)]).toEqual([0, 1, 2, 3]);

    // A second shim is the load half of save -> reload.
    const loaded = createGuestMemory(32 * 1024 * 1024);
    const loadedShim = createTestShim(loaded);
    loadedShim.mountFile(writes[0]!.path, writes[0]!.bytes);
    writeAsciiZ(loaded, pathPtr, 'SAVE\\FS-SMOKE.SAV');
    const loadedHandle = callShim(loadedShim, 'KERNEL32.DLL!_lopen', [pathPtr, 0]).eax >>> 0;
    expect(callShim(loadedShim, 'KERNEL32.DLL!_lread', [loadedHandle, bufferPtr, 4096]).eax).toBe(4096);
    expect([...loaded.read_memory(bufferPtr, 4096)]).toEqual([...writes[0]!.bytes]);
    expect(callShim(loadedShim, 'KERNEL32.DLL!_lclose', [loadedHandle]).eax).toBe(0);

    // The original save flow uses _lopen(path, OF_WRITE) to rewrite label.sav/record.sav in place.
    // Ignoring the writable flag makes _lwrite fail silently, leaving new saves missing or mismatched in the load screen.
    writeAsciiZ(memory, createPathPtr, 'Label.sav');
    writer.mountFile('label.sav', new Uint8Array(324));
    const labelHandle = create('KERNEL32.DLL!_lopen', [createPathPtr, 1]);
    expect(labelHandle, '_lopen OF_WRITE 应打开已挂载文件').not.toBe(0xffff_ffff);
    for (let index = 0; index < 324; index++) {
      memory.bytes[bufferPtr] = (index * 7 + 3) & 0xff;
      expect(
        create('KERNEL32.DLL!_lwrite', [labelHandle, bufferPtr, 1]),
        `OF_WRITE 句柄 _lwrite@${index} 不应被拒绝`,
      ).toBe(1);
    }
    expect(create('KERNEL32.DLL!_lclose', [labelHandle])).toBe(0);
    expect(writes.length, 'OF_WRITE 句柄关闭后应 flush 新内容').toBe(2);
    expect(writes[1]!.path).toBe('label.sav');
    expect(writes[1]!.bytes.length).toBe(324);
    expect([...writes[1]!.bytes.subarray(0, 4)]).toEqual([3, 10, 17, 24]);

    // Load path: read-only _lopen must see the content just written.
    const labelReadHandle = create('KERNEL32.DLL!_lopen', [createPathPtr, 0]);
    expect(create('KERNEL32.DLL!_lread', [labelReadHandle, bufferPtr, 324])).toBe(324);
    expect(memory.bytes[bufferPtr]).toBe(3);
    expect(memory.bytes[bufferPtr + 1]).toBe(10);
    expect(create('KERNEL32.DLL!_lclose', [labelReadHandle])).toBe(0);
  });
});

/**
 * VirtualAlloc reservation/heap exclusion loopback: the original VC6 CRT starts with VirtualAlloc(NULL, 1MB, MEM_RESERVE), then COMMITs/DECOMMITs successive 32 KB blocks.
 * Reserved regions must never enter the heap free list, or file mirrors/HeapAlloc will reuse blocks still used by the game (historically causing CPU #6 at EIP=0x8f).
 * Set virtualTop to 8 MB so the heap must cross the reservation, verifying the skip barrier.
 *
 * The original script used Win32Shim's default arena top, 0x7e00000. createTestShim narrows heapTop to 0xc00000 by default, putting the fixed-address 0xc00000 and 5 MB bump assertions out of range. Explicitly restore the original default here.
 */
describe('VirtualAlloc 保留区与堆互斥', () => {
  const ARENA_TOP = 0x07e0_0000;
  const VIRTUAL_TOP = 0x0080_0000;

  it('reserve/commit/decommit/跳越屏障/释放链表复用全流程', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory, { heapTop: ARENA_TOP, virtualTop: VIRTUAL_TOP });
    const dispatch = (key: string, args: number[]): number => callShim(shim, key, args).eax >>> 0;

    // 1. Reserve 1 MB with NULL.
    const region = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(
      region >= 0x0050_0000 && region < 0x0080_0000,
      `NULL 保留应落在堆上方: 0x${region.toString(16)}`,
    ).toBeTruthy();

    // 2. Commit blocks within the reservation (the game derives commit addresses from the returned base).
    const commitA = dispatch('KERNEL32.DLL!VirtualAlloc', [region + 0x130, 0x8000]);
    expect(commitA, '保留区内提交应返回请求地址').toBe(region + 0x130);
    const commitB = dispatch('KERNEL32.DLL!VirtualAlloc', [region + 0x8130, 0x8000]);
    expect(commitB, '第二个提交块应在同一保留区').toBe(region + 0x8130);

    // 3. DECOMMIT preserves the reservation: the region remains, and the same address can be committed again.
    expect(dispatch('KERNEL32.DLL!VirtualFree', [commitA, 0x8000, 0x4000]), 'DECOMMIT 应成功').toBe(1);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [commitA, 0x8000]), 'DECOMMIT 后应能重新提交同一地址').toBe(commitA);

    // 4. Grow the heap beyond the reservation's address; it must still skip the reserved region.
    const live: number[] = [];
    for (let round = 0; round < 200; round++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x4000 + (round % 8) * 16]);
      expect(ptr, `HeapAlloc 第 ${round} 轮应成功`).toBeTruthy();
      expect(ptr < region || ptr >= region + 0x100000, `HeapAlloc 0x${ptr.toString(16)} 侵入保留区`).toBeTruthy();
      live.push(ptr);
      if (live.length > 5) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, live.shift()!])).toBe(1);
    }
    for (const ptr of live) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);

    // 5. Reject VirtualAlloc overlapping active heap allocations instead of silently aliasing them.
    const heapPtr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [heapPtr, 0x1000]), '重叠的 VirtualAlloc 应拒绝').toBe(0);

    // 6. MEM_RELEASE frees the entire reservation.
    expect(dispatch('KERNEL32.DLL!VirtualFree', [region, 0, 0x8000]), 'MEM_RELEASE 应成功').toBe(1);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [commitB, 0x8000, 0x4000]), '释放后区内 DECOMMIT 应失败').toBe(0);
    expect(shim.inspectHeapState().virtualRegions, '释放后不应有残留保留区').toBe(0);

    // 7. A reservation overlapping free heap blocks must remove those blocks so the heap cannot reuse that range.
    const freed: number[] = [];
    for (let i = 0; i < 8; i++) freed.push(dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]));
    for (const ptr of freed) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [freed[0]!, 0x2000]), '空闲块上的保留应成功').toBe(freed[0]);
    for (let i = 0; i < 8; i++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
      expect(
        ptr < freed[0]! || ptr >= freed[0]! + 0x2000,
        `HeapAlloc 0x${ptr.toString(16)} 复用被保留的空闲块`,
      ).toBeTruthy();
    }

    // 8. MEM_RELEASE returns the region to VirtualAlloc's dedicated release list (wemu try_free model),
    // never the heap free list: HeapAlloc cannot obtain it, and later NULL reservations reuse it from high to low.
    const virtualFreeBefore = shim.inspectHeapState().virtualFreeBytes;
    expect(dispatch('KERNEL32.DLL!VirtualFree', [freed[0]!, 0, 0x8000]), 'MEM_RELEASE 应成功').toBe(1);
    expect(shim.inspectHeapState().virtualFreeBytes, '释放后应计入虚拟释放字节').toBe(virtualFreeBefore + 0x2000);
    const heapAfterRelease = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x2000]);
    expect(heapAfterRelease, 'HeapAlloc 不得复用已释放的保留区').not.toBe(freed[0]);
    expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, heapAfterRelease])).toBe(1);
    // The 8 KB heap-derived range is not allocation-granularity aligned. A NULL
    // reservation uses the highest aligned range in the released 1 MB block instead.
    const reuseHigh = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x2000]);
    expect(reuseHigh % 0x10000).toBe(0);
    expect(reuseHigh).toBe(Math.floor((region + 0x100000 - 0x2000) / 0x10000) * 0x10000);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [reuseHigh, 0, 0x8000]), '复用区再次释放应成功').toBe(1);
    // Both sides of an aligned carve must survive, allowing the original region to coalesce.
    const reuseBig = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(reuseBig, '1MB 块应留给大保留复用').toBe(region);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [reuseBig, 0, 0x8000]), '1MB 复用区再次释放应成功').toBe(1);

    // 9. Fixed addresses outside reservations create regions at the requested base within arena bounds (wemu alloc_at);
    // reject addresses outside the arena. DECOMMIT preserves the reservation and zero-fills; RELEASE allows whole-region reuse.
    const fixed = 0x00c0_0000;
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [fixed, 0x2000]), '界内固定地址应新建保留区').toBe(fixed);
    memory.write_memory(new Uint8Array([0xab, 0xcd]), fixed);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [fixed, 0x2000, 0x4000]), '固定区 DECOMMIT 应成功').toBe(1);
    expect(memory.read_memory(fixed, 2)[0], 'DECOMMIT 后内容应清零').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [fixed, 0x2000]), 'DECOMMIT 后应能重新提交').toBe(fixed);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [0x1000, 0x1000]), '低于堆下界的固定地址应拒绝').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualAlloc', [0x07f0_0000, 0x2000]), '越过堆上界的固定地址应拒绝').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [fixed, 0x2000, 0]), '既非 RELEASE 也非 DECOMMIT 的类型应拒绝').toBe(0);
    expect(dispatch('KERNEL32.DLL!VirtualFree', [fixed, 0, 0x8000]), '固定区 MEM_RELEASE 应成功').toBe(1);

    // 10. When a released region is available, NULL reservations should prefer reusing it whole (the 1 MB blocks from steps 6/8
    // have coalesced again; with virtualTop=8 MB, a 1 MB reservation should be exactly 0x700000).
    const fill: number[] = [];
    for (let i = 0; i < 12; i++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x40000]);
      expect(ptr, `堆填充第 ${i} 块应成功`).toBeTruthy();
      fill.push(ptr);
    }
    for (const ptr of fill) expect(dispatch('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);
    const topRegion = dispatch('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(topRegion, `NULL 保留应复用 0x700000 释放区，实得 0x${topRegion.toString(16)}`).toBe(0x0070_0000);
    for (let i = 0; i < 16; i++) {
      const ptr = dispatch('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
      expect(
        ptr < topRegion || ptr >= topRegion + 0x100000,
        `HeapAlloc 0x${ptr.toString(16)} 复用落在空闲块上的保留区`,
      ).toBeTruthy();
    }
  });

  it('堆 bump 驶入 nextHeap 之上的已释放区域时必须同步剔除', () => {
    // wemu avoids this through separate arenas; in a shared address space, bump allocation immediately removes its range from the release list.
    const shim2 = createTestShim(createGuestMemory(), { heapTop: ARENA_TOP, virtualTop: VIRTUAL_TOP });
    const dispatch2 = (key: string, args: number[]): number => callShim(shim2, key, args).eax >>> 0;
    const top = dispatch2('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(dispatch2('KERNEL32.DLL!VirtualFree', [top, 0, 0x8000]), 'MEM_RELEASE 应成功').toBe(1);
    const big = dispatch2('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x500000]);
    expect(big, `大块应自 0x700000 前进分配，实得 0x${big.toString(16)}`).toBe(0x0070_0000);
    expect(shim2.inspectHeapState().virtualFreeBytes, 'bump 驶入的释放区必须从链表剔除').toBe(0);
    // After the 5 MB bump consumes 0x700000, a top-down 1 MB reservation lands in the free band at 0x600000.
    const again = dispatch2('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(again, '被 bump 吃掉的释放区不得再发给 VirtualAlloc').toBe(0x0060_0000);
    expect(dispatch2('KERNEL32.DLL!VirtualFree', [again, 0, 0x8000]), '0x600000 复用区释放应成功').toBe(1);
  });

  it('无释放区可复用时 NULL 保留必须剔除堆空闲链表重叠（trimFreeBlocks 回归）', () => {
    // Regression for a historically missing trimFreeBlocks call: fill and free 3 MB of heap, then reserve 1 MB over
    // a free block. Later HeapAlloc calls must not reuse the reserved range.
    const shim3 = createTestShim(createGuestMemory(), { heapTop: ARENA_TOP, virtualTop: VIRTUAL_TOP });
    const dispatch3 = (key: string, args: number[]): number => callShim(shim3, key, args).eax >>> 0;
    const fill3: number[] = [];
    for (let i = 0; i < 12; i++) fill3.push(dispatch3('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x40000]));
    for (const ptr of fill3) expect(dispatch3('KERNEL32.DLL!HeapFree', [0x10001, 0, ptr])).toBe(1);
    const reserve3 = dispatch3('KERNEL32.DLL!VirtualAlloc', [0, 0x100000]);
    expect(reserve3, `NULL 保留应落在自顶向下的 0x700000，实得 0x${reserve3.toString(16)}`).toBe(0x0070_0000);
    for (let i = 0; i < 16; i++) {
      const ptr = dispatch3('KERNEL32.DLL!HeapAlloc', [0x10001, 0, 0x1000]);
      expect(
        ptr < reserve3 || ptr >= reserve3 + 0x100000,
        `HeapAlloc 0x${ptr.toString(16)} 复用落在空闲块上的保留区`,
      ).toBeTruthy();
    }
  });

  it('ExitProcess 落在 KERNEL32 路由并携带退出码', () => {
    // Exit-family APIs must route through KERNEL32 (a DLL split once misrouted them to DirectX dispatch, making them unreachable).
    // The original script reused the shim above; routing assertions are independent of heap state, so use a separate shim here.
    const shim = createTestShim(createGuestMemory());
    const exitResult = callShim(shim, 'KERNEL32.DLL!ExitProcess', [7]);
    expect(exitResult.exit, 'ExitProcess 应走 KERNEL32 路由并携带退出码').toBeTruthy();
    expect(exitResult.eax, 'ExitProcess 应走 KERNEL32 路由并携带退出码').toBe(7);
  });
});

describe('MemoryGameFileProvider 控制组', () => {
  it('路径归一化与副本语义与持久化实现一致', async () => {
    // Memory provider is a control: path normalization/copy semantics should
    // match the persistent implementations.
    const memory = new MemoryGameFileProvider();
    const bytes = new Uint8Array([3, 1, 4, 1, 5]);
    await memory.write('Save\\control.sav', bytes);
    bytes[0] = 0;
    expectBytes(await memory.read('save/CONTROL.SAV'), new Uint8Array([3, 1, 4, 1, 5]), 'Memory 控制组');
  });
});
