/** The browser owns only Worker messaging and WASM locations; extraction algorithms are shared with CI. */
import wasmUrl from '7z-wasm/7zz.wasm?url';
import { createArchiveExtractor, type ArchiveExtractRequest } from './archiveExtractor';
export type { ArchiveExtractRequest, ArchiveExtractResponse } from './archiveExtractor';

const extract = createArchiveExtractor({
  locateFile: () => wasmUrl,
  post: (message, transfer = []) => (self as unknown as Worker).postMessage(message, transfer),
});
self.onmessage = (event: MessageEvent<ArchiveExtractRequest | { type: 'prioritize'; name: string }>) =>
  extract(event.data);
