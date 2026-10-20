/**
 * Main-thread archive-extraction wrapper: nested rar / 7z / self-extracting SFX EXEs to required top-level files. A Worker runs 7z-wasm and returns name-to-bytes mappings plus found/missing lists for the manifest panel.
 */
import type { ArchiveDirectoryRule, ArchiveExtractRequest, ArchiveExtractResponse } from './archiveExtractor';

export interface ArchiveExtractResult {
  /** Extracted top-level files, preserving original archive filename case. */
  files: Map<string, Uint8Array>;
  /** Found list: required files actually supplied by the archive. */
  found: string[];
  /** Missing list: wanted files absent from the archive. */
  missing: string[];
}

/** File delivery progress; a missing catalog cannot provide a reliable denominator. */
export interface ArchiveExtractProgress {
  completedFiles: number;
  totalFiles: number | null;
}

export interface ArchiveExtractOptions {
  /** Required top-level filenames, compared individually without case sensitivity. */
  wanted: string[];
  /** Browser memory policy forwarded to the extraction Worker. */
  memoryPolicy?: 'normal' | 'conservative';
  /** Add-on packages only: discover unknown filenames by suffix and explore all nested archives. */
  extensions?: string[];
  directoryRules?: readonly ArchiveDirectoryRule[];
  /** Phase-text callback, such as extraction depth. */
  onStatus?: (message: string) => void;
  onProgress?: (progress: ArchiveExtractProgress) => void;
  signal?: AbortSignal;
  /** Two-stage extraction for base games, not add-on maps; fall back to full extraction if the directory cannot establish a complete base game. */
  layers?: { required: string[]; startup: string[] };
  onCatalog?: (names: string[]) => void;
  onFile?: (name: string, bytes: Uint8Array) => void;
  onStartupReady?: () => void;
  onPrioritizeReady?: (prioritize: (name: string) => void) => void;
}

