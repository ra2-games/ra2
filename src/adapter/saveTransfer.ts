import type { SupportedGameId } from '../games/catalog';
import type { GameFileProvider } from '../resources/contracts';
import { normalizeGuestPath } from '../vm86/paths';

const SAVE_PACKAGE_FORMAT = 'ra2-vm-save';
const SAVE_PACKAGE_VERSION = 1;
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;

interface SavePackageFile {
  path: string;
  data: string;
}

interface SavePackage {
  format: typeof SAVE_PACKAGE_FORMAT;
  version: typeof SAVE_PACKAGE_VERSION;
  gameId: SupportedGameId;
  createdAt: string;
  files: SavePackageFile[];
}

export interface SavePackageSummary {
  gameId: SupportedGameId;
  createdAt: string;
  files: Array<{ path: string; bytes: Uint8Array }>;
}

/** Export game saves from root *.sav files and the Save directory. */
export async function createSavePackage(provider: GameFileProvider, gameId: SupportedGameId): Promise<Blob> {
  const paths = await listSavePaths(provider);
  const files: SavePackageFile[] = [];
  for (const path of paths) {
    const bytes = await provider.read(path);
    if (bytes) files.push({ path, data: bytesToBase64(bytes) });
  }
  if (!files.length) throw new Error('当前游戏目录中没有可导出的存档');
  const archive: SavePackage = {
    format: SAVE_PACKAGE_FORMAT,
    version: SAVE_PACKAGE_VERSION,
    gameId,
    createdAt: new Date().toISOString(),
    files,
  };
  return new Blob([JSON.stringify(archive)], { type: 'application/json' });
}

export async function readSavePackage(file: Blob, expectedGameId: SupportedGameId): Promise<SavePackageSummary> {
  if (file.size > MAX_PACKAGE_BYTES) throw new Error('存档包超过 128MB，拒绝导入');
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error('存档包不是有效的 JSON 文件');
  }
  if (!isRecord(value) || value.format !== SAVE_PACKAGE_FORMAT || value.version !== SAVE_PACKAGE_VERSION) {
    throw new Error('无法识别的存档包格式或版本');
  }
  if (value.gameId !== expectedGameId) {
    throw new Error(`存档属于 ${String(value.gameId)}，当前游戏是 ${expectedGameId}`);
  }
  if (typeof value.createdAt !== 'string' || !Array.isArray(value.files) || !value.files.length) {
    throw new Error('存档包缺少文件');
  }
  const seen = new Set<string>();
  const files = value.files.map((entry): { path: string; bytes: Uint8Array } => {
    if (!isRecord(entry) || typeof entry.path !== 'string' || typeof entry.data !== 'string') {
      throw new Error('存档包文件记录损坏');
    }
    if (!isAllowedSavePath(entry.path)) throw new Error(`存档包包含非法路径：${entry.path}`);
    const path = normalizeGuestPath(entry.path);
    if (!isAllowedSavePath(path) || seen.has(path)) throw new Error(`存档包包含非法或重复路径：${entry.path}`);
    seen.add(path);
    return { path, bytes: base64ToBytes(entry.data) };
  });
  return { gameId: expectedGameId, createdAt: value.createdAt, files };
}

export async function importSavePackage(provider: GameFileProvider, summary: SavePackageSummary): Promise<void> {
  for (const entry of summary.files) await provider.write(entry.path, entry.bytes);
  await provider.flush();
  // Verify writes by reading each file back and checking its byte count. If partial writes are detected only when the game loads a save,
  // they appear as an original-game divide-by-zero crash (#DE@0x43a604); report the failing file here instead.
  const failures: string[] = [];
  for (const entry of summary.files) {
    const written = await provider.read(entry.path);
    if (!written || written.length !== entry.bytes.length) {
      failures.push(`${entry.path}（写入 ${entry.bytes.length} 字节，读回 ${written?.length ?? '无'}）`);
    }
  }
  if (failures.length) throw new Error(`存档写回校验失败：${failures.join('；')}`);
}

export async function listSavePaths(provider: GameFileProvider): Promise<string[]> {
  provider.invalidateCache?.();
  const paths = new Set<string>();
  for (const name of (await provider.list('')) ?? []) {
    if (isAllowedSavePath(name)) paths.add(normalizeGuestPath(name));
  }
  for (const name of (await provider.list('save')) ?? []) {
    const path = `save/${name}`;
    if (isAllowedSavePath(path)) paths.add(normalizeGuestPath(path));
  }
  return [...paths].sort();
}

/** Read the save's embedded FILETIME from the SGBYSTG1 stream table when host file metadata is absent. */
export function readSaveFileLastWriteTime(bytes: Uint8Array): bigint | null {
  const magic = 'SGBYSTG1';
  if (bytes.length < magic.length + 4) return null;
  for (let index = 0; index < magic.length; index++) {
    if (bytes[index] !== magic.charCodeAt(index)) return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streamCount = view.getUint32(magic.length, true);
  if (streamCount > 1024) return null;
  let offset = magic.length + 4;
  const decoder = new TextDecoder();
  for (let index = 0; index < streamCount; index++) {
    if (offset + 8 > bytes.length) return null;
    const nameLength = view.getUint32(offset, true);
    const dataLength = view.getUint32(offset + 4, true);
    offset += 8;
    const nameEnd = offset + nameLength;
    if (nameEnd > bytes.length || dataLength > bytes.length - nameEnd) return null;
    const name = decoder.decode(bytes.subarray(offset, nameEnd));
    const dataOffset = nameEnd;
    if (name === 'last save time') {
      if (dataLength !== 8) return null;
      const fileTime = BigInt(view.getUint32(dataOffset, true)) | (BigInt(view.getUint32(dataOffset + 4, true)) << 32n);
      return fileTime > 0n ? fileTime : null;
    }
    offset = nameEnd + dataLength;
  }
  return null;
}

/** Summarize save-file paths in a human-readable form. */
export function summarizeSavePaths(paths: string[]): string {
  const rootSav = paths.filter((path) => /^[^/]+\.sav$/i.test(path)).sort();
  const nested = paths.filter((path) => /^save\//i.test(path)).sort();
  const lines: string[] = [];
  if (rootSav.length) lines.push(`根目录 .sav 文件 ${rootSav.length} 个：${rootSav.join(', ')}`);
  if (nested.length) lines.push(`Save 目录文件 ${nested.length} 个：${nested.join(', ')}`);
  return lines.join('\n');
}

/** Whether the package contains at least one importable save. */
export function hasPlayerSlotSaves(paths: string[]): boolean {
  return paths.some(isAllowedSavePath);
}

function isAllowedSavePath(path: string): boolean {
  if (!path || path.includes('\0') || path.includes(':') || path.startsWith('/') || path.startsWith('\\')) {
    return false;
  }
  if (path.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) return false;
  return /^(?:[^/\\]+\.sav|save\/[^/\\]+)$/i.test(path);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error('存档包包含无效的 Base64 数据');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
