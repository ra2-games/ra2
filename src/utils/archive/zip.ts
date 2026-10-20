/** General-purpose ZIP reading: native stream decompression with fflate fallback, preserving legacy encoding and duplicate-entry conventions. */
import { Unzip, UnzipInflate } from 'fflate';
import { normalizeWindowsPath } from '../windowsPath';

export interface ZipArchiveEntry {
  /** Guest path normalized by normalizeWindowsPath: lowercase, without a drive letter. */
  path: string;
  /** Final original entry-name component with case preserved, used to construct File objects in import plans. */
  name: string;
  /** Decoded content owned directly by the provider; callers must not modify it afterward. */
  bytes: Uint8Array<ArrayBuffer>;
}

/** Compressed bytes per Unzip batch; yield the main thread between batches so hundreds of MB cannot freeze the UI. */
const PUSH_CHUNK_BYTES = 1024 * 1024;
/** Throttle extraction-progress reports by accumulated bytes rather than logging every block. */
const PROGRESS_INTERVAL_MS = 100;

/** For legacy ZIPs lacking UTF-8 flags, fflate returns bytewise characters; inspect central-directory flags before decoding. */
function legacyZipNames(bytes: Uint8Array): Map<string, string> {
  const names = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== bytes.length)
      continue;
    let offset = view.getUint32(end + 16, true);
    const count = view.getUint16(end + 10, true);
    for (let i = 0; i < count && offset + 46 <= end; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const flags = view.getUint16(offset + 8, true);
      const length = view.getUint16(offset + 28, true);
      if (offset + 46 + length > end) break;
      if (!(flags & 0x800)) {
        const raw = bytes.subarray(offset + 46, offset + 46 + length);
        const original = Array.from(raw, (byte) => String.fromCharCode(byte)).join('');
        for (const encoding of ['utf-8', 'gb18030']) {
          try {
            names.set(original, new TextDecoder(encoding, { fatal: true }).decode(raw));
            break;
          } catch {
            /* Try the next legacy encoding; preserve the original byte mapping if none decodes. */
          }
        }
      }
      offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    break;
  }
  return names;
}

/** Skip directory placeholders, macOS __MACOSX archive clutter, and AppleDouble ._* metadata. */
function isUsableZipEntry(name: string): boolean {
  if (name.endsWith('/')) return false;
  return name.split('/').every((part) => !part.startsWith('._') && part !== '__MACOSX');
}

/** Concurrent native-inflate entries; asynchronous parallel decoding spreads large-package extraction work. */
const NATIVE_UNZIP_CONCURRENCY = 4;

