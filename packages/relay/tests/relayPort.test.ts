import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PortRelaySocket, RelayClient, serveRelayPort, encodeRelayFrame, decodeRelayFrame } from '../src/client';
import { RELAY_MAX_BUFFERED_BYTES } from '../src/network/relayWire';

function portHarness() {
  const messages: any[] = [];
  let receive: ((event: any) => void) | undefined;
  const port = {
    addEventListener: (_: string, listener: any) => {
      receive = listener;
    },
    removeEventListener: () => {
      receive = undefined;
    },
    start() {},
    close() {},
    postMessage: (message: any, transfer: Transferable[] = []) => messages.push(structuredClone(message, { transfer })),
  } as unknown as MessagePort;
  const socket = new PortRelaySocket(port, 'ws://127.0.0.1/game');
  const deliver = (message: object) => receive?.({ data: { id: socket.id, ...message } });
  return { socket, messages, deliver };
}
beforeEach(() =>
  vi.stubGlobal(
    'CloseEvent',
    class extends Event {
      code: number;
      reason: string;
      constructor(type: string, init: any) {
        super(type);
        this.code = init.code;
        this.reason = init.reason;
      }
    },
  ),
);
afterEach(() => vi.unstubAllGlobals());

it('普通发送只复制逻辑字节，独占帧移交且 ACK 保持正确字节数', async () => {
  const { socket, messages, deliver } = portHarness();
  deliver({ t: 'open' });
  const memory = new Uint8Array(new WebAssembly.Memory({ initial: 1 }).buffer);
  memory.set([8, 9], 10);
  socket.send(memory.subarray(10, 12));
  expect(memory.byteLength).toBe(65536);
  memory.fill(0); // The guest may reuse the original data immediately after send returns.
  const owned = new Uint8Array([1, 2, 3]);
  socket.sendOwned(owned);
  expect(messages).toHaveLength(1); // No data has been dispatched in the current execution slice yet.
  await Promise.resolve();
  expect(messages.at(-1).frames.map((frame: Uint8Array) => [...frame])).toEqual([
    [8, 9],
    [1, 2, 3],
  ]);
  expect(messages.at(-1).frames[0].buffer.byteLength).toBe(2);
  expect(owned.byteLength).toBe(0);
  expect(socket.bufferedAmount).toBe(5);
  deliver({ t: 'ack', bytes: 5 });
  expect(socket.bufferedAmount).toBe(0);
  expect(() => socket.sendOwned(memory.subarray(10, 12))).toThrow('exclusive');
  expect(memory.byteLength).toBe(65536);
  const pooled = Buffer.from([7, 8, 9]);
  socket.send(pooled.subarray(1, 2));
  await Promise.resolve();
  expect(messages.at(-1).frames[0]).toEqual(new Uint8Array([8]));
  expect(messages.at(-1).frames[0].buffer.byteLength).toBe(1);
  expect([...pooled]).toEqual([7, 8, 9]);
});

it('客户端仅对内置编码器移交所有权，自定义编码器仍走普通发送', () => {
  for (const custom of [false, true]) {
    const send = vi.fn(),
      sendOwned = vi.fn();
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      binaryType: '',
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send,
      sendOwned,
      close: vi.fn(),
    } as import('../src/client').RelaySocket;
    const client = new RelayClient(
      {
        url: 'ws://127.0.0.1/game',
        room: 'ownership',
        compatibilityHash: 'a'.repeat(64),
        socketFactory: () => socket,
        ...(custom ? { codec: { encode: encodeRelayFrame, decode: decodeRelayFrame } } : {}),
      },
      {},
    );
    try {
      socket.onopen?.(new Event('open'));
      expect(sendOwned).toHaveBeenCalledTimes(custom ? 0 : 1);
      expect(send).toHaveBeenCalledTimes(custom ? 1 : 0);
    } finally {
      client.close();
    }
  }
});

