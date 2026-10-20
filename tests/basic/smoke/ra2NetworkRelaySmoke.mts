/**
 * RA2 virtual-LAN room-relay smoke test: real WebSocket clients against an in-memory relay.
 * Covers hello/welcome, virtual-address allocation, peer-join/peer-leave broadcasts, unicast routing and source rewriting, broadcast fanout without sender echo, silent dropping of unknown destinations, version rejection, protocol closure for malformed/oversized frames, ping/pong, and room cleanup.
 */
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createGameRelay } from 'relay-package/server';
import {
  RA2NET_MAX_FRAME_BYTES,
  RA2NET_SUBNET_BROADCAST,
  decodeRa2NetworkFrame,
  encodeRa2NetworkFrame,
} from '../../../src/games/ra2/networkWire';
import type { Ra2NetworkWire } from '../../../src/games/ra2/networkWire';

const ROOM = 'smoke-room';
const EXE_HASH = 'a'.repeat(64);
const OTHER_EXE_HASH = 'b'.repeat(64);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

type MessagePredicate = (message: Ra2NetworkWire) => boolean;

class TestClient {
  readonly messages: Ra2NetworkWire[] = [];
  private readonly waiters: Array<{
    predicate: MessagePredicate;
    resolve: (message: Ra2NetworkWire) => void;
    timer: ReturnType<typeof globalThis.setTimeout>;
  }> = [];
  private closedCode: number | null = null;
  private closeWaiters: Array<(code: number) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const message = decodeRa2NetworkFrame(data);
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const waiter = this.waiters.splice(waiterIndex, 1)[0]!;
        globalThis.clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
    socket.on('close', (code: number) => {
      this.closedCode = code;
      for (const resolve of this.closeWaiters.splice(0)) resolve(code);
    });
    socket.on('error', () => undefined);
  }

  send(message: Ra2NetworkWire): void {
    this.socket.send(Buffer.from(encodeRa2NetworkFrame(message)));
  }

  hello(room: string, exe = EXE_HASH, name = new Uint8Array([0x52, 0x41])): void {
    this.send({ t: 'hello', room, exe, nonce: `nonce-${Math.random().toString(36).slice(2, 10)}`, n: name });
  }

  next(predicate: MessagePredicate, timeoutMs = 2500): Promise<Ra2NetworkWire> {
    const queuedIndex = this.messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]!);
    return new Promise<Ra2NetworkWire>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for relay message'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  async waitClosed(timeoutMs = 2500): Promise<number> {
    if (this.closedCode !== null) return this.closedCode;
    return new Promise<number>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error('timed out waiting for WebSocket close')), timeoutMs);
      this.closeWaiters.push((code) => {
        globalThis.clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async close(): Promise<number> {
    if (this.closedCode !== null) return this.closedCode;
    this.socket.close();
    return this.waitClosed();
  }
}

async function connect(endpoint: string, clientId: string): Promise<TestClient> {
  const socket = new WebSocket(`${endpoint}?clientId=${encodeURIComponent(clientId)}`);
  const client = new TestClient(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return client;
}

const isType =
  (type: Ra2NetworkWire['t']): MessagePredicate =>
  (message) =>
    message.t === type;

async function main(): Promise<void> {
  const relay = createGameRelay({ logger: () => undefined, heartbeatIntervalMs: 60_000 });
  const httpServer = createServer();
  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    if (pathname === '/ra2') relay.handleUpgrade(request, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  const endpoint = `ws://127.0.0.1:${address.port}/ra2`;
  const clients: TestClient[] = [];
  const open = async (clientId: string): Promise<TestClient> => {
    const client = await connect(endpoint, clientId);
    clients.push(client);
    return client;
  };

  try {
    // ---- Handshake and membership broadcasts ----
    const host = await open('host-one');
    host.hello(ROOM);
    const hostWelcome = await host.next(isType('welcome'));
    assert.ok(hostWelcome.t === 'welcome');
    const hostAddr = hostWelcome.addr;
    assert.equal(hostAddr >>> 16, 0x0af7, 'welcome 分配虚拟 LAN 地址');
    assert.equal((hostAddr & 0xff) !== 0 && (hostAddr & 0xff) !== 0xff, true, '主机号避开 0/255');

    const joiner = await open('joiner-one');
    joiner.hello(ROOM);
    const joinerWelcome = await joiner.next(isType('welcome'));
    assert.ok(joinerWelcome.t === 'welcome');
    const joinerAddr = joinerWelcome.addr;
    assert.notEqual(joinerAddr, hostAddr, '地址不重复');
    // New arrivals receive a peer-join snapshot of existing members; existing members receive the new arrival's peer-join broadcast.
    const joinerSeesHost = await joiner.next(isType('peer-join'));
    assert.ok(joinerSeesHost.t === 'peer-join' && joinerSeesHost.addr === hostAddr, 'joiner 看到 host');
    const hostSeesJoiner = await host.next(isType('peer-join'));
    assert.ok(hostSeesJoiner.t === 'peer-join' && hostSeesJoiner.addr === joinerAddr, 'host 看到 joiner');
    assert.equal(host.messages.length, 0, 'peer-join 不回声给发送者');

    // ---- Unicast routing and source-address rewriting ----
    const forgedSrc = 0x0102_0304;
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    host.send({ t: 'datagram', src: forgedSrc, sport: 1234, dest: joinerAddr, dport: 7000, a: payload });
    const direct = await joiner.next(isType('datagram'));
    assert.ok(direct.t === 'datagram');
    assert.equal(direct.src, hostAddr, '中继按连接覆写源地址，伪造源不被转发');
    assert.equal(direct.sport, 1234);
    assert.equal(direct.dport, 7000);
    assert.deepEqual([...direct.a], [...payload], 'payload 二进制精确');
    await sleep(60);
    assert.equal(host.messages.some(isType('datagram')), false, '单播不到达第三方/发送者');

    // ---- Broadcast fanout ----
    const observer = await open('observer-one');
    observer.hello(ROOM);
    await observer.next(isType('welcome'));
    await observer.next(isType('peer-join'));
    await observer.next(isType('peer-join'));
    await host.next(isType('peer-join'));
    await joiner.next(isType('peer-join'));
    const broadcastPayload = new Uint8Array([1, 2, 3]);
    joiner.send({
      t: 'datagram',
      src: 0,
      sport: 5000,
      dest: RA2NET_SUBNET_BROADCAST,
      dport: 6000,
      a: broadcastPayload,
    });
    const hostBroadcast = await host.next(isType('datagram'));
    const observerBroadcast = await observer.next(isType('datagram'));
    assert.ok(hostBroadcast.t === 'datagram' && hostBroadcast.src === joinerAddr);
    assert.ok(observerBroadcast.t === 'datagram' && observerBroadcast.src === joinerAddr);
    assert.equal(joiner.messages.some(isType('datagram')), false, '广播不回声发送者');

    // ---- Silently drop unknown destinations (UDP semantics, not a protocol error) ----
    host.send({ t: 'datagram', src: 0, sport: 1, dest: 0x0af7_6363, dport: 1, a: new Uint8Array([9]) });
    await sleep(60);
    assert.equal(host.socket.readyState, WebSocket.OPEN, '未知目标只丢包不断线');

    // ---- ping/pong -----------------------------------------------------------------
    host.send({ t: 'ping', n: 42, at: 123456 });
    const pong = await host.next(isType('pong'));
    assert.ok(pong.t === 'pong' && pong.n === 42 && pong.at === 123456, 'pong 回显 nonce');

    // ---- Reject version mismatches ----
    const mismatched = await open('mismatched');
    mismatched.hello(ROOM, OTHER_EXE_HASH);
    assert.equal(await mismatched.waitClosed(), 1008, 'exe 哈希不匹配拒绝入房');

    // ---- Protocol discipline ----
    const premature = await open('premature');
    premature.send({ t: 'datagram', src: 0, sport: 1, dest: hostAddr, dport: 1, a: new Uint8Array([1]) });
    assert.equal(await premature.waitClosed(), 1008, 'hello 前的 datagram 是协议违规');

    const malformed = await open('malformed');
    malformed.socket.send(Buffer.from([0, 0, 0, 1, 0x7b]));
    assert.equal(await malformed.waitClosed(), 1002, '畸形帧协议关闭');

    const oversized = await open('oversized');
    oversized.socket.send(Buffer.alloc(RA2NET_MAX_FRAME_BYTES + 1));
    assert.equal(await oversized.waitClosed(), 1009, '超大帧 message-too-big');

    // ---- Broadcast peer-leave on disconnect; allow a different version after room cleanup ----
    await joiner.close();
    const leaveNotice = await host.next(isType('peer-leave'));
    assert.ok(leaveNotice.t === 'peer-leave' && leaveNotice.addr === joinerAddr, 'peer-leave 广播');
    await observer.next(isType('peer-leave'));

    await host.close();
    await observer.close();
    await sleep(60);
    const fresh = await open('fresh-one');
    fresh.hello(ROOM, OTHER_EXE_HASH); // The room has been reclaimed, removing the old version constraint
    const freshWelcome = await fresh.next(isType('welcome'));
    assert.ok(freshWelcome.t === 'welcome', '空房间回收后重建');

    const stats = relay.getStats();
    assert.ok(stats.datagramsRouted >= 3, '中继应路由多条数据报（单播 1 + 广播扇出 2）');
    assert.ok(stats.datagramsDropped >= 1, '未知目标计入丢弃');
    console.log(
      `RA2 relay smoke passed: packets=${stats.packets} routed=${stats.datagramsRouted} dropped=${stats.datagramsDropped}`,
    );
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    relay.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

await main();
