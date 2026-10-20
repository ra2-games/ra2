import { expect, it } from 'vitest';
import { GuestProcessKernel } from '../../src/vm86/processKernel';
import { callShim, createGuestMemory, createTestShim, readU32, writeAsciiZ, writeU32 } from '../helpers/guestMemory';

function fixture(kernel?: GuestProcessKernel) {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, kernel ? { processContext: { kernel, pid: kernel.createProcess() } } : {});
  const call = (name: string, args: number[]) => callShim(shim, `ADVAPI32.DLL!${name}`, args).eax;
  const path = (value: string) => {
    writeAsciiZ(memory, 0x1000, value);
    return 0x1000;
  };
  const name = (value: string) => {
    writeAsciiZ(memory, 0x1100, value);
    return 0x1100;
  };
  const create = (value = 'Software\\RegistryTest', access = 0xf003f) => {
    expect(call('RegCreateKeyExA', [0x80000002, path(value), 0, 0, 0, access, 0, 0x1200, 0x1204])).toBe(0);
    return readU32(memory, 0x1200);
  };
  const open = (value = 'Software\\RegistryTest', access = 0x20019) => {
    const code = call('RegOpenKeyExA', [0x80000002, path(value), 0, access, 0x1200]);
    return { code, handle: readU32(memory, 0x1200) };
  };
  const set = (handle: number, value: string, type = 3, bytes = Uint8Array.of(7, 8)) => {
    memory.write_memory(bytes, 0x1500);
    return call('RegSetValueExA', [handle, name(value), 0, type, bytes.length ? 0x1500 : 0, bytes.length]);
  };
  const query = (handle: number, value: string, capacity = 64, data = 0x1600) => {
    writeU32(memory, 0x1400, capacity);
    const code = call('RegQueryValueExA', [handle, name(value), 0, 0x1404, data, 0x1400]);
    const size = readU32(memory, 0x1400);
    return { code, size, type: readU32(memory, 0x1404), bytes: memory.read_memory(data, size).slice() };
  };
  return { memory, shim, call, path, name, create, open, set, query };
}

it('never manufactures missing keys, paths or credentials, including through invalid and closed handles', () => {
  const f = fixture();
  writeU32(f.memory, 0x1200, 0xcccccccc);
  expect(f.open().code).toBe(2);
  expect(readU32(f.memory, 0x1200)).toBe(0xcccccccc);
  expect(f.set(0xdead, 'Value')).toBe(6);
  expect(f.query(0xdead, 'InstallPath').code).toBe(6);
  expect(f.call('RegCloseKey', [0xdead])).toBe(6);
  const h = f.create();
  for (const name of ['Serial', 'InstallPath', 'Path', 'ID']) expect(f.query(h, name).code).toBe(2);
  expect(f.call('RegDeleteValueA', [h, f.name('Missing')])).toBe(2);
  expect(f.call('RegCloseKey', [h])).toBe(0);
  expect(f.query(h, 'Path').code).toBe(6);
});

it('preserves typed, unnamed, zero-byte and case-insensitive values and query buffer boundaries', () => {
  const f = fixture();
  const h = f.create();
  expect(readU32(f.memory, 0x1204)).toBe(1);
  const reopened = f.create('SOFTWARE\\REGISTRYTEST');
  expect(readU32(f.memory, 0x1204)).toBe(2);
  expect(f.set(h, 'Binary', 3)).toBe(0);
  expect(f.query(reopened, 'bINARY')).toMatchObject({ code: 0, size: 2, type: 3, bytes: Uint8Array.of(7, 8) });
  expect(f.set(h, '', 4, Uint8Array.of(0, 0, 0, 0))).toBe(0);
  expect(f.query(h, '')).toMatchObject({ code: 0, type: 4, size: 4 });
  expect(f.set(h, 'Empty', 7, new Uint8Array())).toBe(0);
  expect(f.query(h, 'empty')).toMatchObject({ code: 0, size: 0, type: 7 });
  expect(f.query(h, 'Binary', 0, 0)).toMatchObject({ code: 0, size: 2, type: 3 });
  f.memory.bytes.fill(0xcc, 0x1600, 0x1610);
  expect(f.query(h, 'Binary', 1)).toMatchObject({ code: 234, size: 2, type: 3 });
  expect([...f.memory.read_memory(0x1600, 16)]).toEqual(new Array(16).fill(0xcc));
  expect(f.query(h, 'Binary', 2).code).toBe(0);
  expect(f.memory.bytes[0x1602]).toBe(0xcc);
});

