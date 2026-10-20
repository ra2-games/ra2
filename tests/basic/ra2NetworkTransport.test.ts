import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseRa2RelayUrl,
  Ra2BroadcastChannelTransport,
  Ra2WebSocketTransport,
} from '../../src/games/ra2/networkTransport';
import {
  RA2NET_MAX_BUFFERED_BYTES,
  decodeRa2NetworkFrame,
  encodeRa2NetworkFrame,
} from '../../src/games/ra2/networkWire';
import type { Ra2NetworkTransportHandlers, Ra2NetworkJoin } from '../../src/games/ra2/networkTransport';

const EXE_HASH = 'a'.repeat(64);
const OTHER_EXE_HASH = 'b'.repeat(64);
const join: Ra2NetworkJoin = { room: 'transport-test', name: new Uint8Array([1, 2]), exeHash: EXE_HASH };

function handlerSet() {
  return {
    onReady: vi.fn(),
    onPeerJoin: vi.fn(),
    onPeerLeave: vi.fn(),
    onDatagram: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  } satisfies Ra2NetworkTransportHandlers;
}

async function flushBroadcastTasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('RA2 network transports', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('discovers peers, routes datagrams and announces a normal BroadcastChannel leave', async () => {
    expect(typeof globalThis.BroadcastChannel).toBe('function');
    const prefix = `ra2-transport-test-${Date.now()}-${Math.random()}-`;
    const first = handlerSet();
    const second = handlerSet();
    const left = new Ra2BroadcastChannelTransport(first, join, prefix);
    const right = new Ra2BroadcastChannelTransport(second, join, prefix);
    try {
      await flushBroadcastTasks();
      expect(left.ready).toBe(true);
      expect(right.ready).toBe(true);
      expect(first.onPeerJoin).toHaveBeenCalledWith(expect.objectContaining({ id: right.clientId }));
      expect(second.onPeerJoin).toHaveBeenCalledWith(expect.objectContaining({ id: left.clientId }));

      const payload = new Uint8Array([9, 8, 7]);
      expect(left.sendDatagram(right.selfAddr, 5001, 5000, payload)).toBe(true);
      await flushBroadcastTasks();
      expect(second.onDatagram).toHaveBeenCalledWith(left.selfAddr, 5000, 5001, payload);

      left.close();
      await flushBroadcastTasks();
      expect(second.onPeerLeave).toHaveBeenCalledWith(left.clientId, left.selfAddr);
      expect(first.onClose).toHaveBeenCalledWith('closed');
      expect(left.sendDatagram(right.selfAddr, 5001, 5000, payload)).toBe(false);
    } finally {
      left.close();
      right.close();
    }
  });

  it('does not mix same-room peers with a different executable hash', async () => {
    expect(typeof globalThis.BroadcastChannel).toBe('function');
    const prefix = `ra2-transport-isolation-${Date.now()}-${Math.random()}-`;
    const first = handlerSet();
    const second = handlerSet();
    const firstJoin = { ...join, room: 'isolated-room' };
    const secondJoin = { ...join, room: 'isolated-room', exeHash: OTHER_EXE_HASH };
    const left = new Ra2BroadcastChannelTransport(first, firstJoin, prefix);
    const right = new Ra2BroadcastChannelTransport(second, secondJoin, prefix);
    try {
      await flushBroadcastTasks();
      expect(first.onPeerJoin).not.toHaveBeenCalled();
      expect(second.onPeerJoin).not.toHaveBeenCalled();
    } finally {
      left.close();
      right.close();
    }
  });

  it('performs the WebSocket handshake, ping/pong and close protection', async () => {
    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static readonly instances: FakeWebSocket[] = [];
      readonly sent: unknown[] = [];
      readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
      readonly url: string;
      readyState = FakeWebSocket.CONNECTING;
      bufferedAmount = 0;
      binaryType = '';
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
      }

      send(data: unknown): void {
        this.sent.push(data);
      }

      close(code?: number, reason?: string): void {
        this.closeCalls.push({ code, reason });
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code: code ?? 1000, reason: reason ?? '' } as CloseEvent);
      }
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const handlers = handlerSet();
    const transport = new Ra2WebSocketTransport(handlers, join, {
      url: 'ws://relay.test/ra2',
      clientId: 'client-1',
    });
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toContain('clientId=client-1');
    expect(transport.ready).toBe(false);
    expect(transport.sendDatagram(1, 2, 3, new Uint8Array([1]))).toBe(false);

    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.({} as Event);
    expect(decodeRa2NetworkFrame(socket.sent[0] as Uint8Array)).toMatchObject({
      t: 'hello',
      room: 'ra2',
      exe: join.exeHash,
      nonce: 'client-1',
    });

    socket.onmessage?.({
      data: encodeRa2NetworkFrame({ t: 'welcome', peer: 'client-1', addr: 0x0af7_0101, epoch: 1 }),
    } as MessageEvent);
    expect(transport.ready).toBe(true);
    expect(transport.selfAddr).toBe(0x0af7_0101);
    expect(handlers.onReady).toHaveBeenCalledWith({ id: 'client-1', addr: 0x0af7_0101, name: join.name }, []);

    expect(transport.sendDatagram(2, 4001, 4000, new Uint8Array([5]))).toBe(true);
    expect(decodeRa2NetworkFrame(socket.sent.at(-1) as Uint8Array)).toMatchObject({
      t: 'datagram',
      src: 0,
      dest: 2,
      sport: 4000,
      dport: 4001,
    });
    socket.onmessage?.({ data: encodeRa2NetworkFrame({ t: 'ping', n: 9, at: 10 }) } as MessageEvent);
    expect(decodeRa2NetworkFrame(socket.sent.at(-1) as Uint8Array)).toEqual({ t: 'pong', n: 9, at: 10 });
    socket.onmessage?.({
      data: encodeRa2NetworkFrame({
        t: 'datagram',
        src: 2,
        sport: 4001,
        dest: 0x0af7_0101,
        dport: 4000,
        a: new Uint8Array([4, 3]),
      }),
    } as MessageEvent);
    expect(handlers.onDatagram).toHaveBeenCalledWith(2, 4001, 4000, new Uint8Array([4, 3]));

    socket.bufferedAmount = RA2NET_MAX_BUFFERED_BYTES + 1;
    expect(transport.sendDatagram(2, 4001, 4000, new Uint8Array([5]))).toBe(false);
    expect(socket.closeCalls.at(-1)).toEqual({ code: 4000, reason: 'slow consumer' });

    const badHandlers = handlerSet();
    const badTransport = new Ra2WebSocketTransport(badHandlers, join, {
      url: 'ws://relay.test/ra2',
      clientId: 'bad-client',
    });
    const badSocket = FakeWebSocket.instances[1]!;
    badSocket.readyState = FakeWebSocket.OPEN;
    badSocket.onmessage?.({ data: new Uint8Array([0, 0, 0]) } as MessageEvent);
    await Promise.resolve();
    expect(badHandlers.onError).toHaveBeenCalled();
    expect(badSocket.closeCalls.at(-1)?.code).toBe(4000);
    badTransport.close();
  });
});

