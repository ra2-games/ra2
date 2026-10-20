import { describe, expect, it } from 'vitest';
import {
  RELAY_MAX_FRAME_BYTES,
  decodeRelayFrame,
  encodeRelayFrame,
  isAssignableRoomAddress,
  isRelayClientId,
  isRelayBroadcastAddress,
  isRelayWire,
} from '../src/network/relayWire';
import type { RelayWire } from '../src/network/relayWire';

const EXE_HASH = 'a'.repeat(64);
const messages: RelayWire[] = [
  { t: 'hello', room: 'room-1', exe: EXE_HASH, nonce: 'nonce', n: new Uint8Array([1, 2, 3]) },
  { t: 'welcome', peer: 'peer-1', addr: 0x0af7_0101, epoch: 4 },
  { t: 'peer-join', peer: 'peer-2', addr: 0x0af7_0102, exe: EXE_HASH, n: new Uint8Array([7]) },
  { t: 'peer-leave', peer: 'peer-2', addr: 0x0af7_0102 },
  { t: 'datagram', src: 0x0af7_0101, sport: 5000, dest: 0x0af7_0102, dport: 5001, a: new Uint8Array([0, 255, 4]) },
  { t: 'ping', n: 8, at: 1234 },
  { t: 'pong', n: 8, at: 1234 },
  { t: 'room-close', epoch: 4, reason: 'closed' },
];

