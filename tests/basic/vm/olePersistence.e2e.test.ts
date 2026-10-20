import { expect, it } from 'vitest';
import { guidBytes } from '../../../src/vm86/shim/dplayx';
import { HYPERCALL_CALLBACK_DEPTH } from '../../../src/vm86/pe';
import { callShim } from '../../helpers/guestMemory';
import { call32, finish, le32, PROGRAM, push32, store32, withGuestMachine } from '../../helpers/guestMachine';

it.each([
  { bytes: [], expected: 0x8003001e },
  { bytes: new Array<number>(16).fill(0), expected: 0 },
  { bytes: [...guidBytes('{12345678-1234-5678-1234-567812345678}')], expected: 0x80040154 },
])('handles short, null and unregistered persisted objects ($expected)', async ({ bytes, expected }) => {
  await withGuestMachine(async (m) => {
    const data = 0x310000;
    m.code(data, [115, 0, 0, 0]);
    callShim(m.shim, 'OLE32.DLL!StgCreateDocfile', [data, 0x1012, 0, data + 32]);
    callShim(m.shim, 'OLE32.DLL!IStorage.CreateStream', [m.read(data + 32), data, 0x1012, 0, 0, data + 32]);
    const stream = m.read(data + 32);
    m.code(data + 64, bytes);
    callShim(m.shim, 'OLE32.DLL!IStream.Write', [stream, data + 64, bytes.length, 0]);
    callShim(m.shim, 'OLE32.DLL!IStream.Seek', [stream, 0, 0, 0, 0]);
    m.code(data + 96, guidBytes('{00000109-0000-0000-c000-000000000046}'));
    m.write(data + 128, 0xdeadbeef);
    const load = m.api('OleLoadFromStream', 12, undefined, 'OLE32.DLL');
    m.code(PROGRAM, [
      ...push32(data + 128),
      ...push32(data + 96),
      ...push32(stream),
      ...call32(load),
      0xa3,
      ...le32(data + 132),
      ...finish,
    ]);
    await m.run();
    expect(m.read(data + 132)).toBe(expected);
    expect(m.read(data + 128)).toBe(0);
    expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(0);
  });
});

it.each(['success', 'queryFailure', 'loadFailure'])(
  'native COM persistence after 10,000 saves: %s',
  async (mode) => {
    await withGuestMachine(async (m) => {
      const data = 0x310000,
        object = data + 0x100,
        vtable = data + 0x200;
      const factory = data + 0x300,
        factoryVtable = data + 0x400;
      const clsid = data + 0x500,
        iid = data + 0x520,
        output = data + 0x540;
      const loaded = data + 0x560,
        result = data + 0x580;
      const methods = PROGRAM + 0x1000;
      m.code(clsid, guidBytes('{12345678-1234-5678-1234-567812345678}'));
      m.code(iid, guidBytes('{00000109-0000-0000-c000-000000000046}'));
      m.write(object, vtable);
      m.write(factory, factoryVtable);
      m.write(factoryVtable + 12, methods + 0x500);
      for (let index = 0; index < 7; index++) m.write(vtable + index * 4, methods + index * 0x100);
      // QueryInterface returns the persistence object; Release records ownership cleanup.
      m.code(methods, [0x8b, 0x44, 0x24, 12, 0xc7, 0x00, ...le32(object), 0x31, 0xc0, 0xc2, 12, 0]);
      m.code(methods + 0x200, [0xff, 0x05, ...le32(data + 4), 0x31, 0xc0, 0xc2, 4, 0]);
      const guid = m.memory.read_memory(clsid, 16);
      m.code(methods + 0x300, [
        0x8b,
        0x44,
        0x24,
        8,
        ...[0, 4, 8, 12].flatMap((offset) => [0xc7, 0x40, offset, ...guid.slice(offset, offset + 4)]),
        0x31,
        0xc0,
        0xc2,
        8,
        0,
      ]);
      // The factory has its own entry; IPersistStream::Load occupies vtable slot 5.
      m.write(factoryVtable + 12, methods + 0x700);
      m.code(methods + 0x700, [0x8b, 0x44, 0x24, 16, 0xc7, 0x00, ...le32(object), 0x31, 0xc0, 0xc2, 16, 0]);
      m.code(methods + 0x500, [
        0x8b,
        0x4c,
        0x24,
        8,
        ...push32(0),
        ...push32(4),
        ...push32(loaded),
        0x51,
        0x8b,
        0x01,
        0xff,
        0x50,
        12,
        0xc2,
        8,
        0,
      ]);
      m.code(methods + 0x600, [
        0x8b,
        0x4c,
        0x24,
        8,
        ...push32(0),
        ...push32(4),
        ...push32(data),
        0x51,
        0x8b,
        0x01,
        0xff,
        0x50,
        16,
        0xc2,
        12,
        0,
      ]);
      if (mode === 'queryFailure') m.code(methods, [0xb8, ...le32(0x80004002), 0xc2, 12, 0]);
      if (mode === 'loadFailure') m.code(methods + 0x500, [0xb8, ...le32(0x80004005), 0xc2, 8, 0]);
      m.write(data, 0x76543210);
      callShim(m.shim, 'OLE32.DLL!CoRegisterClassObject', [clsid, factory, 1, 1, output]);
      const wide = (address: number, text: string) =>
        m.code(
          address,
          [...text, '\0'].flatMap((char) => [char.charCodeAt(0), 0]),
        );
      wide(data + 0x600, 'roundtrip.sav');
      wide(data + 0x640, 'objects');
      callShim(m.shim, 'OLE32.DLL!StgCreateDocfile', [data + 0x600, 0x1012, 0, output]);
      callShim(m.shim, 'OLE32.DLL!IStorage.CreateStream', [m.read(output), data + 0x640, 0x1012, 0, 0, output]);
      const stream = m.read(output);
      const save = m.api('OleSaveToStream', 8, undefined, 'OLE32.DLL');
      const load = m.api('OleLoadFromStream', 12, undefined, 'OLE32.DLL');
      const seek = m.api('IStream.Seek', 20, undefined, 'OLE32.DLL');
      const loop = [...push32(stream), ...push32(object), ...call32(save), 0x4f];
      m.code(PROGRAM, [
        0xbf,
        ...le32(10000),
        ...loop,
        0x0f,
        0x85,
        ...le32(-(loop.length + 6)),
        ...store32(data, 0), // The loaded value must come from the stream, not live object memory.
        ...push32(0),
        ...push32(0),
        ...push32(0),
        ...push32(0),
        ...push32(stream),
        ...call32(seek),
        ...push32(output),
        ...push32(iid),
        ...push32(stream),
        ...call32(load),
        0xa3,
        ...le32(result),
        ...finish,
      ]);
      await m.run(20000);
      expect(m.read(result)).toBe(mode === 'success' ? 0 : mode === 'queryFailure' ? 0x80004002 : 0x80004005);
      expect(m.read(output)).toBe(mode === 'success' ? object : 0);
      expect(m.read(loaded)).toBe(mode === 'success' ? 0x76543210 : 0);
      expect(m.read(data + 4)).toBe(mode === 'loadFailure' ? 2 : 1);
      expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(0);
      expect(m.calls.filter((call) => call.imported.name === 'OleSaveToStream')).toHaveLength(10000);
    });
  },
  30000,
);
