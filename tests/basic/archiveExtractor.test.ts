import { zipSync, strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { createArchiveExtractor, type ArchiveDirectoryRule } from '../../src/utils/archive/archiveExtractor';

it('retains distinct nested maps and exact launcher paths beneath a package wrapper', async () => {
  const bytes = zipSync({
    'Package/MapsMO/Standard/one.map': strToU8('one'),
    'Package/MapsMO/Standard/two.map': strToU8('two'),
    'Package/Resources/GameOptions.ini': strToU8('sides'),
    'Package/INI/BattleClient.ini': strToU8('missions'),
  });
  const files = new Map<string, Uint8Array>();
  const run = createArchiveExtractor({
    mountInput(seven) {
      seven.FS.writeFile('/work/archive.bin', bytes);
    },
    post(message) {
      if (message.type === 'error') throw Error(message.message);
      if (message.type === 'file') files.set(message.name, message.bytes);
    },
  });
  await run({ type: 'extract', wanted: ['mapsmo/', 'ini/', 'resources/gameoptions.ini'] });
  expect([...files.keys()].sort()).toEqual([
    'ini/battleclient.ini',
    'mapsmo/standard/one.map',
    'mapsmo/standard/two.map',
    'resources/gameoptions.ini',
  ]);
});

it('通用提取器不内置游戏归位规则，按调用方规则选择目录', async () => {
  const bytes = zipSync({ 'install/tauam01.wav': strToU8('sound'), 'other.txt': strToU8('ignored') });
  async function extract(wanted: string[], directoryRules?: readonly ArchiveDirectoryRule[]) {
    const files = new Map<string, Uint8Array>();
    let done = false;
    const run = createArchiveExtractor({
      mountInput(seven) {
        seven.FS.writeFile('/work/archive.bin', bytes);
      },
      post(message) {
        if (message.type === 'error') throw Error(message.message);
        if (message.type === 'file') files.set(message.name, message.bytes);
        if (message.type === 'done') done = true;
      },
    });
    await run({ type: 'extract', wanted, directoryRules });
    expect(done).toBe(true);
    return [...files.keys()];
  }
  expect(await extract(['taunts/'])).toEqual([]);
  const rules = [{ directory: 'voices/', basenamePattern: '^tau.*\\.wav$' }];
  expect(await extract(['voices/'], rules)).toEqual(['voices/tauam01.wav']);
  expect(await extract(['taunts/'], rules)).toEqual([]);
});

it('uses the installation launcher rather than a nested editor copy in progressive ZIP imports', async () => {
  const bytes = zipSync({
    'Package/Editor/launcher.exe': Uint8Array.of(9),
    'Package/launcher.exe': Uint8Array.of(1),
    'Package/engine.exe': Uint8Array.of(2),
    'Package/resource.bin': Uint8Array.of(3),
  });
  const files = new Map<string, Uint8Array>();
  const run = createArchiveExtractor({
    mountInput(seven) {
      seven.FS.writeFile('/work/archive.bin', bytes);
    },
    post(message) {
      if (message.type === 'error') throw Error(message.message);
      if (message.type === 'file') files.set(message.name, message.bytes);
    },
  });
  await run({
    type: 'extract',
    wanted: ['launcher.exe', 'engine.exe', 'resource.bin'],
    layers: { required: ['engine.exe'], startup: ['launcher.exe', 'engine.exe'] },
  });
  expect(files.get('launcher.exe')).toEqual(Uint8Array.of(1));
  expect(files.size).toBe(3);
});
