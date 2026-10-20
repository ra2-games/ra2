/**
 * LZMA-Alone decoding wrapper for NSIS solid blocks. Browsers decode in module Workers; Node/tests call the vendored LZMA SDK JS implementation directly. NSIS has a 5-byte props+dict header without length; add an 8-byte length to form the standard 13-byte header. Use all FF when length is unknown to decode through end of stream.
 */

export interface LzmaDecodeOptions {
  /**
   * 5-byte props+dict header followed by compressed data. The backing buffer may transfer during the call and must not be reused unless transferInput=false.
   */
  stream: Uint8Array;
  /** Expected output length, strictly checked when supplied. */
  outputSize?: number;
  /** Progress fraction, or -1 when unavailable; unknown-size streams may report consumed-input progress. */
  onProgress?: (percent: number) => void;
  /**
   * Whether the Worker transfers the input buffer; default true. Use false when decoding multiple views of one large buffer, as with NSIS per-file streams, to avoid detaching it.
   */
  transferInput?: boolean;
}

/** Construct standard LZMA-Alone input: props+dict (5), length (8), then data. */
export function buildLzmaAloneInput(stream: Uint8Array, outputSize?: number): Uint8Array {
  const result = new Uint8Array(stream.length + 8);
  result.set(stream.subarray(0, 5), 0);
  const sizeView = new DataView(result.buffer);
  if (outputSize === undefined) {
    sizeView.setUint32(5, 0xffffffff, true);
    sizeView.setUint32(9, 0xffffffff, true);
  } else {
    sizeView.setUint32(5, outputSize >>> 0, true);
    sizeView.setUint32(9, Math.floor(outputSize / 0x100000000), true);
  }
  result.set(stream.subarray(5), 13);
  return result;
}

export interface LzmaDecodeWorkerMessage {
  ok?: boolean;
  progress?: number;
  result?: Uint8Array;
  /** Input bytes consumed by the SDK, including the 13-byte LZMA-Alone header; returned with reportConsumed. */
  consumed?: number;
  error?: string;
}

/**
 * Decoded output plus SDK-consumed input bytes, including the 13-byte LZMA-Alone header.
 * NSIS two-stage streams use this to locate payload data after the EOS-terminated header stream.
 */
export interface LzmaDecodedStream {
  output: Uint8Array;
  consumed: number;
}

/** Decode in a dedicated Worker so decoding hundreds of MB does not block the main thread. */
async function decodeInWorker(options: LzmaDecodeOptions, reportConsumed: boolean): Promise<LzmaDecodedStream> {
  const worker = new Worker(new URL('./lzmaDecodeWorker.ts', import.meta.url), { type: 'module' });
  // Clear heartbeats in finally; cleanup only in Worker callbacks would miss synchronous postMessage failures.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<LzmaDecodedStream>((resolve, reject) => {
      // Whole-stream NSIS decoding has unknown length and no intermediate SDK progress; periodic heartbeats let the UI show elapsed time.
      let lastProgressAt = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastProgressAt >= 2000) options.onProgress?.(-1);
      }, 3000);
      worker.onmessage = (event: MessageEvent<LzmaDecodeWorkerMessage>) => {
        const message = event.data;
        if (message.progress !== undefined) {
          lastProgressAt = Date.now();
          options.onProgress?.(message.progress);
          return;
        }
        if (message.ok && message.result) resolve({ output: message.result, consumed: message.consumed ?? 0 });
        else reject(new Error(message.error ?? 'LZMA 解码失败'));
      };
      worker.onerror = (event) => {
        reject(new Error(event.message || 'LZMA Worker 异常'));
      };
      // Transfer the entire input buffer; the cloned Worker view retains offset/length, and the main thread stops using it.
      const input = {
        buffer: options.stream.buffer,
        byteOffset: options.stream.byteOffset,
        byteLength: options.stream.byteLength,
      } as unknown as Uint8Array;
      try {
        worker.postMessage(
          {
            input,
            outputSize: options.outputSize,
            reportConsumed,
          },
          options.transferInput === false ? [] : [options.stream.buffer],
        );
      } catch (error: unknown) {
        // postMessage throws DataCloneError synchronously if the input buffer is already detached;
        // reject synchronously too, or the Promise and caller will hang forever.
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    worker.terminate();
  }
}

