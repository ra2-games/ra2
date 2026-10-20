/**
 * Codec for DirectPlay session/player messages carried by dplayTransport.
 *
 * This differs from packages/relay's virtual-LAN wire format; do not merge or reuse one as the other. Put control fields in a small JSON header and player/session bytes in a binary tail so normal traffic does not become JSON number arrays.
 */

export const DPLAY_WIRE_VERSION = 1;
export const DPLAY_MAX_HEADER_BYTES = 16 * 1024;
export const DPLAY_MAX_FRAME_BYTES = 1024 * 1024;
export const DPLAY_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type DplayWire =
  | { t: 'announce'; i: string; n: Uint8Array; m: number; c: number; g: string; f: number }
  | { t: 'join'; i: string }
  | { t: 'sclose'; i: string }
  | { t: 'pinfo'; i: string; d: number; n: Uint8Array }
  | { t: 'newplayer'; i: string; d: number; n: Uint8Array; c: number }
  | { t: 'pdata'; i: string; d: number; a: Uint8Array }
  | { t: 'msg'; i: string; f: number; o: number; a: Uint8Array }
  | { t: 'leave'; i: string; d: number };

type DplayWireType = DplayWire['t'];
type PayloadKind = 'n' | 'a';

interface HeaderBase {
  v: number;
  t: DplayWireType;
  i: string;
}

type DplayHeader =
  | (HeaderBase & { t: 'announce'; m: number; c: number; g: string; f: number; p: 'n' })
  | (HeaderBase & { t: 'join' })
  | (HeaderBase & { t: 'sclose' })
  | (HeaderBase & { t: 'pinfo'; d: number; p: 'n' })
  | (HeaderBase & { t: 'newplayer'; d: number; c: number; p: 'n' })
  | (HeaderBase & { t: 'pdata'; d: number; p: 'a' })
  | (HeaderBase & { t: 'msg'; f: number; o: number; p: 'a' })
  | (HeaderBase & { t: 'leave'; d: number });

export type DplayWireErrorCode = 'protocol' | 'too-large';

export class DplayWireError extends Error {
  constructor(
    public readonly code: DplayWireErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DplayWireError';
  }
}

function protocolError(message: string): DplayWireError {
  return new DplayWireError('protocol', message);
}

function tooLargeError(message: string): DplayWireError {
  return new DplayWireError('too-large', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isPayloadKind(value: unknown): value is PayloadKind {
  return value === 'n' || value === 'a';
}

function payloadOf(message: DplayWire): Uint8Array | null {
  switch (message.t) {
    case 'announce':
    case 'pinfo':
    case 'newplayer':
      return message.n;
    case 'pdata':
    case 'msg':
      return message.a;
    case 'join':
    case 'sclose':
    case 'leave':
      return null;
  }
}

function headerOf(message: DplayWire): DplayHeader {
  switch (message.t) {
    case 'announce':
      return {
        v: DPLAY_WIRE_VERSION,
        t: message.t,
        i: message.i,
        m: message.m,
        c: message.c,
        g: message.g,
        f: message.f,
        p: 'n',
      };
    case 'join':
    case 'sclose':
      return { v: DPLAY_WIRE_VERSION, t: message.t, i: message.i };
    case 'pinfo':
      return { v: DPLAY_WIRE_VERSION, t: message.t, i: message.i, d: message.d, p: 'n' };
    case 'newplayer':
      return { v: DPLAY_WIRE_VERSION, t: message.t, i: message.i, d: message.d, c: message.c, p: 'n' };
    case 'pdata':
      return { v: DPLAY_WIRE_VERSION, t: message.t, i: message.i, d: message.d, p: 'a' };
    case 'msg':
      return { v: DPLAY_WIRE_VERSION, t: message.t, i: message.i, f: message.f, o: message.o, p: 'a' };
    case 'leave':
      return { v: DPLAY_WIRE_VERSION, t: message.t, i: message.i, d: message.d };
  }
}

/** Encode one complete WebSocket binary message. */
export function encodeDplayFrame(message: DplayWire): Uint8Array {
  const payload = payloadOf(message);
  const header = new TextEncoder().encode(JSON.stringify(headerOf(message)));
  if (header.byteLength > DPLAY_MAX_HEADER_BYTES) {
    throw tooLargeError(`Dplay header exceeds ${DPLAY_MAX_HEADER_BYTES} bytes`);
  }
  const frameBytes = 4 + header.byteLength + (payload?.byteLength ?? 0);
  if (frameBytes > DPLAY_MAX_FRAME_BYTES) {
    throw tooLargeError(`Dplay frame exceeds ${DPLAY_MAX_FRAME_BYTES} bytes`);
  }
  const frame = new Uint8Array(frameBytes);
  new DataView(frame.buffer).setUint32(0, header.byteLength, false);
  frame.set(header, 4);
  if (payload) frame.set(payload, 4 + header.byteLength);
  return frame;
}

function asBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw protocolError('WebSocket data is not binary');
}

function parseHeader(bytes: Uint8Array): DplayHeader {
  if (bytes.byteLength < 4) throw protocolError('Dplay frame is shorter than its length prefix');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (headerLength > DPLAY_MAX_HEADER_BYTES) throw tooLargeError('Dplay header is too large');
  const headerEnd = 4 + headerLength;
  if (headerEnd > bytes.byteLength) throw protocolError('Dplay header extends past the frame');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, headerEnd))) as unknown;
  } catch {
    throw protocolError('Dplay header is not valid UTF-8 JSON');
  }
  if (!isRecord(value)) throw protocolError('Dplay header must be a JSON object');
  if (value.v !== DPLAY_WIRE_VERSION) throw protocolError('Unsupported Dplay wire version');
  if (typeof value.t !== 'string' || !isNonEmptyString(value.i)) throw protocolError('Dplay header has invalid v/t/i');
  return value as unknown as DplayHeader;
}

