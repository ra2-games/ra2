import { expect, it } from 'vitest';
import { HYPERCALL_CALLBACK_DEPTH } from '../../../src/vm86/pe';
import { callShim } from '../../helpers/guestMemory';
import { call32, finish, le32, PROGRAM, push32, withGuestMachine } from '../../helpers/guestMachine';

it('retains each display descriptor through a nested mode change and enumeration', async () => {
  await withGuestMachine(async (m) => {
    const data = 0x310000,
      outer = PROGRAM + 0x1000,
      inner = PROGRAM + 0x2000;
    expect(callShim(m.shim, 'DDRAW.DLL!DirectDrawCreate', [0, data, 0]).eax).toBe(0);
    const object = m.read(data);
    expect(callShim(m.shim, 'DDRAW.COM!IDirectDraw.SetDisplayMode', [object, 640, 480, 8]).eax).toBe(0);
    const enumerate = m.api('IDirectDraw.EnumDisplayModes', 20, undefined, 'DDRAW.COM');
    const setMode = m.api('IDirectDraw.SetDisplayMode', 16, undefined, 'DDRAW.COM');
    const enumCall = (callback: number) => [
      ...push32(callback),
      ...push32(0),
      ...push32(0),
      ...push32(0),
      ...push32(object),
      ...call32(enumerate),
    ];
    m.code(inner, [0x8b, 0x44, 0x24, 4, 0x8b, 0x40, 12, 0xa3, ...le32(data + 8), 0xb8, 1, 0, 0, 0, 0xc2, 8, 0]);
    m.code(outer, [
      0x53,
      0x8b,
      0x5c,
      0x24,
      8, // EBX retains the outer DDSURFACEDESC pointer.
      ...push32(16),
      ...push32(600),
      ...push32(800),
      ...push32(object),
      ...call32(setMode),
      ...enumCall(inner),
      0x8b,
      0x43,
      12,
      0xa3,
      ...le32(data + 4),
      0x5b,
      0xb8,
      1,
      0,
      0,
      0,
      0xc2,
      8,
      0,
    ]);
    m.code(PROGRAM, [...enumCall(outer), ...finish]);
    await m.run();
    expect(m.read(data + 8)).toBe(800);
    expect(m.read(data + 4)).toBe(640);
    expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(0);
  });
});

it.each(['stdcall', 'cdecl'])('repeated display enumeration reclaims real %s callback bridges', async (convention) => {
  await withGuestMachine(async (m) => {
    const data = 0x310000,
      callback = PROGRAM + 0x1000;
    expect(callShim(m.shim, 'DDRAW.DLL!DirectDrawCreate', [0, data, 0]).eax).toBe(0);
    const object = m.read(data),
      enumerate = m.api('IDirectDraw.EnumDisplayModes', 20, undefined, 'DDRAW.COM');
    const resources = m.shim.inspectResourceCounts();
    const baseline = m.shim.inspectHeapState().liveBytes;
    // Validate callback arguments through real instructions, including the enumeration context.
    m.code(callback, [
      0xff,
      0x05,
      ...le32(data + 4),
      0x8b,
      0x44,
      0x24,
      4,
      0x8b,
      0x00,
      0xa3,
      ...le32(data + 8),
      0x8b,
      0x44,
      0x24,
      8,
      0xa3,
      ...le32(data + 12),
      0xb8,
      1,
      0,
      0,
      0,
      ...(convention === 'stdcall' ? [0xc2, 8, 0] : [0xc3]),
    ]);
    const body = [
      ...push32(callback),
      ...push32(0x12345678),
      ...push32(0),
      ...push32(0),
      ...push32(object),
      ...call32(enumerate),
      0x4e,
    ];
    m.code(PROGRAM, [
      0x89,
      0x25,
      ...le32(data + 16),
      0xbe,
      ...le32(2000),
      ...body,
      0x75,
      -(body.length + 2) & 255,
      0x89,
      0x25,
      ...le32(data + 20),
      ...finish,
    ]);
    await m.run();
    expect(m.read(data + 4)).toBe(2000);
    expect(m.read(data + 8)).toBe(108);
    expect(m.read(data + 12)).toBe(0x12345678);
    expect(m.read(data + 20)).toBe(m.read(data + 16));
    expect(m.read(HYPERCALL_CALLBACK_DEPTH)).toBe(0);
    expect(m.shim.inspectResourceCounts()).toEqual(resources);
    // Descriptors live in reusable callback slots, with no permanent heap staging allocation.
    expect(m.shim.inspectHeapState().liveBytes).toBe(baseline);
  });
});
