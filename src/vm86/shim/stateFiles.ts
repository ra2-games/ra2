/**
 * Synchronous Win32 file state/mounting, extracted from state.ts: file bytes, sparse ranges, fast mirrors, and timestamps. Apply after ShimState and before all Kernel32 file dispatch.
 */
import type { FileState } from '../win32';
import { normalizeGuestPath } from '../paths';
import { FAST_FILE_MIRROR_LIMIT, type Constructor, type ShimState } from './state';

export type ShimFilesChain = InstanceType<ReturnType<typeof withShimFiles>>;

export function withShimFiles<TBase extends Constructor<ShimState>>(Base: TBase) {
  return class extends Base {
    protected readonly files = new Map<string, Uint8Array>();
    /** Session-owned empty directories created by the guest; never placeholder file bytes. */
    protected readonly createdDirectories = new Set<string>();
    /** Logical length of sparse mounts; bytes holds only the index prefix. */
    protected readonly fileLogicalSizes = new Map<string, number>();
    /** Sparse files supporting provider range reads, plus already fetched non-prefix ranges. */
    protected readonly rangeBackedFiles = new Set<string>();
    protected readonly sparseFileRanges = new Map<string, Array<{ offset: number; bytes: Uint8Array }>>();
    protected readonly fileHandles = new Map<number, FileState>();
    protected nextFileHandle = 0x4000;
    protected readonly freeFileHandles: number[] = [];
    /** Per-file FILETIME, 100ns since 1601: SetFileTime writes it and FindFirstFileA reads it. */
    protected readonly fileTimes = new Map<string, { created: bigint; accessed: bigint; written: bigint }>();
    /** Distinguish guest-written times from temporary mount times so embedded save timestamps can supply imported files. */
    protected readonly guestFileTimeOverrides = new Set<string>();
    /** PE resource handles to mapped data; LockResource returns pointers directly into module images. */
    protected readonly loadedResources = new Map<number, { module: number; data: number; size: number }>();
    protected fileMirrorBytes = 0;
    protected readonly fastFileMirrorLimit: number;
    protected readonly fastFileMirrorBase: number;
    protected readonly fastFileMirrorTop: number;
    protected readonly fastFileMirrorFiles: ReadonlySet<string> | null;
    protected nextFastFileMirror: number;
    protected readonly sharedFileMirrors = new Map<string, { ptr: number; size: number }>();
    /** Deduplicate large-file mirror failures by reason and path so repeated archive probes cannot flood logs or slow the main thread. */
    protected readonly warnedFileMirrorSkips = new Set<string>();
    /** Hypercall read counts for unmirrored handles, diagnosing frequent slow reads; clear on close. */
    protected readonly unmirroredReads = new Map<number, number>();

    constructor(...args: any[]) {
      super(...args);
      this.fastFileMirrorLimit = this.options.fastFileMirrorLimit ?? FAST_FILE_MIRROR_LIMIT;
      this.fastFileMirrorBase = this.options.fastFileMirrorBase ?? 0;
      this.fastFileMirrorTop = this.options.fastFileMirrorTop ?? 0;
      this.fastFileMirrorFiles = this.options.fastFileMirrorFiles
        ? new Set(this.options.fastFileMirrorFiles.map(normalizeGuestPath))
        : null;
      this.nextFastFileMirror = this.fastFileMirrorBase;
      for (const [path, bytes] of this.options.files ?? []) this.mountFile(path, bytes);
    }

    protected noteFailedOpen(path: string): void {
      if (this.failedOpens.at(-1) === path) return;
      this.failedOpens.push(path);
      if (this.failedOpens.length > 16) this.failedOpens.shift();
    }

    /** Read mounted-path bytes from the current file layer, including guest writes. */
    getMountedFileBytes(path: string): Uint8Array | undefined {
      const normalized = normalizeGuestPath(path);
      if (!normalized) return undefined;
      const bytes = this.files.get(normalized);
      if (bytes) return bytes.slice();
      const mirror = this.sharedFileMirrors.get(normalized);
      return mirror ? this.memory.read_memory(mirror.ptr, mirror.size).slice() : undefined;
    }

    /** Whether a path already has a canonical snapshot, avoiding repeated fetches/copies of large read-only archives. */
    hasMountedFile(path: string): boolean {
      const normalized = normalizeGuestPath(path);
      return normalized ? this.files.has(normalized) || this.sharedFileMirrors.has(normalized) : false;
    }

    /** The host may mount original resources into the synchronous Win32 file layer on demand while the VM runs. */
    mountFile(path: string, bytes: Uint8Array, takeOwnership = false, logicalSize = bytes.length): void {
      const normalized = normalizeGuestPath(path);
      // Provider/read buffers may be reused by the browser or modified by the
      // caller after this synchronous mount.  The Win32 layer owns its snapshot;
      // otherwise a later fetch/decode can silently corrupt an already-open map.
      if (normalized) {
        this.storeFile(normalized, takeOwnership ? bytes : bytes.slice(), false);
        if (logicalSize > bytes.length) this.fileLogicalSizes.set(normalized, logicalSize);
      }
    }

    /** Mark sparse files whose actual ranges the host may fetch on demand at ReadFile boundaries. */
    markFileRangeBacked(path: string): void {
      const normalized = normalizeGuestPath(path);
      if (normalized && this.fileLogicalSizes.has(normalized)) this.rangeBackedFiles.add(normalized);
    }

    /** Add provider-fetched ranges to sparse files without allocating the entire 300+MiB container. */
    mountFileRange(path: string, offset: number, bytes: Uint8Array): void {
      const normalized = normalizeGuestPath(path);
      if (!normalized || !bytes.length || !this.fileLogicalSizes.has(normalized)) return;
      const ranges = this.sparseFileRanges.get(normalized) ?? [];
      ranges.push({ offset: offset >>> 0, bytes });
      ranges.sort((left, right) => left.offset - right.offset);
      this.sparseFileRanges.set(normalized, ranges);
      this.rangeBackedFiles.add(normalized);
    }

    /** Whether the next synchronous ReadFile targets an unfetched sparse range; VmCore suspends the guest for Range fetch accordingly. */
    inspectFileReadRequest(
      handle: number,
      requested: number,
    ): {
      path: string;
      offset: number;
      length: number;
      totalSize: number;
    } | null {
      const file = this.fileHandles.get(handle >>> 0);
      if (!file || !this.rangeBackedFiles.has(file.path) || !requested) return null;
      const end = Math.min(file.size, file.position + (requested >>> 0));
      if (end <= file.position || this.hasFileRange(file.path, file.position, end - file.position)) return null;
      const chunk = 2 * 1024 * 1024;
      const offset = Math.floor(file.position / chunk) * chunk;
      const rangeEnd = Math.min(file.size, Math.ceil(end / chunk) * chunk);
      return { path: file.path, offset, length: rangeEnd - offset, totalSize: file.size };
    }

    protected hasFileRange(path: string, offset: number, length: number): boolean {
      const prefix = this.files.get(path);
      let cursor = offset;
      const end = offset + length;
      if (prefix && cursor < prefix.length) cursor = Math.min(end, prefix.length);
      const ranges = this.sparseFileRanges.get(path) ?? [];
      while (cursor < end) {
        const hit = ranges.find((range) => range.offset <= cursor && range.offset + range.bytes.length > cursor);
        if (!hit) return false;
        cursor = Math.min(end, hit.offset + hit.bytes.length);
      }
      return true;
    }

    protected copyFileRange(path: string, offset: number, length: number, target: number): number {
      const prefix = this.files.get(path);
      const ranges = this.sparseFileRanges.get(path) ?? [];
      let cursor = offset;
      const end = offset + length;
      let written = 0;
      while (cursor < end) {
        if (prefix && cursor < prefix.length) {
          const count = Math.min(end - cursor, prefix.length - cursor);
          this.memory.write_memory(prefix.subarray(cursor, cursor + count), target + written);
          cursor += count;
          written += count;
          continue;
        }
        const hit = ranges.find((range) => range.offset <= cursor && range.offset + range.bytes.length > cursor);
        if (!hit) {
          const next = ranges
            .filter((range) => range.offset > cursor)
            .reduce((value, range) => Math.min(value, range.offset), end);
          const count = Math.max(1, Math.min(end, next) - cursor);
          this.zero(target + written, count);
          cursor += count;
          written += count;
          continue;
        }
        const sourceOffset = cursor - hit.offset;
        const count = Math.min(end - cursor, hit.bytes.length - sourceOffset);
        this.memory.write_memory(hit.bytes.subarray(sourceOffset, sourceOffset + count), target + written);
        cursor += count;
        written += count;
      }
      return written;
    }

    /** Write/update file-layer content and timestamps: initialize created once; refresh written/accessed on writes. */
    protected storeFile(path: string, bytes: Uint8Array, guestWrite = true): void {
      this.files.set(path, bytes);
      this.fileLogicalSizes.delete(path);
      this.rangeBackedFiles.delete(path);
      this.sparseFileRanges.delete(path);
      const now = this.guestNowFileTime();
      const times = this.fileTimes.get(path);
      if (!times) this.fileTimes.set(path, { created: now, accessed: now, written: now });
      else if (guestWrite) {
        times.accessed = now;
        times.written = now;
      }
      if (guestWrite) this.guestFileTimeOverrides.add(path);
    }

    /** Convert current guest milliseconds to FILETIME, 100ns since 1601-01-01, using BigInt for precision. */
    protected guestNowFileTime(): bigint {
      return BigInt(Math.round(this.clock.wallNow())) * 10_000n + 116_444_736_000_000_000n;
    }

    /** Known virtual directories and parents of mounted files count as existing directories. */
    protected isVirtualDirectory(path: string): boolean {
      if (!path || this.createdDirectories.has(path)) return true;
      if (path === 'windows' || path === 'windows/system' || path === 'windows/temp' || path === 'game') {
        return true;
      }
      const prefix = `${path}/`;
      for (const existing of this.files.keys()) {
        if (existing.startsWith(prefix)) return true;
      }
      return false;
    }
  };
}