interface ZipCdEntry {
  /** Raw central-directory entry name, potentially not yet UTF-8 decoded. */
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** Parse the ZIP central directory through EOCD lookup and entry metadata for native extraction. */
function readCentralDirectory(bytes: Uint8Array): ZipCdEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    if (end + 22 + view.getUint16(end + 20, true) !== bytes.length) continue;
    eocd = end;
    break;
  }
  if (eocd < 0) throw new Error('ZIP 中央目录未找到');
  const count = view.getUint16(eocd + 10, true);
  const entries: ZipCdEntry[] = [];
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 中央目录条目损坏');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    // Decode directly when the UTF-8 flag is set; otherwise preserve latin1 bytes for legacyZipNames encoding detection.
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = flags & 0x800 ? new TextDecoder('utf-8').decode(rawName) : new TextDecoder('latin1').decode(rawName);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decode one ZIP raw-deflate entry with native DecompressionStream; slice stored entries directly. */
async function inflateZipEntry(bytes: Uint8Array, entry: ZipCdEntry): Promise<Uint8Array<ArrayBuffer>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLength = view.getUint16(entry.localOffset + 26, true);
  const extraLength = view.getUint16(entry.localOffset + 28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed.slice();
  if (entry.method !== 8) throw new Error(`不支持的压缩方式：${entry.method}`);
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const write = (async () => {
    // Fetched/file-read ZIP buffers always use ArrayBuffer; this assertion only satisfies BufferSource typing.
    await writer.write(compressed as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  await write;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Native DecompressionStream: native inflate is several times faster than JS and asynchronous, avoiding main-thread blocking. */
async function readZipArchiveNative(
  bytes: Uint8Array,
  onProgress?: (extractedFiles: number, extractedBytes: number) => void,
): Promise<ZipArchiveEntry[]> {
  const legacyNames = legacyZipNames(bytes);
  const directory = readCentralDirectory(bytes);
  const known = new Set<string>();
  const chosen: { entry: ZipCdEntry; name: string; normalized: string }[] = [];
  for (const entry of directory) {
    const name = legacyNames.get(entry.name) ?? entry.name;
    const normalized = normalizeWindowsPath(name);
    if (!isUsableZipEntry(name) || !normalized || known.has(normalized)) continue;
    known.add(normalized);
    chosen.push({ entry, name, normalized });
  }
  const entries: ZipArchiveEntry[] = new Array(chosen.length);
  let extractedFiles = 0;
  let extractedBytes = 0;
  let lastReportAt = 0;
  const report = (): void => {
    if (!onProgress) return;
    const now = performance.now();
    if (now - lastReportAt < PROGRESS_INTERVAL_MS) return;
    lastReportAt = now;
    onProgress(extractedFiles, extractedBytes);
  };
  let next = 0;
  const process = async (): Promise<void> => {
    while (next < chosen.length) {
      const index = next++;
      const item = chosen[index]!;
      const output = await inflateZipEntry(bytes, item.entry);
      entries[index] = {
        path: item.normalized,
        name: item.name.split('/').filter(Boolean).pop() ?? item.name,
        bytes: output,
      };
      extractedFiles++;
      extractedBytes += output.length;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(NATIVE_UNZIP_CONCURRENCY, chosen.length) }, () => process()));
  onProgress?.(extractedFiles, extractedBytes);
  return entries;
}

/**
 * Stream-decompress ZIP asynchronously into entries. Keep the first path after case normalization, skipping later case variants that usually represent the same file. Preserve archive entry order.
 */
export async function readZipArchive(
  bytes: Uint8Array,
  onProgress?: (extractedFiles: number, extractedBytes: number) => void,
): Promise<ZipArchiveEntry[]> {
  // Prefer native decompression, available in Chromium/Firefox/Safari/Node; fall back to fflate if unavailable or failing.
  if (typeof DecompressionStream === 'function') {
    try {
      return await readZipArchiveNative(bytes, onProgress);
    } catch (error) {
      console.warn('[ZIP] 原生解压失败，回退 fflate：', error);
    }
  }
  const entries: ZipArchiveEntry[] = [];
  const legacyNames = legacyZipNames(bytes);
  const known = new Set<string>();
  let extractedFiles = 0;
  let extractedBytes = 0;
  let lastReportAt = 0;
  let streamError: unknown = null;
  const report = (): void => {
    if (!onProgress) return;
    const now = performance.now();
    if (now - lastReportAt < PROGRESS_INTERVAL_MS) return;
    lastReportAt = now;
    onProgress(extractedFiles, extractedBytes);
  };
  const unz = new Unzip((file) => {
    const name = legacyNames.get(file.name) ?? file.name;
    const normalized = normalizeWindowsPath(name);
    if (!isUsableZipEntry(name) || !normalized) return;
    if (known.has(normalized)) return;
    known.add(normalized);
    const chunks: Uint8Array[] = [];
    let total = 0;
    file.ondata = (err, data, final) => {
      if (err) {
        streamError = streamError ?? err;
        return;
      }
      if (data && data.length) {
        chunks.push(data);
        total += data.length;
        extractedBytes += data.length;
        report();
      }
      if (final) {
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        entries.push({
          path: normalized,
          name: name.split('/').filter(Boolean).pop() ?? name,
          bytes: combined,
        });
        extractedFiles++;
        report();
      }
    };
    file.start();
  });
  unz.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length; offset += PUSH_CHUNK_BYTES) {
      unz.push(
        bytes.subarray(offset, Math.min(offset + PUSH_CHUNK_BYTES, bytes.length)),
        offset + PUSH_CHUNK_BYTES >= bytes.length,
      );
      if (streamError) break;
      // Decompression is a synchronous CPU-heavy loop; yield between batches so progress text and cancellation state can update.
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  } catch (error) {
    streamError = streamError ?? error;
  }
  if (streamError) {
    throw new Error(`ZIP 解压失败：${streamError instanceof Error ? streamError.message : String(streamError)}`);
  }
  onProgress?.(extractedFiles, extractedBytes);
  return entries;
}

export function formatZipBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
