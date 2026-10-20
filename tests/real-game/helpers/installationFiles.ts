import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { VmAudioSink } from '../../../src/adapter/vmCore';
import { MemoryGameFileProvider } from '../../../src/resources/providers/memory';
import { normalizeGuestPath } from '../../../src/vm86/paths';

export const silentAudio: VmAudioSink = {
  createBuffer() {},
  duplicateBuffer: () => true,
  setFormat: () => true,
  writeBuffer: (_id, _offset, bytes) => bytes.byteLength,
  play: () => true,
  stop: () => true,
  setCurrentPosition: () => true,
  setVolume: () => true,
  setPan: () => true,
  setFrequency: () => true,
  getState: () => null,
  releaseBuffer: () => true,
  setMasterVolume() {},
  stopAll() {},
  async destroy() {},
};

/** Read installation files lazily; never write saves into the player's installation. */
export class InstallationFiles extends MemoryGameFileProvider {
  private readonly paths = new Map<string, string>();
  constructor(directory: string, includeSettings = false) {
    super();
    const visit = (relative: string) => {
      for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path);
        else if (!/\.sav$/i.test(path) && (includeSettings || !/\.ini$/i.test(path)))
          this.paths.set(normalizeGuestPath(path), join(directory, path));
      }
    };
    visit('');
  }
  hasKnownFile(path: string): boolean {
    return this.files.has(normalizeGuestPath(path)) || this.paths.has(normalizeGuestPath(path));
  }
  override async read(path: string): Promise<Uint8Array | null> {
    const own = await super.read(path);
    if (own) return own;
    const disk = this.paths.get(normalizeGuestPath(path));
    return disk ? new Uint8Array(readFileSync(disk)) : null;
  }
  override async readPrefix(path: string, length: number) {
    const own = await super.read(path);
    if (own !== null) return { bytes: own.slice(0, length), totalSize: own.length };
    return this.readDiskRange(path, 0, length);
  }
  override async readRange(path: string, offset: number, length: number) {
    const own = await super.read(path);
    if (own !== null) return own.slice(offset, offset + length);
    return this.readDiskRange(path, offset, length)?.bytes ?? null;
  }
  private readDiskRange(path: string, offset: number, length: number) {
    const disk = this.paths.get(normalizeGuestPath(path));
    if (!disk) return null;
    const fd = openSync(disk, 'r');
    try {
      const totalSize = fstatSync(fd).size;
      // Movie decoding requests small ranges from large MIX files. Reading the whole
      // archive for each range makes provider I/O dominate original playback time.
      const bytes = new Uint8Array(Math.min(length, Math.max(0, totalSize - offset)));
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(fd, bytes, read, bytes.length - read, offset + read);
        if (!count) break;
        read += count;
      }
      return { bytes: bytes.subarray(0, read), totalSize };
    } finally {
      closeSync(fd);
    }
  }
  override async list(directory: string): Promise<string[]> {
    const prefix = normalizeGuestPath(directory);
    const entries = new Set<string>();
    for (const path of [...this.paths.keys(), ...this.files.keys()]) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      entries.add((prefix ? path.slice(prefix.length + 1) : path).split('/')[0]!);
    }
    return [...entries];
  }
}
