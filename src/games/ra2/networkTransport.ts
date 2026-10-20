import type { RelaySocket } from 'relay-package/client';
import { RelayClient, normalizeRelayAddress } from 'relay-package/client';
import {
  RA2NET_HOST_OCTET_COUNT,
  RA2NET_HOST_OCTET_MIN,
  RA2NET_SUBNET_PREFIX,
  decodeRa2NetworkFrame,
  encodeRa2NetworkFrame,
  isRa2ExeHash,
  isRa2BroadcastAddress,
  isRa2NetworkWire,
} from './networkWire';
import type { Ra2NetworkWire } from './networkWire';

/** BroadcastChannel prefix; append the room ID directly. This development transport has no authentication. */
export const RA2NET_BROADCAST_CHANNEL_PREFIX = 'ra2-winsock-lan:';
/** Default WebSocket relay path, distinct from resource /game/* and DirectPlay /game upgrades. */
export const RA2NET_WEBSOCKET_PATH = '/ra2';

export interface Ra2NetworkPeer {
  id: string;
  addr: number;
  name: Uint8Array;
}

export interface Ra2NetworkConfig {
  room: string;
  exeHash: string;
  relayUrl?: string;
}

/** Deterministic rules shared by the RA2 page and Worker; no WSS/WS probes or DNS queries. */
export function parseRa2RelayUrl(value: string | null): string | undefined {
  if (!value?.trim()) return undefined;
  const normalized = normalizeRelayAddress(value, 'ra2');
  const url = new URL(/^wss?:\/\//.test(normalized) ? normalized : `ws://${normalized}`);
  const authority = value
    .trim()
    .replace(/^wss?:\/\//i, '')
    .split(/[/?#]/, 1)[0]!;
  const port = authority.match(/:(\d+)$/)?.[1];
  if (port && Number(port) === 0) throw new Error('relay 必须使用 1–65535 的端口');
  url.protocol = isLocalRelayHost(url.hostname) ? 'ws:' : 'wss:';
  // Changing protocol must not replace explicit :80 / :443 with the new protocol's default port.
  if (port) url.port = port;
  return url.href;
}

function isLocalRelayHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const ipv4 = (parts: number[]) =>
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return ipv4(host.split('.').map(Number));
  if (!host.startsWith('[')) return false;
  const literal = host.slice(1, -1);
  if (literal === '::1') return true;
  const first = Number.parseInt(literal.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  // URL normalizes IPv4-mapped IPv6 to hexadecimal; classify it by the embedded IPv4 address.
  const mapped = literal.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1]!, 16),
    low = Number.parseInt(mapped[2]!, 16);
  return ipv4([high >>> 8, high & 255, low >>> 8, low & 255]);
}

export interface Ra2NetworkTransportHandlers {
  /** Room handshake complete: the client's virtual address and current member snapshot are available. */
  onReady(self: Ra2NetworkPeer, peers: Ra2NetworkPeer[]): void;
  onPeerJoin(peer: Ra2NetworkPeer): void;
  onPeerLeave(id: string, addr: number): void;
  /** The relay overwrites source addresses by connection; development-only BroadcastChannel peers self-report them. */
  onDatagram(srcAddr: number, srcPort: number, destPort: number, payload: Uint8Array): void;
  onClose?(reason: string): void;
  onError?(error: unknown): void;
  /** Browser-to-relay application RTT; measures neither inter-player RTT nor game-logic progress. */
  onLatency?(rttMs: number): void;
}

export interface Ra2NetworkTransport {
  readonly clientId: string;
  /** True only after handshake and virtual-address assignment; earlier outbound datagrams are dropped with UDP semantics. */
  readonly ready: boolean;
  readonly selfAddr: number;
  sendDatagram(destAddr: number, destPort: number, srcPort: number, payload: Uint8Array): boolean;
  close(): void;
}

export interface Ra2NetworkJoin extends Ra2NetworkConfig {
  name: Uint8Array;
}

export type Ra2NetworkTransportFactory = (
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
) => Ra2NetworkTransport;

function newClientId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  const random = new Uint32Array(4);
  cryptoObject?.getRandomValues(random);
  return `vm-${[...random].map((part) => part.toString(16).padStart(8, '0')).join('')}-${Math.random().toString(36).slice(2)}`;
}

function report(handlers: Ra2NetworkTransportHandlers, error: unknown): void {
  handlers.onError?.(error);
}

/**
 * Self-allocate virtual addresses without a BroadcastChannel relay: hash clientId into 10.247.x.y.
 * Share host-number bounds from the relay package instead of duplicating 1/254 on both sides.
 */
export function selfAssignAddress(clientId: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < clientId.length; i++) {
    hash = Math.imul(hash ^ clientId.charCodeAt(i), 0x0100_0193) >>> 0;
  }
  const high = RA2NET_HOST_OCTET_MIN + (((hash >>> 8) & 0xfe) % RA2NET_HOST_OCTET_COUNT);
  const low = RA2NET_HOST_OCTET_MIN + ((hash & 0xfe) % RA2NET_HOST_OCTET_COUNT);
  return (RA2NET_SUBNET_PREFIX | (high << 8) | low) >>> 0;
}

