import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { extractArchiveFiles, type ArchiveExtractOptions } from '../../src/utils/archive/archiveExtract';
import type { ArchiveExtractResponse } from '../../src/utils/archive/archiveExtractor';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: ArchiveExtractResponse }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  emit(data: ArchiveExtractResponse) {
    this.onmessage?.({ data });
  }
}
const latest = () => FakeWorker.instances.at(-1)!;
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('初始化回调抛错时终止 Worker 并移除取消监听', async () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const error = new Error('初始化失败');
  await expect(
    extractArchiveFiles(new Uint8Array(), {
      wanted: [],
      signal: controller.signal,
      onPrioritizeReady() {
        throw error;
      },
    }),
  ).rejects.toBe(error);
  expect(latest().terminate).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(latest().postMessage).not.toHaveBeenCalled();
});

it.each([
  ['onStatus', { type: 'status', message: '进度' }],
  ['onProgress', { type: 'catalog', names: ['file'] }],
  ['onCatalog', { type: 'catalog', names: ['file'] }],
  ['onStartupReady', { type: 'startup-ready' }],
  ['onFile', { type: 'file', name: 'file', bytes: new Uint8Array([1]) }],
] satisfies Array<[keyof ArchiveExtractOptions, ArchiveExtractResponse]>)(
  '%s 抛错后拒绝任务，已排队的 done 和保留的优先请求失效',
  async (callback, message) => {
    const error = new Error('消费失败');
    let prioritize!: (name: string) => void;
    const task = extractArchiveFiles(new Uint8Array(), {
      wanted: ['file'],
      onPrioritizeReady(value) {
        prioritize = value;
      },
      [callback]: () => {
        throw error;
      },
    });
    const worker = latest();
    const queued = worker.onmessage!;
    const rejection = expect(task).rejects.toBe(error);
    expect(() => worker.emit(message)).not.toThrow();
    queued({ data: { type: 'done', found: ['file'] } });
    prioritize('file');
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
  },
);

it.each(['initial', 'prioritize'] as const)('%s postMessage 同步失败会拒绝并清理', async (kind) => {
  const error = new DOMException('不可克隆', 'DataCloneError');
  let prioritize!: (name: string) => void;
  const task = extractArchiveFiles(new Uint8Array(), {
    wanted: [],
    onPrioritizeReady(value) {
      prioritize = value;
      if (kind === 'initial')
        latest().postMessage.mockImplementation(() => {
          throw error;
        });
    },
  });
  const rejection = expect(task).rejects.toBe(error);
  if (kind === 'prioritize') {
    latest().postMessage.mockImplementation(() => {
      throw error;
    });
    prioritize('file');
  }
  await rejection;
  expect(latest().terminate).toHaveBeenCalledOnce();
});

it('预取消不创建 Worker，初始化中取消不发送提取请求', async () => {
  const before = new AbortController();
  before.abort();
  await expect(extractArchiveFiles(new Uint8Array(), { wanted: [], signal: before.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(FakeWorker.instances).toHaveLength(0);
  const during = new AbortController();
  await expect(
    extractArchiveFiles(new Uint8Array(), {
      wanted: [],
      signal: during.signal,
      onPrioritizeReady: () => during.abort(),
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(latest().postMessage).not.toHaveBeenCalled();
  expect(latest().terminate).toHaveBeenCalledOnce();
});

it('成功后不再响应取消或消息，只转移源字节的独占副本', async () => {
  const controller = new AbortController();
  const source = new Uint8Array([1, 2, 3]);
  const task = extractArchiveFiles(source.subarray(1), { wanted: ['FILE', 'missing'], signal: controller.signal });
  const worker = latest();
  const [request, transfer] = worker.postMessage.mock.calls[0]!;
  expect(new Uint8Array(request.buffer)).toEqual(new Uint8Array([2, 3]));
  expect(transfer).toEqual([request.buffer]);
  expect(request.buffer).not.toBe(source.buffer);
  worker.emit({ type: 'file', name: 'file', bytes: new Uint8Array([8]) });
  worker.emit({ type: 'done', found: ['file'] });
  expect(await task).toEqual({
    files: new Map([['file', new Uint8Array([8])]]),
    found: ['file'],
    missing: ['missing'],
  });
  controller.abort();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(source).toEqual(new Uint8Array([1, 2, 3]));
});

it('reports delivered files against the catalog without treating startup readiness as completion', async () => {
  const onProgress = vi.fn();
  const task = extractArchiveFiles(new Uint8Array(), { wanted: ['a', 'b'], onProgress });
  const worker = latest();
  worker.emit({ type: 'catalog', names: ['a', 'b'] });
  worker.emit({ type: 'file', name: 'a', bytes: new Uint8Array() });
  worker.emit({ type: 'startup-ready' });
  expect(onProgress).toHaveBeenLastCalledWith({ completedFiles: 1, totalFiles: 2 });
  worker.emit({ type: 'file', name: 'a', bytes: new Uint8Array([1]) });
  expect(onProgress).toHaveBeenLastCalledWith({ completedFiles: 1, totalFiles: 2 });
  worker.emit({ type: 'file', name: 'b', bytes: new Uint8Array([2]) });
  expect(onProgress).toHaveBeenLastCalledWith({ completedFiles: 2, totalFiles: 2 });
  worker.emit({ type: 'done', found: ['a', 'b'] });
  await task;
});

it('keeps the total unknown for extraction without a complete catalog', async () => {
  const onProgress = vi.fn();
  const task = extractArchiveFiles(new Uint8Array(), { wanted: ['a', 'missing'], onProgress });
  latest().emit({ type: 'file', name: 'a', bytes: new Uint8Array([1]) });
  expect(onProgress).toHaveBeenLastCalledWith({ completedFiles: 1, totalFiles: null });
  latest().emit({ type: 'done', found: ['a'] });
  expect((await task).missing).toEqual(['missing']);
});
