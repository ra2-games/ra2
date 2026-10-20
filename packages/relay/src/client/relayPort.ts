import type { RelaySocket } from './relaySocket';
import { RELAY_MAX_BUFFERED_BYTES } from '../network/relayWire';
import { WsRelaySocket } from './wsRelaySocket';

type PortMessage = { id: number } & (
  | { t: 'connect'; url: string }
  | { t: 'open' }
  | { t: 'send' | 'message'; frames: Uint8Array[] }
  | { t: 'ack'; bytes: number }
  | { t: 'close'; code: number; reason: string }
);
let nextId = 0;

/** Batch only data already available in this execution slice; do not wait across tasks to fill a batch. Bound empty-frame counts and batch size. */
function frameBatch(deliver: (frames: Uint8Array[]) => void) {
  let frames: Uint8Array[] = [],
    bytes = 0,
    scheduled = false;
  const flush = () => {
    if (!frames.length) return;
    const batch = frames;
    frames = [];
    bytes = 0;
    deliver(batch);
  };
  return {
    add(frame: Uint8Array) {
      frames.push(frame);
      bytes += frame.byteLength;
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          flush();
        });
      }
      if (frames.length >= 64 || bytes >= 256 * 1024) flush();
    },
    flush,
    clear() {
      frames = [];
      bytes = 0;
    },
  };
}

