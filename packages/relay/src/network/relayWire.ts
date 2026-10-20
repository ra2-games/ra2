/**
 * General-purpose binary WS protocol: one-byte message type and a fixed 13-byte datagram header.
 * exe is a compatibility SHA-256; n is opaque metadata. The service does not interpret game content.
 */

/** Virtual LAN member limit; each game adapter limits the player count per match. */
export const RELAY_MAX_LAN_MEMBERS = 20;
export const RELAY_MAX_FRAME_BYTES = 128 * 1024;
export const RELAY_MAX_CLIENT_ID_LENGTH = 128;
/** The theoretical UDP datagram limit is 65507; relay and guest queues use the same limit. */
export const RELAY_MAX_DATAGRAM_BYTES = 65_507;
export const RELAY_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const RELAY_COMPATIBILITY_HASH_HEX_LENGTH = 64;
/** Virtual LAN subnet: 10.247.0.0/16 (fixed high 16 bits of a network-order u32). */
export const RELAY_SUBNET_PREFIX = 0x0af7_0000;
export const RELAY_SUBNET_MASK = 0xffff_0000;
/** Treat both limited broadcast 255.255.255.255 and subnet-directed broadcast 10.247.255.255 as broadcasts. */
export const RELAY_LIMITED_BROADCAST = 0xffff_ffff;
export const RELAY_SUBNET_BROADCAST = RELAY_SUBNET_PREFIX | (~RELAY_SUBNET_MASK >>> 0);

/**
 * Allocatable range for both host octets in room virtual addresses: 0 and 255 are reserved in this subnet.
 * Relay allocation and client self-allocation must share these bounds to prevent their rules from diverging.
 */
export const RELAY_HOST_OCTET_MIN = 1;
export const RELAY_HOST_OCTET_MAX = 254;
export const RELAY_HOST_OCTET_COUNT = RELAY_HOST_OCTET_MAX - RELAY_HOST_OCTET_MIN + 1;

/** Whether the address belongs to the virtual LAN subnet and both host octets are allocatable. */
export function isAssignableRoomAddress(address: number): boolean {
  const host = address & 0x0000_ffff;
  const high = (host >>> 8) & 0xff;
  const low = host & 0xff;
  return (
    (address & RELAY_SUBNET_MASK) >>> 0 === RELAY_SUBNET_PREFIX &&
    high >= RELAY_HOST_OCTET_MIN &&
    high <= RELAY_HOST_OCTET_MAX &&
    low >= RELAY_HOST_OCTET_MIN &&
    low <= RELAY_HOST_OCTET_MAX
  );
}

export type RelayWire =
  | { t: 'hello'; room: string; exe: string; nonce: string; n: Uint8Array }
  | { t: 'welcome'; peer: string; addr: number; epoch: number }
  | { t: 'peer-join'; peer: string; addr: number; exe: string; n: Uint8Array }
  | { t: 'peer-leave'; peer: string; addr: number }
  | { t: 'datagram'; src: number; sport: number; dest: number; dport: number; a: Uint8Array }
  | { t: 'ping'; n: number; at: number }
  | { t: 'pong'; n: number; at: number }
  | { t: 'room-close'; epoch: number; reason: string };

export type RelayWireErrorCode = 'protocol' | 'invalid-hash' | 'too-large';

export class RelayWireError extends Error {
  constructor(
    public readonly code: RelayWireErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayWireError';
  }
}

function protocolError(message: string): RelayWireError {
  return new RelayWireError('protocol', message);
}

function tooLargeError(message: string): RelayWireError {
  return new RelayWireError('too-large', message);
}

