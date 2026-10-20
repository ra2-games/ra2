import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { createGameRelay } from 'relay-package/server';
import { Ra2WebSocketTransport, type Ra2NetworkTransportHandlers } from '../../src/games/ra2/networkTransport';
import { RA2NET_SUBNET_BROADCAST } from '../../src/games/ra2/networkWire';

afterEach(() => vi.unstubAllGlobals());

it('默认浏览器 UUID 能通过真实中继握手、发现彼此并收发广播', async () => {
  const server = createServer();
  const relay = createGameRelay({ logger: () => {} });
  server.on('upgrade', (request, socket, head) => relay.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubGlobal('WebSocket', WebSocket);
  const uuid = '12345678-1234-4567-89ab-123456789abc';
  let sequence = 0;
  vi.stubGlobal('crypto', { randomUUID: () => uuid.slice(0, -1) + sequence++ });
  const handlers = (): Ra2NetworkTransportHandlers => ({
    onReady: vi.fn(),
    onPeerJoin: vi.fn(),
    onPeerLeave: vi.fn(),
    onDatagram: vi.fn(),
    onError: vi.fn(),
  });
  const first = handlers(),
    second = handlers();
  const options = { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ra2` };
  const join = { room: 'discovery-regression', exeHash: 'a'.repeat(64), name: new Uint8Array([65]) };
  const a = new Ra2WebSocketTransport(first, join, options);
  const b = new Ra2WebSocketTransport(second, join, options);
  try {
    expect(a.clientId.length).toBe(36);
    expect(a.clientId).not.toBe(b.clientId);
    await vi.waitFor(
      () => {
        expect(a.ready).toBe(true);
        expect(b.ready).toBe(true);
        expect(first.onPeerJoin).toHaveBeenCalledOnce();
        expect(second.onPeerJoin).toHaveBeenCalledOnce();
      },
      { timeout: 3000 },
    );
    expect(a.selfAddr).not.toBe(b.selfAddr);
    expect(a.sendDatagram(RA2NET_SUBNET_BROADCAST, 5000, 5000, new Uint8Array([1, 2, 3]))).toBe(true);
    await vi.waitFor(() =>
      expect(second.onDatagram).toHaveBeenCalledWith(a.selfAddr, 5000, 5000, new Uint8Array([1, 2, 3])),
    );
    expect(first.onDatagram).not.toHaveBeenCalled();
    // Discovery uses broadcasts, but game messages after room creation also need reverse unicast; a successful hello alone is insufficient.
    expect(b.sendDatagram(a.selfAddr, 5000, 5000, new Uint8Array([4, 5]))).toBe(true);
    await vi.waitFor(() =>
      expect(first.onDatagram).toHaveBeenCalledWith(b.selfAddr, 5000, 5000, new Uint8Array([4, 5])),
    );
    expect(first.onError).not.toHaveBeenCalled();
    expect(second.onError).not.toHaveBeenCalled();
  } finally {
    a.close();
    b.close();
    relay.close();
    await relay.drained();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
