/** Affects only outbound game datagrams from the relay; does not simulate TCP retransmission or disturb handshakes and heartbeats. */
export interface RelayFaultConfig {
  seed?: number;
  room?: string;
  fromClientId?: string;
  toClientId?: string;
  delayMs?: number;
  jitterMs?: number;
  lossRate?: number;
  blackholeMs?: number;
  bytesPerSecond?: number;
  maxQueuedPackets?: number;
  maxQueuedBytes?: number;
}

export function parseRelayFaultConfig(json: string | undefined): RelayFaultConfig | undefined {
  if (!json) return undefined;
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('弱网配置必须是 JSON 对象');
  const config = value as Record<string, unknown>;
  const ranges: Record<string, [number, number]> = {
    seed: [0, 0xffffffff],
    delayMs: [0, 60000],
    jitterMs: [0, 60000],
    lossRate: [0, 1],
    blackholeMs: [0, 300000],
    bytesPerSecond: [1, 1e9],
    maxQueuedPackets: [1, 10000],
    maxQueuedBytes: [1, 64 * 1024 * 1024],
  };
  for (const [key, entry] of Object.entries(config)) {
    if (['room', 'fromClientId', 'toClientId'].includes(key)) {
      if (typeof entry !== 'string' || !entry.length || entry.length > 128) throw new Error(`弱网配置 ${key} 无效`);
    } else {
      const range = ranges[key];
      if (
        !range ||
        typeof entry !== 'number' ||
        !Number.isFinite(entry) ||
        entry < range[0] ||
        entry > range[1] ||
        (['seed', 'maxQueuedPackets', 'maxQueuedBytes'].includes(key) && !Number.isInteger(entry))
      ) {
        throw new Error(`弱网配置 ${key} 无效`);
      }
    }
  }
  return config as RelayFaultConfig;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  from: number;
  to: number;
  bytes: number;
  finish: (deliver: boolean) => void;
}

/** Bounded, ordered fault queue; connection IDs, not reusable virtual addresses, determine queue lifetime. */
export class RelayFaults {
  private readonly config: RelayFaultConfig;
  private randomState: number;
  private readonly startedAt = performance.now();
  private readonly pending = new Set<Pending>();
  private readonly dueByTarget = new Map<number, number>();
  private queuedBytes = 0;
  private closed = false;
  private dropped = 0;
  private delayed = 0;

  constructor(config: RelayFaultConfig) {
    this.config = parseRelayFaultConfig(JSON.stringify(config))!;
    this.randomState = this.config.seed ?? 1;
  }

  private random(): number {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
    return this.randomState / 0x100000000;
  }

  getStats() {
    return {
      queuedPackets: this.pending.size,
      queuedBytes: this.queuedBytes,
      dropped: this.dropped,
      delayed: this.delayed,
    };
  }

  route(
    room: string,
    from: { id: number; clientId: string },
    to: { id: number; clientId: string },
    bytes: number,
    finish: (deliver: boolean) => void,
  ): void {
    const c = this.config;
    if (this.closed) {
      finish(false);
      return;
    }
    if (
      (c.room && c.room !== room) ||
      (c.fromClientId && c.fromClientId !== from.clientId) ||
      (c.toClientId && c.toClientId !== to.clientId)
    ) {
      finish(true);
      return;
    }
    const now = performance.now();
    if (now - this.startedAt < (c.blackholeMs ?? 0) || this.random() < (c.lossRate ?? 0)) {
      this.dropped++;
      finish(false);
      return;
    }
    // Preserve order per receiving connection; bandwidth caps apply to selected traffic per receiver, not the entire server.
    const delay = Math.max(0, (c.delayMs ?? 0) + (this.random() * 2 - 1) * (c.jitterMs ?? 0));
    const due =
      Math.max(now + delay, this.dueByTarget.get(to.id) ?? now) +
      (c.bytesPerSecond ? (bytes * 1000) / c.bytesPerSecond : 0);
    if (due <= now) {
      finish(true);
      return;
    }
    if (
      this.pending.size >= (c.maxQueuedPackets ?? 1024) ||
      this.queuedBytes + bytes > (c.maxQueuedBytes ?? 4 * 1024 * 1024) ||
      due - now > 300000
    ) {
      this.dropped++;
      finish(false);
      return;
    }
    this.dueByTarget.set(to.id, due);
    const item: Pending = {
      from: from.id,
      to: to.id,
      bytes,
      finish,
      timer: setTimeout(() => this.settle(item, true), due - now),
    };
    this.pending.add(item);
    this.queuedBytes += bytes;
    this.delayed++;
  }

  private settle(item: Pending, deliver: boolean): void {
    if (!this.pending.delete(item)) return;
    clearTimeout(item.timer);
    this.queuedBytes -= item.bytes;
    if (!deliver) this.dropped++;
    if (![...this.pending].some((other) => other.to === item.to)) this.dueByTarget.delete(item.to);
    item.finish(deliver);
  }

  disconnect(id: number): void {
    for (const item of this.pending) if (item.from === id || item.to === id) this.settle(item, false);
    this.dueByTarget.delete(id);
  }

  close(): void {
    this.closed = true;
    for (const item of this.pending) this.settle(item, false);
    this.dueByTarget.clear();
  }
}
