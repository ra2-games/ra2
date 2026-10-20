import { describe, expect, it } from 'vitest';
import { GUEST_CALLBACK_BASE } from '../../src/vm86/pe';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../helpers/guestMemory';
import { guidBytes } from '../../src/vm86/shim/dplayx';
import { RA2_ABI } from '../../src/games/ra2/abi';

function writeWide(memory: ReturnType<typeof createGuestMemory>, address: number, value: string): void {
  const bytes = new Uint8Array((value.length + 1) * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
  memory.write_memory(bytes, address);
}

describe('OLE structured storage', () => {
  it('persists numeric and Unicode properties across a fresh shim session', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    writeWide(memory, 0x2000, 'props.sav');
    memory.write_memory(guidBytes('{0000013a-0000-0000-c000-000000000046}'), 0x2100);
    memory.write_memory(guidBytes('{f29f85e0-4ff9-1068-ab91-08002b27b3d9}'), 0x2120);
    callShim(shim, 'OLE32.DLL!StgCreateDocfile', [0x2000, 0x1012, 0, 0x2200]);
    const storage = readU32(memory, 0x2200);
    callShim(shim, 'OLE32.DLL!IStorage.QueryInterface', [storage, 0x2100, 0x2204]);
    callShim(shim, 'OLE32.DLL!IPropertySetStorage.Create', [readU32(memory, 0x2204), 0x2120, 0, 0, 0x1012, 0x2208]);
    const properties = readU32(memory, 0x2208);
    writeU32(memory, 0x2300, 1);
    writeU32(memory, 0x2304, 2);
    writeU32(memory, 0x2308, 1);
    writeU32(memory, 0x230c, 3);
    writeU32(memory, 0x2400, 3);
    writeU32(memory, 0x2408, 10000);
    writeU32(memory, 0x2410, 31);
    writeU32(memory, 0x2418, 0x2500);
    writeWide(memory, 0x2500, '遭遇战存档');
    expect(callShim(shim, 'OLE32.DLL!IPropertyStorage.WriteMultiple', [properties, 2, 0x2300, 0x2400, 2]).eax).toBe(0);
    callShim(shim, 'OLE32.DLL!IStorage.Commit', [storage, 0]);
    const bytes = shim.getMountedFileBytes('props.sav')!.slice();
    // Overwrite original pointer targets: serialized properties must own their values.
    memory.write_memory(new Uint8Array(64), 0x2500);
    const restored = createTestShim(memory);
    restored.mountFile('props.sav', bytes);
    expect(callShim(restored, 'OLE32.DLL!StgOpenStorage', [0x2000, 0, 0x10, 0, 0, 0x2200]).eax).toBe(0);
    callShim(restored, 'OLE32.DLL!IStorage.QueryInterface', [readU32(memory, 0x2200), 0x2100, 0x2204]);
    expect(
      callShim(restored, 'OLE32.DLL!IPropertySetStorage.Open', [readU32(memory, 0x2204), 0x2120, 0x10, 0x2208]).eax,
    ).toBe(0);
    expect(
      callShim(restored, 'OLE32.DLL!IPropertyStorage.ReadMultiple', [readU32(memory, 0x2208), 2, 0x2300, 0x2600]).eax,
    ).toBe(0);
    expect(readU32(memory, 0x2608)).toBe(10000);
    expect(readU32(memory, 0x2610)).toBe(31);
    expect(new TextDecoder('utf-16le').decode(memory.read_memory(readU32(memory, 0x2618), 10))).toBe('遭遇战存档');
    // Truncated metadata must be rejected instead of exposing partial properties.
    const corrupt = createTestShim(memory);
    corrupt.mountFile('props.sav', bytes.subarray(0, bytes.length - 1));
    expect(callShim(corrupt, 'OLE32.DLL!StgOpenStorage', [0x2000, 0, 0x10, 0, 0, 0x2200]).eax).not.toBe(0);
    expect(readU32(memory, 0x2200)).toBe(0);
  });
  it('RA2 and YR both serialize native objects', () => {
    const memory = createGuestMemory();
    const stack = 0x3000;
    const returnAddress = 0x0065_5938;
    writeU32(memory, stack, returnAddress);
    const shim = createTestShim(memory, { gameId: 'ra2' });
    expect(callShim(shim, 'OLE32.DLL!OleSaveToStream', [0x4000, 0x5000], stack).eax).toBe(0);
    expect(readU32(memory, stack)).not.toBe(returnAddress);

    const yrMemory = createGuestMemory();
    writeU32(yrMemory, stack, returnAddress);
    const yrShim = createTestShim(yrMemory, { gameId: 'yr' });
    expect(callShim(yrShim, 'OLE32.DLL!OleSaveToStream', [0x4000, 0x5000], stack).eax).toBe(0);
    expect(readU32(yrMemory, stack)).not.toBe(returnAddress);
  });

  it('OleSaveToStream 保持两参数 stdcall ABI 并串接客体 IPersistStream', () => {
    expect(RA2_ABI['OLE32.DLL!OleSaveToStream']).toBe(8);

    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const stack = 0x3000;
    const originalReturn = 0x1234_5678;
    const persistStream = 0x4000;
    const stream = 0x5000;
    writeU32(memory, stack, originalReturn);

    expect(callShim(shim, 'OLE32.DLL!OleSaveToStream', [persistStream, stream], stack).eax).toBe(0);
    const bridge = readU32(memory, stack);
    expect(bridge).not.toBe(originalReturn);
    const code = memory.read_memory(bridge, 160);
    const contains = (needle: readonly number[]) =>
      code.some((_, index) => needle.every((byte, offset) => code[index + offset] === byte));
    expect(contains([0x8b, 0x11, 0xff, 0x52, 0x0c])).toBe(true); // GetClassID
    expect(contains([0x8b, 0x11, 0xff, 0x52, 0x10])).toBe(true); // IStream::Write
    expect(contains([0x8b, 0x11, 0xff, 0x52, 0x18])).toBe(true); // IPersistStream::Save
    // The bridge lives in a callback slot, so its tail releases the slot under CLI and returns with push/ret
    // instead of jumping through ECX; the original return address must still be what it returns to.
    expect(bridge).toBeGreaterThanOrEqual(GUEST_CALLBACK_BASE);
    expect(
      contains([
        0x68,
        originalReturn & 0xff,
        (originalReturn >>> 8) & 0xff,
        (originalReturn >>> 16) & 0xff,
        originalReturn >>> 24,
      ]),
    ).toBe(true);
    expect(contains([0xfb, 0xc3])).toBe(true); // sti; ret
  });

  it('为 IStorage/IStream vtable 登记正确的 x86 stdcall 参数字节数', () => {
    const memory = createGuestMemory();
    const imports = new Map<string, number>();
    const shim = createTestShim(memory, {
      dynamicImportStub: (dll, name, _id, argBytes) => {
        imports.set(`${dll}!${name}`, argBytes);
        return new Uint8Array([0xc3]);
      },
    });
    const path = 0x2000;
    const storageOut = 0x2200;
    const streamName = 0x2300;
    const streamOut = 0x2400;
    writeWide(memory, path, 'Save\\abi.sav');
    writeWide(memory, streamName, 'Contents');

    expect(callShim(shim, 'OLE32.DLL!StgCreateDocfile', [path, 0x1012, 0, storageOut]).eax).toBe(0);
    expect(
      callShim(shim, 'OLE32.DLL!IStorage.CreateStream', [
        readU32(memory, storageOut),
        streamName,
        0x1012,
        0,
        0,
        streamOut,
      ]).eax,
    ).toBe(0);

    expect(imports.get('OLE32.DLL!IStorage.CreateStorage')).toBe(24);
    expect(imports.get('OLE32.DLL!IStorage.OpenStorage')).toBe(28);
    expect(imports.get('OLE32.DLL!IStream.Seek')).toBe(20);
    expect(imports.get('OLE32.DLL!IStream.CopyTo')).toBe(24);
  });

  it('QueryInterface 为 IPropertySetStorage 返回独立且 ABI 正确的接口', () => {
    const memory = createGuestMemory();
    const imports = new Map<string, number>();
    const shim = createTestShim(memory, {
      dynamicImportStub: (dll, name, _id, argBytes) => {
        imports.set(`${dll}!${name}`, argBytes);
        return new Uint8Array([0xc3]);
      },
    });
    const path = 0x2000;
    const storageOut = 0x2200;
    const iid = 0x2300;
    const propertySetStorageOut = 0x2320;
    const fmtid = 0x2340;
    const propertyStorageOut = 0x2360;
    writeWide(memory, path, 'Save\\props.sav');
    memory.write_memory(guidBytes('{0000013a-0000-0000-c000-000000000046}'), iid);
    memory.write_memory(guidBytes('{f29f85e0-4ff9-1068-ab91-08002b27b3d9}'), fmtid);

    expect(callShim(shim, 'OLE32.DLL!StgCreateDocfile', [path, 0x1012, 0, storageOut]).eax).toBe(0);
    const storage = readU32(memory, storageOut);
    expect(callShim(shim, 'OLE32.DLL!IStorage.QueryInterface', [storage, iid, propertySetStorageOut]).eax).toBe(0);
    const propertySetStorage = readU32(memory, propertySetStorageOut);
    expect(propertySetStorage).not.toBe(0);
    expect(propertySetStorage).not.toBe(storage);
    expect(imports.get('OLE32.DLL!IPropertySetStorage.Create')).toBe(24);
    expect(imports.get('OLE32.DLL!IPropertySetStorage.Open')).toBe(16);

    expect(
      callShim(shim, 'OLE32.DLL!IPropertySetStorage.Open', [propertySetStorage, fmtid, 0x10, propertyStorageOut]).eax,
    ).toBe(0x8003_0002);
    expect(
      callShim(shim, 'OLE32.DLL!IPropertySetStorage.Create', [
        propertySetStorage,
        fmtid,
        0,
        0,
        0x1012,
        propertyStorageOut,
      ]).eax,
    ).toBe(0);
    expect(readU32(memory, propertyStorageOut)).not.toBe(0);
    expect(imports.get('OLE32.DLL!IPropertyStorage.ReadMultiple')).toBe(16);
    expect(imports.get('OLE32.DLL!IPropertyStorage.WriteMultiple')).toBe(20);
  });

  it('IStorage.QueryInterface 对未知 IID 返回 E_NOINTERFACE 并清空输出', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const path = 0x2000;
    const storageOut = 0x2200;
    const iid = 0x2300;
    const output = 0x2320;
    writeWide(memory, path, 'Save\\unknown.sav');
    memory.write_memory(guidBytes('{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}'), iid);
    writeU32(memory, output, 0xdead_beef);

    expect(callShim(shim, 'OLE32.DLL!StgCreateDocfile', [path, 0x1012, 0, storageOut]).eax).toBe(0);
    expect(callShim(shim, 'OLE32.DLL!IStorage.QueryInterface', [readU32(memory, storageOut), iid, output]).eax).toBe(
      0x8000_4002,
    );
    expect(readU32(memory, output)).toBe(0);
  });

  it('创建 storage/stream 后可写入、定位、读取并提交', () => {
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    const path = 0x2000;
    const storageOut = 0x2200;
    const streamName = 0x2300;
    const streamOut = 0x2400;
    const payload = 0x2500;
    const readBack = 0x2600;
    const countOut = 0x2700;
    writeWide(memory, path, 'Save\\slot.sav');
    writeWide(memory, streamName, 'Contents');
    memory.write_memory(new Uint8Array([1, 2, 3, 4]), payload);

    expect(callShim(shim, 'OLE32.DLL!StgCreateDocfile', [path, 0x1012, 0, storageOut]).eax).toBe(0);
    const storage = readU32(memory, storageOut);
    expect(storage).not.toBe(0);
    expect(callShim(shim, 'OLE32.DLL!IStorage.CreateStream', [storage, streamName, 0x1012, 0, 0, streamOut]).eax).toBe(
      0,
    );
    const stream = readU32(memory, streamOut);
    expect(callShim(shim, 'OLE32.DLL!IStream.Write', [stream, payload, 4, countOut]).eax).toBe(0);
    expect(readU32(memory, countOut)).toBe(4);
    writeU32(memory, countOut, 0);
    expect(callShim(shim, 'OLE32.DLL!IStream.Seek', [stream, 0, 0, 0, 0]).eax).toBe(0);
    expect(callShim(shim, 'OLE32.DLL!IStream.Read', [stream, readBack, 4, countOut]).eax).toBe(0);
    expect(memory.read_memory(readBack, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    // Sequential campaign-save writes reuse geometric backing capacity while
    // preserving the exact logical stream length exposed by Stat/Read/encode.
    expect(callShim(shim, 'OLE32.DLL!IStream.Write', [stream, payload, 4, countOut]).eax).toBe(0);
    expect(callShim(shim, 'OLE32.DLL!IStream.Seek', [stream, 0, 0, 0, 0]).eax).toBe(0);
    expect(callShim(shim, 'OLE32.DLL!IStream.Read', [stream, readBack, 8, countOut]).eax).toBe(0);
    expect(memory.read_memory(readBack, 8)).toEqual(new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4]));
    expect(callShim(shim, 'OLE32.DLL!IStorage.Commit', [storage, 0]).eax).toBe(0);
    expect(new TextDecoder().decode(shim.getMountedFileBytes('Save\\slot.sav')!.subarray(0, 8))).toBe('SGBYSTG1');

    const reopenedOut = 0x2800;
    const reopenedStreamOut = 0x2900;
    expect(callShim(shim, 'OLE32.DLL!StgOpenStorage', [path, 0, 0x10, 0, 0, reopenedOut]).eax).toBe(0);
    expect(
      callShim(shim, 'OLE32.DLL!IStorage.OpenStream', [
        readU32(memory, reopenedOut),
        streamName,
        0,
        0x10,
        0,
        reopenedStreamOut,
      ]).eax,
    ).toBe(0);
    writeU32(memory, countOut, 0);
    expect(
      callShim(shim, 'OLE32.DLL!IStream.Read', [readU32(memory, reopenedStreamOut), readBack, 8, countOut]).eax,
    ).toBe(0);
    expect(memory.read_memory(readBack, 8)).toEqual(new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4]));
  });
});
