import { inspectPe32, type ByteSignature, type PeProbeBytes } from '../../vm86/peProbe';
import type { GuestMemory } from '../../vm86/win32';
import type { GameFrameReader } from '../performance';

// RA2/YR share these opcode shapes. Resolve addresses and call displacements from the image;
// each game's settings initializer independently identifies its native layout.
const address = [null, null, null, null] as const;
// biome-ignore format: Preserve the guest instruction layout.
const frameLoop: ByteSignature = [
  0x8b, 0x15, ...address,                     // MOV EDX, [Frame]
  0xa1, ...address, 0x42, 0x3b, 0xc7,         // MOV EAX, [StopFrame]; INC EDX; CMP EAX, EDI
  0x89, 0x15, ...address,                     // MOV [Frame], EDX
  0x74, 0x11, 0x8b, 0xca, 0x3b, 0xc1, 0x7d, 0x0b,
  0xe8, ...address, 0x89, 0x3d, ...address,    // CALL; MOV [StopFrame], EDI
  0xe8, ...address, 0xe8, ...address, 0xe8, ...address,
];
// biome-ignore format: Preserve the guest instruction layout.
const speedCopy: ByteSignature = [
  0x89, 0x0d, ...address, 0x89, 0x0d, ...address, // MOV [Session.GameSpeed], ECX; MOV [GameSpeed], ECX
  0x8b, 0x8b, 0x8e, 0, 0, 0, 0xc1, 0xe9, 4, 0x80, 0xe1, 1, 0x88, 0x0d, ...address,
  0x8b, 0x93, 0x8e, 0, 0, 0, 0xc1, 0xea, 5, 0x80, 0xe2, 1, 0x88, 0x15, ...address,
];
// biome-ignore format: Preserve the guest instruction layout.
const fpsDisplay: ByteSignature = [
  0x8b, 0x0d, ...address, 0x8d, 0x54, 0x24, 0x50, 0x51, // MOV ECX, [RequestedFPS]; LEA; PUSH ECX
  0x68, ...address, 0x52, 0xe8, ...address, 0x83, 0xc4, 0x2c, // PUSH label; PUSH EDX; CALL; ADD ESP, 0x2c
];
// biome-ignore format: Preserve the guest instruction layout.
const fpsTiming: ByteSignature = [
  0x8b, 0x0d, ...address, 0x85, 0xc9, 0x75, 0x60, // MOV ECX, [RequestedFPS]; TEST ECX, ECX; JNE
  0x8d, 0x4c, 0x24, null, 0xe8, ...address, 0xb9, 2, 0, 0, 0, 0xa3, ...address,
];
const fpsDivision: ByteSignature = [0xb8, 60, 0, 0, 0, 0x99, 0xf7, 0xf9, 0x8d, 0x4c, 0x24, null, 0x8b, 0xf0];
const fpsLabel = Array.from('Req fps : %d\0').flatMap((char) => [char.charCodeAt(0), 0]);

function operand(match: PeProbeBytes, offset: number): number {
  return new DataView(match.bytes.buffer, match.bytes.byteOffset, match.bytes.byteLength).getUint32(offset, true);
}

/** Resolve read-only counters from independent instruction references, never from unverified fixed addresses. */
export function resolveFrameCounters(memory: GuestMemory, exe: Uint8Array, settingsSignature: ByteSignature) {
  const image = inspectPe32(exe);
  if (!image) return null;
  const frame = image.findCode(frameLoop);
  const speed = image.findCode(speedCopy);
  const settings = image.findCode(settingsSignature);
  const readLabel = (pointer: number) =>
    image.read(pointer, fpsLabel.length, 'data') ?? image.read(pointer, fpsLabel.length, 'readonly');
  // Other debug fields use the same formatting instructions; identify this one by its referenced label.
  const display = image.findCode(fpsDisplay, (match) => {
    const label = readLabel(operand(match, 12));
    return !!label && fpsLabel.every((byte, i) => label.bytes[i] === byte);
  });
  const timing = image.findCode(fpsTiming);
  if (!frame || !speed || !settings || !display || !timing) return null;

  const counters = {
    frame: operand(frame, 2),
    gameSpeed: operand(speed, 8),
    sessionSpeed: operand(speed, 2),
    requestedFps: operand(display, 2),
  };
  if (
    counters.frame !== operand(frame, 16) ||
    operand(frame, 7) !== operand(frame, 35) ||
    counters.sessionSpeed !== operand(settings, 8) ||
    counters.requestedFps !== operand(timing, 2) ||
    operand(speed, 26) !== counters.sessionSpeed - 6 ||
    operand(speed, 44) !== counters.sessionSpeed - 5 ||
    new Set(Object.values(counters)).size !== 4 ||
    ![...Object.values(counters), operand(frame, 7), operand(timing, 25)].every(
      (value) => value % 4 === 0 && image.contains(value, 4, 'data'),
    )
  )
    return null;

  const calls: [PeProbeBytes, number[]][] = [
    [frame, [28, 39, 44, 49]],
    [display, [17]],
    [timing, [14]],
  ];
  for (const [match, offsets] of calls) {
    for (const offset of offsets) {
      const target = match.address + offset + 5 + (operand(match, offset + 1) | 0);
      if (!image.contains(target, 1, 'code')) return null;
    }
  }
  const label = readLabel(operand(display, 12));
  // JNE +0x60 at offset 8 leads to signed 60 / RequestedFPS in the native pacing path.
  const division = image.read(timing.address + 10 + 0x60, fpsDivision.length, 'code');
  if (
    !label ||
    !fpsLabel.every((byte, i) => label.bytes[i] === byte) ||
    !division ||
    !fpsDivision.every((byte, i) => byte === null || division.bytes[i] === byte) ||
    division.bytes[11] !== timing.bytes[13]
  )
    return null;

  // File bounds and operands are evidence only while the loaded image still contains the same instructions.
  try {
    for (const match of [frame, speed, settings, display, timing, label, division]) {
      const live = memory.read_memory(match.address, match.bytes.length);
      if (live.length !== match.bytes.length || !match.bytes.every((byte, i) => live[i] === byte)) return null;
    }
  } catch {
    return null;
  }
  return { ...counters, settings };
}

export function createFrameCounterReader(
  memory: GuestMemory,
  exe: Uint8Array,
  settingsSignature: ByteSignature,
): GameFrameReader | null {
  const counters = resolveFrameCounters(memory, exe, settingsSignature);
  if (!counters) return null;
  return () => {
    try {
      const read = (pointer: number) => {
        const bytes = memory.read_memory(pointer, 4);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      };
      return {
        frame: read(counters.frame),
        gameSpeed: read(counters.gameSpeed),
        sessionSpeed: read(counters.sessionSpeed),
        requestedFps: read(counters.requestedFps),
      };
    } catch {
      return null;
    }
  };
}
