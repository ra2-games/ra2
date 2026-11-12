/**
 * NSIS installer parsing unit tests: a synthetic container (real format layout and LZMA compression, generated once with Python lzma and embedded) covers signature discovery, solid-stream decoding, and instruction-stream file enumeration.
 * End-to-end validation of the real 206 MB multiplayer package is in tests/real-game/smoke/ra2NsisSmoke.mts.
 */
import { describe, expect, it } from 'vitest';
import { decodeLzmaStream } from '../../src/utils/archive/lzmaDecode';
import {
  decodeAndParseNsis,
  decodeNsisSplitFiles,
  findNsisArchive,
  parseNsisFiles,
} from '../../src/utils/archive/nsis';

/**
 * Synthetic container using the real NSIS layout: [MZ stub][16B signature][u32 header length][u32 archive length][LZMA stream].
 * Decoded output = [u32 header length][header block][u32 length + data per file]. The instruction stream contains two SetOutPath operations (rmcache -> empty) and three ExtractFile operations, covering directory-prefix switching and nested paths.
 */
const FIXTURE_BASE64 =
  'TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADvvq3eTnVsbHNvZnRJbnN0/wAAAH8AAABdAAAABAB/gDAQD4WorOPiHWz0K92CiLCUH5X1CmM3pCWksvr2jnsQVFtyaglX6+g0w5uS5ElD7VdCVl9qFdIfA0xt6YAle8QiYgsj02jjJHioRVvfj/Xp7OQkICZa+K9ThOgYUE/ggzn4mkjr8g97CHuzfAMoAo+iaf/81OqA';
const FIXTURE = Uint8Array.from(atob(FIXTURE_BASE64), (char) => char.charCodeAt(0));
/** Total synthetic decoded length (4-byte header length + header + data). */
const DECODED_LENGTH = 298;

