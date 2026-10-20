import { afterEach, expect, it, vi } from 'vitest';
import { Ra2WebSocketTransport } from '../../src/games/ra2/networkTransport';
import { decodeRa2NetworkFrame, encodeRa2NetworkFrame, type Ra2NetworkWire } from '../../src/games/ra2/networkWire';

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instance: Socket;
  readyState = 0;
  bufferedAmount = 0;
  onopen?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onmessage?: (event: { data: Uint8Array }) => void;
  sent: Ra2NetworkWire[] = [];
  constructor() {
    Socket.instance = this;
  }
  send(data: Uint8Array) {
    this.sent.push(decodeRa2NetworkFrame(data));
  }
  close(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  receive(message: Ra2NetworkWire) {
    this.onmessage?.({ data: encodeRa2NetworkFrame(message) });
  }
  welcome() {
    this.readyState = 1;
    this.onopen?.();
    this.receive({ t: 'welcome', peer: 'p', addr: 0x0af70001, epoch: 1 });
  }
}
function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  const onClose = vi.fn(),
    onLatency = vi.fn(),
    onDatagram = vi.fn();
  const transport = new Ra2WebSocketTransport(
    { onClose, onLatency, onDatagram, onReady: vi.fn(), onPeerJoin: vi.fn(), onPeerLeave: vi.fn() },
    { room: 'r', exeHash: 'a'.repeat(64), name: new Uint8Array() },
    { url: 'ws://localhost', handshakeTimeoutMs: 100 },
  );
  return { transport, socket: Socket.instance, onClose, onLatency, onDatagram };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('未打开或已打开但没有 welcome，都在期限后结束且只通知一次', () => {
  for (const opened of [false, true]) {
    const { transport, socket, onClose } = setup();
    if (opened) {
      socket.readyState = 1;
      socket.onopen?.();
    }
    vi.advanceTimersByTime(100);
    expect(transport.ready).toBe(false);
    expect(onClose.mock.calls).toEqual([['handshake timeout']]);
    transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  }
});

it('握手后测量中继 RTT；room-close 收口传输而不只是发送通知', () => {
  const { transport, socket, onClose, onLatency } = setup();
  socket.welcome();
  expect(transport.ready).toBe(true);
  vi.advanceTimersByTime(2000);
  const ping = socket.sent.at(-1)!;
  expect(ping.t).toBe('ping');
  if (ping.t !== 'ping') throw new Error('缺少 ping');
  vi.advanceTimersByTime(50);
  socket.receive({ ...ping, t: 'pong' });
  expect(onLatency).toHaveBeenCalledWith(50);
  socket.receive({ t: 'room-close', epoch: 1, reason: 'relay closing' });
  expect(transport.ready).toBe(false);
  expect(transport.sendDatagram(1, 2, 3, new Uint8Array([1]))).toBe(false);
  expect(onClose.mock.calls).toEqual([['relay closing']]);
  expect(vi.getTimerCount()).toBe(0);
});

it('物理连接关闭立刻取消 ready 和定时器', () => {
  const { transport, socket, onClose } = setup();
  socket.welcome();
  socket.close(1006, '');
  expect(transport.ready).toBe(false);
  expect(onClose).toHaveBeenCalledWith('code=1006');
  expect(vi.getTimerCount()).toBe(0);
});

it('握手前游戏包不能进入客体', () => {
  const { socket, onClose, onDatagram } = setup();
  socket.readyState = 1;
  socket.receive({ t: 'datagram', src: 1, dest: 2, sport: 1, dport: 2, a: new Uint8Array([1]) });
  expect(onDatagram).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledWith('welcome required');
  expect(vi.getTimerCount()).toBe(0);
});
