import { expect, it, vi } from 'vitest';
import { RA2_YR_RESOURCE_POLICY as policy } from '../../src/games/shared/resourcePolicy';
import { supportedGame } from '../../src/games/catalog';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';

it('RA2/YR 静态介质允许会话复用，配置、存档和未知类型仍重读', () => {
  for (const extension of [
    'mix',
    'bag',
    'idx',
    'shp',
    'pcx',
    'pal',
    'fnt',
    'csf',
    'aud',
    'vqa',
    'bik',
    'wav',
    'hva',
    'vxl',
    'map',
    'mpr',
    'yrm',
    'yro',
  ]) {
    expect(policy.isSessionStatic(`dir/FILE.${extension.toUpperCase()}`)).toBe(true);
  }
  for (const path of ['ra2.ini', 'save.sav', 'unknown', 'test.mix.tmp']) {
    expect(policy.isSessionStatic(path)).toBe(false);
  }
});

it('RA2 preparation retains the session-only speed overlay', async () => {
  const files = new MemoryGameFileProvider(new Map());
  const prepared = await policy.prepareSource({ game: supportedGame('ra2'), files, executableBytes: new Uint8Array() });
  expect(new TextDecoder().decode((await prepared.files.read('ra2.ini'))!)).toContain('GameSpeed=0');
  expect(await files.read('ra2.ini')).toBeNull();
});

it('MO requires a supplied native injector rather than selecting a direct fallback', async () => {
  const id = 'mo';
  const files = new MemoryGameFileProvider(new Map());
  const read = vi.spyOn(files, 'read');
  await expect(
    policy.prepareSource({ game: supportedGame(id), files, executableBytes: new Uint8Array() }),
  ).rejects.toThrow('Syringe.exe');
  expect(read).toHaveBeenCalledWith('Syringe.exe');
});