it('enforces granted value/enumeration access and rejects unsupported views, options and security attributes', () => {
  const f = fixture();
  const h = f.create();
  expect(f.set(h, 'Value')).toBe(0);
  const read = f.open().handle;
  expect(f.set(read, 'Value')).toBe(5);
  expect(f.call('RegDeleteValueA', [read, f.name('Value')])).toBe(5);
  const write = f.open(undefined, 2).handle;
  expect(f.query(write, 'Value').code).toBe(5);
  expect(f.open(undefined, 0x20119).code).toBe(50);
  expect(f.call('RegOpenKeyExA', [0x80000002, f.path('Software'), 8, 1, 0x1200])).toBe(50);
  expect(f.call('RegCreateKeyExA', [0x80000002, f.path('Unsupported'), 0, 0, 2, 1, 0, 0x1200, 0])).toBe(50);
  expect(f.call('RegCreateKeyExA', [0x80000002, f.path('Unsupported'), 0, 0, 0, 1, 0x1800, 0x1200, 0])).toBe(50);
  expect(f.open('Unsupported').code).toBe(2);
});

it('reports actual subkeys, values and sizes, without overwriting short enumeration buffers', () => {
  const f = fixture();
  const h = f.create();
  f.create('Software\\RegistryTest\\Child');
  f.create('Software\\RegistryTest\\Other');
  f.set(h, 'Binary', 3, Uint8Array.of(1, 2, 3));
  expect(f.call('RegQueryInfoKeyA', [h, 0, 0, 0, 0x1300, 0x1304, 0, 0x1308, 0x130c, 0x1310, 0, 0x1320])).toBe(0);
  expect([0x1300, 0x1304, 0x1308, 0x130c, 0x1310].map((p) => readU32(f.memory, p))).toEqual([2, 5, 1, 6, 3]);
  expect(readU32(f.memory, 0x1324)).toBeGreaterThan(0);
  writeU32(f.memory, 0x1400, 5);
  f.memory.bytes.fill(0xcc, 0x1600, 0x1610);
  expect(f.call('RegEnumKeyExA', [h, 0, 0x1600, 0x1400, 0, 0, 0, 0])).toBe(234);
  expect(f.memory.bytes[0x1600]).toBe(0xcc);
  writeU32(f.memory, 0x1400, 6);
  expect(f.call('RegEnumKeyExA', [h, 0, 0x1600, 0x1400, 0, 0, 0, 0])).toBe(0);
  expect(readU32(f.memory, 0x1400)).toBe(5);
  expect(new TextDecoder().decode(f.memory.read_memory(0x1600, 6))).toBe('Child\0');
  expect(f.call('RegEnumKeyExA', [h, 2, 0x1600, 0x1400, 0, 0, 0, 0])).toBe(259);
  const restricted = f.open(undefined, 1).handle;
  expect(f.call('RegEnumKeyExA', [restricted, 0, 0x1600, 0x1400, 0, 0, 0, 0])).toBe(5);
});

it('deletes only leaf keys, invalidates old handles and does not reuse their contents after recreation', () => {
  const f = fixture();
  const h = f.create();
  const child = f.create('Software\\RegistryTest\\Child');
  f.set(child, 'Value');
  expect(f.call('RegDeleteKeyA', [0x80000002, f.path('Software\\RegistryTest')])).toBe(5);
  expect(f.call('RegDeleteKeyA', [h, f.path('Child')])).toBe(0);
  expect(f.query(child, 'Value').code).toBe(1018);
  expect(f.open('Software\\RegistryTest\\Child').code).toBe(1018);
  expect(f.call('RegCreateKeyExA', [h, f.path('Child'), 0, 0, 0, 0xf003f, 0, 0x1200, 0])).toBe(1018);
  expect(f.call('RegCloseKey', [child])).toBe(0);
  expect(f.open('Software\\RegistryTest\\Child').code).toBe(2);
  const replacement = f.create('Software\\RegistryTest\\Child');
  expect(f.query(replacement, 'Value').code).toBe(2);
  expect(f.query(child, 'Value').code).toBe(6);
});

