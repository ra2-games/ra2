import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { loadPe } from '../../src/vm86/pe';
import { createRa2FrameReader } from '../../src/games/ra2/performance';
import { createYrFrameReader } from '../../src/games/yr/performance';
import { gameResourceExe } from './helpers/gameDir';

const cases = [
  {
    game: 'ra2',
    create: createRa2FrameReader,
    other: createYrFrameReader,
    counters: [0xa40d2c, 0xa40b18, 0xa3d2c8, 0xa3d568],
  },
  {
    game: 'yr',
    create: createYrFrameReader,
    other: createRa2FrameReader,
    counters: [0xa8ed84, 0xa8eb60, 0xa8b268, 0xa8b558],
  },
] as const;

// This validates static discovery against local 1.006/1.001 layout evidence, not live simulation advancement.
it.each(cases)('discovers $game counters in the locally supplied executable without writing memory', (entry) => {
  const exe = new Uint8Array(readFileSync(gameResourceExe(entry.game)));
  const ram = new Uint8Array(16 * 1024 * 1024);
  let stub = 0x80000;
  loadPe(
    ram,
    exe,
    (size) => {
      const result = stub;
      stub += size;
      return result;
    },
    () => 0,
  );
  const memory = {
    read_memory: vi.fn((pointer: number, size: number) => ram.subarray(pointer, pointer + size)),
    write_memory: vi.fn(() => {
      throw new Error('Read-only discovery must not write');
    }),
  };
  const reader = entry.create(memory, exe);
  expect(reader).not.toBeNull();
  memory.read_memory.mockClear();
  expect(reader!()).not.toBeNull();
  expect(memory.read_memory.mock.calls).toEqual(entry.counters.map((pointer) => [pointer, 4]));
  expect(entry.other(memory, exe)).toBeNull();
  expect(memory.write_memory).not.toHaveBeenCalled();
});
