/**
 * BroadcastChannel DirectPlay transport unit tests (migrated from scripts/dplayBroadcastChannelSmoke.mts).
 * Guest memory reads return views into the entire WASM buffer. Before postMessage, clone only the logical payload, not the VM's entire backing buffer. BroadcastChannel is global in Node.
 */
import { expect, it } from 'vitest';
import { BroadcastChannelTransport } from '../../src/vm86/shim/dplayTransport';
import type { DplayWire } from '../../src/vm86/shim/dplayWire';

it('BroadcastChannel 精确尺寸 payload 克隆（不携带整个 VM 底缓冲）', async () => {
  // Random channel name avoids conflicts with other tests/processes.
  const channelName = `dplay-broadcast-smoke-${Date.now()}-${Math.random()}`;
  const oversizedBacking = new Uint8Array(1024 * 1024);
  oversizedBacking.set([1, 2, 3, 4, 5], 123);
  const narrowPayload = oversizedBacking.subarray(123, 128);

  let receiver!: BroadcastChannelTransport;
  let timeout: ReturnType<typeof setTimeout>;
  const received = new Promise<DplayWire>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('BroadcastChannel payload was not delivered')), 2000);
    receiver = new BroadcastChannelTransport({ onMessage: resolve }, channelName);
  });
  const sender = new BroadcastChannelTransport({ onMessage() {} }, channelName);

  try {
    expect(sender.send({ t: 'msg', i: 'smoke-room', f: 1, o: 2, a: narrowPayload })).toBe(true);
    const cloned = await received;
    expect(cloned.t).toBe('msg');
    if (cloned.t !== 'msg') throw new Error('Expected a msg payload');
    expect([...cloned.a]).toEqual([1, 2, 3, 4, 5]);
    expect(cloned.a.byteLength).toBe(5);
    expect(cloned.a.buffer.byteLength, 'must not clone the full VM backing buffer').toBe(5);
  } finally {
    clearTimeout(timeout!);
    sender.close();
    receiver.close();
  }
}, 10_000);
