import { createServer, connect, type AddressInfo, type Socket } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';

/** Fixed one-way test latency: queue each chunk by arrival time; serial sleeps per chunk would incorrectly impose a bandwidth limit. */
export class DelayedStream extends Transform {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private pendingBytes = 0;
  private releaseWriter?: TransformCallback;
  private finish?: TransformCallback;
  constructor(private readonly delayMs: number) {
    super();
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('单程延迟必须为 0–1000ms');
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.delayMs === 0) {
      callback(null, chunk);
      return;
    }
    this.pendingBytes += chunk.length;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.pendingBytes -= chunk.length;
      this.push(chunk);
      this.releasePendingWriter();
      if (!this.timers.size) {
        const finish = this.finish;
        this.finish = undefined;
        finish?.();
      }
    }, this.delayMs);
    this.timers.add(timer);
    // Propagate backpressure to the source socket; do not buffer indefinitely for connections that stop reading.
    if (this.pendingBytes >= this.writableHighWaterMark || this.readableLength >= this.readableHighWaterMark)
      this.releaseWriter = callback;
    else callback();
  }
  private releasePendingWriter(): void {
    if (this.pendingBytes >= this.writableHighWaterMark || this.readableLength >= this.readableHighWaterMark) return;
    const release = this.releaseWriter;
    this.releaseWriter = undefined;
    release?.();
  }
  override _read(size: number): void {
    super._read(size);
    if (this.pendingBytes < this.writableHighWaterMark) {
      const release = this.releaseWriter;
      this.releaseWriter = undefined;
      release?.();
    }
  }
  override _flush(callback: TransformCallback): void {
    if (this.timers.size) this.finish = callback;
    else callback();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pendingBytes = 0;
    this.releaseWriter?.(error);
    this.releaseWriter = undefined;
    this.finish?.(error);
    this.finish = undefined;
    callback(error);
  }
}

/** Proxy only explicit test targets, including WS handshakes, heartbeats, and data, preserving raw-byte order. */
export async function startLatencyProxy(targetUrl: string, delayMs: number) {
  const target = new URL(targetUrl);
  if (target.protocol !== 'ws:') throw new Error('延迟对照需要显式 ws:// relay');
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('单程延迟必须为 0–1000ms');
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 80), target.hostname.replace(/^\[|\]$/g, ''));
    const outgoing = new DelayedStream(delayMs),
      incoming = new DelayedStream(delayMs);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.setNoDelay();
    }
    const close = () => {
      for (const socket of [client, upstream]) {
        sockets.delete(socket);
        socket.destroy();
      }
      outgoing.destroy();
      incoming.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
    }
    outgoing.on('error', close);
    incoming.on('error', close);
    client.pipe(outgoing).pipe(upstream);
    upstream.pipe(incoming).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as AddressInfo).port);
  return {
    url: url.href,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
