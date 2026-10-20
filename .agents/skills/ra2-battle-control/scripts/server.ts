import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { CHANNEL_PATTERN, CONTROL_PORT, MAX_CONTROL_MESSAGE, isControlRequest } from './protocol';

export interface ControlServerOptions {
  port?: number;
  /** Exact browser origins permitted to register a game. CLI requests have no Origin header. */
  origins: readonly string[];
  requestTimeoutMs?: number;
}

/** Loopback-only router. A channel has one owner; disconnects reject requests instead of replaying them. */
export async function startControlServer(options: ControlServerOptions) {
  const channels = new Map<string, WebSocket>();
  const pending = new Map<string, { socket: WebSocket; finish: (status: number, value: unknown) => void }>();
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    // Browser control uses the registered WebSocket, never the CLI HTTP endpoint.
    if (req.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '')) {
      reply(403, { error: 'Loopback CLI requests only' });
      return;
    }
    if (req.method === 'GET' && req.url === '/channels') {
      reply(200, { channels: [...channels.keys()].sort() });
      return;
    }
    const match = /^\/channels\/([a-zA-Z0-9_-]{1,64})\/request$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match) {
      reply(404, { error: 'Unknown endpoint' });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_CONTROL_MESSAGE) {
          reply(413, { error: 'Request too large' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const request: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isControlRequest(request)) {
        reply(400, { error: 'Invalid request' });
        return;
      }
      const socket = channels.get(match[1]!);
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reply(409, { error: 'Channel offline' });
        return;
      }
      if (pending.size >= 128) {
        reply(429, { error: 'Too many pending requests' });
        return;
      }
      const id = randomUUID();
      const finish = (status: number, value: unknown) => {
        clearTimeout(timer);
        pending.delete(id);
        reply(status, value);
      };
      const timer = setTimeout(
        () => finish(504, { id: request.id, error: 'Response timed out; execution outcome unknown' }),
        options.requestTimeoutMs ?? 10000,
      );
      pending.set(id, { socket, finish: (status, value) => finish(status, { ...(value as object), id: request.id }) });
      res.on('close', () => {
        clearTimeout(timer);
        pending.delete(id);
      });
      socket.send(JSON.stringify({ ...request, id }));
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_MESSAGE });
  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    const channel = url.searchParams.get('channel') ?? '';
    if (
      url.pathname !== '/connect' ||
      !CHANNEL_PATTERN.test(channel) ||
      !options.origins.includes(req.headers.origin ?? '') ||
      channels.has(channel) ||
      channels.size >= 64
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      channels.set(channel, ws);
      ws.on('message', (bytes) => {
        try {
          const value = JSON.parse(bytes.toString());
          const entry = pending.get(value?.id);
          if (entry?.socket !== ws || !entry) return;
          if (typeof value.error === 'string') entry.finish(422, { error: value.error });
          else if ('result' in value) entry.finish(200, { result: value.result });
        } catch {
          ws.close(1008, 'Invalid response');
        }
      });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => {
        if (channels.get(channel) === ws) channels.delete(channel);
        for (const entry of [...pending.values()])
          if (entry.socket === ws) entry.finish(409, { error: 'Channel disconnected; execution outcome unknown' });
      });
      ws.send(JSON.stringify({ type: 'connected', channel }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? CONTROL_PORT, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as { port: number }).port,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
