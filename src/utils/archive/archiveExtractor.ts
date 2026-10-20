/**
 * Shared extractor: NSIS installers / rar / 7z / self-extracting SFX EXEs to required files.
 *
 * 7z-wasm builds official 7-Zip code as WebAssembly, including RAR decoding and native NSIS support. Run it in a Worker to avoid blocking the main thread; WORKERFS mounts incoming archive bytes without copying. Extract each file, postMessage it, then unlink it to bound WASM32 heap peaks.
 *
 * Adaptive recursion lists directories first with l -slt and extracts only required files plus nested archives. Unrelated files never enter memory or trigger errors from installer extras. Process nested SFX/archive entries one by one across arbitrary subdirectories, up to six levels. Preserve directory-prefix structure; callers explicitly supply additional filename relocation rules.
 * Some NSIS variants expose entry names but no payload sizes through 7z. Fall back to JS decodeAndParseNsis: decode standard solid archives as one stream; repacked installers use two stages, an EOS-terminated header stream with flags-first layout plus independent per-file LZMA streams. Decode only required files using recorded stream offsets.
 */
import SevenZip from '7z-wasm';
import { selectImportPaths } from './selectImportPaths';
import { decodeAndParseNsis, decodeNsisSplitFiles, findNsisArchive } from './nsis';
import { decodeLzmaStream } from './lzmaDecode';
import { archiveExtensionKey } from './archiveFileKey';

export interface ArchiveDirectoryRule {
  directory: string;
  /** Caller-configured regular-expression source matched against lowercase basenames. */
  basenamePattern: string;
}

export interface ArchiveExtractRequest {
  type: 'extract';
  /** Archive bytes transferred from the main thread. */
  buffer?: ArrayBuffer;
  /** Local File/Blob references can be structured-cloned; WORKERFS reads on demand without copying the whole large package first. */
  archive?: Blob;
  /** Required filenames, compared in lowercase; do not extract unlisted files. */
  wanted: string[];
  extensions?: string[];
  directoryRules?: readonly ArchiveDirectoryRule[];
  layers?: { required: string[]; startup: string[] };
}

export type ArchiveExtractResponse =
  | { type: 'status'; message: string }
  | { type: 'catalog'; names: string[] }
  | { type: 'startup-ready' }
  | { type: 'file'; name: string; bytes: Uint8Array }
  | { type: 'done'; found: string[] }
  | { type: 'error'; message: string };

// Depth limit supports chained exe/7z/zip/rar nesting, including installers inside installers;
// extract only required files and nested archives per level, bounding pathological archive chains.
const MAX_LAYERS = 6;
const ARCHIVE_SUFFIXES = ['.rar', '.7z', '.zip', '.exe', '.sfx'];

export interface ArchiveExtractorOptions {
  post: (message: ArchiveExtractResponse, transfer?: Transferable[]) => void;
  locateFile?: (name: string) => string;
  mountInput?: (sevenZip: Awaited<ReturnType<typeof SevenZip>>, request: ArchiveExtractRequest) => void;
  /** Hosts may mount the output staging directory on disk; browsers default to MEMFS. */
  mountOutput?: (sevenZip: Awaited<ReturnType<typeof SevenZip>>) => void;
}

