import { loadPe, rvaToOff } from '../../src/vm86/pe';
import { createGuestMemory, writeU32 } from '../helpers/guestMemory';
import { buildPe32 } from './peBuilder';

const word = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];

/** Hand-assembled probe evidence at synthetic addresses, independent of shipped executable bytes. */
export function frameCounterImage(game: 'ra2' | 'yr', base = 0x400000, shift = 0) {
  const text = new Uint8Array(0x1000).fill(0xcc);
  const data = new Uint8Array(0x1000);
  const strings = new Uint8Array(0x100);
  const frame = base + 0x2100 + shift;
  const stop = frame + 4;
  const speed = frame + 0x10;
  const session = frame + 0x40;
  const fps = frame + 0x50;
  const timer = frame + 0x60;
  const label = base + 0x3000;
  const sites = {
    frame: base + 0x1010 + shift,
    speed: base + 0x1100 + shift,
    settings: base + 0x1180 + shift,
    display: base + 0x1210 + shift,
    timing: base + 0x1300 + shift,
  };
  const emit = (site: number, bytes: number[]) => text.set(bytes, site - base - 0x1000);
  const call = (site: number, offset: number) => [0xe8, ...word(base + 0x1800 - site - offset - 5)];
  emit(sites.frame, [
    0x8b,
    0x15,
    ...word(frame),
    0xa1,
    ...word(stop),
    0x42,
    0x3b,
    0xc7,
    0x89,
    0x15,
    ...word(frame),
    0x74,
    0x11,
    0x8b,
    0xca,
    0x3b,
    0xc1,
    0x7d,
    0x0b,
    ...call(sites.frame, 28),
    0x89,
    0x3d,
    ...word(stop),
    ...call(sites.frame, 39),
    ...call(sites.frame, 44),
    ...call(sites.frame, 49),
  ]);
  emit(sites.speed, [
    0x89,
    0x0d,
    ...word(session),
    0x89,
    0x0d,
    ...word(speed),
    0x8b,
    0x8b,
    0x8e,
    0,
    0,
    0,
    0xc1,
    0xe9,
    4,
    0x80,
    0xe1,
    1,
    0x88,
    0x0d,
    ...word(session - 6),
    0x8b,
    0x93,
    0x8e,
    0,
    0,
    0,
    0xc1,
    0xea,
    5,
    0x80,
    0xe2,
    1,
    0x88,
    0x15,
    ...word(session - 5),
  ]);
  const settingsOffset = game === 'ra2' ? 0x1108 : 0x14a0;
  const registers = game === 'ra2' ? [0x90, 0x15, 0x88, 0x0d] : [0x88, 0x0d, 0x90, 0x15];
  emit(sites.settings, [
    0x8b,
    registers[0]!,
    ...word(settingsOffset),
    0x89,
    registers[1]!,
    ...word(session),
    0x8b,
    registers[2]!,
    ...word(settingsOffset + 4),
    0x89,
    registers[3]!,
    ...word(session + 16),
    0x8b,
    registers[0]!,
    ...word(settingsOffset + 8),
    0x89,
    registers[1]!,
    ...word(session + 12),
  ]);
  emit(sites.display, [
    0x8b,
    0x0d,
    ...word(fps),
    0x8d,
    0x54,
    0x24,
    0x50,
    0x51,
    0x68,
    ...word(label),
    0x52,
    ...call(sites.display, 17),
    0x83,
    0xc4,
    0x2c,
  ]);
  emit(sites.timing, [
    0x8b,
    0x0d,
    ...word(fps),
    0x85,
    0xc9,
    0x75,
    0x60,
    0x8d,
    0x4c,
    0x24,
    0x14,
    ...call(sites.timing, 14),
    0xb9,
    2,
    0,
    0,
    0,
    0xa3,
    ...word(timer),
  ]);
  emit(sites.timing + 0x6a, [0xb8, 60, 0, 0, 0, 0x99, 0xf7, 0xf9, 0x8d, 0x4c, 0x24, 0x14, 0x8b, 0xf0]);
  strings.set(Array.from('Req fps : %d\0').flatMap((c) => [c.charCodeAt(0), 0]));
  const { exe } = buildPe32({
    imageBase: base,
    entryRva: 0x1800,
    imports: [],
    sections: [
      { name: '.text', data: text, characteristics: 0x60000020 },
      { name: '.data', data, characteristics: 0xc0000040 },
      { name: '.rdata', data: strings, characteristics: 0x40000040 },
    ],
  });
  const memory = createGuestMemory();
  loadPe(
    memory.bytes,
    exe,
    () => {
      throw new Error('No fixture imports');
    },
    () => 0,
  );
  for (const [pointer, value] of [
    [frame, 321],
    [speed, 2],
    [session, 3],
    [fps, 45],
  ])
    writeU32(memory, pointer!, value!);
  const patch = (pointer: number, bytes: number[] | Uint8Array) => {
    exe.set(bytes, rvaToOff(exe, pointer - base));
    memory.write_memory(bytes, pointer);
  };
  return {
    exe,
    memory,
    sites,
    frame,
    speed,
    session,
    fps,
    base,
    patch,
    patchWord: (pointer: number, value: number) => patch(pointer, word(value)),
  };
}
