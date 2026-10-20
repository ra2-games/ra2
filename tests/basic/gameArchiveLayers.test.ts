import { gameArchiveLayers } from '../../src/games/archivePolicy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveExtractOptions, ArchiveExtractResult } from '../../src/utils/archive/archiveExtract';
import { openGameArchive } from '../../src/adapter/gameArchiveLayers';
import { ProgressiveGameFileProvider } from '../../src/adapter/progressiveFiles';

const extraction = vi.hoisted(() => ({
  options: null as ArchiveExtractOptions | null,
  resolve: null as ((result: ArchiveExtractResult) => void) | null,
  reject: null as ((error: Error) => void) | null,
}));
vi.mock('../../src/utils/archive/archiveExtract', () => ({
  extractArchiveFiles(_bytes: Uint8Array, options: ArchiveExtractOptions) {
    extraction.options = options;
    return new Promise<ArchiveExtractResult>((resolve, reject) => {
      extraction.resolve = resolve;
      extraction.reject = reject;
      options.signal?.addEventListener('abort', () => reject(new Error('取消')));
    });
  },
}));
afterEach(() => vi.unstubAllGlobals());

describe('游戏归档启动层发布', () => {
  it('目录/单个文件不提前启动，startup-ready 才发布，后台失败不伪造完成', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const ready = vi.fn();
    const progress = vi.fn();
    const opening = openGameArchive(new Uint8Array(), 'ra2', () => {}, progress).then((source) => {
      ready();
      return source;
    });
    const options = extraction.options!;
    options.onProgress!({ completedFiles: 1, totalFiles: 2 });
    expect(progress).toHaveBeenCalledWith({ completedFiles: 1, totalFiles: 2 });
    options.onCatalog!(['ra2.mix', 'movies01.mix']);
    options.onFile!('ra2.mix', new Uint8Array([1]));
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    options.onStartupReady!();
    const source = (await opening) as ProgressiveGameFileProvider;
    expect(source.status().phase).toBe('loading');
    const pending = expect(source.read('movies01.mix')).rejects.toThrow('损坏');
    extraction.reject!(new Error('损坏'));
    await pending;
    await expect(source.completion).rejects.toThrow('损坏');
    expect(source.status().phase).toBe('error');
  });
  it('后台所有文件成功才完成，空占位保留，未分层格式完整解压回退', async () => {
    const opening = openGameArchive(new Uint8Array(), 'ra2', () => {});
    extraction.options!.onCatalog!(['movies01.mix']);
    extraction.options!.onFile!('movies01.mix', new Uint8Array());
    extraction.options!.onStartupReady!();
    const source = (await opening) as ProgressiveGameFileProvider;
    extraction.resolve!({ files: source.files, found: ['movies01.mix'], missing: [] });
    await source.completion;
    expect(await source.read('movies01.mix')).toEqual(new Uint8Array());
    const fallback = openGameArchive(new Uint8Array(), 'ra2', () => {});
    extraction.resolve!({ files: new Map([['ra2.mix', new Uint8Array([1])]]), found: ['ra2.mix'], missing: [] });
    expect(await fallback).not.toBeInstanceOf(ProgressiveGameFileProvider);
  });
  it('就绪前错误拒绝启动，取消已发布来源会终止解压并拒绝未完成读取', async () => {
    const opening = openGameArchive(new Uint8Array(), 'ra2', () => {});
    const rejected = expect(opening).rejects.toThrow('格式');
    extraction.reject!(new Error('格式'));
    await rejected;
    const next = openGameArchive(new Uint8Array(), 'ra2', () => {});
    extraction.options!.onCatalog!(['ra2.mix']);
    extraction.options!.onStartupReady!();
    const source = (await next) as ProgressiveGameFileProvider;
    source.cancel();
    expect(extraction.options!.signal?.aborted).toBe(true);
    await expect(source.completion).rejects.toThrow('取消');
  });
  it('iPhone uses conservative extraction to limit overlapping WASM output buffers', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    const archive = new Blob();
    Object.defineProperty(archive, 'name', { value: 'game.rar' });
    const opening = openGameArchive(archive, 'ra2', () => {});
    expect(extraction.options!.memoryPolicy).toBe('conservative');
    extraction.reject!(new Error('stop'));
    await expect(opening).rejects.toThrow('stop');
  });

  it('iPhone keeps non-uploaded archive bytes on the normal extraction path', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    const opening = openGameArchive(new Uint8Array(), 'ra2', () => {});
    expect(extraction.options!.memoryPolicy).toBe('normal');
    extraction.reject!(new Error('stop'));
    await expect(opening).rejects.toThrow('stop');
  });

  it('iPhone keeps executable uploads on the normal extraction path', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    const executable = new Blob();
    Object.defineProperty(executable, 'name', { value: 'setup.exe' });
    const opening = openGameArchive(executable, 'ra2', () => {});
    expect(extraction.options!.memoryPolicy).toBe('normal');
    extraction.reject!(new Error('stop'));
    await expect(opening).rejects.toThrow('stop');
  });
});

it.each(['ra2', 'yr'] as const)('retains %s native launcher inputs in the startup archive layer', (game) => {
  const layers = gameArchiveLayers(game);
  for (const path of game === 'yr'
    ? ['ra2md.exe', 'ra2md.lcf', 'conquermd.dat']
    : ['ra2.exe', 'ra2.lcf', 'conquer.dat']) {
    expect(layers.startup).toContain(path);
    expect(layers.wanted.map((name) => name.toLowerCase())).toContain(path);
    expect(layers.required).not.toContain(path);
  }
});
