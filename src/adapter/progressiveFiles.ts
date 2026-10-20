import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { normalizeGuestPath } from '../vm86/paths';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { ScopedGameFileProvider } from '../resources/providers/scoped';
import { type GameFileProvider } from '../resources/contracts';

export interface ResourceLoadStatus {
  phase: 'loading' | 'complete' | 'error';
  detail: string;
  loaded: number;
  total: number;
}

/**
 * Publish the directory before content arrives; incomplete files are not ENOENT, and reads must wait for extraction.
 * Inherit session save semantics, but not the memory provider's synchronous prefix/range reads.
 */
export class ProgressiveGameFileProvider extends SessionGameFileProvider {
  private readonly pending = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  >();
  private readonly written = new Set<string>();
  private failure: Error | null = null;
  private complete = false;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;
  readonly completion = new Promise<void>((resolve, reject) => {
    this.resolveCompletion = resolve;
    this.rejectCompletion = reject;
  });
  private readonly listeners = new Set<(status: ResourceLoadStatus) => void>();
  private detail = '启动层已就绪，其他资源后台解压中';
  private loaded = 0;

  constructor(
    label: string,
    readonly inventory: ReadonlySet<string>,
    private readonly abortExtraction: () => void = () => {},
    private readonly prioritize: (name: string) => void = () => {},
  ) {
    super(label, new Map());
    // Notify readers/UI of errors without creating unhandled rejections before cache-save subscribers attach.
    void this.completion.catch(() => {});
  }

  subscribe(listener: (status: ResourceLoadStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }
  status(): ResourceLoadStatus {
    return {
      phase: this.failure ? 'error' : this.complete ? 'complete' : 'loading',
      detail: this.detail,
      loaded: this.loaded,
      total: this.inventory.size,
    };
  }
  updateStatus(detail: string): void {
    this.detail = detail;
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
  cancel(): void {
    if (this.complete) return;
    this.abortExtraction();
    this.finish(new Error('后台解压已取消；重新导入以恢复完整资源'));
  }

  accept(path: string, bytes: Uint8Array): void {
    if (this.complete) return;
    const name = normalizeGuestPath(path);
    if (!this.files.has(name) && this.inventory.has(name)) this.loaded++;
    if (!this.written.has(name)) this.files.set(name, bytes);
    this.pending.get(name)?.resolve();
    this.pending.delete(name);
    this.updateStatus(this.detail);
  }

  finish(error?: Error): void {
    if (this.complete) return;
    error ??= [...this.inventory].some((name) => !this.files.has(name))
      ? new Error('归档未完整解出已列出的资源')
      : undefined;
    this.complete = true;
    this.failure = error ?? null;
    for (const [name, waiter] of this.pending) {
      if (this.files.has(name)) waiter.resolve();
      else waiter.reject(error ?? new Error(`归档未能解出文件：${name}`));
    }
    this.pending.clear();
    if (error) this.rejectCompletion(error);
    else this.resolveCompletion();
    this.updateStatus(error ? `后台资源加载失败：${error.message}` : '全部资源已就绪');
  }

  override hasKnownFile(path: string): boolean | null {
    return this.inventory.has(normalizeGuestPath(path)) || super.hasKnownFile(path);
  }

  private async waitFile(path: string): Promise<void> {
    const name = normalizeGuestPath(path);
    if (this.files.has(name) || !this.inventory.has(name)) return;
    if (this.complete) throw this.failure ?? new Error(`归档未能解出文件：${name}`);
    let waiter = this.pending.get(name);
    if (!waiter) {
      this.prioritize(name);
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      waiter = { promise, resolve, reject };
      this.pending.set(name, waiter);
    }
    await waiter.promise;
  }

  override async read(path: string): Promise<Uint8Array | null> {
    await this.waitFile(path);
    return super.read(path);
  }
  override async readPrefix(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null> {
    await this.waitFile(path);
    const bytes = this.files.get(normalizeGuestPath(path));
    if (bytes) return { bytes: bytes.slice(0, maxBytes), totalSize: bytes.length };
    const stored = await super.read(path);
    return stored ? { bytes: stored.slice(0, maxBytes), totalSize: stored.length } : null;
  }
  override async readRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    await this.waitFile(path);
    const bytes = this.files.get(normalizeGuestPath(path)) ?? (await super.read(path));
    return bytes?.slice(offset, offset + length) ?? null;
  }
  override async write(path: string, bytes: Uint8Array): Promise<void> {
    const name = normalizeGuestPath(path);
    if (!this.files.has(name) && this.inventory.has(name)) this.loaded++;
    this.written.add(name);
    this.files.set(name, bytes.slice());
    this.pending.get(name)?.resolve();
    this.pending.delete(name);
    await super.write(path, bytes);
  }
  override async list(directory: string): Promise<string[]> {
    const prefix = normalizeGuestPath(directory);
    const names = new Set((await super.list(directory)) ?? []);
    for (const path of this.inventory) {
      if (prefix && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      if (rest) names.add(rest.split('/')[0]!);
    }
    return [...names];
  }
}

export function progressiveFilesOf(provider: GameFileProvider): ProgressiveGameFileProvider | null {
  if (provider instanceof ProgressiveGameFileProvider) return provider;
  if (provider instanceof OverlayGameFileProvider || provider instanceof ScopedGameFileProvider)
    return progressiveFilesOf(provider.parent);
  return null;
}