it('shares explicitly created empty keys and typed values across a session, while keeping handles and sessions separate', () => {
  const kernel = new GuestProcessKernel();
  const a = fixture(kernel),
    b = fixture(kernel),
    separate = fixture(new GuestProcessKernel());
  const h = a.create();
  expect(b.query(h, 'Value').code).toBe(6);
  const other = b.open(undefined, 0xf003f);
  expect(other.code).toBe(0);
  a.set(h, 'Value', 4, Uint8Array.of(42, 0, 0, 0));
  expect(b.query(other.handle, 'Value')).toMatchObject({ code: 0, type: 4, bytes: Uint8Array.of(42, 0, 0, 0) });
  a.shim.dispose();
  expect(b.query(other.handle, 'Value').code).toBe(0);
  expect(separate.open().code).toBe(2);
});

it('enumerates narrow GBK key names with byte-accurate capacities and metadata', () => {
  const f = fixture();
  const h = f.create();
  // "中文" encoded in the guest code page, without relying on the host UTF-8 encoder.
  const path = new Uint8Array([...new TextEncoder().encode('Software\\RegistryTest\\'), 0xd6, 0xd0, 0xce, 0xc4, 0]);
  f.memory.write_memory(path, 0x1000);
  expect(f.call('RegCreateKeyExA', [0x80000002, 0x1000, 0, 0, 0, 0xf003f, 0, 0x1200, 0])).toBe(0);
  expect(f.call('RegQueryInfoKeyA', [h, 0, 0, 0, 0, 0x1300, 0, 0, 0, 0, 0, 0])).toBe(0);
  expect(readU32(f.memory, 0x1300)).toBe(4);
  writeU32(f.memory, 0x1400, 4);
  expect(f.call('RegEnumKeyExA', [h, 0, 0x1600, 0x1400, 0, 0, 0, 0])).toBe(234);
  writeU32(f.memory, 0x1400, 5);
  expect(f.call('RegEnumKeyExA', [h, 0, 0x1600, 0x1400, 0, 0, 0, 0])).toBe(0);
  expect(f.memory.read_memory(0x1600, 5)).toEqual(Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4, 0));
  expect(readU32(f.memory, 0x1400)).toBe(4);
});

it('keeps a deleted key pending until the last process handle is released, including on disposal', () => {
  const kernel = new GuestProcessKernel();
  const a = fixture(kernel),
    b = fixture(kernel),
    observer = fixture(kernel);
  a.create();
  const other = b.open(undefined, 0xf003f).handle;
  expect(a.call('RegDeleteKeyA', [0x80000002, a.path('Software\\RegistryTest')])).toBe(0);
  expect(b.query(other, 'Value').code).toBe(1018);
  a.shim.dispose();
  expect(observer.open().code).toBe(1018);
  b.shim.dispose();
  expect(observer.open().code).toBe(2);
  expect(observer.create()).toBeGreaterThan(0);
  expect(observer.query(readU32(observer.memory, 0x1200), 'Value').code).toBe(2);
});

it('keeps legacy opens and predefined roots distinct from creating missing keys', () => {
  const f = fixture();
  expect(f.call('RegOpenKeyA', [0x80000002, f.path('Missing'), 0x1200])).toBe(2);
  expect(f.call('RegOpenKeyExA', [0x80000002, 0, 0, 0x20019, 0x1200])).toBe(0);
  expect(readU32(f.memory, 0x1200)).toBe(0x80000002);
  expect(f.call('RegCloseKey', [0x80000002])).toBe(0);
  f.create();
  expect(f.call('RegOpenKeyA', [0x80000002, f.path('Software\\RegistryTest'), 0x1200])).toBe(0);
  expect(f.set(readU32(f.memory, 0x1200), 'Value')).toBe(0);
});
