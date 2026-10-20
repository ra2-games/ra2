import { afterEach, expect, it, vi } from 'vitest';
import { HttpGameFileProvider } from '../../src/platform/browser/files/http';
import { readGuestFileSearch } from '../../src/adapter/fileSearch';

afterEach(() => vi.unstubAllGlobals());
function setup(fetch: typeof globalThis.fetch) {
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('fetch', fetch);
  return new HttpGameFileProvider();
}
function partial(bytes: number[], total = bytes.length) {
  return new Response(new Uint8Array(bytes), {
    status: 206,
    headers: { 'Content-Range': `bytes 0-${bytes.length - 1}/${total}` },
  });
}
it('重复地图枚举只请求一次前缀，返回真实文件长度', async () => {
  const fetch = vi.fn(async (url: RequestInfo | URL) =>
    String(url).includes('.list') ? new Response('["yuriplot.mmx"]') : partial([7], 246152),
  );
  const files = setup(fetch);
  for (let i = 0; i < 5; i++)
    expect(await readGuestFileSearch(files, 'ra2/*.mmx')).toEqual([{ path: 'ra2/yuriplot.mmx', size: 246152 }]);
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('yuriplot.mmx'))).toHaveLength(1);
});
it('同一路径并发读取合并，较小读取复用，返回缓冲互不共享', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const files = setup(fetch);
  const first = files.readPrefix('RA2/YuriPlot.mmx', 3);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const second = files.readPrefix('ra2/yuriplot.mmx', 1);
  finish(partial([7, 8, 9], 10));
  const a = await first,
    b = await second;
  a!.bytes.fill(0);
  b!.bytes.fill(0);
  expect(await files.readPrefix('ra2/yuriplot.mmx', 2)).toEqual({ bytes: new Uint8Array([7, 8]), totalSize: 10 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('失败和缺失不污染缓存，零字节文件仍然存在', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(new Uint8Array()));
  const files = setup(fetch);
  await expect(files.readPrefix('a', 1)).rejects.toThrow('HTTP 500');
  expect(await files.readPrefix('a', 1)).toBeNull();
  expect(await files.readPrefix('a', 1)).toEqual({ bytes: new Uint8Array(), totalSize: 0 });
  expect(await files.readPrefix('a', 1)).toEqual({ bytes: new Uint8Array(), totalSize: 0 });
  expect(fetch).toHaveBeenCalledTimes(3);
});
it('失效后旧请求不能覆盖新内容，写入覆盖缓存与在途结果', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () => partial([9], 2));
  const files = setup(fetch);
  const old = files.readPrefix('a', 1);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  files.invalidateCache();
  expect((await files.readPrefix('a', 1))!.bytes[0]).toBe(9);
  finish(partial([1], 2));
  await old;
  expect((await files.readPrefix('a', 1))!.bytes[0]).toBe(9);
  await files.write('a', new Uint8Array([5, 6, 7]));
  expect(await files.readPrefix('a', 2)).toEqual({ bytes: new Uint8Array([5, 6]), totalSize: 3 });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('缓存按总字节淘汰旧前缀，不持有全部大文件', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(new Uint8Array(65536), { status: 206, headers: { 'Content-Range': 'bytes 0-65535/1000000' } }),
  );
  const files = setup(fetch);
  for (let i = 0; i < 65; i++) await files.readPrefix(`file${i}`, 65536);
  await files.readPrefix('file64', 1);
  expect(fetch).toHaveBeenCalledTimes(65);
  await files.readPrefix('file0', 1);
  expect(fetch).toHaveBeenCalledTimes(66);
});
