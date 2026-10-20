import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocket, type WebSocket as WebSocketType } from 'ws';
import {
  createGameRelay,
  sendGameRelayFrame,
  type GameRelay,
  type GameRelaySocketAdapter,
} from '../src/server/gameRelay';
import {
  RELAY_MAX_BUFFERED_BYTES,
  RELAY_SUBNET_BROADCAST,
  RELAY_SUBNET_PREFIX,
  decodeRelayFrame,
  encodeRelayFrame,
  isAssignableRoomAddress,
} from '../src/network/relayWire';
import type { RelayWire } from '../src/network/relayWire';

type Predicate = (message: RelayWire) => boolean;
const EXE_HASH_A = 'a'.repeat(64);
const EXE_HASH_B = 'b'.repeat(64);

class RelayClient {
  readonly messages: RelayWire[] = [];
  private readonly waiters: Array<{
    predicate: Predicate;
    resolve: (message: RelayWire) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closedCode: number | null = null;
  private readonly closeWaiters: Array<(code: number) => void> = [];

  constructor(readonly socket: WebSocketType) {
    socket.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const message = decodeRelayFrame(rawDataBytes(data));
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index < 0) {
        this.messages.push(message);
        return;
      }
      const waiter = this.waiters.splice(index, 1)[0]!;
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    });
    socket.on('close', (code) => {
      this.closedCode = code;
      for (const resolve of this.closeWaiters.splice(0)) resolve(code);
    });
    socket.on('error', () => undefined);
  }

  send(message: RelayWire): void {
    this.socket.send(Buffer.from(encodeRelayFrame(message)));
  }

  hello(room: string, exe = EXE_HASH_A): void {
    this.send({
      t: 'hello',
      room,
      exe,
      nonce: `nonce-${Math.random().toString(36).slice(2, 10)}`,
      n: new Uint8Array([1, 2]),
    });
  }

  next(predicate: Predicate, timeoutMs = 2_000): Promise<RelayWire> {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise<RelayWire>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1);
        reject(
          new Error(
            `timed out waiting for relay message; queued=${this.messages.map((message) => message.t).join(',')}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async close(): Promise<number> {
    if (this.closedCode !== null) return this.closedCode;
    this.socket.close();
    return new Promise<number>((resolve) => this.closeWaiters.push(resolve));
  }
}

function rawDataBytes(data: WebSocket.RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    const combined = Buffer.concat(data);
    return new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
  }
  throw new Error('unexpected WebSocket data');
}

interface RelayHarness {
  relay: GameRelay;
  server: Server;
  endpoint: string;
}

async function openHarness(options: import('../src/server/gameRelay').GameRelayOptions = {}): Promise<RelayHarness> {
  const relay = createGameRelay({ logger: () => undefined, heartbeatIntervalMs: 60_000, ...options });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    if (path === '/ra2') relay.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { relay, server, endpoint: `ws://127.0.0.1:${address.port}/ra2` };
}

async function connect(endpoint: string, clientId: string): Promise<RelayClient> {
  const socket = new WebSocket(`${endpoint}?clientId=${encodeURIComponent(clientId)}`);
  const client = new RelayClient(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return client;
}

async function waitForClose(socket: WebSocketType): Promise<number> {
  return new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
}

const isType =
  (type: RelayWire['t']): Predicate =>
  (message) =>
    message.t === type;

describe('RA2 network relay', () => {
  const harnesses: RelayHarness[] = [];
  const clients: RelayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => -1);
    for (const harness of harnesses.splice(0)) {
      harness.relay.close();
      await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    }
  });

  it('在记录日志前拒绝含控制字符的客户端 ID', async () => {
    const logs: string[] = [];
    const harness = await openHarness({ logger: (message) => logs.push(message) });
    harnesses.push(harness);
    const socket = new WebSocket(`${harness.endpoint}?clientId=${encodeURIComponent('client\nlog')}`);
    socket.on('error', () => undefined);
    expect(await waitForClose(socket)).toBe(1008);
    expect(logs).toEqual([]);
  });

  it('WS 分片仍交付完整消息，无魔数的连续数据报保持边界', async () => {
    const harness = await openHarness();
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'fragment-host');
    const peer = await connect(harness.endpoint, 'fragment-peer');
    clients.push(host, peer);
    const hello = encodeRelayFrame({ t: 'hello', room: 'ignored', exe: EXE_HASH_A, nonce: 'n', n: new Uint8Array() });
    host.socket.send(hello.subarray(0, 1), { fin: false });
    host.socket.send(hello.subarray(1), { fin: true });
    await host.next(isType('welcome'));
    peer.hello('ignored');
    await peer.next(isType('welcome'));
    const datagram = encodeRelayFrame({
      t: 'datagram',
      src: 0,
      dest: 0xffffffff,
      sport: 1,
      dport: 2,
      a: new Uint8Array([0, 1, 5]),
    });
    host.socket.send(datagram.subarray(0, 6), { fin: false });
    host.socket.send(datagram.subarray(6), { fin: true });
    host.send({ t: 'datagram', src: 0, dest: 0xffffffff, sport: 1, dport: 2, a: new Uint8Array([9]) });
    expect(await peer.next(isType('datagram'))).toMatchObject({ a: new Uint8Array([0, 1, 5]) });
    expect(await peer.next(isType('datagram'))).toMatchObject({ a: new Uint8Array([9]) });
  });

  it('handshakes, rewrites source addresses, fans out broadcast and reports exact route/drop counts', async () => {
    const harness = await openHarness();
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'host');
    const peer = await connect(harness.endpoint, 'peer');
    clients.push(host, peer);
    host.hello('relay-room');
    const hostWelcome = await host.next(isType('welcome'));
    peer.hello('relay-room');
    const peerWelcome = await peer.next(isType('welcome'));
    if (hostWelcome.t !== 'welcome' || peerWelcome.t !== 'welcome')
      throw new Error('relay did not welcome both clients');
    await peer.next(isType('peer-join'));
    await host.next(isType('peer-join'));

    host.send({
      t: 'datagram',
      src: 0x0102_0304,
      sport: 1234,
      dest: peerWelcome.addr,
      dport: 7000,
      a: new Uint8Array([1, 2]),
    });
    const direct = await peer.next(isType('datagram'));
    if (direct.t !== 'datagram') throw new Error('relay did not route a datagram');
    expect(direct).toMatchObject({ t: 'datagram', src: hostWelcome.addr, sport: 1234, dport: 7000 });
    expect([...direct.a]).toEqual([1, 2]);

    peer.send({
      t: 'datagram',
      src: 0,
      sport: 5000,
      dest: RELAY_SUBNET_BROADCAST,
      dport: 6000,
      a: new Uint8Array([3]),
    });
    const broadcast = await host.next(isType('datagram'));
    expect(broadcast).toMatchObject({ t: 'datagram', src: peerWelcome.addr, dest: RELAY_SUBNET_BROADCAST });

    host.send({
      t: 'datagram',
      src: 0,
      sport: 1,
      dest: 0x0af7_6363,
      dport: 1,
      a: new Uint8Array([9]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.socket.readyState).toBe(WebSocket.OPEN);
    expect(harness.relay.getStats()).toMatchObject({ datagramsRouted: 2, datagramsDropped: 1 });

    await peer.close();
    const leave = await host.next(isType('peer-leave'));
    expect(leave).toMatchObject({ t: 'peer-leave', addr: peerWelcome.addr });
  });

  it('分配的房间地址在两个主机号八位组上都避开 0/255', async () => {
    const harness = await openHarness();
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'octet-host');
    clients.push(host);
    host.hello('ignored');
    const welcome = await host.next(isType('welcome'));
    if (welcome.t !== 'welcome') throw new Error('relay did not welcome the host');
    // Regression: the allocation loop previously skipped only low=0, giving the first connection 10.247.0.1 (high=0).
    expect(welcome.addr).not.toBe((RELAY_SUBNET_PREFIX | 0x0001) >>> 0);
    expect(isAssignableRoomAddress(welcome.addr)).toBe(true);
  });

  it('uses injected time for token refill and counts rate-limited destinations as drops', async () => {
    let now = 0;
    const harness = await openHarness({
      now: () => now,
      limits: { ratePacketsPerSec: 1, rateBytesPerSec: 100, rateAbuseClosePackets: 100 },
    });
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'rate-host');
    const peer = await connect(harness.endpoint, 'rate-peer');
    clients.push(host, peer);
    host.hello('rate-room');
    await host.next(isType('welcome'));
    peer.hello('rate-room');
    const peerWelcome = await peer.next(isType('welcome'));
    if (peerWelcome.t !== 'welcome') throw new Error('relay did not welcome rate peer');
    await host.next(isType('peer-join'));

    const send = () =>
      host.send({
        t: 'datagram',
        src: 0,
        sport: 1,
        dest: peerWelcome.addr,
        dport: 2,
        a: new Uint8Array([7]),
      });
    send();
    await peer.next(isType('datagram'));
    send();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.relay.getStats()).toMatchObject({ datagramsRouted: 1, datagramsDropped: 1, rateLimited: 1 });

    now = 1_000;
    send();
    await peer.next(isType('datagram'));
    expect(harness.relay.getStats().datagramsRouted).toBe(2);
  });

  it('protects a slow consumer and send failures without requiring a real buffered socket', () => {
    const socket = { readyState: WebSocket.OPEN } as unknown as WebSocketType;
    const close = vi.fn();
    const send = vi.fn();
    const adapter: GameRelaySocketAdapter = {
      isOpen: () => true,
      bufferedAmount: () => RELAY_MAX_BUFFERED_BYTES + 1,
      send,
      close,
    };
    expect(
      sendGameRelayFrame(socket, new Uint8Array([1]), { maxBufferedBytes: RELAY_MAX_BUFFERED_BYTES }, adapter),
    ).toBe(false);
    expect(close).toHaveBeenCalledWith(socket, 1008, 'slow consumer');
    expect(send).not.toHaveBeenCalled();

    const failedAdapter: GameRelaySocketAdapter = {
      ...adapter,
      bufferedAmount: () => 0,
      send: () => {
        throw new Error('socket failure');
      },
    };
    expect(
      sendGameRelayFrame(socket, new Uint8Array([1]), { maxBufferedBytes: RELAY_MAX_BUFFERED_BYTES }, failedAdapter),
    ).toBe(false);
  });

  it('服务关闭接管协议拒绝后卡在 CLOSING 的连接，drained 不提前返回', async () => {
    vi.useFakeTimers();
    try {
      class ClosingSocket extends EventEmitter {
        readyState: number = WebSocket.OPEN;
        bufferedAmount = 0;
        readonly terminate = vi.fn(() => {
          this.readyState = WebSocket.CLOSED;
          this.emit('close');
        });
        send(): void {}
        ping(): void {}
        close = vi.fn(() => {
          this.readyState = WebSocket.CLOSING;
        });
      }
      const relay = createGameRelay({ logger: () => undefined, heartbeatIntervalMs: 60_000 });
      const socket = new ClosingSocket();
      relay.acceptTransport(socket as unknown as import('../src/server/gameRelay').RelayConnectionSocket, null, 'ra2');
      socket.emit('message', Buffer.from([0]), true);
      expect(socket.readyState).toBe(WebSocket.CLOSING);

      relay.close();
      let drained = false;
      const waiting = relay.drained(2500).then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(drained).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.terminate).toHaveBeenCalledOnce();
      await waiting;
      expect(drained).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects truncated binary hello and mismatched compatibility hashes', async () => {
    const harness = await openHarness();
    harnesses.push(harness);

    const missing = await connect(harness.endpoint, 'missing-hash');
    clients.push(missing);
    missing.socket.send(Buffer.from([0x47, 0x52, 3, 1, 0, 1, 0x72]));
    expect(await missing.close()).toBe(1002);

    const malformed = await connect(harness.endpoint, 'malformed-hash');
    clients.push(malformed);
    malformed.socket.send(Buffer.concat([Buffer.from([0x47, 0x52, 3, 1, 0, 1, 0x72]), Buffer.alloc(31)]));
    expect(await malformed.close()).toBe(1002);

    const host = await connect(harness.endpoint, 'strict-host');
    clients.push(host);
    host.hello('strict-room', EXE_HASH_A);
    await host.next(isType('welcome'));

    const mismatched = await connect(harness.endpoint, 'mismatched-hash');
    clients.push(mismatched);
    mismatched.hello('strict-room', EXE_HASH_B);
    expect(await mismatched.close()).toBe(1008);
  });

  it('真实 WS 握手不受弱网影响，数据报按服务端规则丢弃', async () => {
    const harness = await openHarness({ faults: { lossRate: 1, fromClientId: 'fault-host' } });
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'fault-host');
    const peer = await connect(harness.endpoint, 'fault-peer');
    clients.push(host, peer);
    host.hello('fault-room');
    await host.next(isType('welcome'));
    peer.hello('fault-room');
    await peer.next(isType('welcome'));
    await host.next(isType('peer-join'));
    const packet: RelayWire = {
      t: 'datagram',
      src: 0,
      sport: 1,
      dest: RELAY_SUBNET_BROADCAST,
      dport: 2,
      a: new Uint8Array([1]),
    };
    host.send(packet);
    // A pong on the same connection is a barrier proving the preceding datagram passed through the relay; do not infer packet loss from arbitrary sleeps.
    host.send({ t: 'ping', n: 1, at: 0 });
    await host.next(isType('pong'));
    expect(harness.relay.getFaultStats().dropped).toBe(1);
    expect(harness.relay.getStats()).toMatchObject({ datagramsRouted: 0, datagramsDropped: 1 });
    expect(peer.messages.some((message) => message.t === 'datagram')).toBe(false);
    peer.send(packet);
    await host.next(isType('datagram'));
    expect(harness.relay.getStats().datagramsRouted).toBe(1);
  });

  it('真实 WS 延迟消息最终送达，待发消息随源连接退出而取消', async () => {
    const harness = await openHarness({ faults: { delayMs: 80 } });
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'delayed-host');
    const peer = await connect(harness.endpoint, 'delayed-peer');
    clients.push(host, peer);
    host.hello('delayed-room');
    await host.next(isType('welcome'));
    peer.hello('delayed-room');
    await peer.next(isType('welcome'));
    await host.next(isType('peer-join'));
    const packet: RelayWire = {
      t: 'datagram',
      src: 0,
      sport: 1,
      dest: RELAY_SUBNET_BROADCAST,
      dport: 2,
      a: new Uint8Array([9]),
    };
    host.send(packet);
    await peer.next(isType('datagram'));
    expect(harness.relay.getStats().datagramsRouted).toBe(1);
    expect(harness.relay.getFaultStats()).toMatchObject({ delayed: 1, queuedPackets: 0 });
    host.send(packet);
    await host.close();
    await peer.next(isType('peer-leave'));
    expect(harness.relay.getFaultStats()).toMatchObject({ delayed: 2, queuedPackets: 0, queuedBytes: 0, dropped: 1 });
    expect(harness.relay.getStats()).toMatchObject({ datagramsRouted: 1, datagramsDropped: 1 });
  });

  it('三端广播中单人弱网不堵塞其他人的路由，未排空时禁止切换故障规则', async () => {
    const harness = await openHarness();
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'isolation-host');
    const weak = await connect(harness.endpoint, 'isolation-weak');
    const healthy = await connect(harness.endpoint, 'isolation-healthy');
    clients.push(host, weak, healthy);
    for (const client of [host, weak, healthy]) {
      client.hello('isolation-room');
      await client.next(isType('welcome'));
    }
    harness.relay.setFaults({ toClientId: 'isolation-weak', delayMs: 60000, maxQueuedPackets: 1 });
    const packet: RelayWire = {
      t: 'datagram',
      src: 0,
      sport: 1,
      dest: RELAY_SUBNET_BROADCAST,
      dport: 2,
      a: new Uint8Array([1]),
    };
    host.send(packet);
    await healthy.next(isType('datagram'));
    expect(harness.relay.getFaultStats().queuedPackets).toBe(1);
    expect(() => harness.relay.setFaults()).toThrow('队列未排空');
    host.send(packet);
    await healthy.next(isType('datagram'));
    expect(harness.relay.getFaultStats()).toMatchObject({ queuedPackets: 1, dropped: 1 });
    expect(healthy.socket.readyState).toBe(WebSocket.OPEN);
    expect(host.socket.readyState).toBe(WebSocket.OPEN);
    await weak.close();
    await host.next(isType('peer-leave'));
    expect(harness.relay.getFaultStats().queuedPackets).toBe(0);
    harness.relay.setFaults();
    host.send(packet);
    await healthy.next(isType('datagram'));
    expect(harness.relay.getStats()).toMatchObject({ datagramsRouted: 3, datagramsDropped: 2 });
  });

  it('维护停止新入场但保留旧路由，连接上限包含尚未握手者', async () => {
    const harness = await openHarness({ maxConnections: 2 });
    harnesses.push(harness);
    const host = await connect(harness.endpoint, 'drain-host');
    const peer = await connect(harness.endpoint, 'drain-peer');
    clients.push(host, peer);
    expect(harness.relay.getHealth()).toMatchObject({ connections: 2, players: 0 });
    const excess = await connect(harness.endpoint, 'excess');
    clients.push(excess);
    expect(await excess.close()).toBe(1013);
    host.hello('drain-room');
    await host.next(isType('welcome'));
    peer.hello('drain-room');
    await peer.next(isType('welcome'));
    harness.relay.beginDrain();
    expect(harness.relay.getHealth()).toEqual({ connections: 2, rooms: 1, players: 2, draining: true });
    const newcomer = await connect(harness.endpoint, 'newcomer');
    clients.push(newcomer);
    expect(await newcomer.close()).toBe(1013);
    host.send({ t: 'datagram', src: 0, sport: 1, dest: RELAY_SUBNET_BROADCAST, dport: 2, a: new Uint8Array([1]) });
    await peer.next(isType('datagram'));
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
    expect(harness.relay.getStats().datagramsRouted).toBe(1);
  });

  it('虚拟 LAN 接纳二十人并全互通，拒绝第二十一人且不影响已有连接', async () => {
    const harness = await openHarness();
    harnesses.push(harness);
    const members: RelayClient[] = [];
    const addresses = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const client = await connect(harness.endpoint, `lan-${i}`);
      clients.push(client);
      members.push(client);
      client.hello('public-ra2');
      const welcome = await client.next(isType('welcome'));
      if (welcome.t === 'welcome') addresses.add(welcome.addr);
    }
    expect(addresses.size).toBe(20);
    const excess = await connect(harness.endpoint, 'lan-excess');
    clients.push(excess);
    excess.hello('public-ra2');
    await expect(excess.next(isType('welcome'), 100)).rejects.toThrow('timed out');
    expect(await excess.close()).toBe(1008);
    expect(harness.relay.getHealth()).toMatchObject({ rooms: 1, players: 20 });
    for (let source = 0; source < members.length; source++) {
      members[source]!.send({
        t: 'datagram',
        src: 0,
        sport: 1,
        dest: RELAY_SUBNET_BROADCAST,
        dport: 2,
        a: new Uint8Array([source]),
      });
      await Promise.all(
        members.map(async (client, i) => {
          if (i === source) return;
          const message = await client.next(isType('datagram'));
          expect(message.t === 'datagram' && message.a[0]).toBe(source);
          expect(client.socket.readyState).toBe(WebSocket.OPEN);
        }),
      );
    }
    expect(harness.relay.getStats()).toMatchObject({ datagramsRouted: 380, datagramsDropped: 0 });
  });

  it('八连接全互通，单人黑洞不影响其余七人的转发', async () => {
    const harness = await openHarness();
    harnesses.push(harness);
    const members: RelayClient[] = [];
    for (let i = 0; i < 8; i++) {
      const client = await connect(harness.endpoint, `eight-${i}`);
      clients.push(client);
      members.push(client);
      client.hello('eight-room');
      await client.next(isType('welcome'));
    }
    expect(harness.relay.getHealth()).toMatchObject({ rooms: 1, players: 8 });
    const broadcast = async (source: number, excluded: number[] = []) => {
      members[source]!.send({
        t: 'datagram',
        src: 0,
        sport: 1,
        dest: RELAY_SUBNET_BROADCAST,
        dport: 2,
        a: new Uint8Array([source]),
      });
      await Promise.all(
        members.map(async (client, i) => {
          if (i === source || excluded.includes(i)) return;
          const message = await client.next(isType('datagram'));
          expect(message.t === 'datagram' && message.a[0]).toBe(source);
        }),
      );
    };
    for (let i = 0; i < 8; i++) await broadcast(i);
    expect(harness.relay.getStats().datagramsRouted).toBe(56);
    harness.relay.setFaults({ toClientId: 'eight-7', lossRate: 1 });
    for (let i = 0; i < 7; i++) await broadcast(i, [7]);
    expect(harness.relay.getStats()).toMatchObject({ datagramsRouted: 98, datagramsDropped: 7 });
    harness.relay.setFaults();
    await broadcast(0);
    expect(harness.relay.getStats().datagramsRouted).toBe(105);
  });
});
