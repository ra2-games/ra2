import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressiveGameFileProvider } from '../../src/adapter/progressiveFiles';
import { PortGameFileProvider, serveFileProvider } from '../../src/adapter/fileProviderPort';
import { gameArchiveLayers } from '../../src/games/archivePolicy';

afterEach(() => vi.unstubAllGlobals());
const make = (names = ['ra2.mix', 'movies01.mix']) => {
  vi.stubGlobal('indexedDB', undefined);
  return new ProgressiveGameFileProvider('两层测试', new Set(names));
};
describe('两层资源存在性和等待语义', () => {
  it('未就绪文件只提优先级一次，写入和后到交付不会重复计算进度', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const prioritize = vi.fn();
    const provider = new ProgressiveGameFileProvider('测试', new Set(['a']), () => {}, prioritize);
    const first = provider.read('a');
    const second = provider.readPrefix('a', 1);
    expect(prioritize).toHaveBeenCalledExactlyOnceWith('a');
    await provider.write('a', new Uint8Array([7]));
    provider.accept('a', new Uint8Array([9]));
    expect(await first).toEqual(new Uint8Array([7]));
    await second;
    expect(provider.status().loaded).toBe(1);
  });
  it('目录先完整可见，读取尚未解出的文件等待，空文件和缺失不同', async () => {
    const files = make();
    expect(await files.list('')).toEqual(['ra2.mix', 'movies01.mix']);
    expect(files.hasKnownFile('MOVIES01.MIX')).toBe(true);
    const done = vi.fn();
    const read = files.read('movies01.mix').then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    files.accept('movies01.mix', new Uint8Array());
    await read;
    expect(done).toHaveBeenCalledWith(new Uint8Array());
    expect(await files.read('absent.mix')).toBeNull();
  });
  it('前缀、分段和全文读都等待同一个文件，返回独立字节', async () => {
    const files = make(['movie.mix']);
    const all = files.read('movie.mix');
    const prefix = files.readPrefix('movie.mix', 2);
    const range = files.readRange('movie.mix', 1, 2);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    files.accept('movie.mix', bytes);
    expect(await prefix).toEqual({ bytes: new Uint8Array([1, 2]), totalSize: 4 });
    expect(await range).toEqual(new Uint8Array([2, 3]));
    (await all)![0] = 9;
    expect(bytes[0]).toBe(1);
    files.finish();
    await files.completion;
  });
  it('解压失败/取消拒绝等待者和完整缓存承诺，不能无限等待或返回 null', async () => {
    const files = make();
    const read = files.read('ra2.mix');
    const pending = expect(read).rejects.toThrow('损坏');
    files.finish(new Error('压缩包损坏'));
    await pending;
    await expect(files.completion).rejects.toThrow('损坏');
    await expect(files.readPrefix('movies01.mix', 4)).rejects.toThrow('损坏');
    expect(files.status().phase).toBe('error');
    const cancelled = make();
    cancelled.cancel();
    await expect(cancelled.completion).rejects.toThrow('取消');
  });
  it('done 但目录内仍有文件未交付也报错，运行中写入不被迟到解压覆盖', async () => {
    const files = make(['rules.ini']);
    const read = files.read('rules.ini');
    await files.write('rules.ini', new Uint8Array([9]));
    files.accept('rules.ini', new Uint8Array([1]));
    expect(await read).toEqual(new Uint8Array([9]));
    files.finish();
    expect(files.status().phase).toBe('complete');
    const missing = make();
    missing.finish();
    await expect(missing.completion).rejects.toThrow('未完整');
  });
  it('YR 优先准备 RA2 基础数据，未选择游戏时公布启动层并集但不扩大必需清单', () => {
    const ra2 = gameArchiveLayers('ra2');
    const yr = gameArchiveLayers('yr');
    expect(yr.startup).toEqual(expect.arrayContaining(ra2.required));
    expect(yr.required).not.toContain('ra2.mix');
    const unselected = gameArchiveLayers();
    expect(unselected.required).toEqual([]);
    expect(unselected.startup).toEqual(expect.arrayContaining([...ra2.startup, ...yr.startup]));
  });

  it.each(['ra2', 'yr'] as const)('%s 启动层包含必需/MOD 数据，影片地图音乐留在其他层', (game) => {
    const plan = gameArchiveLayers(game);
    expect(plan.startup).toEqual(expect.arrayContaining(plan.required));
    expect(plan.startup).toContain(game === 'ra2' ? 'expand01.mix' : 'expandmd01.mix');
    expect(plan.startup).toContain('blowfish.dll');
    expect(plan.startup).not.toContain(game === 'ra2' ? 'movies01.mix' : 'movmd03.mix');
    expect(plan.startup).not.toContain(game === 'ra2' ? 'maps01.mix' : 'mapsmd03.mix');
    expect(plan.startup).not.toContain(game === 'ra2' ? 'theme.mix' : 'thememd.mix');
  });
});

describe('Worker 文件独立端口', () => {
  it('端口等待后台文件，transfer 不拆走源字节，写回和分段仍正确', async () => {
    const source = make(['maps01.mix']);
    const channel = new MessageChannel();
    const close = serveFileProvider(source, channel.port1);
    const remote = new PortGameFileProvider('远端', channel.port2, await source.list(''));
    try {
      expect(remote.hasKnownFile('maps01.mix')).toBe(true);
      expect(remote.hasKnownFile('absent.mix')).toBe(false);
      expect(await remote.list('')).toEqual(['maps01.mix']);
      const read = remote.read('maps01.mix');
      source.accept('maps01.mix', new Uint8Array([1, 2, 3]));
      expect(await read).toEqual(new Uint8Array([1, 2, 3]));
      expect(source.files.get('maps01.mix')?.length).toBe(3);
      expect(await remote.readRange('maps01.mix', 1, 1)).toEqual(new Uint8Array([2]));
      expect(await remote.readPrefix('maps01.mix', 1)).toEqual({ bytes: new Uint8Array([1]), totalSize: 3 });
      await remote.write('save.sav', new Uint8Array([7]));
      expect(await source.read('save.sav')).toEqual(new Uint8Array([7]));
      await remote.flush();
    } finally {
      remote.dispose();
      close();
    }
  });
  it('服务关闭和生产者失败均结束等待，关闭后不能发新请求', async () => {
    const source = make();
    const channel = new MessageChannel();
    const close = serveFileProvider(source, channel.port1);
    const remote = new PortGameFileProvider('远端', channel.port2, ['ra2.mix']);
    try {
      const read = remote.read('ra2.mix');
      const failed = expect(read).rejects.toThrow('损坏');
      source.finish(new Error('损坏'));
      await failed;
      const closing = expect(remote.read('ra2.mix')).rejects.toThrow();
      close();
      await closing;
      await expect(remote.read('ra2.mix')).rejects.toThrow('关闭');
    } finally {
      remote.dispose();
      close();
    }
  });
});
