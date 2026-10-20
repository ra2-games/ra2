import { installVmWorker } from './vmWorkerController';
import type { MainToWorkerMessage, WorkerToMainMessage } from './vmProtocol';

interface WorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
}

// self exists only in an actual Dedicated Worker; avoid activating this in Node tests.
if (typeof self !== 'undefined') {
  installVmWorker(self as unknown as WorkerScope);
}
