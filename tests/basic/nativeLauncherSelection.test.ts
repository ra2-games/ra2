import { describe, expect, it } from 'vitest';
import { supportedGame } from '../../src/games/catalog';
import { RA2_YR_RESOURCE_POLICY } from '../../src/games/shared/resourcePolicy';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { adaptiveImage } from '../fixture/adaptiveImage';

const configuration = new TextEncoder().encode('[Settings]\n');
describe.each(['ra2', 'yr'] as const)('%s installation selection without sample identities', (id) => {
  const executable = id === 'ra2' ? 'ra2.exe' : 'ra2md.exe';
  const config = id === 'ra2' ? 'ra2.lcf' : 'ra2md.lcf';
  const data = id === 'ra2' ? 'Conquer.dat' : 'ConquerMD.dat';
  const prepare = (entries: [string, Uint8Array][], bytes = adaptiveImage(id).exe) => {
    const files = new MemoryGameFileProvider(new Map(entries));
    return RA2_YR_RESOURCE_POLICY.prepareSource({ game: supportedGame(id), files, executableBytes: bytes });
  };
  it.each([0, 0x60])('accepts different PE contents without modifying them (shift %s)', async (shift) => {
    const bytes = adaptiveImage(id, 0x500000, shift).exe;
    const launcher = adaptiveImage(id, 0x600000, shift).exe;
    const before = launcher.slice();
    const prepared = await prepare(
      [
        [executable, launcher],
        [config, configuration],
      ],
      bytes,
    );
    expect(prepared.executableBytes).toBe(bytes);
    expect(prepared.nativeLauncher?.executableBytes).toEqual(launcher);
    expect(launcher).toEqual(before);
    expect(await prepared.files.read(`C:\\GAME\\${config}`)).toEqual(configuration);
    expect(await prepared.files.read(data)).toBeNull();
  });
  it('allows direct execution only when both launcher inputs are absent', async () => {
    const prepared = await prepare([]);
    expect(prepared.nativeLauncher).toBeUndefined();
  });
  it.each(['launcher', 'configuration'] as const)('rejects a partial installation missing %s', async (missing) => {
    await expect(
      prepare(missing === 'launcher' ? [[config, configuration]] : [[executable, adaptiveImage(id).exe]]),
    ).rejects.toThrow('missing or empty');
  });
  it.each(['launcher', 'configuration'] as const)('does not confuse an empty %s with absence', async (empty) => {
    await expect(
      prepare([
        [executable, empty === 'launcher' ? new Uint8Array() : adaptiveImage(id).exe],
        [config, empty === 'configuration' ? new Uint8Array() : configuration],
      ]),
    ).rejects.toThrow('missing or empty');
  });
  it('rejects non-PE launcher bytes instead of retrying direct execution', async () => {
    await expect(
      prepare([
        [executable, new Uint8Array([1, 2, 3])],
        [config, configuration],
      ]),
    ).rejects.toThrow('PE32');
  });
  it('propagates read errors instead of treating the launcher as absent', async () => {
    const files = new MemoryGameFileProvider();
    const read = files.read.bind(files);
    files.read = async (path) => {
      if (path === executable) throw new Error('installation read failed');
      return read(path);
    };
    await expect(
      RA2_YR_RESOURCE_POLICY.prepareSource({ game: supportedGame(id), files, executableBytes: adaptiveImage(id).exe }),
    ).rejects.toThrow('installation read failed');
  });
});
