import { extractArchiveFiles } from '../utils/archive/archiveExtract';
import { archiveExtensionKey } from '../utils/archive/archiveFileKey';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameFileProvider } from '../resources/contracts';
import { type GameSource } from '../games/source';
import type { VmAttachResult } from './vmShell';

/** Accept only CSF / YRM / MPR; do not execute installers or mount bundled EXEs, DLLs, or rules files into the game. */
export async function readCustomMapPackage(
  bytes: Uint8Array,
  onStatus?: (message: string) => void,
): Promise<Map<string, Uint8Array>> {
  if (bytes.length > 128 * 1024 * 1024) throw new Error('附加压缩包超过 128 MB');
  const result = await extractArchiveFiles(bytes, { wanted: [], extensions: ['.csf', '.yrm', '.mpr'], onStatus });
  return validateCustomMapFiles(result.files);
}

export function validateCustomMapFiles(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const normalized = new Map<string, Uint8Array>();
  for (const [path, bytes] of files) {
    const key = archiveExtensionKey(path, ['.csf', '.yrm', '.mpr']);
    if (!key || !bytes.length) throw new Error(`无效的附加文件：${path}`);
    if (normalized.has(key)) throw new Error(`压缩包存在同名文件：${key}`);
    normalized.set(key, bytes);
  }
  if (!normalized.size) throw new Error('压缩包中没有找到 .csf、.yrm 或 .mpr 文件');
  return normalized;
}

/** Use the same overlay semantics on the main thread and in Workers; guest writes stay in the session and do not alter the original installation. */
export function mountCustomMapFiles(source: GameSource, files: ReadonlyMap<string, Uint8Array>): GameSource {
  if (!files.size) return source;
  const normalized = validateCustomMapFiles(files);
  // Disable add-on CSF files for map compatibility comparisons so they cannot override the base text table; old caches pass through this gate too.
  // Filter only the mounted copy, preserving extracted data and identical main-thread/Worker behavior.
  for (const name of normalized.keys()) if (name.endsWith('.csf')) normalized.delete(name);
  if (!normalized.size) return source;
  return { ...source, files: new OverlayGameFileProvider(source.files, normalized, ' + 自定义地图', true) };
}

/** Initial hot-mount support adds new maps only; do not overwrite existing files that the guest may have open or cached. */
export async function prepareDynamicMaps(
  base: GameFileProvider,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<{ provider: GameFileProvider; result: VmAttachResult }> {
  const normalized = files.size ? validateCustomMapFiles(files) : new Map<string, Uint8Array>();
  const listing = await base.list('');
  const existing = new Set(listing?.map((name) => name.toLowerCase()));
  const added = new Map<string, Uint8Array>();
  const result: VmAttachResult = { attached: [], existing: [] };
  for (const [name, bytes] of normalized) {
    // Filter on the receiving side too so old caches or direct RPC CSF input cannot bypass the restriction.
    if (name.endsWith('.csf')) continue;
    const present =
      listing !== null
        ? existing.has(name)
        : !!(base.readPrefix ? await base.readPrefix(name, 1) : await base.read(name));
    if (present) result.existing.push(name);
    else {
      added.set(name, bytes);
      result.attached.push(name);
    }
  }
  return {
    provider: added.size ? new OverlayGameFileProvider(base, added, ' + 动态地图', true) : base,
    result,
  };
}