it.each([
  ['127.0.0.1:15176', 'ws://127.0.0.1:15176/ra2'],
  ['10.1.2.3:15176', 'ws://10.1.2.3:15176/ra2'],
  ['172.16.0.1:80', 'ws://172.16.0.1/ra2'],
  ['172.31.255.255:443', 'ws://172.31.255.255:443/ra2'],
  ['192.168.1.2:15176', 'ws://192.168.1.2:15176/ra2'],
  ['169.254.1.2:15176', 'ws://169.254.1.2:15176/ra2'],
  ['100.64.0.1:15176', 'ws://100.64.0.1:15176/ra2'],
  ['[::1]:15176', 'ws://[::1]:15176/ra2'],
  ['[fd00::1]:15176', 'ws://[fd00::1]:15176/ra2'],
  ['[fe80::1]:15176', 'ws://[fe80::1]:15176/ra2'],
  ['[::ffff:192.168.1.2]:15176', 'ws://[::ffff:c0a8:102]:15176/ra2'],
  ['localhost:15176', 'ws://localhost:15176/ra2'],
  ['172.32.0.1:15176', 'wss://172.32.0.1:15176/ra2'],
  ['100.128.0.1:15176', 'wss://100.128.0.1:15176/ra2'],
  ['192.169.1.2:15176', 'wss://192.169.1.2:15176/ra2'],
  ['relay.example:80', 'wss://relay.example:80/ra2'],
  ['[2001:db8::1]:443', 'wss://[2001:db8::1]/ra2'],
  ['ws://relay.example:80/custom', 'wss://relay.example:80/custom'],
  ['wss://127.0.0.1:443/custom?token=abc', 'ws://127.0.0.1:443/custom?token=abc'],
])('根据主机选定唯一协议并保留端口：%s', (input, expected) => {
  expect(parseRa2RelayUrl(input)).toBe(expected);
});
it.each([null, '', '  '])('未指定 relay 时保持默认：%s', (value) => {
  expect(parseRa2RelayUrl(value)).toBeUndefined();
});
it.each([
  '/ra2',
  'https://127.0.0.1/',
  'ws://user:pass@127.0.0.1/',
  'ws://127.0.0.1/#fragment',
  '127.0.0.1:0',
  '127.0.0.1:65536',
])('拒绝无效 relay：%s', (value) => {
  expect(() => parseRa2RelayUrl(value)).toThrow('relay 必须');
});
