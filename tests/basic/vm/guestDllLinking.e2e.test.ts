import { expect, it } from 'vitest';
import { GUEST_THREAD_CRITICAL_DEPTH, type PeImport } from '../../../src/vm86/pe';
import { buildPe32 } from '../../fixture/peBuilder';
import { call32, finish, le32, PROGRAM, push32, withGuestMachine } from '../../helpers/guestMachine';

it('links native DLL calls with original return values, stdcall cleanup, and one process attach', async () => {
  const data = 0x310000;
  const text = new Uint8Array(128);
  text.set([0xff, 0x05, ...le32(data), 0xb8, ...le32(1), 0xc2, 12, 0]); // DllMain
  text.set([0x8b, 0x44, 0x24, 4, 0xba, ...le32(0x87654321), 0xc2, 4, 0], 32); // Echo
  const exports = new Uint8Array(128);
  const directory = new DataView(exports.buffer);
  directory.setUint32(16, 1, true); // Ordinal base
  directory.setUint32(20, 1, true);
  directory.setUint32(24, 1, true);
  directory.setUint32(28, 0x2040, true);
  directory.setUint32(32, 0x2044, true);
  directory.setUint32(36, 0x2048, true);
  directory.setUint32(64, 0x1020, true);
  directory.setUint32(68, 0x2050, true);
  exports.set(new TextEncoder().encode('Echo\0'), 80);
  const { exe } = buildPe32({
    imageBase: 0x600000,
    entryRva: 0x1000,
    imports: [],
    sections: [
      { name: '.text', data: text, characteristics: 0x60000020 },
      { name: '.edata', data: exports, characteristics: 0x40000040 },
    ],
  });
  const headers = new DataView(exe.buffer);
  const opt = headers.getUint32(0x3c, true) + 24;
  headers.setUint16(opt - 2, headers.getUint16(opt - 2, true) | 0x2000, true); // IMAGE_FILE_DLL
  headers.setUint32(opt + 96, 0x2000, true);
  headers.setUint32(opt + 100, exports.length, true);
  await withGuestMachine(
    async (m) => {
      m.shim.mountFile('fixture.dll', exe);
      const imported: PeImport = {
        id: 100,
        dll: 'FIXTURE.DLL',
        name: 'Echo',
        key: 'FIXTURE.DLL!Echo',
        argBytes: 4,
        slot: data + 4,
        stub: 0,
      };
      const entry = m.shim.linkGuestDllBeforeEntry('fixture.dll', PROGRAM + 64, [imported]);
      expect(m.read(imported.slot)).toBe(0x601020);
      expect(m.shim.linkGuestDllBeforeEntry('fixture.dll', entry, [imported])).toBe(entry);
      m.code(PROGRAM, [0xb8, ...le32(entry), 0xff, 0xe0]);
      m.code(PROGRAM + 64, [
        0x89,
        0x25,
        ...le32(data + 8), // Initial ESP
        ...push32(0),
        ...call32(m.read(imported.slot)),
        0xa3,
        ...le32(data + 12), // Preserve the actual failure result.
        ...push32(0x12345678),
        ...call32(m.read(imported.slot)),
        0xa3,
        ...le32(data + 16),
        0x89,
        0x15,
        ...le32(data + 20), // EDX is not overwritten by a host bridge.
        0x89,
        0x25,
        ...le32(data + 24),
        ...finish,
      ]);
      await m.run();
      expect(m.read(data)).toBe(1);
      expect(m.read(data + 12)).toBe(0);
      expect(m.read(data + 16)).toBe(0x12345678);
      expect(m.read(data + 20)).toBe(0x87654321);
      expect(m.read(data + 24)).toBe(m.read(data + 8));
      expect(m.read(GUEST_THREAD_CRITICAL_DEPTH)).toBe(0);
      expect(m.calls).toHaveLength(0);
    },
    { importArgBytes: () => 0 },
  );
});

it.each(['preload', 'LoadLibraryA'])('does not turn a FALSE DllMain result into success through %s', async (route) => {
  const { exe } = buildPe32({
    imageBase: 0x600000,
    entryRva: 0x1000,
    imports: [],
    sections: [{ name: '.text', data: new Uint8Array([0x31, 0xc0, 0xc2, 12, 0]), characteristics: 0x60000020 }],
  });
  await withGuestMachine(
    async (m) => {
      m.shim.mountFile('fixture.dll', exe);
      if (route === 'preload') {
        const entry = m.shim.initializeGuestDllBeforeEntry('fixture.dll', PROGRAM + 64);
        m.code(PROGRAM, [0xb8, ...le32(entry), 0xff, 0xe0]);
        m.code(PROGRAM + 64, finish);
      } else {
        const load = m.api('LoadLibraryA', 4);
        m.code(0x310000, new TextEncoder().encode('fixture.dll\0'));
        m.code(PROGRAM, [...push32(0x310000), ...call32(load), ...finish]);
      }
      await expect(m.run()).rejects.toThrow('CPU 异常 #6');
    },
    { importArgBytes: () => 0 },
  );
});