/**
 * BroadcastChannel structured-clones the complete backing ArrayBuffer of a
 * typed-array view. Guest-memory reads are views into the VM's full WASM
 * memory, so copy only the logical payload before posting it.
 */
function copyStructuredPayload(message: Ra2NetworkWire): Ra2NetworkWire {
  switch (message.t) {
    case 'hello':
    case 'peer-join':
      return { ...message, n: message.n.slice() };
    case 'datagram':
      return { ...message, a: message.a.slice() };
    case 'welcome':
    case 'peer-leave':
    case 'ping':
    case 'pong':
    case 'room-close':
      return message;
  }
}

/**
 * Same-origin multi-tab/Node smoke transport: no relay, self-assigned addresses, and member discovery through mutual peer-join replies.
 * Limited to same-origin pages in one browser profile; this development/regression transport does not represent a real LAN.
 */
export class Ra2BroadcastChannelTransport implements Ra2NetworkTransport {
  readonly clientId: string;
  readonly selfAddr: number;
  private readonly channel: BroadcastChannel;
  private readonly peers = new Map<string, Ra2NetworkPeer>();
  private closed = false;
  private announced = false;

  constructor(
    private readonly handlers: Ra2NetworkTransportHandlers,
    join: Ra2NetworkJoin,
    channelPrefix = RA2NET_BROADCAST_CHANNEL_PREFIX,
  ) {
    this.clientId = newClientId();
    if (!isRa2ExeHash(join.exeHash)) throw new Error('RA2 联机需要有效的 EXE SHA-256');
    this.selfAddr = selfAssignAddress(this.clientId);
    if (typeof globalThis.BroadcastChannel !== 'function') {
      throw new Error('BroadcastChannel is unavailable in this runtime');
    }
    const channel = new globalThis.BroadcastChannel(`${channelPrefix}${join.room}:${join.exeHash}`);
    this.channel = channel;
    this.name = join.name.slice(0, 64);
    this.exeHash = join.exeHash;
    channel.onmessage = (event: MessageEvent<unknown>) => this.receive(event.data);
    channel.onmessageerror = (event: MessageEvent<unknown>) => report(handlers, event);
    // Become ready before broadcasting: the shim sends only after onReady, and peer-join must expose complete state to peers.
    globalThis.queueMicrotask(() => {
      if (this.closed) return;
      handlers.onReady({ id: this.clientId, addr: this.selfAddr, name: this.name.slice() }, []);
      this.announce();
    });
  }

  private readonly name: Uint8Array;
  private readonly exeHash: string;

  get ready(): boolean {
    return this.announced && !this.closed;
  }

  private announce(): void {
    if (this.closed) return;
    this.announced = true;
    this.post({ t: 'peer-join', peer: this.clientId, addr: this.selfAddr, exe: this.exeHash, n: this.name });
  }

  private post(message: Ra2NetworkWire): boolean {
    if (this.closed) return false;
    try {
      this.channel.postMessage(copyStructuredPayload(message));
      return true;
    } catch (error: unknown) {
      report(this.handlers, error);
      return false;
    }
  }

