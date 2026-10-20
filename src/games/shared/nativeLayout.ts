import { inspectPe32, type ByteSignature, type PeProbeBytes, type PeImageProbe } from '../../vm86/peProbe';
import type { GuestMemory } from '../../vm86/win32';
import { resolveFrameCounters } from './frameCounter';

const word = [null, null, null, null] as const;
export const operand = (match: PeProbeBytes, offset: number): number =>
  new DataView(match.bytes.buffer, match.bytes.byteOffset, match.bytes.byteLength).getUint32(offset, true);
export const relativeTarget = (match: PeProbeBytes, offset: number): number =>
  match.address + offset + 5 + (operand(match, offset + 1) | 0);

/** Evidence is copied from the immutable executable, then checked against the loaded image before use. */
export function matchesLoaded(memory: GuestMemory, evidence: readonly PeProbeBytes[]): boolean {
  try {
    return evidence.every(({ address, bytes }) => {
      const live = memory.read_memory(address, bytes.length);
      return live.length === bytes.length && bytes.every((value, i) => value === live[i]);
    });
  } catch {
    return false;
  }
}

export interface NativeLayoutPolicy {
  settingsSignature: ByteSignature;
  menuRegister: 0xbd | 0xbe;
}

/** Resolve shared Westwood instruction shapes, never an executable hash or a global address delta. */
export function resolveNativeLayout(memory: GuestMemory, exe: Uint8Array, policy: NativeLayoutPolicy) {
  const image = inspectPe32(exe);
  const counters = resolveFrameCounters(memory, exe, policy.settingsSignature);
  if (!image || !counters) return null;
  const settings = resolveSettings(image, counters.settings);
  if (!settings || !matchesLoaded(memory, settings.evidence)) return null;
  const menu = resolveMenu(image, policy.menuRegister, counters.sessionSpeed);
  const battle = resolveBattle(image);
  const repair = resolveRepair(image, settings.pointer, counters.frame);
  const lan = resolveLan(image, counters);
  const restorationFault = image.findCode([
    0x3b, 0x01, 0x74, 0x16, 0xc7, 0x44, 0x24, 0x10, 0, 0, 0, 0, 0xb8, 1, 0, 0, 0, 0x99, 0xf7, 0x7c, 0x24, 0x10, 0x89,
    0x44, 0x24, 0x10, 0x85, 0xed, 0x7f, 0xbf,
  ]);
  return {
    image,
    counters,
    settings,
    restorationFault:
      restorationFault && matchesLoaded(memory, [restorationFault]) ? restorationFault.address + 18 : null,
    menu: menu && matchesLoaded(memory, menu.evidence) ? menu : null,
    battle: battle && matchesLoaded(memory, battle.evidence) ? battle : null,
    repair: repair && matchesLoaded(memory, repair.evidence) ? repair : null,
    lan: lan && matchesLoaded(memory, lan.evidence) ? lan : null,
  };
}

function resolveSettings(image: PeImageProbe, settings: PeProbeBytes) {
  // The initializer loads one singleton, then copies six fields without changing EAX.
  const prefix = image.read(settings.address - 46, 46, 'code');
  if (!prefix || prefix.bytes[0] !== 0xa1 || prefix.bytes[5] !== 0x68) return null;
  const offset = operand(settings, 2);
  const first = settings.bytes[1] === 0x90 ? [0x88, 0x0d] : [0x90, 0x15];
  const second = settings.bytes[1] === 0x90 ? [0x90, 0x15] : [0x88, 0x0d];
  for (const [at, delta, registers] of [
    [10, -28, first],
    [22, -12, second],
    [34, -4, first],
  ] as const) {
    if (
      prefix.bytes[at] !== 0x8b ||
      prefix.bytes[at + 1] !== registers[0] ||
      operand(prefix, at + 2) !== offset + delta ||
      prefix.bytes[at + 6] !== 0x89 ||
      prefix.bytes[at + 7] !== registers[1] ||
      !image.contains(operand(prefix, at + 8), 4, 'data')
    )
      return null;
  }
  const pointer = operand(prefix, 1);
  if (pointer % 4 || !image.contains(pointer, 4, 'data') || offset < 4 || offset > 0x10000) return null;
  return { pointer, offset, evidence: [prefix, settings] };
}

