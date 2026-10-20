import type { GuestMemory } from '../../vm86/win32';

export interface DeployQueueEntry {
  queue: 'outgoing' | 'scheduled';
  slot: number;
  frame: number;
  house: number;
  targetId: number;
  targetType: number;
  flags: number;
  executed: boolean;
}

/**
 * Explicit diagnostics: read only the latest 128 ring slots, including dequeued history not yet overwritten.
 * This is not a complete event log; missing overwritten samples do not prove an event was never sent.
 */
export function createCommandQueueReader(
  memory: GuestMemory,
  profile: {
    signatures: ReadonlyArray<{ address: number; bytes: readonly number[] }>;
    outgoing: number;
    scheduled: number;
  },
): (() => DeployQueueEntry[] | null) | null {
  try {
    for (const { address, bytes } of profile.signatures) {
      const actual = memory.read_memory(address, bytes.length);
      if (actual.length !== bytes.length || !actual.every((byte, i) => byte === bytes[i])) return null;
    }
  } catch {
    return null;
  }
  return () => {
    try {
      const result: DeployQueueEntry[] = [];
      for (const [queue, address, capacity] of [
        ['outgoing', profile.outgoing, 128],
        ['scheduled', profile.scheduled, 16384],
      ] as const) {
        const header = memory.read_memory(address, 12);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const count = view.getUint32(0, true),
          head = view.getUint32(4, true),
          tail = view.getUint32(8, true);
        if (count > capacity || head >= capacity || tail >= capacity) return null;
        let slot = (tail + capacity - 128) % capacity,
          remaining = 128;
        while (remaining) {
          const slots = Math.min(remaining, capacity - slot);
          const bytes = memory.read_memory(address + 12 + slot * 111, slots * 111);
          if (bytes.length !== slots * 111) return null;
          const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let i = 0; i < slots; i++) {
            const offset = i * 111;
            // Native DEPLOY=9; Frame is the original event field and denotes the planned execution frame in scheduled queues.
            if (bytes[offset] !== 9 || bytes[offset + 2] === 255) continue;
            // Both versions' send paths only AND 0xFE, and execution paths only OR 1; the high seven bits may retain stack data.
            // Do not filter for canonical C++ bool values 0/1, which would miss real local events.
            const flags = bytes[offset + 1]!;
            result.push({
              queue,
              slot: slot + i,
              frame: data.getUint32(offset + 3, true),
              house: bytes[offset + 2]!,
              targetId: data.getUint32(offset + 7, true),
              targetType: bytes[offset + 11]!,
              flags,
              executed: (flags & 1) !== 0,
            });
          }
          remaining -= slots;
          slot = 0;
        }
      }
      return result;
    } catch {
      return null;
    }
  };
}
