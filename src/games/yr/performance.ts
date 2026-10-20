import type { GuestMemory } from '../../vm86/win32';
import { createFrameCounterReader } from '../shared/frameCounter';

/** YR 1.001 layout evidence: settings at EAX+0x14a0, independently copied into Session.GameSpeed. */
export function createYrFrameReader(memory: GuestMemory, exe: Uint8Array) {
  return createFrameCounterReader(memory, exe, YR_SETTINGS_SIGNATURE);
}

export const YR_SETTINGS_SIGNATURE = [
  0x8b,
  0x88,
  0xa0,
  0x14,
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
  0xa4,
  0x14,
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
  0xa8,
  0x14,
  0,
  0,
  0x89,
  0x0d,
  null,
  null,
  null,
  null,
] as const;