/** Call the vendored implementation directly in Node/tests. */
async function decodeInline(options: LzmaDecodeOptions, reportConsumed: boolean): Promise<LzmaDecodedStream> {
  // The vendored file now exports ESM explicitly; supply a self global in Node for its internals.
  (globalThis as Record<string, unknown>).self ??= globalThis;
  (globalThis as Record<string, unknown>).window ??= globalThis;
  const { LZMA: lzma } = await import('./vendor/lzma-worker.js');
  const input = buildLzmaAloneInput(options.stream, options.outputSize);
  // The SDK's consumed offset includes the synthetic 13-byte LZMA-Alone header.
  const compressedBytesTotal = input.length - 13;
  const getLastInputConsumed = (lzma as { getLastInputConsumed?: () => number }).getLastInputConsumed;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lastProgressAt = Date.now();
  heartbeat = setInterval(() => {
    if (Date.now() - lastProgressAt < 2000) return;
    if (options.outputSize === undefined && compressedBytesTotal > 0 && getLastInputConsumed) {
      const compressedBytesConsumed = getLastInputConsumed() - 13;
      options.onProgress?.(Math.min(0.99, Math.max(0, compressedBytesConsumed / compressedBytesTotal)));
    } else {
      options.onProgress?.(-1);
    }
  }, 3000);
  return new Promise<LzmaDecodedStream>((resolve, reject) => {
    lzma.decompress(
      input,
      (result, error) => {
        if (!result) {
          reject(new Error(typeof error === 'string' ? error : (error?.message ?? 'LZMA 解码失败')));
          return;
        }
        if (options.outputSize !== undefined && result.length < options.outputSize) {
          reject(new Error(`LZMA 输出长度不足：${result.length} < ${options.outputSize}`));
          return;
        }
        // SDK decode() returns String for pure ASCII output without NUL/high bytes,
        // and plain arrays on some paths; normalize all results to Uint8Array.
        const raw =
          result instanceof Uint8Array
            ? result
            : typeof result === 'string'
              ? new TextEncoder().encode(result)
              : Uint8Array.from(result);
        // SDK block filling may overshoot the target by a final 1-2 bytes; trim to length.
        const output = options.outputSize !== undefined ? raw.subarray(0, options.outputSize) : raw;
        resolve({
          output,
          consumed: reportConsumed
            ? ((lzma as { getLastInputConsumed?: () => number }).getLastInputConsumed?.() ?? 0)
            : 0,
        });
      },
      (percent) => {
        lastProgressAt = Date.now();
        options.onProgress?.(percent);
      },
    );
  }).finally(() => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  });
}

async function decodeLzmaStreamInternal(
  options: LzmaDecodeOptions,
  reportConsumed: boolean,
): Promise<LzmaDecodedStream> {
  if (typeof Worker !== 'undefined' && typeof document !== 'undefined' && !import.meta.env?.VITEST) {
    return decodeInWorker(options, reportConsumed);
  }
  return decodeInline(options, reportConsumed);
}

export function decodeLzmaStream(options: LzmaDecodeOptions): Promise<Uint8Array> {
  return decodeLzmaStreamInternal(options, false).then((decoded) => decoded.output);
}

/** Decode and return SDK-consumed input bytes, including the 13-byte LZMA-Alone header. */
export function decodeLzmaStreamWithConsumed(options: LzmaDecodeOptions): Promise<LzmaDecodedStream> {
  return decodeLzmaStreamInternal(options, true);
}
