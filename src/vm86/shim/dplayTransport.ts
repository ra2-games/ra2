import { DPLAY_MAX_BUFFERED_BYTES, DplayWireError, decodeDplayFrame, encodeDplayFrame, isDplayWire } from './dplayWire';
import type { DplayWire } from './dplayWire';

export const DPLAY_TRANSPORT_CHANNEL = 'win32-dplayx';

export interface DplayTransportHandlers {
  onMessage(message: DplayWire): void;
  onOpen?(): void;
  onClose?(): void;
  onError?(error: unknown): void;
}

export interface DplayTransport {
  readonly clientId: string;
  send(message: DplayWire): boolean;
  close(): void;
}

export type DplayTransportFactory = (handlers: DplayTransportHandlers) => DplayTransport;

function newClientId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  const random = new Uint32Array(4);
  cryptoObject?.getRandomValues(random);
  return `vm-${[...random].map((part) => part.toString(16).padStart(8, '0')).join('')}-${Math.random().toString(36).slice(2)}`;
}

function report(handlers: DplayTransportHandlers, error: unknown): void {
  handlers.onError?.(error);
}

/**
 * BroadcastChannel structured-clones the complete backing ArrayBuffer of a
 * typed-array view. Guest-memory reads are views into the VM's full WASM
 * memory, so copy only the logical payload before posting it.
 */
function copyStructuredPayload(message: DplayWire): DplayWire {
  switch (message.t) {
    case 'announce':
    case 'pinfo':
    case 'newplayer':
      return { ...message, n: message.n.slice() };
    case 'pdata':
    case 'msg':
      return { ...message, a: message.a.slice() };
    case 'join':
    case 'sclose':
    case 'leave':
      return message;
  }
}

/** Structured transport retained for same-origin local diagnostics and Node/unit smoke tests. */
export class BroadcastChannelTransport implements DplayTransport {
  readonly clientId: string;
  private closed = false;

  constructor(
    private readonly handlers: DplayTransportHandlers,
    channelName = DPLAY_TRANSPORT_CHANNEL,
  ) {
    this.clientId = newClientId();
    if (typeof globalThis.BroadcastChannel !== 'function') {
      throw new Error('BroadcastChannel is unavailable in this runtime');
    }
    const channel = new globalThis.BroadcastChannel(channelName);
    this.channel = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isDplayWire(event.data)) return;
      handlers.onMessage(event.data);
    };
    channel.onmessageerror = (event: MessageEvent<unknown>) => report(handlers, event);
    globalThis.queueMicrotask(() => {
      if (!this.closed) handlers.onOpen?.();
    });
  }

  private readonly channel: BroadcastChannel;

  send(message: DplayWire): boolean {
    if (this.closed) return false;
    try {
      this.channel.postMessage(copyStructuredPayload(message));
      return true;
    } catch (error: unknown) {
      report(this.handlers, error);
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    this.handlers.onClose?.();
  }
}

interface WebSocketTransportOptions {
  url?: string;
  clientId?: string;
}

/**
 * Browser DirectPlay transport address. Default /game is historical: dev/preview serve only local game resources there, not WebSocket upgrades, so omitting url inevitably fails and enters reconnect backoff. Current multiplayer uses the relay virtual-LAN protocol; this path runs only when the guest creates DirectPlay sessions itself. Existing automation covers only Node's BroadcastChannel default.
 */
function websocketUrl(clientId: string, suppliedUrl?: string): string {
  const pageLocation = globalThis.location;
  if (!pageLocation && !suppliedUrl) throw new Error('A WebSocket URL is required outside a browser page');
  const base = suppliedUrl
    ? new URL(suppliedUrl, pageLocation?.href ?? 'http://localhost/')
    : new URL(
        '/game',
        pageLocation.origin && pageLocation.origin !== 'null' ? `${pageLocation.origin}/` : pageLocation.href,
      );
  if (base.protocol === 'http:') base.protocol = 'ws:';
  if (base.protocol === 'https:') base.protocol = 'wss:';
  base.searchParams.set('clientId', clientId);
  return base.href;
}

/** Browser transport with bounded reconnect backoff and no application queue. */
export class WebSocketTransport implements DplayTransport {
  readonly clientId: string;
  private readonly url: string;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private reconnectStep = 0;
  private closed = false;

  constructor(
    private readonly handlers: DplayTransportHandlers,
    options: WebSocketTransportOptions = {},
  ) {
    this.clientId = options.clientId ?? newClientId();
    this.url = websocketUrl(this.clientId, options.url);
    if (typeof globalThis.WebSocket !== 'function') throw new Error('WebSocket is unavailable in this runtime');
    this.connect();
  }

  send(message: DplayWire): boolean {
    const socket = this.socket;
    if (this.closed || !socket || socket.readyState !== globalThis.WebSocket.OPEN) return false;
    if (socket.bufferedAmount > DPLAY_MAX_BUFFERED_BYTES) {
      socket.close(1008, 'slow consumer');
      return false;
    }
    try {
      socket.send(encodeDplayFrame(message));
      return true;
    } catch (error: unknown) {
      report(this.handlers, error);
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (
      socket &&
      (socket.readyState === globalThis.WebSocket.OPEN || socket.readyState === globalThis.WebSocket.CONNECTING)
    ) {
      socket.close(1000, 'client closed');
    }
    this.handlers.onClose?.();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = new globalThis.WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed || this.socket !== socket) return;
      this.reconnectStep = 0;
      this.handlers.onOpen?.();
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.closed || this.socket !== socket) return;
      void this.receive(event.data, socket);
    };
    socket.onerror = (event: Event) => report(this.handlers, event);
    socket.onclose = (event: CloseEvent) => {
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      this.handlers.onClose?.();
      // 1002/1008/1009 are protocol/policy closes; reconnecting would be rejected again, endlessly for 1008,
      // so never reconnect. Back off and retry only network loss 1006, server restart 1001, or server error 1011.
      if (event.code === 1002 || event.code === 1008 || event.code === 1009) return;
      this.scheduleReconnect();
    };
  }

  private async receive(data: unknown, socket: WebSocket): Promise<void> {
    try {
      let binary: ArrayBuffer | ArrayBufferView;
      if (data instanceof Blob) binary = await data.arrayBuffer();
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) binary = data;
      else throw new DplayWireError('protocol', 'WebSocket message is not binary');
      if (this.closed || this.socket !== socket) return;
      this.handlers.onMessage(decodeDplayFrame(binary));
    } catch (error: unknown) {
      report(this.handlers, error);
      if (socket.readyState === globalThis.WebSocket.OPEN) {
        const closeCode = error instanceof DplayWireError && error.code === 'too-large' ? 1009 : 1002;
        socket.close(closeCode, closeCode === 1009 ? 'frame too large' : 'protocol error');
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delays = [1000, 2000, 4000, 8000, 16000, 30000];
    const delay = delays[Math.min(this.reconnectStep++, delays.length - 1)]!;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

/** Default browser behavior is WebSocket; Node smoke must opt into BroadcastChannel. */
export function createDefaultDplayTransport(handlers: DplayTransportHandlers): DplayTransport {
  if (globalThis.location && typeof globalThis.WebSocket === 'function') {
    return new WebSocketTransport(handlers);
  }
  if (!globalThis.location && typeof globalThis.BroadcastChannel === 'function') {
    return new BroadcastChannelTransport(handlers);
  }
  throw new Error('No default Dplay transport is available');
}
