/**
 * Game-package parsing: a shared entry point for local ZIP and NSIS imports. Extract in the browser into a session provider, then use the same discovery flow as folder selection (discoverGameSources -> validateGameDirectory). The provider owns extracted data directly without copying; saves write to browser IndexedDB.
 */
import { readZipArchive, formatZipBytes } from '../utils/archive/zip';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { decodeLzmaStream } from '../utils/archive/lzmaDecode';
import { findNsisArchive, parseNsisFiles } from '../utils/archive/nsis';

export interface RemotePackageOptions {
  /** Phase status text for page extraction-progress display. */
  onStatus?: (message: string) => void;
}

/**
 * Parse in-memory game-package bytes: ZIP or NSIS with solid LZMA.
 * For local file-input archive imports only; NSIS decoding runs in a Worker to avoid blocking the main thread.
 */
export async function loadRemoteGamePackageBytes(
  bytes: Uint8Array,
  options: RemotePackageOptions = {},
): Promise<SessionGameFileProvider> {
  const { onStatus } = options;
  // Identify ZIP and NSIS by magic bytes: NSIS has an MZ wrapper plus signature; ZIP has a PK header.
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = await readZipArchive(bytes, (files, extractedBytes) => {
      onStatus?.(`正在解压游戏包：已 ${files} 个文件 / ${formatZipBytes(extractedBytes)}`);
    });
    return new SessionGameFileProvider('ZIP 压缩包', new Map(entries.map((entry) => [entry.path, entry.bytes])));
  }
  const nsis = findNsisArchive(bytes);
  if (nsis) {
    onStatus?.('正在解压安装包（LZMA 解码，约需一分钟）…');
    const stream = bytes.subarray(nsis.streamStart);
    // Total length is unknown during whole-stream decoding; the SDK reports only 0/100 endpoints, so show elapsed time during heartbeat (-1) progress.
    let decodeStartedAt: number | null = null;
    const decoded = await decodeLzmaStream({
      stream,
      onProgress: (percent) => {
        if (percent < 0) {
          decodeStartedAt ??= Date.now();
          onStatus?.(`正在解压安装包… 已用时 ${Math.floor((Date.now() - decodeStartedAt) / 1000)}s`);
        } else {
          onStatus?.(`正在解压安装包：${Math.floor(percent * 100)}%`);
        }
      },
    });
    const entries = parseNsisFiles(decoded);
    const files = new Map<string, Uint8Array>();
    for (const entry of entries) {
      files.set(entry.path, decoded.subarray(entry.offset + 4, entry.offset + 4 + entry.size));
    }
    onStatus?.(`解压完成：${entries.length} 个文件`);
    return new SessionGameFileProvider('本地安装包', files);
  }
  throw new Error('无法识别的游戏包格式（需要 ZIP 或 NSIS 安装包）');
}