it('端口 ACK 不掩盖底层 WS 积压，超限帧不进入发送队列', () => {
  const send = vi.fn(),
    close = vi.fn();
  vi.stubGlobal(
    'WebSocket',
    class {
      bufferedAmount = RELAY_MAX_BUFFERED_BYTES;
      binaryType = '';
      onopen = null;
      onmessage = null;
      onclose = null;
      send = send;
      close = close;
    },
  );
  const port = { onmessage: null, postMessage: vi.fn(), start() {}, close() {} } as unknown as MessagePort;
  const dispose = serveRelayPort(port);
  try {
    const deliver = (data: any) => port.onmessage?.call(port, { data } as MessageEvent);
    deliver({ t: 'connect', id: 1, url: 'ws://127.0.0.1/game' });
    deliver({ t: 'send', id: 1, frames: [new Uint8Array([1])] });
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(4000, 'slow consumer');
    expect(port.postMessage).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
});

it('突发发送按数量分批，逐帧有序，close 不等待微任务也不丢已接受的数据', async () => {
  const { socket, messages, deliver } = portHarness();
  deliver({ t: 'open' });
  for (let i = 0; i < 130; i++) socket.sendOwned(new Uint8Array([i]));
  expect(messages.filter((m) => m.t === 'send').map((m) => m.frames.length)).toEqual([64, 64]);
  expect(socket.bufferedAmount).toBe(130);
  socket.close();
  expect(messages.at(-2).frames).toHaveLength(2);
  expect(messages.at(-1).t).toBe('close');
  const count = messages.length;
  await Promise.resolve();
  expect(messages).toHaveLength(count);
  expect(messages.filter((m) => m.t === 'send').flatMap((m) => m.frames.map((f: Uint8Array) => f[0]))).toEqual(
    Array.from({ length: 130 }, (_, i) => i),
  );
  expect(socket.bufferedAmount).toBe(0);
});

it('远端关闭取消尚未派发的数据；接收回调关闭连接后不继续投递同批事件', async () => {
  const first = portHarness();
  first.deliver({ t: 'open' });
  first.socket.send(new Uint8Array([1]));
  first.deliver({ t: 'close', code: 1000, reason: 'bye' });
  await Promise.resolve();
  expect(first.messages.map((m) => m.t)).toEqual(['connect']);
  const { socket, messages, deliver } = portHarness();
  deliver({ t: 'open' });
  const receive = vi.fn(() => socket.close());
  socket.onmessage = receive;
  deliver({ t: 'message', frames: [new Uint8Array([1]), new Uint8Array([2, 3])] });
  expect(receive).toHaveBeenCalledTimes(1);
  expect(messages.find((m) => m.t === 'ack').bytes).toBe(3);
});

it('页面一批发送仍产生独立 WS 消息和一个 ACK；双向积压与销毁有效', async () => {
  const sockets: any[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      bufferedAmount = 0;
      binaryType = '';
      onopen: any;
      onmessage: any;
      onclose: any;
      send = vi.fn((frame: Uint8Array) => {
        this.bufferedAmount += frame.byteLength;
      });
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    },
  );
  const messages: any[] = [];
  const port = {
    onmessage: null,
    postMessage: (m: any, transfer: Transferable[] = []) => messages.push(structuredClone(m, { transfer })),
    start() {},
    close: vi.fn(),
  } as unknown as MessagePort;
  const dispose = serveRelayPort(port);
  const deliver = (data: any) => port.onmessage?.call(port, { data: { id: 1, ...data } } as MessageEvent);
  deliver({ t: 'connect', url: 'ws://127.0.0.1/ra2' });
  const socket = sockets[0];
  deliver({ t: 'send', frames: [new Uint8Array([1]), new Uint8Array([2, 3])] });
  expect(socket.send.mock.calls.map((args: any[]) => [...args[0]])).toEqual([[1], [2, 3]]);
  expect(messages).toEqual([{ id: 1, t: 'ack', bytes: 3 }]);
  for (let i = 0; i < 5; i++) socket.onmessage({ data: new Uint8Array([i]).buffer });
  await Promise.resolve();
  expect(messages.at(-1).frames.map((f: Uint8Array) => f[0])).toEqual([0, 1, 2, 3, 4]);
  deliver({ t: 'ack', bytes: 5 });
  socket.bufferedAmount = RELAY_MAX_BUFFERED_BYTES - 1;
  deliver({ t: 'send', frames: [new Uint8Array([4]), new Uint8Array([5])] });
  expect(socket.send).toHaveBeenCalledTimes(3);
  expect(socket.close).toHaveBeenCalledWith(4000, 'slow consumer');
  socket.onmessage({ data: new Uint8Array([9]).buffer });
  const count = messages.length;
  dispose();
  dispose();
  await Promise.resolve();
  expect(messages).toHaveLength(count);
  expect(port.close).toHaveBeenCalledTimes(1);
});

it('发送异常只关闭一次，微任务不重放失败批次；字节阈值可提前派发', async () => {
  const { socket, messages, deliver } = portHarness();
  deliver({ t: 'open' });
  socket.sendOwned(new Uint8Array(128 * 1024));
  socket.sendOwned(new Uint8Array(128 * 1024));
  expect(messages.at(-1).frames).toHaveLength(2);
  expect(socket.bufferedAmount).toBe(256 * 1024);
  socket.close();
  const posted: any[] = [];
  const broken = {
    addEventListener() {},
    removeEventListener: vi.fn(),
    start() {},
    postMessage(m: any) {
      posted.push(m.t);
      if (m.t === 'send') throw new Error('closed port');
    },
  } as unknown as MessagePort;
  const failing = new PortRelaySocket(broken, 'ws://127.0.0.1/ra2');
  failing.readyState = 1;
  const closed = vi.fn();
  failing.onclose = closed;
  failing.send(new Uint8Array([1]));
  await Promise.resolve();
  expect(failing.readyState).toBe(3);
  expect(failing.bufferedAmount).toBe(0);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(posted).toEqual(['connect', 'send', 'close']);
  failing.close();
  await Promise.resolve();
  expect(closed).toHaveBeenCalledTimes(1);
});
