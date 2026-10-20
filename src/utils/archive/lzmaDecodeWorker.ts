/** NSIS solid LZMA decoding Worker: transfer the entire input buffer in and decoded output back to the main thread. */
import { LZMA as lzma } from './vendor/lzma-worker.js';
import { buildLzmaAloneInput, type LzmaDecodeWorkerMessage } from './lzmaDecode';

export interface LzmaDecodeRequest {
  input: { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  outputSize?: number;
  reportConsumed?: boolean;
}

self.onmessage = (event: MessageEvent<LzmaDecodeRequest>) => {
  const { input, outputSize, reportConsumed } = event.data;
  const stream = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const post = (message: LzmaDecodeWorkerMessage, transfer?: Transferable[]): void => {
    (self as unknown as Worker).postMessage(message, transfer ?? []);
  };
  try {
    const withHeader = buildLzmaAloneInput(stream, outputSize);
    lzma.decompress(
      withHeader,
      (result, error) => {
        if (!result) {
          post({ ok: false, error: typeof error === 'string' ? error : (error?.message ?? 'LZMA 解码失败') });
          return;
        }
        if (outputSize !== undefined && result.length < outputSize) {
          post({ ok: false, error: `LZMA 输出长度不足：${result.length} < ${outputSize}` });
          return;
        }
        // SDK decode() returns String for pure ASCII and plain arrays on some paths;
        // normalize all results to Uint8Array.
        const raw =
          result instanceof Uint8Array
            ? result
            : typeof result === 'string'
              ? new TextEncoder().encode(result)
              : Uint8Array.from(result);
        // SDK block filling may overshoot the target by a final 1-2 bytes; trim to length.
        const output = outputSize !== undefined ? raw.subarray(0, outputSize) : raw;
        post(
          {
            ok: true,
            result: output,
            consumed: reportConsumed
              ? ((lzma as { getLastInputConsumed?: () => number }).getLastInputConsumed?.() ?? 0)
              : undefined,
          },
          [output.buffer],
        );
      },
      (percent) => {
        post({ progress: percent });
      },
    );
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