function resolveMenu(image: PeImageProbe, register: number, sessionSpeed: number) {
  // Both compiler choices (ECX/EDX) preserve the same EBP state in RA2. YR uses ESI.
  const match = image.findCode(
    [
      0xa1,
      ...word,
      0x3b,
      0xc3,
      0x75,
      7,
      register,
      18,
      0,
      0,
      0,
      0xeb,
      13,
      0x33,
      null,
      0x83,
      0xf8,
      4,
      0x0f,
      0x94,
      null,
      0x83,
      null,
      16,
      0x8b,
      null,
      0xa0,
      ...word,
      0x84,
      0xc0,
    ],
    (m) => {
      const temp = m.bytes[17] === 0xc9 ? 1 : m.bytes[17] === 0xd2 ? 2 : -1;
      return (
        temp >= 0 &&
        m.bytes[23] === 0xc0 + temp &&
        m.bytes[25] === 0xc0 + temp &&
        m.bytes[28] === (register === 0xbd ? 0xe8 : 0xf0) + temp &&
        operand(m, 1) === sessionSpeed - 48 &&
        image.contains(operand(m, 30), 1, 'data')
      );
    },
  );
  return match
    ? {
        site: match.address + 9,
        signature: [...match.bytes.subarray(9, 29)],
        movOperand: register === 0xbd ? 0x2d : 0x35,
        evidence: [match],
      }
    : null;
}

function resolveBattle(image: PeImageProbe) {
  const match = image.findCode([
    0x8b,
    0x44,
    0x24,
    4,
    0x3d,
    0x17,
    6,
    0,
    0,
    0x74,
    0x22,
    0x3d,
    0xc0,
    5,
    0,
    0,
    0x74,
    0x1b,
    0xe8,
    ...word,
    0x3c,
    1,
    0x74,
    0x12,
    0x32,
    0xc9,
    0xe8,
    ...word,
    0x8b,
    0x44,
    0x24,
    4,
    0x3d,
    0x17,
    6,
    0,
    0,
    0x75,
    0xde,
  ]);
  if (!match) return null;
  // Recover the dialog callback from the adjacent native creation of template 0x102.
  const setup = image.findCode(
    [0xba, ...word, 0xb9, 2, 1, 0, 0],
    (m) => m.address < match.address && m.address >= match.address - 64,
  );
  if (!setup) return null;
  const callback = operand(setup, 1);
  const dispatch = image.read(callback, 0x64, 'code');
  if (!dispatch) return null;
  const signature: ByteSignature = [
    0x81,
    0xfe,
    0x11,
    1,
    0,
    0,
    0x75,
    0x79,
    0x8b,
    0xc5,
    0x8b,
    0xd5,
    0xc1,
    0xe8,
    16,
    0x50,
    0x57,
    0x81,
    0xe2,
    0xff,
    0xff,
    0,
    0,
    0x8b,
    0xcb,
    0xe8,
    ...word,
    0x5f,
    0x5e,
    0x5d,
    0xb8,
    1,
    0,
    0,
    0,
    0x5b,
    0xc2,
    16,
    0,
  ];
  const route = image.findCode(signature, (m) => m.address === callback + 0x3a);
  if (!route) return null;
  const handler = relativeTarget(route, 25);
  const entry = image.read(handler, 14, 'code');
  // Native handler receives ECX/EDX and saves them before dispatching commands.
  if (
    !entry ||
    ![0x81, 0xec].every((b, i) => entry.bytes[i] === b) ||
    ![0x53, 0x55, 0x56, 0x57, 0x8b, 0xe9, 0x8b].every((b, i) => entry.bytes[i + 6] === b) ||
    ![0xda, 0xf2].includes(entry.bytes[13]!) ||
    ![18, 29].every((at) => image.contains(relativeTarget(match, at), 1, 'code'))
  )
    return null;
  return { site: match.address, handler, evidence: [match, setup, dispatch, route, entry] };
}