describe('RA2 network wire', () => {
  it('可分配房间地址拒绝 0/255 主机号与网段外地址', () => {
    for (const [address, expected] of [
      [0x0af7_0101, true],
      [0x0af7_0102, true],
      [0x0af7_fefe, true],
      [0x0af7_0001, false], // high=0
      [0x0af7_0100, false], // low=0
      [0x0af7_ff01, false], // high=255
      [0x0af7_01ff, false], // low=255
      [0x0af7_ffff, false],
      [0x0bf7_0101, false], // Outside the subnet.
      [0x0000_0101, false],
    ] as const) {
      expect(isAssignableRoomAddress(address), `0x${address.toString(16)}`).toBe(expected);
    }
  });

  it('round-trips every message type and copies only the logical payload', () => {
    for (const message of messages) {
      const encoded = encodeRelayFrame(message);
      expect(encoded.byteLength).toBeLessThanOrEqual(RELAY_MAX_FRAME_BYTES);
      const decoded = decodeRelayFrame(encoded.subarray(0));
      expect(decoded).toEqual(message);
    }
  });

  it('recognizes valid structured-clone messages and rejects invalid values', () => {
    expect(isRelayWire(messages[0])).toBe(true);
    expect(isRelayWire({ ...messages[0], exe: '' })).toBe(false);
    expect(isRelayWire({ ...messages[0], exe: 'a'.repeat(63) })).toBe(false);
    expect(isRelayWire({ ...messages[0], n: [1, 2, 3] })).toBe(false);
    expect(isRelayWire({ t: 'datagram', src: 1, sport: 1, dest: 2, dport: 2, a: new Uint8Array() })).toBe(false);
    expect(isRelayWire({ t: 'unknown' })).toBe(false);
    expect(isRelayBroadcastAddress(0xffff_ffff)).toBe(true);
    expect(isRelayBroadcastAddress(0x0af7_ffff)).toBe(true);
    expect(isRelayBroadcastAddress(0x0af7_0101)).toBe(false);
  });

  it('accepts generated client IDs and rejects control characters or unsafe syntax', () => {
    for (const id of ['12345678-1234-4567-89ab-123456789abc', 'vm-0123456789abcdef-abc123', 'client-1'])
      expect(isRelayClientId(id)).toBe(true);
    for (const id of ['', 'a'.repeat(129), 'client id', 'client\nlog', 'client\u001b[31m', 'client/room', '玩家'])
      expect(isRelayClientId(id)).toBe(false);
  });

  it('uses an exact 13-byte binary datagram header', () => {
    const vector = Uint8Array.from([5, 10, 247, 1, 1, 10, 247, 1, 2, 0x13, 0x88, 0x13, 0x89, 0, 255, 4]);
    expect(encodeRelayFrame(messages[4]!)).toEqual(vector);
    expect(decodeRelayFrame(vector)).toEqual(messages[4]);
    const padded = new Uint8Array(vector.length + 12);
    padded.set(vector, 7);
    const decoded = decodeRelayFrame(new DataView(padded.buffer, 7, vector.length));
    padded.fill(0);
    expect(decoded).toEqual(messages[4]);
  });

  it('preserves Unicode strings and full safe-integer timestamps', () => {
    for (const message of [
      { t: 'hello', room: '房间🚀', exe: EXE_HASH, nonce: '你好', n: new Uint8Array() },
      { t: 'room-close', epoch: 0xffffffff, reason: '\ufeff维护中' },
      { t: 'ping', n: 0xffffffff, at: Number.MAX_SAFE_INTEGER },
    ] as RelayWire[])
      expect(decodeRelayFrame(encodeRelayFrame(message))).toEqual(message);
    expect(encodeRelayFrame({ t: 'ping', n: 1, at: 2 })).toEqual(
      Uint8Array.from([6, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2]),
    );
  });

  it('rejects truncated control fields and unexpected tails', () => {
    for (const message of messages.filter((m) => !['hello', 'peer-join', 'datagram'].includes(m.t))) {
      const frame = encodeRelayFrame(message);
      for (let length = 0; length < frame.length; length++)
        expect(() => decodeRelayFrame(frame.slice(0, length))).toThrow();
      expect(() => decodeRelayFrame(new Uint8Array([...frame, 0]))).toThrow();
    }
  });

  it('rejects legacy headers, unknown versions/types and invalid UTF-8', () => {
    for (const frame of [
      new Uint8Array([0, 0, 0, 2, 123, 125]),
      new Uint8Array([0x47, 0x52, 2, 5]),
      new Uint8Array([0x47, 0x52, 3, 5]),
      new Uint8Array([0x4a, 0x4c, 1, 5]),
      new Uint8Array([0x4a, 0x4c, 0x4c, 5]),
      new Uint8Array([0x4a, 0x4c, 0x31, 99]),
      new Uint8Array([2, 0, 1, 0xff, 0, 0, 0, 1, 0, 0, 0, 1]),
    ])
      expect(() => decodeRelayFrame(frame)).toThrowError(expect.objectContaining({ code: 'protocol' }));
    const timestamp = encodeRelayFrame({ t: 'ping', n: 1, at: 0 });
    timestamp.fill(255, 5);
    expect(() => decodeRelayFrame(timestamp)).toThrow();
  });

  it('enforces metadata, datagram, frame and hash bounds', () => {
    expect(() => encodeRelayFrame({ t: 'hello', room: 'r', exe: '', nonce: 'n', n: new Uint8Array() })).toThrowError(
      expect.objectContaining({ code: 'invalid-hash' }),
    );
    expect(() =>
      encodeRelayFrame({ t: 'hello', room: 'r', exe: EXE_HASH, nonce: 'n', n: new Uint8Array(65) }),
    ).toThrow();
    const large = {
      t: 'datagram',
      src: 0xffffffff,
      dest: 0xffffffff,
      sport: 65535,
      dport: 65535,
      a: new Uint8Array(65507),
    } as const;
    expect(decodeRelayFrame(encodeRelayFrame(large))).toEqual(large);
    expect(() => encodeRelayFrame({ ...large, a: new Uint8Array(65508) })).toThrow();
    const frame = encodeRelayFrame(large);
    expect(() => decodeRelayFrame(frame.slice(0, 13))).toThrow();
    expect(() => decodeRelayFrame(new Uint8Array([...frame, 0]))).toThrowError(
      expect.objectContaining({ code: 'too-large' }),
    );
    expect(() => decodeRelayFrame(new Uint8Array(RELAY_MAX_FRAME_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: 'too-large' }),
    );
    const hello = encodeRelayFrame({ t: 'hello', room: 'r', exe: EXE_HASH, nonce: 'n', n: new Uint8Array(64) });
    expect(() => decodeRelayFrame(new Uint8Array([...hello, 0]))).toThrow();
  });
});