  private receive(data: unknown): void {
    if (this.closed || !isRa2NetworkWire(data)) return;
    switch (data.t) {
      case 'peer-join': {
        if (data.peer === this.clientId) return;
        if (data.exe !== this.exeHash) return;
        const known = this.peers.has(data.peer);
        this.peers.set(data.peer, { id: data.peer, addr: data.addr, name: data.n });
        if (!known) {
          // A new member arrived: rebroadcast self so the newcomer can discover the full member list.
          this.post({ t: 'peer-join', peer: this.clientId, addr: this.selfAddr, exe: this.exeHash, n: this.name });
          this.handlers.onPeerJoin({ id: data.peer, addr: data.addr, name: data.n });
        }
        return;
      }
      case 'peer-leave': {
        if (this.peers.delete(data.peer)) this.handlers.onPeerLeave(data.peer, data.addr);
        return;
      }
      case 'datagram': {
        if (data.src === this.selfAddr) return; // Do not echo our own packets; BroadcastChannel already avoids echoes, but guard against mixed relay wiring.
        if (data.dest !== this.selfAddr && !isRa2BroadcastAddress(data.dest)) return;
        this.handlers.onDatagram(data.src, data.sport, data.dport, data.a);
        return;
      }
      case 'ping':
        this.post({ t: 'pong', n: data.n, at: data.at });
        return;
      default:
        return;
    }
  }

  sendDatagram(destAddr: number, destPort: number, srcPort: number, payload: Uint8Array): boolean {
    if (!this.announced) return false;
    return this.post({
      t: 'datagram',
      src: this.selfAddr,
      sport: srcPort,
      dest: destAddr,
      dport: destPort,
      a: payload,
    });
  }

  close(): void {
    if (this.closed) return;
    this.post({ t: 'peer-leave', peer: this.clientId, addr: this.selfAddr });
    this.closed = true;
    this.channel.close();
    this.handlers.onClose?.('closed');
  }
}

interface Ra2WebSocketTransportOptions {
  url?: string;
  clientId?: string;
  handshakeTimeoutMs?: number;
  socketFactory?: (url: string) => RelaySocket;
  codec?: { encode: typeof encodeRa2NetworkFrame; decode: typeof decodeRa2NetworkFrame };
}

function websocketUrl(clientId: string, suppliedUrl?: string): string {
  if (suppliedUrl) return parseRa2RelayUrl(suppliedUrl)!;
  const pageLocation = globalThis.location;
  if (!pageLocation) throw new Error('A WebSocket URL is required outside a browser page');
  const base = new URL(
    RA2NET_WEBSOCKET_PATH,
    pageLocation.origin && pageLocation.origin !== 'null' ? `${pageLocation.origin}/` : pageLocation.href,
  );
  if (base.protocol === 'http:') base.protocol = 'ws:';
  if (base.protocol === 'https:') base.protocol = 'wss:';
  base.searchParams.set('clientId', clientId);
  return base.href;
}

/**
 * WebSocket room relay: send hello after connecting, then await welcome and virtual-address assignment.
 * Handle disconnects with UDP semantics: never automatically rejoin the old room, since old-epoch frames could contaminate new games. The shim maps disconnects to player departures.
 */
export class Ra2WebSocketTransport extends RelayClient implements Ra2NetworkTransport {
  constructor(handlers: Ra2NetworkTransportHandlers, join: Ra2NetworkJoin, options: Ra2WebSocketTransportOptions = {}) {
    const clientId = options.clientId ?? newClientId();
    super(
      {
        ...options,
        url: websocketUrl(clientId, options.url),
        clientId,
        room: join.room,
        compatibilityHash: join.exeHash,
        metadata: join.name.slice(0, 64),
      },
      {
        ...handlers,
        onReady: (self, peers) =>
          handlers.onReady(
            { id: self.id, addr: self.addr, name: self.metadata },
            peers.map((peer) => ({ id: peer.id, addr: peer.addr, name: peer.metadata })),
          ),
        onPeerJoin: (peer) => handlers.onPeerJoin({ id: peer.id, addr: peer.addr, name: peer.metadata }),
      },
    );
  }
}

export function createRa2BroadcastChannelTransport(
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
): Ra2NetworkTransport {
  return new Ra2BroadcastChannelTransport(handlers, join);
}

export function createRa2WebSocketTransport(
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
  options: Ra2WebSocketTransportOptions = {},
): Ra2NetworkTransport {
  return new Ra2WebSocketTransport(handlers, join, options);
}

/** Browsers default to WebSocket relay; Node smoke tests explicitly inject a BroadcastChannel factory. */
export function createDefaultRa2NetworkTransport(
  handlers: Ra2NetworkTransportHandlers,
  join: Ra2NetworkJoin,
): Ra2NetworkTransport {
  if (globalThis.location && typeof globalThis.WebSocket === 'function') {
    return createRa2WebSocketTransport(handlers, join);
  }
  if (!globalThis.location && typeof globalThis.BroadcastChannel === 'function') {
    return new Ra2BroadcastChannelTransport(handlers, join);
  }
  throw new Error('No default RA2 network transport is available');
}
