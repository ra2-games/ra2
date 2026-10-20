import type { GameFileProvider } from '../contracts';
import { normalizeGuestPath } from '../../vm86/paths';

/** Overlay memory files; writes use the parent unless overlay hits are explicitly shadowed within this session. */
export class OverlayGameFileProvider implements GameFileProvider {
  readonly label: string;
  private readonly overlay: ReadonlyMap<string, Uint8Array>;
  private readonly sessionWrites = new Map<string, Uint8Array>();

  constructor(
    readonly parent: GameFileProvider,
    files: ReadonlyMap<string, Uint8Array>,
    labelSuffix: string,
    /** Writes to overlay hits succeed only within the guest session and never reach the real directory. */
    private readonly shadowOverlayWrites = false,
    /** With copy=false, retain input bytes directly; the caller guarantees no later modification. */
    copy = true,
    /**
     * Parent-first: read the player's full installation, including localized assets, before filling missing files from the online-package overlay. Default false means overlay-first. Explicit session writes take precedence in either mode.
     */
    private readonly parentFirst = false,
  ) {
    const normalized = new Map<string, Uint8Array>();
    for (const [path, bytes] of files) normalized.set(normalizeGuestPath(path), copy ? bytes.slice() : bytes);
    this.overlay = normalized;
    this.label = `${parent.label}${labelSuffix}`;
  }

  /** Normalized files in this overlay, exposed for Worker init serialization. */
  get overlays(): ReadonlyMap<string, Uint8Array> {
    return this.sessionWrites.size ? new Map([...this.overlay, ...this.sessionWrites]) : this.overlay;
  }

  invalidateCache(): void {
    this.parent.invalidateCache?.();
  }

  hasKnownFile(path: string): boolean | null {
    const normalized = normalizeGuestPath(path);
    if (this.parentFirst) {
      const base = this.parent.hasKnownFile?.(path);
      if (base === true) return true;
      return this.overlay.has(normalized) ? true : (base ?? null);
    }
    if (this.overlay.has(normalized)) return true;
    return this.parent.hasKnownFile?.(path) ?? null;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const written = this.sessionWrites.get(normalizeGuestPath(path));
    if (written) return written.slice();
    if (this.parentFirst) {
      const base = await this.parent.read(path);
      if (base) return base;
      return this.overlay.get(normalizeGuestPath(path))?.slice() ?? null;
    }
    const hit = this.overlay.get(normalizeGuestPath(path));
    if (hit) return hit.slice();
    return this.parent.read(path);
  }

  async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    const written = this.sessionWrites.get(normalizeGuestPath(path));
    if (written) return { bytes: written.slice(0, maxBytes), totalSize: written.length };
    if (this.parentFirst) {
      const base = this.parent.readPrefix
        ? await this.parent.readPrefix(path, maxBytes)
        : await this.parent
            .read(path)
            .then((bytes) => (bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null));
      if (base) return base;
      const hit = this.overlay.get(normalizeGuestPath(path));
      return hit ? { bytes: hit.slice(0, maxBytes), totalSize: hit.length } : null;
    }
    const hit = this.overlay.get(normalizeGuestPath(path));
    if (hit) return { bytes: hit.slice(0, maxBytes), totalSize: hit.length };
    if (this.parent.readPrefix) return this.parent.readPrefix(path, maxBytes);
    const bytes = await this.parent.read(path);
    return bytes ? { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length } : null;
  }

  async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    const written = this.sessionWrites.get(normalizeGuestPath(path));
    if (written) return written.slice(offset, offset + length);
    if (this.parentFirst) {
      const base = this.parent.readRange
        ? await this.parent.readRange(path, offset, length)
        : await this.parent.read(path).then((bytes) => bytes?.slice(offset, offset + length) ?? null);
      if (base) return base;
      const hit = this.overlay.get(normalizeGuestPath(path));
      return hit?.slice(offset, offset + length) ?? null;
    }
    const hit = this.overlay.get(normalizeGuestPath(path));
    if (hit) return hit.slice(offset, offset + length);
    if (this.parent.readRange) return this.parent.readRange(path, offset, length);
    const bytes = await this.parent.read(path);
    return bytes?.slice(offset, offset + length) ?? null;
  }

  write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizeGuestPath(path);
    if (this.shadowOverlayWrites && this.overlay.has(normalized)) {
      // Reopens must observe guest writes without modifying imported assets or retaining borrowed guest memory.
      this.sessionWrites.set(normalized, bytes.slice());
      return Promise.resolve();
    }
    return this.parent.write(path, bytes);
  }

  flush(): Promise<void> {
    return this.parent.flush();
  }

  async list(directory: string): Promise<string[] | null> {
    const base = await this.parent.list(directory);
    const prefix = normalizeGuestPath(directory);
    const depth = prefix ? prefix.split('/').length : 0;
    const overlayNames = new Set<string>();
    for (const path of this.overlay.keys()) {
      const parts = path.split('/');
      if (parts.length <= depth) continue;
      const parentPath = parts.slice(0, depth).join('/');
      if (depth ? parentPath === prefix : true) overlayNames.add(parts[depth]!);
    }
    if (!overlayNames.size) return base;
    return [...new Set([...(base ?? []), ...overlayNames])];
  }
}
