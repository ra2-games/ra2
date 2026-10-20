/**
 * Browser persistence for imported game files: once all required manifest entries are present, write the session's file set to IndexedDB (ra2-vm-game-files), restoring it automatically next time without another selection.
 *
 * Executables and data belong to the same imported file set; restore both without a separate download. If quota is insufficient, fall back to required startup files only; optional packages will still be missing next time.
 */

import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { normalizeGuestPath } from '../vm86/paths';

const DB_NAME = 'ra2-vm-game-files';
const STORE = 'files';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function keyOf(gameId: string, name: string): string {
  return `${gameId}/${name.toLowerCase()}`;
}

/** Persist add-on packages independently so reimporting the base game cannot erase them; surface failures instead of claiming a successful save. */
export async function saveCustomMapFiles(gameId: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await writeGameFiles(`custom-${gameId}`, files);
}

export async function loadCustomMapFiles(gameId: string): Promise<Map<string, Uint8Array>> {
  return (await loadCachedGameFiles(`custom-${gameId}`)) ?? new Map();
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || (error.name === 'UnknownError' && /quota|storage/i.test(error.message)))
  );
}

async function writeGameFiles(gameId: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    // Clear this game's old records first, then write each file, replacing the old set as a whole.
    await new Promise<void>((resolve, reject) => {
      const clear = store.delete(IDBKeyRange.bound(`${gameId}/`, `${gameId}/￿`));
      clear.onsuccess = () => resolve();
      clear.onerror = () => reject(clear.error);
    });
    for (const [name, bytes] of files) {
      // Empty files are part of the asset set: lightweight RA2 packages use zero-byte MIX files to indicate present but empty movie content.
      // Dropping one changes probing from present to ENOENT and may cause ExitProcess(0) after a refresh.
      // IndexedDB Blob records support partial reads; restoring movie packages must not copy the entire package into the JS heap first.
      store.put(new Blob([bytes as BlobPart]), keyOf(gameId, name));
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new DOMException('Resource cache transaction aborted', 'AbortError'));
    });
  } finally {
    database.close();
  }
}

/**
 * Save imported game files. If quota is insufficient and required filenames were supplied, fall back to saving only those files with a console notice. If that also fails, abandon persistence without affecting the current session.
 */
export async function saveCachedGameFiles(
  gameId: string,
  files: ReadonlyMap<string, Uint8Array>,
  requiredFiles: readonly string[] = [],
): Promise<void> {
  try {
    await writeGameFiles(gameId, files);
  } catch (error) {
    if (!isQuotaError(error)) {
      console.warn('[游戏文件] 持久化导入文件失败', error);
      return;
    }
    const required = new Map<string, Uint8Array>();
    for (const name of requiredFiles) {
      for (const [candidate, bytes] of files) {
        if (candidate.toLowerCase() === name.toLowerCase()) {
          required.set(candidate, bytes);
          break;
        }
      }
    }
    if (!required.size) {
      console.warn('[游戏文件] 存储配额不足：本次资源未缓存，保留原缓存；刷新后可能需要重新选择资源。', error);
      return;
    }
    try {
      await writeGameFiles(gameId, required);
      console.warn('[游戏文件] 存储配额不足：仅持久化必需文件');
    } catch (secondError) {
      console.warn('[游戏文件] 持久化导入文件失败', secondError);
    }
  }
}

/** Read a game's persisted files keyed by lowercase filename; return null if no records exist. */
export async function loadCachedGameFiles(gameId: string): Promise<Map<string, Uint8Array> | null> {
  const database = await openDatabase();
  try {
    const prefix = `${gameId}/`;
    const files = new Map<string, Uint8Array>();
    const blobs: Array<Promise<void>> = [];
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE)
        .objectStore(STORE)
        .openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const name = (cursor.key as string).slice(prefix.length);
        const bytes = cursor.value as Uint8Array | Blob;
        // Match save semantics: a record's existence cannot be inferred from the truthiness of its length.
        if (bytes instanceof Uint8Array) files.set(name, bytes);
        if (bytes instanceof Blob)
          blobs.push(
            bytes.arrayBuffer().then((buffer) => {
              files.set(name, new Uint8Array(buffer));
            }),
          );
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await Promise.all(blobs);
    return files.size ? files : null;
  } finally {
    database.close();
  }
}