function resolveRepair(image: PeImageProbe, settingsPointer: number, frame: number) {
  const match = image.findCode(
    [
      0xa1,
      ...word,
      0xdd,
      0x80,
      ...word,
      0xdc,
      0x0d,
      ...word,
      0xe8,
      ...word,
      0x8b,
      0xc8,
      0xa1,
      ...word,
      0x99,
      0xf7,
      0xf9,
      0x85,
      0xd2,
      0x74,
      6,
      0x5f,
      0x5e,
      0x32,
      0xc0,
      0x5b,
      0xc3,
    ],
    (m) => operand(m, 1) === settingsPointer && operand(m, 25) === frame,
  );
  if (!match) return null;
  const multiplier = image.read(operand(match, 13), 8, 'readonly');
  const offset = operand(match, 7);
  if (
    !multiplier ||
    new DataView(multiplier.bytes.buffer, multiplier.bytes.byteOffset, 8).getFloat64(0, true) !== 900 ||
    offset % 8 ||
    offset > 0x10000 ||
    !image.contains(relativeTarget(match, 17), 1, 'code')
  )
    return null;
  return { pointer: settingsPointer, offset, divide: match.address + 30, evidence: [match, multiplier] };
}

function resolveLan(
  image: PeImageProbe,
  counters: { frame: number; gameSpeed: number; sessionSpeed: number; requestedFps: number },
) {
  const patterns: ByteSignature[] = [
    [0xb9, 5, 0, 0, 0, 0x3b, 0xc6, 0x89, 0x0d, ...word],
    [0xb8, 5, 0, 0, 0, 0x89, 0x15, ...word, 0x8b, 0x15, ...word, 0x3b, 0xd6, 0xa3, ...word],
    [0xb8, 5, 0, 0, 0, 0x3b, 0xce, 0xa3, ...word],
    [0xb8, 5, 0, 0, 0, 0x3b, 0xcf, 0xa3, ...word],
  ];
  const sites = patterns.map((pattern, i) =>
    image.findCode(
      pattern,
      (m) =>
        operand(m, i === 0 ? 9 : i === 1 ? 20 : 8) === counters.requestedFps - 4 &&
        (i !== 1 || (operand(m, 7) === counters.gameSpeed && operand(m, 13) === counters.sessionSpeed - 28)),
    ),
  );
  if (sites.some((m) => !m)) return null;
  const reportPrefix = image.findCode(
    [
      0x8b,
      0x0d,
      ...word,
      0x8b,
      0x35,
      ...word,
      0x8b,
      0x1d,
      ...word,
      0x8b,
      0xd1,
      0x81,
      0xe2,
      0xff,
      0,
      0,
      0,
      0x3b,
      0xcf,
      0x89,
      0x34,
      0x95,
      ...word,
      0xba,
      20,
      0,
      0,
      0,
      0x0f,
      0x84,
      ...word,
      0x3b,
      0xdf,
      0x0f,
      0x85,
      ...word,
      0xf6,
      0xc1,
      127,
      0x0f,
      0x85,
      ...word,
      0x8b,
      0x45,
      0,
      0x8b,
      0xcd,
      0xff,
      0x50,
      0x30,
    ],
    (m) => operand(m, 2) === counters.frame,
  );
  const report = reportPrefix && image.read(reportPrefix.address + 54, 9, 'code');
  const negotiate = image.findCode(
    [0xa0, ...word, 0x84, 0xc0, 0x0f, 0x85, ...word],
    (m) =>
      operand(m, 1) === counters.frame && !!report && m.address > report.address && m.address < report.address + 0x1000,
  );
  if (!report || !negotiate) return null;
  const beforeReport = reportPrefix!;
  // JNE near targets must stay in executable sections; displacement bytes are not version identifiers.
  for (const [m, at] of [
    [report, 3],
    [negotiate, 7],
  ] as const)
    if (!image.contains(m.address + at + 6 + (operand(m, at + 2) | 0), 1, 'code')) return null;
  return {
    sites: sites as PeProbeBytes[],
    report,
    negotiate,
    evidence: [...(sites as PeProbeBytes[]), beforeReport, report, negotiate],
  };
}
