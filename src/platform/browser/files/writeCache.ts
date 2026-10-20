import { normalizeGuestPath } from '../../../vm86/paths';

/**
 * IndexedDB write cache: persistence for saves/writeback over read-only sources such as development servers and in-memory ZIP/installers. IndexedDB usually holds few saves, while RA2 probes thousands of MIX resource names during level loading. Cache the key set once to avoid an asynchronous IDB transaction for every missing resource.
 */
export class IndexedDbWriteCache {
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private persistedKeysPromise: Promise<Set<string>> | null = null;
  private persistedKeysSnapshot: Set<string> | null = null;
  private generation = 0;

  invalidate(): void {
    this.generation++;
    this.persistedKeysPromise = null;
    this.persistedKeysSnapshot = null;
  }

  /** Synchronous existence check; null until key enumeration finishes. Lets hasKnownFile reject missing files without awaiting. */
  hasKnownKey(path: string): boolean | null {
    if (!this.persistedKeysSnapshot) return null;
    return this.persistedKeysSnapshot.has(path);
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (!(await this.keys()).has(path)) return null;
    const database = await this.database();
    if (!database) return null;
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const request = database.transaction(DEVELOPMENT_FILE_STORE).objectStore(DEVELOPMENT_FILE_STORE).get(path);
      request.onsuccess = () => {
        const value = request.result as ArrayBuffer | Uint8Array | undefined;
        // get already obtains an exclusive copy through IndexedDB structured cloning; copying again doubles large-save memory
        // before handing it to the file port. Preserve view boundaries for legacy Uint8Array records.
        resolve(value === undefined ? null : value instanceof Uint8Array ? value : new Uint8Array(value));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const database = await this.database();
    if (!database) return;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DEVELOPMENT_FILE_STORE, 'readwrite');
      // Request success does not mean transaction commit; quota exhaustion or later abort must fail the save.
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new DOMException('保存事务已中止', 'AbortError'));
      transaction.onerror = () => reject(transaction.error ?? new Error('保存事务失败'));
      const request = transaction.objectStore(DEVELOPMENT_FILE_STORE).put(buffer, path);
      request.onerror = () => reject(request.error);
    });
    (await this.keys()).add(path);
  }

  keys(): Promise<Set<string>> {
    if (this.persistedKeysPromise) return this.persistedKeysPromise;
    const generation = this.generation;
    const request = (async () => {
      const database = await this.database();
      if (!database) return new Set<string>();
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database.transaction(DEVELOPMENT_FILE_STORE).objectStore(DEVELOPMENT_FILE_STORE).getAllKeys();
        request.onsuccess = () => resolve(request.result as IDBValidKey[]);
        request.onerror = () => reject(request.error);
      });
      return new Set(keys.map((key) => normalizeGuestPath(String(key))));
    })();
    this.persistedKeysPromise = request;
    void request.then(
      (keys) => {
        if (generation === this.generation) this.persistedKeysSnapshot = keys;
      },
      () => {},
    );
    return request;
  }

  private async database(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    this.databasePromise ??= openDevelopmentDatabase();
    return this.databasePromise;
  }
}

const DEVELOPMENT_FILE_DB = 'ra2-vm-development-files';
const DEVELOPMENT_FILE_STORE = 'files';

function openDevelopmentDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVELOPMENT_FILE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DEVELOPMENT_FILE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