/** Restore only the directory; fetch each Blob on its first content read. Support old Uint8Array records per file without requiring reimport. */
export async function restoreCachedFileProvider(gameId: string): Promise<CachedGameFileProvider | null> {
  const database = await openDatabase();
  try {
    const prefix = `${gameId}/`;
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = database
        .transaction(STORE)
        .objectStore(STORE)
        .getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = keys.map((key) => String(key).slice(prefix.length));
    return names.length ? new CachedGameFileProvider(gameId, names) : null;
  } finally {
    database.close();
  }
}

export class CachedGameFileProvider extends SessionGameFileProvider {
  private readonly names: Set<string>;
  private readonly blobs = new Map<string, Promise<Blob | null>>();
  constructor(
    private readonly gameId: string,
    names: string[],
  ) {
    super('本地缓存', new Map());
    this.names = new Set(names.map(normalizeGuestPath));
  }
  override hasKnownFile(path: string): boolean | null {
    return this.names.has(normalizeGuestPath(path)) || super.hasKnownFile(path);
  }
  private blob(path: string): Promise<Blob | null> {
    const name = normalizeGuestPath(path);
    if (!this.names.has(name)) return Promise.resolve(null);
    let pending = this.blobs.get(name);
    if (!pending) {
      pending = (async () => {
        const database = await openDatabase();
        try {
          return await new Promise<Blob | null>((resolve, reject) => {
            const request = database.transaction(STORE).objectStore(STORE).get(keyOf(this.gameId, name));
            request.onsuccess = () => {
              const value: unknown = request.result;
              resolve(
                value instanceof Blob ? value : value instanceof Uint8Array ? new Blob([value as BlobPart]) : null,
              );
            };
            request.onerror = () => reject(request.error);
          });
        } finally {
          database.close();
        }
      })();
      this.blobs.set(name, pending);
      // Retain only a small number of Blob handles; allow retries and do not permanently cache rejected Promises.
      if (this.blobs.size > 8) this.blobs.delete(this.blobs.keys().next().value!);
      void pending.catch(() => {
        if (this.blobs.get(name) === pending) this.blobs.delete(name);
      });
    }
    return pending;
  }
  override async read(path: string): Promise<Uint8Array | null> {
    if (this.files.has(normalizeGuestPath(path))) return super.read(path);
    const blob = await this.blob(path);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : super.read(path);
  }
  override async readPrefix(path: string, length: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    if (this.files.has(normalizeGuestPath(path))) return super.readPrefix(path, length);
    const blob = await this.blob(path);
    if (blob) return { bytes: new Uint8Array(await blob.slice(0, length).arrayBuffer()), totalSize: blob.size };
    const bytes = await super.read(path);
    return bytes ? { bytes: bytes.slice(0, length), totalSize: bytes.length } : null;
  }
  override async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    if (this.files.has(normalizeGuestPath(path))) return super.readRange(path, offset, length);
    const blob = await this.blob(path);
    return blob
      ? new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
      : ((await super.read(path))?.slice(offset, offset + length) ?? null);
  }
  override async list(directory: string): Promise<string[]> {
    const prefix = normalizeGuestPath(directory);
    const entries = new Set(await super.list(directory));
    for (const name of this.names) {
      if (prefix && !name.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? name.slice(prefix.length + 1) : name;
      if (rest) entries.add(rest.split('/')[0]!);
    }
    return [...entries];
  }
}

/** Clear all persisted file sets when switching sources so the picker appears instead of automatic restoration. */
export async function clearCachedGameFiles(): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** Drop imported packages without deleting independently persisted custom maps or save writeback. */
export async function clearCachedImportedGameFiles(gameIds: readonly string[]): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      for (const gameId of gameIds) {
        const prefix = `${gameId}/`;
        store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