describe('NSIS 安装包解析', () => {
  it('定位签名并报告头长与流起点', () => {
    const info = findNsisArchive(FIXTURE);
    expect(info).not.toBeNull();
    expect(info!.headerSize).toBe(255);
    // 128-byte stub + 16-byte signature + 4-byte header length + 4-byte archive length
    expect(info!.streamStart).toBe(128 + 16 + 8);
  });

  it('非 NSIS 内容返回 null', () => {
    expect(findNsisArchive(new Uint8Array(512))).toBeNull();
    const mz = Uint8Array.from(atob('TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), (c) =>
      c.charCodeAt(0),
    );
    expect(findNsisArchive(mz)).toBeNull();
  });

  it('解码 solid 流并枚举文件（含 SetOutPath 前缀切换）', async () => {
    const info = findNsisArchive(FIXTURE)!;
    const decoded = await decodeLzmaStream({
      stream: FIXTURE.subarray(info.streamStart),
      outputSize: DECODED_LENGTH,
    });
    const files = parseNsisFiles(decoded);
    expect(files.map((file) => file.path).sort()).toEqual(['game.exe', 'rmcache/preview.mmp', 'sub/dir/file.bin']);
    const read = (path: string): Uint8Array => {
      const file = files.find((candidate) => candidate.path === path)!;
      return decoded.subarray(file.offset + 4, file.offset + 4 + file.size);
    };
    expect(new TextDecoder().decode(read('game.exe'))).toBe('MZfake-game');
    expect(new TextDecoder().decode(read('rmcache/preview.mmp'))).toBe('mmp-data');
    expect(new TextDecoder().decode(read('sub/dir/file.bin'))).toBe('bin-data');
  });

  it('声明的输出长度大于实际内容时报错', async () => {
    const info = findNsisArchive(FIXTURE)!;
    await expect(
      decodeLzmaStream({
        stream: FIXTURE.subarray(info.streamStart),
        outputSize: DECODED_LENGTH + 100,
      }),
    ).rejects.toThrow();
  });
});

/**
 * Synthetic container matching the YR jb51 installer layout, generated once with Python lzma and embedded:
 * [MZ stub][signature][u32 header length][4 junk bytes][header-stream properties after junk] + [00 80 separator] + independent LZMA streams per file.
 * The header block is flags-first (u32 flags + 8 block headers); EW_EXTRACTFILE params[2] holds each stream's offset relative to the first data stream.
 */
const SPLIT_BASE64 =
  'TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADvvq3eTnVsbHNvZnRJbnN0kQAAAAECAwRdAACAAABAgC9uRIQwFz4PbvEA4FcKUtnWsSRLtLM+u+RZyeK0Ur2TwzsFM0i74dj/v//mBYAAAIBdAACAAAAmloktFqDa2/6nDTo2Ig43peOxOf6ZEf/HxIAAAIBdAACAAAAoEsktFqDa2/6nDTo2JVjHpeOxOf6ZEf/HxIAA';
const SPLIT_FIXTURE = Uint8Array.from(atob(SPLIT_BASE64), (char) => char.charCodeAt(0));

describe('NSIS 两段流变体（重打包安装器）', () => {
  it('flags-first 头块 + 每文件独立流：定位载荷起点并逐流解码', async () => {
    const nsis = findNsisArchive(SPLIT_FIXTURE)!;
    expect(nsis.headerSize).toBe(145);
    const decoded = await decodeAndParseNsis(SPLIT_FIXTURE, nsis);
    expect(decoded.kind).toBe('split');
    if (decoded.kind !== 'split') return;
    expect(decoded.files.map((file) => file.path)).toEqual(['file1.bin', 'file2.bin']);
    expect(decoded.files.map((file) => file.streamOffset)).toEqual([0, 36]);
    const file1 = new TextEncoder().encode('MZfake-file-1-data');
    const file2 = new TextEncoder().encode('PKfake-file-2-data');
    expect(await decodeLzmaStream({ stream: SPLIT_FIXTURE.subarray(decoded.payloadStart + 0) })).toEqual(file1);
    expect(await decodeLzmaStream({ stream: SPLIT_FIXTURE.subarray(decoded.payloadStart + 36) })).toEqual(file2);
  });
});

describe('NSIS 两段流：单条损坏不中断后续文件', () => {
  /**
   * Synthetic container matching the preceding layout, generated once with Python lzma and embedded: firstheader contains flags/siginfo, and three EW_EXTRACTFILE instructions reference independent streams.
   * file2's stream tail (including EOS) is truncated, so decoding must report corrupted input. This reproduces a shared-extractor bug: the YR jb51 installer's corrupt movies01.mix stub stream previously prevented extraction of the later required ra2md.mix.
   */
  const BROKEN_SPLIT_BASE64 =
    'TVoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA776t3u++rd5OdWxsc29mdEluc3S3AAAAnQAAAF0AAIAAAABuAIx7HhLqHOJW+I3JgaBLjDwFh9Yg9Fe4MIJ8/aoYtAgL2FOVfOqkvy5CLmfZkCv//7OuAABdAACAAAAmloktFqDa2/6nDTo2Ig43peOxOf6ZEf/HxIAAXQAAgAAAKBLJLRag2tv+pw06NiVYx6XjsTn+mV0AAIAAACgSyS0WoNrb/qcNOjYoo1el47E5/pkR/8fEgAA=';

  it('损坏流只跳过该文件，前后文件仍解码收集', async () => {
    const fixture = Uint8Array.from(atob(BROKEN_SPLIT_BASE64), (char) => char.charCodeAt(0));
    const nsis = findNsisArchive(fixture)!;
    const decoded = await decodeAndParseNsis(fixture, nsis);
    expect(decoded.kind).toBe('split');
    if (decoded.kind !== 'split') return;
    expect(decoded.files.map((file) => file.path)).toEqual(['file1.bin', 'file2.bin', 'file3.bin']);

    const collected = new Map<string, string>();
    const statuses: string[] = [];
    const skipped = await decodeNsisSplitFiles({
      bytes: fixture,
      payloadStart: decoded.payloadStart,
      files: decoded.files,
      isTarget: (path) => path.endsWith('.bin'),
      decode: (stream) => decodeLzmaStream({ stream, transferInput: false }),
      collect: async (path, out) => {
        collected.set(path, new TextDecoder().decode(out));
      },
      onStatus: (message) => statuses.push(message),
    });
    expect(Object.fromEntries(collected)).toEqual({
      'file1.bin': 'MZfake-file-1-data',
      'file3.bin': 'PKfake-file-3-data',
    });
    expect(skipped).toEqual(['file2.bin（corrupted input）']);
    expect(statuses).toContain('NSIS 流损坏，跳过：file2.bin');
  });
});

describe('NSIS 非 solid 数据块前缀（压缩位 + 长度）', () => {
  /**
   * Real non-solid installers (observed in the YR jb5 installer) prefix every data block with a u32 whose bit 31 marks an LZMA payload and whose low 31 bits give the payload size; the stream offset points after that prefix.
   * Stored blocks such as ConquerMD.dat hold file bytes directly, so treating them as LZMA dropped them and made YR exit with code 1.
   */
  async function framedContainer(prefixDelta: number): Promise<{
    container: Uint8Array;
    payloadStart: number;
    secondOffset: number;
    storedText: string;
  }> {
    const nsis = findNsisArchive(SPLIT_FIXTURE)!;
    const decoded = await decodeAndParseNsis(SPLIT_FIXTURE, nsis);
    if (decoded.kind !== 'split') throw new Error('fixture must use split streams');
    const compressed = SPLIT_FIXTURE.subarray(
      decoded.payloadStart,
      decoded.payloadStart + decoded.files[1]!.streamOffset,
    );
    const storedText = '[Settings]\r\nConquerMD=1\r\n';
    const stored = new TextEncoder().encode(storedText);
    const secondOffset = 4 + compressed.length;
    const container = new Uint8Array(secondOffset + 4 + stored.length);
    const view = new DataView(container.buffer);
    // prefixDelta perturbs the declared sizes so the blocks no longer tile exactly.
    view.setUint32(0, 0x8000_0000 | (compressed.length + prefixDelta), true);
    container.set(compressed, 4);
    view.setUint32(secondOffset, stored.length + prefixDelta, true);
    container.set(stored, secondOffset + 4);
    return { container, payloadStart: 4, secondOffset, storedText };
  }

  it('存储块原样输出，压缩块按 LZMA 解码，共享块保留每个文件名', async () => {
    const { container, payloadStart, secondOffset, storedText } = await framedContainer(0);
    const collected = new Map<string, string>();
    const skipped = await decodeNsisSplitFiles({
      bytes: container,
      payloadStart,
      files: [
        { path: 'file1.bin', streamOffset: 0 },
        { path: 'ConquerMD.dat', streamOffset: secondOffset },
        // Identical placeholder resources reference one payload under several names.
        { path: 'movies01.mix', streamOffset: secondOffset },
      ],
      isTarget: () => true,
      decode: (stream) => decodeLzmaStream({ stream, transferInput: false }),
      collect: async (path, out) => {
        collected.set(path, new TextDecoder().decode(out));
      },
    });
    expect(skipped).toEqual([]);
    expect(Object.fromEntries(collected)).toEqual({
      'file1.bin': 'MZfake-file-1-data',
      'ConquerMD.dat': storedText,
      'movies01.mix': storedText,
    });
  });

  it('前缀尺寸不连续时退回下一流边界，不猜测存储块', async () => {
    const { container, payloadStart, secondOffset } = await framedContainer(1);
    const collected = new Map<string, string>();
    const skipped = await decodeNsisSplitFiles({
      bytes: container,
      payloadStart,
      files: [
        { path: 'file1.bin', streamOffset: 0 },
        { path: 'conquermd.dat', streamOffset: secondOffset },
      ],
      isTarget: () => true,
      decode: (stream) => decodeLzmaStream({ stream, transferInput: false }),
      collect: async (path, out) => {
        collected.set(path, new TextDecoder().decode(out));
      },
    });
    expect([...collected.keys()]).toEqual(['file1.bin']);
    expect(skipped).toEqual(['conquermd.dat（corrupted input）']);
  });
});
