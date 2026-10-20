/** shim/dplayWire.ts unit tests: DirectPlay relay frame encoding/decoding and protocol validation. */
import { describe, expect, it } from 'vitest';
import {
  decodeDplayFrame,
  DPLAY_MAX_FRAME_BYTES,
  DplayWireError,
  encodeDplayFrame,
  isDplayWire,
  type DplayWire,
} from '../../src/vm86/shim/dplayWire';

const NAME = new Uint8Array([0x41, 0x42]); // "AB"

function roundTrip(message: DplayWire): DplayWire {
  return decodeDplayFrame(encodeDplayFrame(message));
}

describe('encodeDplayFrame / decodeDplayFrame', () => {
  it('全部消息类型往返一致', () => {
    const cases: DplayWire[] = [
      { t: 'announce', i: 's1', n: NAME, m: 0x1234, c: 4, g: 'game', f: 7 },
      { t: 'join', i: 's1' },
      { t: 'sclose', i: 's1' },
      { t: 'pinfo', i: 's1', d: 1, n: NAME },
      { t: 'newplayer', i: 's1', d: 2, n: NAME, c: 3 },
      { t: 'pdata', i: 's1', d: 2, a: new Uint8Array([1, 2, 3]) },
      { t: 'msg', i: 's1', f: 1, o: 2, a: new Uint8Array([9]) },
      { t: 'leave', i: 's1', d: 2 },
    ];
    for (const message of cases) {
      const decoded = roundTrip(message);
      expect(decoded).toEqual(message);
    }
  });

  it('拒绝过短帧与坏 JSON 头', () => {
    expect(() => decodeDplayFrame(new Uint8Array([0, 1]))).toThrowError(DplayWireError);
    const badJson = new Uint8Array(8);
    new DataView(badJson.buffer).setUint32(0, 4, false);
    badJson.set([0xff, 0xfe, 0xfd, 0xfc], 4);
    expect(() => decodeDplayFrame(badJson)).toThrowError(/UTF-8 JSON/);
  });

  it('拒绝版本不符与未知类型', () => {
    const frame = (header: object): Uint8Array => {
      const json = new TextEncoder().encode(JSON.stringify(header));
      const out = new Uint8Array(4 + json.length);
      new DataView(out.buffer).setUint32(0, json.length, false);
      out.set(json, 4);
      return out;
    };
    expect(() => decodeDplayFrame(frame({ v: 99, t: 'join', i: 'x' }))).toThrowError(/version/);
    expect(() => decodeDplayFrame(frame({ v: 1, t: 'nope', i: 'x' }))).toThrowError(/Unknown/);
  });

  it('无载荷类型不得携带载荷', () => {
    const json = new TextEncoder().encode(JSON.stringify({ v: 1, t: 'join', i: 'x' }));
    const out = new Uint8Array(4 + json.length + 1);
    new DataView(out.buffer).setUint32(0, json.length, false);
    out.set(json, 4);
    expect(() => decodeDplayFrame(out)).toThrowError(/payload/);
  });

  it('超过帧上限直接拒绝', () => {
    expect(() => decodeDplayFrame(new Uint8Array(DPLAY_MAX_FRAME_BYTES + 1))).toThrowError(/too large/);
    const huge = { t: 'pdata', i: 's', d: 1, a: new Uint8Array(DPLAY_MAX_FRAME_BYTES) } as const;
    expect(() => encodeDplayFrame(huge)).toThrowError(/exceeds/);
  });
});

describe('isDplayWire', () => {
  it('识别合法消息、拒绝缺字段消息', () => {
    expect(isDplayWire({ t: 'join', i: 's' })).toBe(true);
    expect(isDplayWire({ t: 'pdata', i: 's', d: 1, a: new Uint8Array(1) })).toBe(true);
    expect(isDplayWire({ t: 'pdata', i: 's', d: -1, a: new Uint8Array(1) })).toBe(false);
    expect(isDplayWire({ t: 'join' })).toBe(false);
    expect(isDplayWire(null)).toBe(false);
    expect(isDplayWire({ t: 'unknown', i: 's' })).toBe(false);
  });
});
