import { CHANNEL_PATTERN, CONTROL_PORT, MAX_CONTROL_MESSAGE, isControlRequest } from '@ra2vm/control/protocol';

export type ControlConnectionStatus = 'connected' | 'connection failed' | 'disconnected';

/** One explicitly opened connection. The owner closes it on session/page destruction. */
export function connectControlChannel(options: {
  channel: string;
  port?: number;
  request(method: string, params: unknown): Promise<unknown>;
  status(value: ControlConnectionStatus): void;
}) {
  if (!CHANNEL_PATTERN.test(options.channel)) throw new Error('Channel must contain 1–64 letters, digits, _ or -');
  const socket = new WebSocket(`ws://127.0.0.1:${options.port ?? CONTROL_PORT}/connect?channel=${options.channel}`);
  let disposed = false;
  let pending = 0;
  socket.onopen = () => options.status('connected');
  socket.onerror = () => options.status('connection failed');
  socket.onclose = () => {
    if (!disposed) options.status('disconnected');
  };
  socket.onmessage = async (event) => {
    if (typeof event.data !== 'string' || event.data.length > MAX_CONTROL_MESSAGE) {
      socket.close(1008);
      return;
    }
    let request: unknown;
    try {
      request = JSON.parse(event.data);
    } catch {
      socket.close(1008);
      return;
    }
    if (!isControlRequest(request)) return;
    const { id, method, params } = request;
    const send = (value: unknown) => {
      if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    if (pending >= 16) {
      send({ id, error: 'Too many pending requests' });
      return;
    }
    pending++;
    try {
      const result = await options.request(method, params);
      send({ id, result });
    } catch (error) {
      send({ id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      pending--;
    }
  };
  return () => {
    disposed = true;
    socket.onopen = socket.onerror = socket.onclose = socket.onmessage = null;
    socket.close();
  };
}
