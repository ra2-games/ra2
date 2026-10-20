import { normalizeWindowsPath } from '../../../utils/windowsPath';
import { SessionGameFileProvider } from './sessionFiles';

export interface ImportedResourceGroup {
  label: string;
  files: ReadonlyMap<string, Uint8Array | Blob>;
}
export type ImportedResources = Record<string, ImportedResourceGroup>;
const DATABASE = 'ra2-vm-imported-resources';
const STORE = 'snapshots';

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Resource cache database is blocked'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

/** Publish all import layers in one transaction; a failed write retains the previous snapshot. */
export async function saveImportedResources(groups: ImportedResources): Promise<void> {
  const snapshot: ImportedResources = {};
  for (const [key, group] of Object.entries(groups)) {
    snapshot[key] = {
      label: group.label,
      files: new Map(
        [...group.files].map(([path, bytes]) => [
          normalizeWindowsPath(path),
          bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]),
        ]),
      ),
    };
  }
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Resource cache transaction aborted'));
      transaction.objectStore(STORE).put(snapshot, 'current');
    });
  } finally {
    db.close();
  }
}

/** Blob handles keep large archives out of the JS heap until their contents are requested. */
export async function loadImportedResources(): Promise<ImportedResources | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE);
      const request = transaction.objectStore(STORE).get('current');
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Resource cache transaction aborted'));
    });
  } finally {
    db.close();
  }
}

/** An empty committed snapshot also prevents stale legacy imports from being restored. */
export function clearImportedResources(): Promise<void> {
  return saveImportedResources({});
}

export class ImportedResourceFileProvider extends SessionGameFileProvider {
  constructor(readonly imported: ImportedResourceGroup) {
    super(imported.label, new Map());
  }
  override hasKnownFile(path: string): boolean | null {
    return this.imported.files.has(normalizeWindowsPath(path)) || super.hasKnownFile(path);
  }
  private importedFile(path: string): Uint8Array | Blob | undefined {
    const key = normalizeWindowsPath(path);
    return this.files.has(key) ? undefined : this.imported.files.get(key);
  }
  override async read(path: string): Promise<Uint8Array | null> {
    const file = this.importedFile(path);
    if (file instanceof Blob) return new Uint8Array(await file.arrayBuffer());
    return file ? file.slice() : super.read(path);
  }
  override async readPrefix(path: string, length: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    const file = this.importedFile(path);
    if (file instanceof Blob)
      return { bytes: new Uint8Array(await file.slice(0, length).arrayBuffer()), totalSize: file.size };
    return file ? { bytes: file.slice(0, length), totalSize: file.length } : super.readPrefix(path, length);
  }
  override async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const file = this.importedFile(path);
    if (file instanceof Blob) return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    return file ? file.slice(offset, offset + length) : super.readRange(path, offset, length);
  }
  override async list(directory: string): Promise<string[]> {
    const prefix = normalizeWindowsPath(directory);
    const names = new Set(await super.list(directory));
    for (const path of this.imported.files.keys()) {
      if (prefix && !path.startsWith(prefix + '/')) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      if (rest) names.add(rest.split('/')[0]!);
    }
    return [...names];
  }
}
