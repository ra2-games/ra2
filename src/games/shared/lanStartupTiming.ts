import { le32 } from './bytes';

// Native speed settings: 0 -> 60, 1 -> 45, other valid settings -> integer 60 / setting.
// Run on the LAN startup path using this room's settings; preserve timers, acknowledgments, and later Timing events.

export function makeLanStartupTiming(
  sessionSpeed: number,
  requestedFps: number,
  moveOpcode: number,
  sendRate: number,
): number[] {
  return [
    0x9c,
    0x50,
    0x51,
    0x52, // pushfd; preserve temporary registers.
    0x8b,
    0x0d,
    ...le32(sessionSpeed),
    0xb8,
    ...le32(30), // Keep the native conservative starting value for invalid settings, avoiding divide-by-zero or abnormal acceleration.
    0x83,
    0xf9,
    6,
    0x77,
    24, // unsigned > 6 → store
    0xb8,
    ...le32(60),
    0x85,
    0xc9,
    0x74,
    15, // 0 → store
    0x83,
    0xf9,
    1,
    0x75,
    7,
    0xb8,
    ...le32(45),
    0xeb,
    3,
    0x99,
    0xf7,
    0xf9, // cdq; idiv ecx
    0xa3,
    ...le32(requestedFps),
    0x5a,
    0x59,
    0x58,
    0x9d,
    moveOpcode,
    ...le32(sendRate), // Replay the replaced mov eax/ecx, FrameSendRate.
    0xc3,
  ];
}

export function lanTimingCall(site: number, target: number): number[] {
  return [0xe8, ...le32(target - site - 5)];
}
