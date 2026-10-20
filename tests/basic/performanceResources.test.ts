import { afterEach, describe, expect, it, vi } from 'vitest';
import { RangePrefetch } from '../../src/adapter/rangePrefetch';
import { FrameBufferPool } from '../../src/adapter/frameBufferPool';
import { HttpGameFileProvider } from '../../src/platform/browser/files/http';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';

afterEach(() => vi.unstubAllGlobals());

describe('有界预取与呈现缓冲复用', () => {
  it('连续跳读不会堆积多个在途预取，销毁后的慢读取不再启动预取', async () => {
    const provider = new MemoryGameFileProvider(new Map());
    let finish!: (bytes: Uint8Array) => void;
    const read = vi.spyOn(provider, 'readRange').mockImplementation(async (_path, offset) => {
      if (offset === 1)
        return new Promise<Uint8Array>((resolve) => {
          finish = resolve;
        });
      return new Uint8Array([offset]);
    });
    const prefetch = new RangePrefetch();
    await prefetch.read(provider, 'a', 0, 1, 2);
    await prefetch.read(provider, 'a', 3, 1, 5);
    expect(read).toHaveBeenCalledTimes(3);
    prefetch.clear();
    finish(new Uint8Array([1]));
    await Promise.resolve();
    let finishDemand!: (bytes: Uint8Array) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDemand = resolve;
        }),
    );
    const demand = prefetch.read(provider, 'a', 0, 1, 2);
    prefetch.clear();
    finishDemand(new Uint8Array([0]));
    await demand;
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('HTTP 忽略 Range 时复用完整 Blob，失效后重新请求', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const provider = new HttpGameFileProvider();
    expect(await provider.readPrefix('ra2/movies01.mix', 1)).toEqual({ bytes: new Uint8Array([1]), totalSize: 4 });
    expect(await provider.readRange('ra2/movies01.mix', 2, 2)).toEqual(new Uint8Array([3, 4]));
    expect(fetch).toHaveBeenCalledTimes(1);
    provider.invalidateCache();
    await provider.readRange('ra2/movies01.mix', 0, 1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('后续页复用在途读取，到 EOF 不再预取，clear 后重新读取', async () => {
    const provider = new MemoryGameFileProvider(new Map([['a', new Uint8Array([1, 2, 3, 4])]]));
    const read = vi.spyOn(provider, 'readRange');
    const prefetch = new RangePrefetch();
    expect(await prefetch.read(provider, 'a', 0, 2, 4)).toEqual(new Uint8Array([1, 2]));
    expect(read).toHaveBeenCalledTimes(2);
    expect(await prefetch.read(provider, 'a', 2, 2, 4)).toEqual(new Uint8Array([3, 4]));
    expect(read).toHaveBeenCalledTimes(2);
    await prefetch.read(provider, 'a', 0, 2, 4);
    prefetch.clear();
    await prefetch.read(provider, 'a', 2, 2, 4);
    expect(read).toHaveBeenCalledTimes(5);
  });
  it('预取失败静默，真正访问时重试；不跨 provider 命中旧页', async () => {
    const provider = new MemoryGameFileProvider(new Map([['a', new Uint8Array([1, 2, 3, 4])]]));
    const read = vi.spyOn(provider, 'readRange');
    read.mockImplementationOnce(async () => new Uint8Array([1, 2])).mockRejectedValueOnce(new Error('临时失败'));
    const prefetch = new RangePrefetch();
    await prefetch.read(provider, 'a', 0, 2, 4);
    expect(await prefetch.read(provider, 'a', 2, 2, 4)).toEqual(new Uint8Array([3, 4]));
    await prefetch.read(provider, 'a', 0, 2, 4);
    const other = new MemoryGameFileProvider(new Map([['a', new Uint8Array([9, 9, 8, 8])]]));
    expect(await prefetch.read(other, 'a', 2, 2, 4)).toEqual(new Uint8Array([8, 8]));
  });
  it('只复用精确尺寸，池最多留两帧，不收超大/已转移缓冲', () => {
    const pool = new FrameBufferPool();
    const a = new ArrayBuffer(8),
      b = new ArrayBuffer(16),
      c = new ArrayBuffer(32);
    pool.release(a);
    pool.release(b);
    pool.release(c);
    expect(pool.take(8)).not.toBe(a);
    expect(pool.take(16)).toBe(b);
    expect(pool.take(32)).toBe(c);
    pool.release(a);
    pool.clear();
    expect(pool.take(8)).not.toBe(a);
    pool.release(new ArrayBuffer(0));
    const large = new ArrayBuffer(17 * 1024 * 1024);
    pool.release(large);
    expect(pool.take(large.byteLength)).not.toBe(large);
  });
});