/** Browser and CI share parsing, nested traversal, selection, and NSIS fallback; only input mounting and output differ. */
export function createArchiveExtractor(options: ArchiveExtractorOptions) {
  const post = options.post;
  const urgentFiles = new Set<string>();
  let wakeBackground: (() => void) | undefined;
  return async (request: ArchiveExtractRequest | { type: 'prioritize'; name: string }): Promise<void> => {
    if (request.type === 'prioritize') {
      urgentFiles.add(request.name.toLowerCase());
      wakeBackground?.();
      return;
    }
    const { buffer, archive, wanted, extensions = [], layers } = request;
    const wantedLower = new Set(wanted.map((name) => name.toLowerCase()));
    // Match directory-prefix entries by lowercase relative path and retain directory structure.
    const wantedDirs = new Set([...wantedLower].filter((name) => name.endsWith('/')));
    try {
      const logs: string[] = [];
      const sevenZip = await SevenZip({
        ...(options.locateFile ? { locateFile: options.locateFile } : {}),
        print: (text) => logs.push(String(text)),
        printErr: (text) => logs.push(String(text)),
      });
      const fs = sevenZip.FS;

      fs.mkdir('/work');
      if (options.mountInput) options.mountInput(sevenZip, request);
      else {
        if (!archive && !buffer) throw new Error('缺少归档输入');
        fs.mount(
          sevenZip.WORKERFS,
          { blobs: [{ name: 'archive.bin', data: archive ?? new Blob([buffer!]) }] },
          '/work',
        );
      }
      fs.mkdir('/out');
      options.mountOutput?.(sevenZip);

      const callMain = (args: string[]): number => {
        logs.length = 0;
        try {
          return sevenZip.callMain(args) as unknown as number;
        } catch (error) {
          if (error && (error as { name?: string }).name === 'ExitStatus') {
            return (error as { status: number }).status;
          }
          throw error;
        }
      };

      const isDir = (path: string): boolean => {
        try {
          return fs.isDir(fs.stat(path).mode);
        } catch {
          return false;
        }
      };
      const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;
      const directoryRules = (request.directoryRules ?? [])
        .filter((rule) => wantedDirs.has(rule.directory))
        .map((rule) => ({ directory: rule.directory, pattern: new RegExp(rule.basenamePattern) }));
      /** Match required files by basename, directory prefix, or caller-provided relocation rules. */
      const storeKeyOfPath = (path: string): string | null => {
        const extensionKey = archiveExtensionKey(path, extensions);
        if (extensionKey) return extensionKey;
        const lower = path.toLowerCase().replaceAll('\\', '/');
        const base = basename(lower);
        if (wantedLower.has(base)) return base;
        const exact = [...wantedLower].find(
          (name) => !name.endsWith('/') && (lower === name || lower.endsWith('/' + name)),
        );
        if (exact) return exact;
        const dir = [...wantedDirs].find((dir) => lower.startsWith(dir));
        if (dir) return lower;
        for (const prefix of wantedDirs) {
          const index = lower.lastIndexOf('/' + prefix);
          if (index >= 0) return lower.slice(index + 1);
        }
        for (const rule of directoryRules) if (rule.pattern.test(base)) return rule.directory + base;
        return null;
      };
      const readBytes = (path: string): Uint8Array | null => {
        try {
          if (!fs.isFile(fs.stat(path).mode)) return null;
          // FS.readFile already allocates an exclusive Uint8Array; avoid another full MIX/nested-package copy.
          return fs.readFile(path);
        } catch {
          return null;
        }
      };
      const isArchiveName = (name: string): boolean =>
        ARCHIVE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));

      /** List archive entries using l -slt, splitting records on blank lines; entries without Size are directories. Return null for non-archives. */
      const listEntries = (archivePath: string): Array<{ path: string; isDir: boolean; size: number }> | null => {
        if (callMain(['l', '-slt', archivePath]) !== 0) return null;
        const entries: Array<{ path: string; isDir: boolean; size: number }> = [];
        for (const record of logs.join('\n').split(/\n\s*\n/)) {
          const path = record.match(/^Path = (.+)$/m)?.[1]?.trim();
          if (!path) continue;
          const size = record.match(/^Size = (\d+)$/m)?.[1];
          entries.push({ path: path.replace(/\\/g, '/'), isDir: size === undefined, size: Number(size ?? 0) });
        }
        return entries;
      };

      /** Collect all relative file paths with DFS; bound depth against pathological directory trees. */
      const walkFiles = (root: string, prefix = '', depth = 0): string[] => {
        if (depth > 32) return [];
        const result: string[] = [];
        let names: string[];
        try {
          names = fs.readdir(root);
        } catch {
          return [];
        }
        for (const name of names) {
          if (name === '.' || name === '..') continue; // MEMFS readdir includes dot entries.
          const full = `${root}/${name}`;
          const rel = prefix ? `${prefix}/${name}` : name;
          if (isDir(full)) result.push(...walkFiles(full, rel, depth + 1));
          else result.push(rel);
        }
        return result;
      };

      const found = new Set<string>();
      let extractedBytes = 0;

      /**
       * Detect archive magic: ZIP (PK), 7z, RAR, and NSIS signatures. SFX signatures may be near the file end, so search the whole file; plain MZ does not identify an archive.
       */
      const containsBytes = (haystack: Uint8Array, needle: readonly number[]): boolean => {
        for (let i = 0; i + needle.length <= haystack.length; i++) {
          if (haystack[i] !== needle[0]) continue;
          if (needle.every((byte, offset) => haystack[i + offset] === byte)) return true;
        }
        return false;
      };
      const looksLikeArchive = (bytes: Uint8Array): boolean =>
        containsBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) || // zip / SFX zip
        containsBytes(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || // 7z / SFX 7z
        containsBytes(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) || // rar4/5
        containsBytes(
          bytes,
          [...'NullsoftInst'].map((char) => char.charCodeAt(0)),
        ); // NSIS

      /**
       * Process one layer: list, extract on demand, then collect required files. Report entries/results per level. Recurse using a wrapper-layer heuristic when this level has few files or yields no required files; treat populated, productive directories as game roots. Verify archive magic first so ordinary EXEs such as launcher copies do not incur wasted extraction attempts.
       */
      const processLayer = async (archivePath: string, outDir: string, depth: number): Promise<void> => {
        const entries = listEntries(archivePath);
        if (!entries) {
          // The top level must be a readable archive; skip nested non-archives such as ordinary EXEs.
          if (depth === 0) throw new Error('无法读取该归档（格式不支持或已损坏）');
          return;
        }
        const solid = logs.some((line) => line.trim() === 'Solid = +');
        const sizeable = entries.filter((entry) => !entry.isDir).length;
        // NSIS variant detection: if over half the entries lack Size, 7z cannot parse the payload; use JS whole-stream decoding.
        if (sizeable * 2 < entries.length && (await tryNsisFallback(archivePath, depth))) {
          return;
        }
        const gameEntries = [
          ...selectImportPaths(
            entries.filter((entry) => !entry.isDir),
            (entry) => entry.path,
            storeKeyOfPath,
            extensions.length > 0,
          ).values(),
        ];
        const selectedEntries = [
          ...gameEntries,
          ...entries.filter(
            (entry) => !entry.isDir && storeKeyOfPath(entry.path) === null && isArchiveName(entry.path),
          ),
        ];
        const names = gameEntries.map((entry) => storeKeyOfPath(entry.path)!);
        // Publish the directory only when it fully lists the selected base game. Wrapper layers keep recursing, and NSIS whole-stream
        // fallback still awaits complete decoding; never assume unexplored inner files are absent.
        if (
          layers &&
          depth === 0 &&
          !extensions.length &&
          !found.size &&
          sizeable > 3 &&
          layers.required.every((name) => names.includes(name.toLowerCase()))
        ) {
          if (new Set(names).size !== names.length) throw new Error('游戏归档存在同名资源，无法确定覆盖顺序');
          post({ type: 'catalog', names });
          const startupNames = new Set(layers.startup.map((name) => name.toLowerCase()));
          // Empty MIX placeholders must be ready first; listed-but-unloaded files must not be mistaken for empty movie packages.
          const startup = gameEntries.filter(
            (entry) => entry.size === 0 || startupNames.has(storeKeyOfPath(entry.path)!),
          );
          const startupPaths = new Set(startup.map((entry) => entry.path));
          const other = gameEntries.filter((entry) => !startupPaths.has(entry.path)).sort((a, b) => a.size - b.size);
          const extractBatch = (batch: typeof gameEntries): void => {
            if (!batch.length) return;
            const code = callMain([
              'x',
              archivePath,
              `-o${outDir}`,
              '-y',
              '-bso0',
              '-bsp0',
              '--',
              ...batch.map((entry) => entry.path),
            ]);
            if (code !== 0) throw new Error('游戏资源解压失败（损坏、加密或格式不支持）');
            for (const entry of batch) {
              const bytes = readBytes(`${outDir}/${entry.path}`);
              if (!bytes || bytes.length !== entry.size) throw new Error(`解压文件缺失或长度不符：${entry.path}`);
              const name = storeKeyOfPath(entry.path)!;
              post({ type: 'file', name, bytes }, [bytes.buffer]);
              found.add(name);
              fs.unlink(`${outDir}/${entry.path}`);
            }
          };
          post({ type: 'status', message: `正在准备启动层（${startup.length} 个文件）…` });
          extractBatch(startup);
          post({ type: 'startup-ready' });
          post({ type: 'status', message: `启动层已就绪，后台解压其余 ${other.length} 个文件…` });
          // Yield across a task boundary so the page can process startup readiness first. Use one extraction Worker for remaining resources,
          // never multiple large-package decoders concurrently. Solid batches may rescan compressed streams, so speedups are not guaranteed.
          // Yield some post-extraction CPU time to the VM; real page-miss requests can wake the wait and reprioritize the next file.
          // Messages cannot interrupt one synchronous 7z decode; retain whole solid batches to avoid repeated stream rescans.
          const rest = async (elapsed: number) => {
            if (other.some((entry) => urgentFiles.has(storeKeyOfPath(entry.path)!))) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              return;
            }
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                wakeBackground = undefined;
                resolve();
              };
              const timer = setTimeout(finish, Math.min(100, Math.max(8, elapsed)));
              wakeBackground = finish;
            });
          };
          await rest(32);
          if (solid) extractBatch(other);
          else
            while (other.length) {
              const urgent = other.findIndex((entry) => urgentFiles.has(storeKeyOfPath(entry.path)!));
              const entry = other.splice(urgent >= 0 ? urgent : 0, 1)[0]!;
              urgentFiles.delete(storeKeyOfPath(entry.path)!);
              // Non-solid archives can deliver/release files individually, so small resources need not await the largest movie package.
              // Extract remaining solid layers as a batch to avoid rescanning from the stream start for every file.
              const started = performance.now();
              extractBatch([entry]);
              await rest(performance.now() - started);
            }
          return;
        }
        const toExtract = selectedEntries.map((entry) => entry.path);
        if (extensions.length && toExtract.length > 4096) throw new Error('附加包文件数量超过 4096 项');
        // Check declared sizes, including nested archives, before allocating extraction memory; do not wait until a huge archive is decoded to reject it.
        extractedBytes += selectedEntries.reduce((sum, entry) => sum + entry.size, 0);
        if (extensions.length && extractedBytes > 128 * 1024 * 1024) throw new Error('附加包累计解压大小超过 128 MB');
        post({
          type: 'status',
          message: `第 ${depth} 层：${sizeable} 个文件${toExtract.length ? `，提取 ${toExtract.length} 个` : ''}…`,
        });
        if (toExtract.length) {
          // Partial entry failures are nonfatal; still process successfully extracted content.
          const code = callMain(['x', archivePath, `-o${outDir}`, '-y', '-bso0', '-bsp0', '--', ...toExtract]);
          if (extensions.length && code !== 0) throw new Error('附加包解压失败（损坏、加密或格式不支持）');
        }
        // Collect required files from any subdirectory; retain only the first occurrence across layers.
        const layerFound: string[] = [];
        for (const rel of walkFiles(outDir)) {
          const storeKey = storeKeyOfPath(rel);
          if (!storeKey) continue;
          if (found.has(storeKey)) {
            // Duplicate basenames are ambiguous in flat add-on mounts; never silently choose an arbitrary copy.
            if (extensions.length) throw new Error(`压缩包存在同名文件：${storeKey}`);
            fs.unlink(`${outDir}/${rel}`);
            continue;
          }
          const bytes = readBytes(`${outDir}/${rel}`);
          if (!bytes) continue;
          post({ type: 'file', name: storeKey, bytes }, [bytes.buffer]);
          found.add(storeKey);
          layerFound.push(storeKey);
          fs.unlink(`${outDir}/${rel}`);
        }
        if (layerFound.length) {
          post({
            type: 'status',
            message: `第 ${depth} 层找到：${layerFound.slice(0, 8).join('、')}${layerFound.length > 8 ? ` 等 ${layerFound.length} 个` : ''}`,
          });
        }
        if (extensions.length && depth >= MAX_LAYERS && walkFiles(outDir).some(isArchiveName)) {
          throw new Error(`附加包嵌套超过 ${MAX_LAYERS} 层，无法完整探索`);
        }
        // Wrapper heuristic: few file entries or no required files found means recurse; otherwise treat a populated,
        // productive directory as the game root and stop exploring nested archives.
        if (depth < MAX_LAYERS && (extensions.length > 0 || sizeable <= 3 || layerFound.length === 0)) {
          const nested = walkFiles(outDir)
            .filter((rel) => isArchiveName(basename(rel)))
            .filter((rel) => {
              const bytes = readBytes(`${outDir}/${rel}`);
              return !!bytes && looksLikeArchive(bytes);
            });
          let index = 0;
          for (const rel of nested) {
            post({ type: 'status', message: `第 ${depth + 1} 层解压（${basename(rel)}）…` });
            const sub = `${outDir}/n${depth}_${index++}`;
            fs.mkdir(sub);
            await processLayer(`${outDir}/${rel}`, sub, depth + 1);
          }
        }
        // Cleanup: remove all remaining files at this level; Worker exit reclaims nested directory structures.
        for (const rel of walkFiles(outDir)) {
          try {
            fs.unlink(`${outDir}/${rel}`);
          } catch {
            /* Already removed. */
          }
        }
      };

      /**
       * JS whole-stream NSIS fallback for variants whose payload sizes 7z cannot read: extract required files and write nested archives for further wrapper recursion. Return whether this layer was handled.
       */
      const tryNsisFallback = async (archivePath: string, depth: number): Promise<boolean> => {
        const bytes = readBytes(archivePath);
        if (!bytes) return false;
        const nsis = findNsisArchive(bytes);
        if (!nsis) return false;
        if (extensions.length) throw new Error('附加包无法确认解压大小，请先转换为 ZIP 或 7z');
        post({
          type: 'status',
          message: `第 ${depth} 层：7z 无法列出载荷尺寸，改走 NSIS 整流解码…`,
        });
        try {
          const onProgress = (percent: number): void => {
            const displayPercent = Math.floor(percent * 100);
            if (percent < 0 || displayPercent <= 0) return;
            post({ type: 'status', message: `正在解码 NSIS：${displayPercent}%` });
          };
          const decoded = await decodeAndParseNsis(bytes, nsis, onProgress);
          const layerFound: string[] = [];
          let nestedIndex = 0;
          /**
           * Unified file output: post required files directly after copying their bytes, never transferring a view of a large buffer; write nested archives for further wrapper recursion.
           */
          const collect = async (path: string, storeKey: string | null, bytesOut: Uint8Array): Promise<void> => {
            if (storeKey) {
              if (found.has(storeKey)) {
                if (extensions.length) throw new Error(`压缩包存在同名文件：${storeKey}`);
                return;
              }
              post({ type: 'file', name: storeKey, bytes: bytesOut }, [bytesOut.buffer]);
              found.add(storeKey);
              layerFound.push(storeKey);
              return;
            }
            if (depth < MAX_LAYERS && isArchiveName(path) && looksLikeArchive(bytesOut)) {
              const base = basename(path);
              const sub = `/out/n${depth}_${nestedIndex++}`;
              fs.mkdir(sub);
              fs.writeFile(`${sub}/${base}`, bytesOut);
              await processLayer(`${sub}/${base}`, sub, depth + 1);
            }
          };
          if (decoded.kind === 'solid') {
            // Standard solid archives: subarray views the entire decoded output buffer, so copy before postMessage.
            for (const file of decoded.files) {
              const slice = new Uint8Array(decoded.output.subarray(file.offset + 4, file.offset + 4 + file.size));
              await collect(file.path, storeKeyOfPath(file.path), slice);
            }
          } else {
            // Two-stage streams: decode independent per-file LZMA streams by offset only for required files and nested-archive candidates.
            // Deduplicate offsets; the instruction stream may reference one file repeatedly with different overwrite flags.
            const skippedStreams = await decodeNsisSplitFiles({
              bytes,
              payloadStart: decoded.payloadStart,
              files: decoded.files,
              isTarget: (path) => storeKeyOfPath(path) !== null || isArchiveName(path),
              decode: (stream) => decodeLzmaStream({ stream, onProgress, transferInput: false }),
              collect: (path, out) => collect(path, storeKeyOfPath(path), new Uint8Array(out)),
              onStatus: (message) => post({ type: 'status', message }),
            });
            if (skippedStreams.length) {
              post({
                type: 'status',
                message: `NSIS 跳过 ${skippedStreams.length} 条损坏流：${skippedStreams.slice(0, 3).join('、')}${
                  skippedStreams.length > 3 ? ' 等' : ''
                }`,
              });
            }
          }
          if (layerFound.length) {
            post({
              type: 'status',
              message: `第 ${depth} 层找到：${layerFound.slice(0, 8).join('、')}${layerFound.length > 8 ? ` 等 ${layerFound.length} 个` : ''}`,
            });
          }
          return true;
        } catch (error) {
          if (extensions.length) throw error;
          post({
            type: 'status',
            message: `NSIS 整流解码失败：${error instanceof Error ? error.message : String(error)}`,
          });
          return false;
        }
      };

      await processLayer('/work/archive.bin', '/out', 0);
      post({ type: 'done', found: [...found] });
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
}