/** Worker proxy: normal sends copy immediately; owned frames transfer in a microtask, with per-batch ACKs bounding the backlog. */
export class PortRelaySocket implements RelaySocket {
  readonly id = ++nextId;
  readyState = 0;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: RelaySocket['onopen'] = null;
  onmessage: RelaySocket['onmessage'] = null;
  onerror: RelaySocket['onerror'] = null;
  onclose: RelaySocket['onclose'] = null;
  private readonly outgoing = frameBatch((frames) => {
    if (this.readyState !== 1) return;
    try {
      this.port.postMessage(
        { id: this.id, t: 'send', frames } satisfies PortMessage,
        frames.map((frame) => frame.buffer as ArrayBuffer),
      );
    } catch {
      this.finishClose(4000, 'port send failed', true);
    }
  });
  constructor(
    private readonly port: MessagePort,
    url: string,
  ) {
    port.addEventListener('message', this.receive);
    port.start();
    port.postMessage({ id: this.id, t: 'connect', url } satisfies PortMessage);
  }
  private readonly receive = (event: MessageEvent<PortMessage>) => {
    const m = event.data;
    if (m.id !== this.id || this.readyState === 3) return;
    switch (m.t) {
      case 'open':
        this.readyState = 1;
        this.onopen?.(new Event('open'));
        break;
      case 'message':
        this.port.postMessage({
          id: this.id,
          t: 'ack',
          bytes: m.frames.reduce((sum, frame) => sum + frame.byteLength, 0),
        } satisfies PortMessage);
        for (const frame of m.frames) {
          if (this.readyState !== 1) break;
          this.onmessage?.(new MessageEvent('message', { data: frame }));
        }
        break;
      case 'ack':
        this.bufferedAmount = Math.max(0, this.bufferedAmount - m.bytes);
        break;
      case 'close':
        this.finishClose(m.code, m.reason, false);
        break;
    }
  };
  send(frame: Uint8Array): void {
    // Buffer.slice() still shares memory; copy the logical bytes so the caller can immediately reuse the original buffer.
    this.sendOwned(new Uint8Array(frame));
  }
  sendOwned(frame: Uint8Array): void {
    if (this.readyState !== 1) throw new Error('relay port is not open');
    if (this.bufferedAmount + frame.byteLength > RELAY_MAX_BUFFERED_BYTES) {
      this.finishClose(1008, 'slow consumer', true);
      return;
    }
    if (
      !(frame.buffer instanceof ArrayBuffer) ||
      frame.byteOffset !== 0 ||
      frame.byteLength !== frame.buffer.byteLength
    ) {
      throw new Error('relay owned frame must have an exclusive ArrayBuffer');
    }
    // The caller must not access the frame after handing over ownership; batching adds neither a second byte copy nor an early transfer.
    this.bufferedAmount += frame.byteLength;
    this.outgoing.add(frame);
  }
  close(code = 1000, reason = 'closed'): void {
    // Preserve send-before-close ordering by handing accepted normal sends to the page first.
    this.outgoing.flush();
    this.finishClose(code, reason, true);
  }
  private finishClose(code: number, reason: string, notify: boolean): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.outgoing.clear();
    this.bufferedAmount = 0;
    this.port.removeEventListener('message', this.receive);
    if (notify) {
      try {
        this.port.postMessage({ id: this.id, t: 'close', code, reason } satisfies PortMessage);
      } catch {
        /* The port is already unavailable, but local cleanup must still finish. */
      }
    }
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

/** The VM session owns the returned cleanup function; terminating the Worker must also close the page connection. */
export function serveRelayPort(port: MessagePort): () => void {
  let disposed = false;
  const sockets = new Map<
    number,
    { socket: WsRelaySocket; pending: number; incoming: ReturnType<typeof frameBatch> }
  >();
  const send = (message: PortMessage) => {
    if (!disposed) port.postMessage(message);
  };
  port.onmessage = (event: MessageEvent<PortMessage>) => {
    const m = event.data;
    if (disposed) return;
    if (m.t === 'connect') {
      if (sockets.has(m.id) || sockets.size >= 8) {
        send({ id: m.id, t: 'close', code: 1008, reason: 'too many transports' });
        return;
      }
      try {
        const socket = new WsRelaySocket(m.url);
        const incoming = frameBatch((frames) => {
          if (disposed || !sockets.has(m.id)) return;
          try {
            port.postMessage(
              { id: m.id, t: 'message', frames } satisfies PortMessage,
              frames.map((frame) => frame.buffer as ArrayBuffer),
            );
          } catch {
            incoming.clear();
            socket.close(4000, 'port send failed');
          }
        });
        const entry = { socket, pending: 0, incoming };
        sockets.set(m.id, entry);
        socket.onopen = () => send({ id: m.id, t: 'open' });
        socket.onmessage = (event) => {
          if (disposed || !sockets.has(m.id)) return;
          const frame = new Uint8Array(event.data as ArrayBuffer);
          entry.pending += frame.byteLength;
          if (entry.pending > RELAY_MAX_BUFFERED_BYTES) {
            incoming.clear();
            socket.close(1008, 'slow worker');
            return;
          }
          incoming.add(frame);
        };
        socket.onclose = (event) => {
          incoming.flush();
          sockets.delete(m.id);
          send({ id: m.id, t: 'close', code: event.code, reason: event.reason });
        };
      } catch (error) {
        send({ id: m.id, t: 'close', code: 1006, reason: String(error) });
      }
      return;
    }
    const entry = sockets.get(m.id);
    if (!entry) return;
    if (m.t === 'send') {
      let bytes = 0;
      try {
        for (const frame of m.frames) {
          // Each frame remains a separate WS message; check the actual WS queue on every send so batch ACKs cannot hide backlog.
          if (entry.socket.bufferedAmount + frame.byteLength > RELAY_MAX_BUFFERED_BYTES) {
            entry.socket.close(1008, 'slow consumer');
            return;
          }
          entry.socket.send(frame);
          bytes += frame.byteLength;
        }
        send({ id: m.id, t: 'ack', bytes });
      } catch {
        entry.socket.close(1006, 'send failed');
      }
    } else if (m.t === 'ack') entry.pending = Math.max(0, entry.pending - m.bytes);
    else if (m.t === 'close') entry.socket.close(m.code, m.reason);
  };
  port.start();
  return () => {
    if (disposed) return;
    disposed = true;
    for (const { socket, incoming } of sockets.values()) {
      incoming.clear();
      socket.close();
    }
    sockets.clear();
    port.onmessage = null;
    port.close();
  };
}
