import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { InstallationFiles } from '../real-game/helpers/installationFiles';

it('reads actual disk ranges and EOF while preserving empty overrides and missing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'installation-ranges-'));
  try {
    await writeFile(join(directory, 'movie.mix'), new Uint8Array([1, 2, 3, 4, 5]));
    const files = new InstallationFiles(directory);
    expect(await files.readPrefix('MOVIE.MIX', 2)).toEqual({ bytes: new Uint8Array([1, 2]), totalSize: 5 });
    expect(await files.readRange('movie.mix', 2, 2)).toEqual(new Uint8Array([3, 4]));
    expect(await files.readRange('movie.mix', 4, 8)).toEqual(new Uint8Array([5]));
    expect(await files.readRange('movie.mix', 9, 8)).toEqual(new Uint8Array());
    expect(await files.readRange('missing.mix', 0, 8)).toBeNull();
    await files.write('movie.mix', new Uint8Array());
    expect(await files.readPrefix('movie.mix', 8)).toEqual({ bytes: new Uint8Array(), totalSize: 0 });
    expect(await files.readRange('movie.mix', 0, 8)).toEqual(new Uint8Array());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
