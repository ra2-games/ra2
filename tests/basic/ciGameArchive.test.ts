import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { expect, it } from 'vitest';
import { extractGameArchive } from '../../scripts/ci/prepareGame';

it('CI 复用前端提取器：嵌套包、目录扁平化、零字节、可选文件与无关文件过滤', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-game-archive-'));
  try {
    const inner = zipSync({
      '安装目录/RA2.MIX': strToU8('fixture'),
      '安装目录/GAME.EXE': strToU8('package-executable'),
      '安装目录/empty.mix': new Uint8Array(),
      '安装目录/ignored.txt': strToU8('ignored'),
      'taunts/test.wav': strToU8('sound'),
      '安装目录/TAUAM01.WAV': strToU8('flat-sound'),
    });
    await writeFile(join(root, 'archive.bin'), zipSync({ 'data/game.zip': inner }));
    const output = join(root, 'output');
    await extractGameArchive(join(root, 'archive.bin'), output, ['game.exe', 'ra2.mix', 'empty.mix', 'taunts/']);
    expect(await readFile(join(output, 'game.exe'), 'utf8')).toBe('package-executable');
    expect(await readFile(join(output, 'ra2.mix'), 'utf8')).toBe('fixture');
    expect((await readFile(join(output, 'empty.mix'))).length).toBe(0);
    expect(await readFile(join(output, 'taunts/test.wav'), 'utf8')).toBe('sound');
    expect(await readFile(join(output, 'taunts/tauam01.wav'), 'utf8')).toBe('flat-sound');
    expect(await readdir(output)).toEqual(['empty.mix', 'game.exe', 'ra2.mix', 'taunts']);
    expect(await readdir(root)).toEqual(['archive.bin', 'output']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('损坏包不因提取器返回空目录而成功', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ci-game-invalid-'));
  try {
    await writeFile(join(root, 'archive.bin'), 'invalid');
    await expect(extractGameArchive(join(root, 'archive.bin'), join(root, 'output'), ['ra2.mix'])).rejects.toThrow(
      '提取失败',
    );
    expect(await readdir(root)).toEqual(['archive.bin']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
