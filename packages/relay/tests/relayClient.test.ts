import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { RelayClient, encodeRelayFrame, decodeRelayFrame } from '../src/client';
import { createGameRelay } from '../src/server/gameRelay';

it('公开客户端直连真实服务：握手、成员、双向数据报、RTT 与退出收口', async () => {
  const relay = createGameRelay();
  const server = createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/game`;
  const options = { url, room: 'generic-client', compatibilityHash: 'a'.repeat(64) };
  const receivedA = vi.fn(),
    receivedB = vi.fn(),
    joined = vi.fn(),
    left = vi.fn(),
    latency = vi.fn(),
    closed = vi.fn();
  const clients: RelayClient[] = [];
  try {
    const a = new RelayClient(
      { ...options, metadata: new Uint8Array([1]) },
      {
        onDatagram: receivedA,
        onPeerJoin: joined,
        onPeerLeave: left,
        onLatency: latency,
        onClose: closed,
      },
    );
    clients.push(a);
    expect(a.sendDatagram(1, 2, 3, new Uint8Array([1]))).toBe(false);
    await vi.waitFor(() => expect(a.ready).toBe(true));
    const b = new RelayClient({ ...options, metadata: new Uint8Array([2]) }, { onDatagram: receivedB });
    clients.push(b);
    await vi.waitFor(() => expect(b.ready).toBe(true));
    await vi.waitFor(() =>
      expect(joined).toHaveBeenCalledWith({ id: b.clientId, addr: b.selfAddr, metadata: new Uint8Array([2]) }),
    );
    const memory = new Uint8Array([99, 4, 5, 88]);
    expect(a.sendDatagram(b.selfAddr, 4001, 4000, memory.subarray(1, 3))).toBe(true);
    await vi.waitFor(() => expect(receivedB).toHaveBeenCalledWith(a.selfAddr, 4000, 4001, new Uint8Array([4, 5])));
    expect(b.sendDatagram(a.selfAddr, 4000, 4001, new Uint8Array([6]))).toBe(true);
    await vi.waitFor(() => expect(receivedA).toHaveBeenCalledWith(b.selfAddr, 4001, 4000, new Uint8Array([6])));
    await vi.waitFor(() => expect(latency).toHaveBeenCalledWith(expect.any(Number)), { timeout: 4000 });
    b.close();
    await vi.waitFor(() => expect(left).toHaveBeenCalledWith(b.clientId, b.selfAddr));
    a.close();
    a.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(a.ready).toBe(false);
    expect(a.sendDatagram(b.selfAddr, 4001, 4000, memory)).toBe(false);
  } finally {
    for (const client of clients) client.close();
    relay.close();
    await relay.drained();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('非法握手配置在创建连接前拒绝', () => {
  const socketFactory = vi.fn();
  expect(
    () => new RelayClient({ url: 'ws://127.0.0.1/game', room: '', compatibilityHash: 'a'.repeat(64), socketFactory }),
  ).toThrow();
  expect(
    () =>
      new RelayClient({
        url: 'ws://127.0.0.1/game',
        room: 'valid-room',
        compatibilityHash: 'a'.repeat(64),
        clientId: 'bad\nclient',
        socketFactory,
      }),
  ).toThrow('Invalid relay client ID');
  expect(socketFactory).not.toHaveBeenCalled();
});

it('握手超时只关闭一次，关闭后迟到消息不能重新激活客户端', async () => {
  vi.useFakeTimers();
  const close = vi.fn(),
    onClose = vi.fn(),
    onReady = vi.fn();
  const socket: import('../src/client').RelaySocket = {
    readyState: 1,
    bufferedAmount: 0,
    binaryType: '',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close,
  };
  const client = new RelayClient(
    {
      url: 'ws://127.0.0.1/game',
      room: 'timeout',
      compatibilityHash: 'a'.repeat(64),
      handshakeTimeoutMs: 25,
      socketFactory: () => socket,
    },
    { onClose, onReady },
  );
  try {
    await vi.advanceTimersByTimeAsync(25);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('handshake timeout');
    const { encodeRelayFrame } = await import('../src/client');
    socket.onmessage?.({ data: encodeRelayFrame({ t: 'welcome', peer: 'late', addr: 1, epoch: 1 }) } as MessageEvent);
    client.close();
    expect(onReady).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

it('非法入站消息立即终止客户端，不等待底层 close 事件', async () => {
  const close = vi.fn(),
    onClose = vi.fn();
  const socket: import('../src/client').RelaySocket = {
    readyState: 1,
    bufferedAmount: 0,
    binaryType: '',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close,
  };
  const client = new RelayClient(
    { url: 'ws://127.0.0.1/game', room: 'invalid', compatibilityHash: 'a'.repeat(64), socketFactory: () => socket },
    { onClose },
  );
  try {
    socket.onmessage?.({ data: 'not binary' } as MessageEvent);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('protocol error');
    expect(client.ready).toBe(false);
  } finally {
    client.close();
  }
});

it('裸地址真实探测后连接明文服务，路径覆盖 hello，跨路径不可见', async () => {
  const relay = createGameRelay();
  const server = createServer();
  server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: RelayClient[] = [];
  const joined = vi.fn(),
    received = vi.fn(),
    closed = vi.fn();
  try {
    clients.push(
      new RelayClient(
        { url: host + '/room-a', compatibilityHash: 'a'.repeat(64), room: 'ignored-a' },
        { onPeerJoin: joined, onClose: closed },
      ),
    );
    await vi.waitFor(() => expect(clients[0]!.ready).toBe(true), { timeout: 5000 });
    clients.push(
      new RelayClient(
        { url: 'ws://' + host + '/room-b', compatibilityHash: 'a'.repeat(64), room: 'room-a' },
        { onDatagram: received },
      ),
    );
    clients.push(
      new RelayClient({
        url: 'ws://' + host + '/room-a',
        compatibilityHash: 'a'.repeat(64),
        room: 'ignored-b',
        codec: {
          encode: (message) => encodeRelayFrame(message.t === 'hello' ? { ...message, room: 'room-b' } : message),
          decode: decodeRelayFrame,
        },
      }),
    );
    await vi.waitFor(() => expect(clients.every((c) => c.ready)).toBe(true));
    await vi.waitFor(() => expect(joined).toHaveBeenCalledTimes(1));
    expect(relay.getHealth()).toMatchObject({ rooms: 2, players: 3 });
    clients[0]!.sendDatagram(0xffffffff, 12, 34, new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  } finally {
    for (const client of clients) client.close();
    relay.close();
    await relay.drained();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('探测超时关闭旧 socket；打开后不降级，主动退出清理计时器', async () => {
  vi.useFakeTimers();
  const makeSocket = (): import('../src/client').RelaySocket => ({
    readyState: 0,
    bufferedAmount: 0,
    binaryType: '',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
  });
  const first = makeSocket(),
    second = makeSocket();
  const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const onClose = vi.fn();
  const client = new RelayClient(
    { url: 'localhost:15176/room', compatibilityHash: 'a'.repeat(64), handshakeTimeoutMs: 25, socketFactory: factory },
    { onClose },
  );
  try {
    await vi.advanceTimersByTimeAsync(25);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.onclose).toBeNull();
    expect(factory.mock.calls.map((args) => new URL(args[0]).protocol)).toEqual(['wss:', 'ws:']);
    second.onopen?.(new Event('open'));
    second.onclose?.({ code: 1006, reason: '' } as CloseEvent);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

it('显式 WSS 失败不尝试明文，裸地址已打开后也不回退', () => {
  for (const url of ['wss://localhost/room', 'localhost/room']) {
    const socket: import('../src/client').RelaySocket = {
      readyState: 0,
      bufferedAmount: 0,
      binaryType: '',
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: vi.fn(),
      close: vi.fn(),
    };
    const factory = vi.fn(() => socket),
      onClose = vi.fn();
    const client = new RelayClient({ url, compatibilityHash: 'a'.repeat(64), socketFactory: factory }, { onClose });
    try {
      if (!url.startsWith('wss:')) socket.onopen?.(new Event('open'));
      socket.onclose?.({ code: 1006, reason: '' } as CloseEvent);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
    }
  }
});

it('TLS 探测只报告 error 时立即尝试明文，旧 close 不干扰新连接', () => {
  const makeSocket = (): import('../src/client').RelaySocket => ({
    readyState: 0,
    bufferedAmount: 0,
    binaryType: '',
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
  });
  const first = makeSocket(),
    second = { ...makeSocket(), readyState: 1 };
  const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const onClose = vi.fn(),
    onError = vi.fn();
  const client = new RelayClient(
    { url: 'localhost:15176/room', compatibilityHash: 'a'.repeat(64), socketFactory: factory },
    { onClose, onError },
  );
  try {
    const lateClose = first.onclose;
    first.onerror?.(new Event('error'));
    expect(factory.mock.calls.map((args) => new URL(args[0]).protocol)).toEqual(['wss:', 'ws:']);
    expect(first.close).toHaveBeenCalledTimes(1);
    second.onopen?.(new Event('open'));
    lateClose?.({ code: 1006, reason: '' } as CloseEvent);
    expect(second.send).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    client.close();
  }
});