function invalidHashError(message: string): RelayWireError {
  return new RelayWireError('invalid-hash', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= maxLength;
}

export function isRelayClientId(value: unknown): value is string {
  return isBoundedString(value, RELAY_MAX_CLIENT_ID_LENGTH, false) && /^[A-Za-z0-9._-]+$/.test(value);
}

function isPeerId(value: unknown): value is string {
  return isRelayClientId(value);
}

export function isRelayRoomId(value: unknown): value is string {
  return isBoundedString(value, 64, false) && !/[?&#/\s]/.test(value);
}

export function isRelayCompatibilityHash(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length === RELAY_COMPATIBILITY_HASH_HEX_LENGTH && /^[0-9a-f]{64}$/.test(value)
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const opcodes = {
  hello: 1,
  welcome: 2,
  'peer-join': 3,
  'peer-leave': 4,
  datagram: 5,
  ping: 6,
  pong: 7,
  'room-close': 8,
} as const;

/** Allocate only the final frame on the hot path; WS supplies message length, so payload length need not be encoded again. */
export function encodeRelayFrame(message: RelayWire): Uint8Array {
  if ((message.t === 'hello' || message.t === 'peer-join') && !isRelayCompatibilityHash(message.exe)) {
    throw invalidHashError('兼容性哈希无效');
  }
  if (message.t === 'datagram' && message.a.byteLength > RELAY_MAX_DATAGRAM_BYTES) throw tooLargeError('数据报过大');
  if (!isRelayWire(message)) throw protocolError('消息字段无效');
  const frame = new Uint8Array(message.t === 'datagram' ? 13 + message.a.byteLength : 1024);
  const view = new DataView(frame.buffer);
  frame[0] = opcodes[message.t];
  let offset = 1;
  const u32 = (value: number) => {
    view.setUint32(offset, value);
    offset += 4;
  };
  const text = (value: string) => {
    const bytes = encoder.encode(value);
    if (decoder.decode(bytes) !== value) throw protocolError('字符串不是合法 Unicode');
    view.setUint16(offset, bytes.length);
    offset += 2;
    frame.set(bytes, offset);
    offset += bytes.length;
  };
  const hash = (value: string) => {
    for (let i = 0; i < 64; i += 2) frame[offset++] = Number.parseInt(value.slice(i, i + 2), 16);
  };
  const payload = (bytes: Uint8Array) => {
    frame.set(bytes, offset);
    offset += bytes.length;
  };
  switch (message.t) {
    case 'datagram':
      u32(message.src);
      u32(message.dest);
      view.setUint16(offset, message.sport);
      view.setUint16(offset + 2, message.dport);
      offset += 4;
      payload(message.a);
      return frame;
    case 'hello':
      text(message.room);
      hash(message.exe);
      text(message.nonce);
      payload(message.n);
      break;
    case 'welcome':
      text(message.peer);
      u32(message.addr);
      u32(message.epoch);
      break;
    case 'peer-join':
      text(message.peer);
      u32(message.addr);
      hash(message.exe);
      payload(message.n);
      break;
    case 'peer-leave':
      text(message.peer);
      u32(message.addr);
      break;
    case 'ping':
    case 'pong':
      u32(message.n);
      view.setBigUint64(offset, BigInt(message.at));
      offset += 8;
      break;
    case 'room-close':
      u32(message.epoch);
      text(message.reason);
      break;
  }
  return frame.slice(0, offset);
}

/** Strictly validate bounds, types, UTF-8, and trailing bytes; copy only the logical payload bytes. */
export function decodeRelayFrame(data: ArrayBuffer | ArrayBufferView): RelayWire {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : undefined;
  if (!bytes) throw protocolError('消息不是二进制帧');
  if (bytes.length > RELAY_MAX_FRAME_BYTES) throw tooLargeError('网络帧过大');
  if (bytes.length < 1) throw protocolError('空消息');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 1;
  const take = (size: number) => {
    if (size > bytes.length - offset) throw protocolError('帧被截断');
    const start = offset;
    offset += size;
    return start;
  };
  const u32 = () => view.getUint32(take(4));
  const u16 = () => view.getUint16(take(2));
  const text = () => {
    const size = u16();
    const start = take(size);
    try {
      return decoder.decode(bytes.subarray(start, start + size));
    } catch {
      throw protocolError('字符串不是合法 UTF-8');
    }
  };
  const hash = () => {
    const start = take(32);
    return Array.from(bytes.subarray(start, start + 32), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const payload = () => {
    const start = offset;
    offset = bytes.length;
    return bytes.slice(start);
  };
  let message: RelayWire;
  switch (bytes[0]) {
    case 1:
      message = { t: 'hello', room: text(), exe: hash(), nonce: text(), n: payload() };
      break;
    case 2:
      message = { t: 'welcome', peer: text(), addr: u32(), epoch: u32() };
      break;
    case 3:
      message = { t: 'peer-join', peer: text(), addr: u32(), exe: hash(), n: payload() };
      break;
    case 4:
      message = { t: 'peer-leave', peer: text(), addr: u32() };
      break;
    case 5: {
      if (bytes.length - 13 > RELAY_MAX_DATAGRAM_BYTES) throw tooLargeError('数据报过大');
      message = { t: 'datagram', src: u32(), dest: u32(), sport: u16(), dport: u16(), a: payload() };
      break;
    }
    case 6:
    case 7: {
      const n = u32();
      const timestamp = view.getBigUint64(take(8));
      if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw protocolError('时间戳越界');
      message = { t: bytes[0] === 6 ? 'ping' : 'pong', n, at: Number(timestamp) };
      break;
    }
    case 8:
      message = { t: 'room-close', epoch: u32(), reason: text() };
      break;
    default:
      throw protocolError('未知消息类型');
  }
  if (offset !== bytes.length) throw protocolError('不允许尾随字节');
  if (!isRelayWire(message)) throw protocolError('消息字段无效');
  return message;
}

/** Runtime guard for the BroadcastChannel structured-clone transport, using the same rules as binary decoding. */
export function isRelayWire(value: unknown): value is RelayWire {
  if (!isRecord(value) || typeof value.t !== 'string') return false;
  try {
    switch (value.t) {
      case 'hello':
        return (
          isRelayRoomId(value.room) &&
          isRelayCompatibilityHash(value.exe) &&
          isBoundedString(value.nonce, 32, false) &&
          value.n instanceof Uint8Array &&
          value.n.byteLength <= 64
        );
      case 'welcome':
        return isPeerId(value.peer) && isUint32(value.addr) && isUint32(value.epoch);
      case 'peer-join':
        return (
          isPeerId(value.peer) &&
          isUint32(value.addr) &&
          isRelayCompatibilityHash(value.exe) &&
          value.n instanceof Uint8Array &&
          value.n.byteLength <= 64
        );
      case 'peer-leave':
        return isPeerId(value.peer) && isUint32(value.addr);
      case 'datagram':
        return (
          isUint32(value.src) &&
          isUint32(value.dest) &&
          isPort(value.sport) &&
          isPort(value.dport) &&
          value.a instanceof Uint8Array &&
          value.a.byteLength > 0 &&
          value.a.byteLength <= RELAY_MAX_DATAGRAM_BYTES
        );
      case 'ping':
      case 'pong':
        return isUint32(value.n) && isTimestamp(value.at);
      case 'room-close':
        return isUint32(value.epoch) && isBoundedString(value.reason, 128, false);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Whether the destination is a broadcast address: limited broadcast or virtual subnet-directed broadcast. */
export function isRelayBroadcastAddress(addr: number): boolean {
  return addr === RELAY_LIMITED_BROADCAST || addr === RELAY_SUBNET_BROADCAST;
}
