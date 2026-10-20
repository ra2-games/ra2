import type { GuestMemory } from '../../vm86/win32';
import { createCommandQueueReader } from '../shared/commandQueue';

/** YR 1.001: EventClass is 111 bytes; all ring addresses are isolated from RA2. */
export function createYrCommandQueueReader(memory: GuestMemory) {
  return createCommandQueueReader(memory, {
    outgoing: 0xa802c8,
    scheduled: 0x8b41f8,
    signatures: [
      {
        address: 0x6521c0,
        bytes: [0xa1, 0x84, 0xed, 0xa8, 0, 0x89, 0x44, 0x24, 7, 0xa1, 0xc8, 2, 0xa8, 0, 0x3d, 0x80, 0, 0, 0],
      },
      { address: 0x64750b, bytes: [0xa1, 0xf8, 0x41, 0x8b, 0, 0x3d, 0, 0x40, 0, 0] },
    ],
  });
}
