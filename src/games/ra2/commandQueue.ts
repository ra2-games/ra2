import type { GuestMemory } from '../../vm86/win32';
import { createCommandQueueReader } from '../shared/commandQueue';

/** RA2 1.006: independently verify OutList append and DoList capacity-check instructions without installing guest jumps. */
export function createRa2CommandQueueReader(memory: GuestMemory) {
  return createCommandQueueReader(memory, {
    outgoing: 0xa32338,
    scheduled: 0x866270,
    signatures: [
      {
        address: 0x62e670,
        bytes: [0xa1, 0x2c, 0x0d, 0xa4, 0, 0x89, 0x44, 0x24, 7, 0xa1, 0x38, 0x23, 0xa3, 0, 0x3d, 0x80, 0, 0, 0],
      },
      { address: 0x623a1b, bytes: [0xa1, 0x70, 0x62, 0x86, 0, 0x3d, 0, 0x40, 0, 0] },
    ],
  });
}