function validateCommonHeader(header: Record<string, unknown>, type: DplayWireType): void {
  if (header.v !== DPLAY_WIRE_VERSION || header.t !== type || !isNonEmptyString(header.i)) {
    throw protocolError(`Invalid ${type} header`);
  }
}

function validatePayloadHeader(header: Record<string, unknown>, expected: PayloadKind): void {
  if (!hasOwn(header, 'p') || !isPayloadKind(header.p) || header.p !== expected) {
    throw protocolError('Invalid Dplay payload marker');
  }
}

function validateNoPayload(header: Record<string, unknown>): void {
  if (hasOwn(header, 'p')) throw protocolError('Unexpected payload marker');
}

/** Decode one complete WebSocket binary message and copy its payload once. */
export function decodeDplayFrame(data: ArrayBuffer | ArrayBufferView): DplayWire {
  const bytes = asBytes(data);
  if (bytes.byteLength > DPLAY_MAX_FRAME_BYTES) throw tooLargeError('Dplay frame is too large');
  const header = parseHeader(bytes);
  const headerEnd = 4 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  const payload = new Uint8Array(bytes.subarray(headerEnd));
  const fields = header as unknown as Record<string, unknown>;
  switch (header.t) {
    case 'announce':
      validateCommonHeader(fields, 'announce');
      validatePayloadHeader(fields, 'n');
      if (!isUint32(fields.m) || !isUint32(fields.c) || !isUint32(fields.f) || !isNonEmptyString(fields.g)) {
        throw protocolError('Invalid announce fields');
      }
      return { t: 'announce', i: header.i, n: payload, m: fields.m, c: fields.c, g: fields.g, f: fields.f };
    case 'join':
      validateCommonHeader(fields, 'join');
      validateNoPayload(fields);
      if (payload.byteLength !== 0) throw protocolError('join cannot carry a payload');
      return { t: 'join', i: header.i };
    case 'sclose':
      validateCommonHeader(fields, 'sclose');
      validateNoPayload(fields);
      if (payload.byteLength !== 0) throw protocolError('sclose cannot carry a payload');
      return { t: 'sclose', i: header.i };
    case 'pinfo':
      validateCommonHeader(fields, 'pinfo');
      validatePayloadHeader(fields, 'n');
      if (!isUint32(fields.d)) throw protocolError('Invalid pinfo DPID');
      return { t: 'pinfo', i: header.i, d: fields.d, n: payload };
    case 'newplayer':
      validateCommonHeader(fields, 'newplayer');
      validatePayloadHeader(fields, 'n');
      if (!isUint32(fields.d) || !isUint32(fields.c)) throw protocolError('Invalid newplayer fields');
      return { t: 'newplayer', i: header.i, d: fields.d, n: payload, c: fields.c };
    case 'pdata':
      validateCommonHeader(fields, 'pdata');
      validatePayloadHeader(fields, 'a');
      if (!isUint32(fields.d)) throw protocolError('Invalid pdata DPID');
      return { t: 'pdata', i: header.i, d: fields.d, a: payload };
    case 'msg':
      validateCommonHeader(fields, 'msg');
      validatePayloadHeader(fields, 'a');
      if (!isUint32(fields.f) || !isUint32(fields.o)) throw protocolError('Invalid msg routing fields');
      return { t: 'msg', i: header.i, f: fields.f, o: fields.o, a: payload };
    case 'leave':
      validateCommonHeader(fields, 'leave');
      validateNoPayload(fields);
      if (payload.byteLength !== 0) throw protocolError('leave cannot carry a payload');
      if (!isUint32(fields.d)) throw protocolError('Invalid leave DPID');
      return { t: 'leave', i: header.i, d: fields.d };
    default:
      throw protocolError('Unknown Dplay message type');
  }
}

/** Runtime guard used by the structured BroadcastChannel test transport. */
export function isDplayWire(value: unknown): value is DplayWire {
  if (!isRecord(value) || typeof value.t !== 'string' || !isNonEmptyString(value.i)) return false;
  try {
    switch (value.t) {
      case 'announce':
        return (
          isUint32(value.m) &&
          isUint32(value.c) &&
          isUint32(value.f) &&
          isNonEmptyString(value.g) &&
          value.n instanceof Uint8Array
        );
      case 'join':
      case 'sclose':
        return true;
      case 'pinfo':
        return isUint32(value.d) && value.n instanceof Uint8Array;
      case 'newplayer':
        return isUint32(value.d) && isUint32(value.c) && value.n instanceof Uint8Array;
      case 'pdata':
        return isUint32(value.d) && value.a instanceof Uint8Array;
      case 'msg':
        return isUint32(value.f) && isUint32(value.o) && value.a instanceof Uint8Array;
      case 'leave':
        return isUint32(value.d);
      default:
        return false;
    }
  } catch {
    return false;
  }
}
