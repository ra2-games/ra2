import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { SUPPORTED_GAMES } from '../../src/games/catalog';
import { loadPe } from '../../src/vm86/pe';
import { createGuestMemory } from '../helpers/guestMemory';
import { resolveNativeLayout } from '../../src/games/shared/nativeLayout';
import { RA2_SETTINGS_SIGNATURE } from '../../src/games/ra2/performance';
import { YR_SETTINGS_SIGNATURE } from '../../src/games/yr/performance';
import { executableCorpus } from './helpers/executableCorpus';

it.each(executableCorpus())('resolves and installs native capabilities: $label', (entry) => {
  const game = SUPPORTED_GAMES.find((g) => g.id === entry.gameId)!;
  const memory = createGuestMemory(32 << 20);
  let next = 0x80000;
  const reserve = (size: number) => {
    const p = next;
    next = (next + size + 15) & ~15;
    return p;
  };
  const pe = loadPe(memory.bytes, entry.bytes, reserve, game.argBytes);
  expect(pe.importList.length).toBeGreaterThan(0);
  const layout = resolveNativeLayout(memory, entry.bytes, {
    settingsSignature: entry.gameId === 'ra2' ? RA2_SETTINGS_SIGNATURE : YR_SETTINGS_SIGNATURE,
    menuRegister: entry.gameId === 'ra2' ? 0xbd : 0xbe,
  });
  expect(layout).not.toBeNull();
  expect(layout?.menu).not.toBeNull();
  expect(layout?.battle).not.toBeNull();
  expect(layout?.lan).not.toBeNull();
  const hooks = game.runtimeHooks!.resolve!(memory, entry.bytes);
  hooks.prepareImage!(memory);
  expect(hooks.createFrameReader!(memory, entry.bytes)).not.toBeNull();
  hooks.prepareStartupPage!(memory, 'battle', reserve);
  let dynamic = 0xc0000;
  expect(
    hooks.prepareNetwork!(memory, (code) => {
      const p = dynamic;
      dynamic += (code.length + 15) & ~15;
      memory.write_memory(code, p);
      return p;
    }),
  ).toBe(true);
  expect(memory.read_memory(layout!.menu!.site, 1)[0]).toBe(0xe9);
  expect(memory.read_memory(layout!.battle!.site, 1)[0]).toBe(0xe9);
  expect(createHash('sha256').update(entry.bytes).digest('hex')).toBe(entry.sha256);
  console.log(
    `${entry.label}: menu=0x${layout!.menu!.site.toString(16)}, settings=0x${layout!.settings.pointer.toString(16)}, handler=0x${layout!.battle!.handler.toString(16)}`,
  );
});
