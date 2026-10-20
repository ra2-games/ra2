import { normalizeGuestPath } from '../../../vm86/paths';
import { MemoryGameFileProvider } from '../../../resources/providers/memory';
import { IndexedDbWriteCache } from './writeCache';

/**
 * Session memory-package provider: own extracted data without copying and slice on demand for reads.
 * Persist saves to browser IndexedDB, shared with the development backend, so they survive page refreshes.
 */
export class SessionGameFileProvider extends MemoryGameFileProvider {
  /** Game packages have variable directory layouts; discovery recursively enumerates all subdirectories. */
  readonly deepDiscovery = true;
  private readonly writeCache = new IndexedDbWriteCache();

  constructor(label: string, files: ReadonlyMap<string, Uint8Array>) {
    super(files, false, label);
  }

  invalidateCache(): void {
    this.writeCache.invalidate();
  }

  hasKnownFile(path: string): boolean | null {
    const normalized = normalizeGuestPath(path);
    if (this.files.has(normalized)) return true;
    return this.writeCache.hasKnownKey(normalized);
  }

  async read(path: string): Promise<Uint8Array | null> {
    const normalized = normalizeGuestPath(path);
    const inMemory = this.files.get(normalized);
    if (inMemory) return inMemory.slice();
    return this.writeCache.read(normalized);
  }

  override async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    // Copy only the requested range from large in-memory packages; persistence fallback uses the same precedence as read.
    const bytes = this.files.get(normalizeGuestPath(path)) ?? (await this.writeCache.read(normalizeGuestPath(path)));
    return bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null;
  }

  override async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const bytes = this.files.get(normalizeGuestPath(path)) ?? (await this.writeCache.read(normalizeGuestPath(path)));
    return bytes?.slice(offset, offset + length) ?? null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizeGuestPath(path);
    if (!normalized) throw new Error('拒绝写入空游戏路径');
    await super.write(path, bytes);
    await this.writeCache.write(normalized, bytes);
  }

  async list(directory: string): Promise<string[] | null> {
    const base = await super.list(directory);
    const prefix = normalizeGuestPath(directory);
    const extra = new Set<string>();
    for (const key of await this.writeCache.keys()) {
      if (prefix && !key.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? key.slice(prefix.length + 1) : key;
      if (rest) extra.add(rest.split('/')[0]!);
    }
    if (!extra.size) return base;
    return [...new Set([...(base ?? []), ...extra])];
  }
}
