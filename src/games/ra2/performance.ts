import type { GuestMemory } from '../../vm86/win32';
import { createFrameCounterReader } from '../shared/frameCounter';

/** RA2 1.006 layout evidence: settings at EAX+0x1108, independently copied into Session.GameSpeed. */
export function createRa2FrameReader(memory: GuestMemory, exe: Uint8Array) {
  return createFrameCounterReader(memory, exe, RA2_SETTINGS_SIGNATURE);
}

export const RA2_SETTINGS_SIGNATURE = [
  0x8b,
  0x90,
  0x08,
  0x11,
  0,
  0,
  0x89,
  0x15,
  null,
  null,
  null,
  null,
  0x8b,
  0x88,
  0x0c,
  0x11,
  0,
  0,
  0x89,
  0x0d,
  null,
  null,
  null,
  null,
  0x8b,
  0x90,
  0x10,
  0x11,
  0,
  0,
  0x89,
  0x15,
  null,
  null,
  null,
  null,
] as const;
