import { expect, it } from 'vitest';
import { inspectPe32 } from '../../src/vm86/peProbe';
import { buildPe32 } from '../fixture/peBuilder';

function fixture() {
  return buildPe32({
    entryRva: 0x1000,
    imports: [],
    sections: [
      { name: '.text', data: new Uint8Array([0x8b, 0x15, 1, 2, 3, 4, 0xc3]), characteristics: 0x60000020 },
      { name: '.data', data: new Uint8Array(32), characteristics: 0xc0000040 },
    ],
  }).exe;
}

it('scans initialized executable bytes, with unique validated matches and section bounds', () => {
  const exe = fixture();
  const probe = inspectPe32(exe)!;
  expect(probe.findCode([0x8b, 0x15, null, null, null, null, 0xc3])?.address).toBe(0x401000);
  expect(probe.findCode([0], () => false)).toBeNull();
  expect(probe.findCode([0])).toBeNull();
  expect(probe.findCode([])).toBeNull();
  expect(probe.contains(0x402000, 4, 'data')).toBe(true);
  expect(probe.contains(0x402000, 4, 'code')).toBe(false);
  expect(probe.contains(0x4021fe, 4, 'data')).toBe(false);
  expect(probe.read(0x4021fe, 4, 'data')).toBeNull();
  expect(probe.read(0x401000, 7, 'code')?.bytes).toEqual(new Uint8Array([0x8b, 0x15, 1, 2, 3, 4, 0xc3]));
});

it.each([
  ['wrong DOS signature', 0, 0],
  ['invalid PE offset', 0x3c, 0xfffffff0],
  ['unsupported machine', 0x84, 0x00038664],
  ['PE32+', 0x98, 0x20b],
  ['overflowing image', 0x98 + 28, 0xfffff000],
  ['raw section outside file', 0x178 + 20, 0xffffff00],
  ['section outside image', 0x178 + 12, 0xffff0000],
  ['overlapping virtual sections', 0x178 + 40 + 12, 0x1000],
  ['overlapping raw sections', 0x178 + 40 + 20, 0x200],
  ['section overlaps headers', 0x178 + 12, 0x100],
] as const)('rejects %s', (_name, offset, value) => {
  const exe = fixture();
  new DataView(exe.buffer).setUint32(offset, value, true);
  expect(inspectPe32(exe)).toBeNull();
});

it('rejects truncation and does not scan writable code or virtual zero-fill', () => {
  const exe = fixture();
  for (const end of [0, 10, 0x90, 0x190, exe.length - 1]) expect(inspectPe32(exe.subarray(0, end))).toBeNull();
  const view = new DataView(exe.buffer);
  view.setUint32(0x178 + 36, 0xe0000020, true);
  expect(inspectPe32(exe)?.findCode([0x8b, 0x15])).toBeNull();
  view.setUint32(0x178 + 36, 0x60000020, true);
  view.setUint32(0x178 + 16, 0, true);
  expect(inspectPe32(exe)?.findCode([0])).toBeNull();
});