export function extractArchiveFiles(
  bytes: Uint8Array | Blob,
  options: ArchiveExtractOptions,
): Promise<ArchiveExtractResult> {
  if (options.memoryPolicy === 'conservative' && isArchiveBlob(bytes)) {
    return extractArchiveByBatch(bytes, options);
  }
  return new Promise((resolve, reject) => {
    const { wanted, extensions, onStatus, signal } = options;
    const files = new Map<string, Uint8Array>();
    let totalFiles: number | null = null;
    let worker: Worker | undefined;
    let settled = false;
    // All exits share one cleanup; invalidate queued messages and retained prioritize callbacks after completion.
    const cleanup = () => {
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException('归档提取已取消', 'AbortError'));
    const send = (
      request: ArchiveExtractRequest | { type: 'prioritize'; name: string },
      transfer: Transferable[] = [],
    ) => {
      if (settled) return;
      try {
        worker!.postMessage(request, transfer);
      } catch (error) {
        fail(error);
      }
    };
    try {
      if (signal?.aborted) {
        abort();
        return;
      }
      worker = new Worker(new URL('./archiveExtractWorker.ts', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = (event: MessageEvent<ArchiveExtractResponse>) => {
        if (settled) return;
        try {
          const message = event.data;
          if (message.type === 'status') {
            onStatus?.(message.message);
          } else if (message.type === 'catalog') {
            totalFiles = new Set(message.names.map((name) => name.toLowerCase())).size;
            options.onProgress?.({ completedFiles: files.size, totalFiles });
            options.onCatalog?.(message.names);
          } else if (message.type === 'startup-ready') {
            options.onStartupReady?.();
          } else if (message.type === 'file') {
            files.set(message.name, message.bytes);
            options.onFile?.(message.name, message.bytes);
            options.onProgress?.({ completedFiles: files.size, totalFiles });
            if (!settled) onStatus?.(`已提取 ${message.name}（${formatArchiveBytes(message.bytes.length)}）`);
          } else if (message.type === 'done') {
            const found = message.found;
            const lower = new Set(found.map((name) => name.toLowerCase()));
            const missing = wanted.filter((name) => !lower.has(name.toLowerCase()));
            cleanup();
            resolve({ files, found, missing });
          } else {
            fail(new Error(message.message));
          }
        } catch (error) {
          fail(error);
        }
      };
      worker.onerror = (event) => fail(new Error(event.message || '归档提取 Worker 异常'));
      worker.onmessageerror = () => fail(new Error('归档提取 Worker 消息解码失败'));
      options.onPrioritizeReady?.((name) => send({ type: 'prioritize', name }));
      if (settled) return;
      const request = {
        type: 'extract' as const,
        wanted,
        extensions,
        directoryRules: options.directoryRules,
        layers: options.layers,
      };
      if (bytes instanceof Blob) {
        // The browser owns File; pass it to WORKERFS without copying the entire archive.
        send({ ...request, archive: bytes });
      } else {
        // Transfer only an exclusive copy, never detaching source bytes still owned by the caller.
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        send({ ...request, buffer }, [buffer]);
      }
    } catch (error) {
      fail(error);
    }
  });
}

/** Run bounded archive batches in fresh Workers so iOS can reclaim the grown 7z WASM heap between batches. */
function extractArchiveByBatch(
  bytes: Uint8Array | Blob,
  options: ArchiveExtractOptions,
): Promise<ArchiveExtractResult> {
  const files = new Map<string, Uint8Array>();
  const found = new Set<string>();
  const targets = [...new Set(options.wanted.map((name) => name.toLowerCase()))];
  let activeWorker: Worker | undefined;
  let aborted = false;
  const abort = () => {
    aborted = true;
    activeWorker?.terminate();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const runTargets = (batch: readonly string[]): Promise<number> =>
    new Promise((resolve, reject) => {
      if (aborted) {
        reject(new DOMException('归档提取已取消', 'AbortError'));
        return;
      }
      const worker = new Worker(new URL('./archiveExtractWorker.ts', import.meta.url), { type: 'module' });
      activeWorker = worker;
      let settled = false;
      let batchBytes = 0;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        if (activeWorker === worker) activeWorker = undefined;
        if (error) reject(error);
        else resolve(batchBytes);
      };
      worker.onmessage = (event: MessageEvent<ArchiveExtractResponse>) => {
        const message = event.data;
        if (message.type === 'status') options.onStatus?.(`[低内存归档] ${message.message}`);
        else if (message.type === 'file') {
          files.set(message.name, message.bytes);
          found.add(message.name.toLowerCase());
          batchBytes += message.bytes.byteLength;
          options.onFile?.(message.name, message.bytes);
          options.onProgress?.({ completedFiles: found.size, totalFiles: null });
        } else if (message.type === 'done') {
          for (const name of message.found) found.add(name.toLowerCase());
          finish();
        } else if (message.type === 'error') finish(new Error(message.message));
      };
      worker.onerror = (event) => finish(new Error(event.message || '归档解压 Worker 异常'));
      worker.onmessageerror = () => finish(new Error('归档解压 Worker 消息解码失败'));
      const request = {
        type: 'extract' as const,
        wanted: [...batch],
        extensions: options.extensions,
        directoryRules: options.directoryRules,
      };
      if (bytes instanceof Blob) worker.postMessage({ ...request, archive: bytes });
      else {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        worker.postMessage({ ...request, buffer }, [buffer]);
      }
    });
  return (async () => {
    try {
      let index = 0;
      let batchSize = 1;
      while (index < targets.length) {
        const batch = targets.slice(index, index + batchSize);
        const extractedBytes = await runTargets(batch);
        index += batch.length;
        // Large outputs stay isolated; small outputs share the next Worker to reduce full-RAR rescans.
        batchSize = extractedBytes >= 32 * 1024 * 1024 ? 1 : extractedBytes >= 8 * 1024 * 1024 ? 2 : 4;
      }
      return {
        files,
        found: [...found],
        missing: options.wanted.filter((name) => !found.has(name.toLowerCase())),
      };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      activeWorker?.terminate();
    }
  })();
}

function isArchiveBlob(bytes: Uint8Array | Blob): boolean {
  return (
    bytes instanceof Blob &&
    'name' in bytes &&
    typeof bytes.name === 'string' &&
    /\.(?:rar|7z|zip|exe)$/i.test(bytes.name)
  );
}

function formatArchiveBytes(size: number): string {
  return size >= 1048576
    ? `${(size / 1048576).toFixed(1)} MB`
    : size >= 1024
      ? `${Math.floor(size / 1024)} KB`
      : `${size} B`;
}
