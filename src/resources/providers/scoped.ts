import type { GameFileProvider } from '../contracts';
import { normalizeGuestPath } from '../../vm86/paths';

/** Map a parent subdirectory to an independent game root, hiding the parent from the VM. */
export class ScopedGameFileProvider implements GameFileProvider {
  readonly label: string;
  private readonly prefix: string;

  constructor(
    readonly parent: GameFileProvider,
    prefix: string,
  ) {
    this.prefix = normalizeGuestPath(prefix);
    this.label = `${parent.label}/${this.prefix}`;
  }

  get scope(): string {
    return this.prefix;
  }

  invalidateCache(): void {
    this.parent.invalidateCache?.();
  }

  hasKnownFile(path: string): boolean | null {
    return this.parent.hasKnownFile?.(this.path(path)) ?? null;
  }

  read(path: string): Promise<Uint8Array | null> {
    return this.parent.read(this.path(path));
  }

  readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    if (this.parent.readPrefix) return this.parent.readPrefix(this.path(path), maxBytes);
    return this.parent
      .read(this.path(path))
      .then((bytes) => (bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null));
  }

  readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    if (this.parent.readRange) return this.parent.readRange(this.path(path), offset, length);
    return this.parent.read(this.path(path)).then((bytes) => bytes?.slice(offset, offset + length) ?? null);
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    return this.parent.write(this.path(path), bytes);
  }

  flush(): Promise<void> {
    return this.parent.flush();
  }

  list(directory: string): Promise<string[] | null> {
    const normalized = normalizeGuestPath(directory);
    return this.parent.list(normalized ? `${this.prefix}/${normalized}` : this.prefix);
  }

  private path(path: string): string {
    const normalized = normalizeGuestPath(path);
    return normalized ? `${this.prefix}/${normalized}` : this.prefix;
  }
}
