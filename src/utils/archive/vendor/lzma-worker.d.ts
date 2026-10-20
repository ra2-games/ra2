export interface LzmaSdk {
  decompress(
    input: Uint8Array,
    onFinish: (result: Uint8Array | null, error?: string | { message?: string } | null) => void,
    onProgress?: (percent: number) => void,
  ): void;
}

export const LZMA: LzmaSdk;
export const LZMA_WORKER: LzmaSdk;
