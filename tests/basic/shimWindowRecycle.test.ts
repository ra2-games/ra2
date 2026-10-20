import { describe, expect, it } from 'vitest';
import { Win32Shim } from '../../src/games/win32Shim';
import {
  GUEST_WINDOW_ENTRY_BYTES,
  GUEST_WINDOW_OWNER,
  GUEST_WINDOW_TABLE,
  GUEST_WINDOW_TABLE_MAX,
  GUEST_WINDOW_VALID,
  GUEST_WINDOW_WIDTH,
} from '../../src/vm86/pe';
import { callShim, createGuestMemory, readU32, writeAsciiZ, type FakeGuestMemory } from '../helpers/guestMemory';

function mirror(memory: FakeGuestMemory, hwnd: number, field: number): number | null {
  if (hwnd < 0x2000) return null;
  const index = (hwnd - 0x2000) & (GUEST_WINDOW_TABLE_MAX - 1);
  return readU32(memory, GUEST_WINDOW_TABLE + index * GUEST_WINDOW_ENTRY_BYTES + field);
}

describe('客体窗口镜像表环绕', () => {
  it('反复开关菜单页后新窗口仍有镜像槽位，快速桩不会永久退化为 hypercall', () => {
    const memory = createGuestMemory();
    const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
    writeAsciiZ(memory, 0x330000, 'Static');
    let hwnd = 0;
    // Far more create/destroy cycles than the mirror table holds; only one window is ever live.
    for (let i = 0; i < GUEST_WINDOW_TABLE_MAX + 200; i++) {
      hwnd = callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x330000, 0, 0, 0, 0, 120, 40, 0, 0, 0, 0]).eax;
      expect(hwnd).toBeGreaterThan(0);
      expect(callShim(shim, 'USER32.DLL!DestroyWindow', [hwnd]).eax).toBe(1);
    }
    const live = callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x330000, 0, 0, 0, 0, 120, 40, 0, 0, 0, 0]).eax;
    expect(live).toBeGreaterThan(0x2000 + GUEST_WINDOW_TABLE_MAX); // Past the table: the old code gave up here.
    expect(mirror(memory, live, GUEST_WINDOW_VALID)).toBe(1);
    expect(mirror(memory, live, GUEST_WINDOW_WIDTH)).toBe(120);
    expect(mirror(memory, live, GUEST_WINDOW_OWNER)).toBe(live);
  });

  it('HWND 不复用；环绕碰撞的两个窗口各自记录属主，旧窗口的桩因属主不符而回退', () => {
    const memory = createGuestMemory();
    const shim = new Win32Shim(memory, { heapTop: 0x00c0_0000, virtualTop: 0x00c0_0000 });
    writeAsciiZ(memory, 0x330000, 'Static');
    const create = (width: number) =>
      callShim(shim, 'USER32.DLL!CreateWindowExA', [0, 0x330000, 0, 0, 0, 0, width, 10, 0, 0, 0, 0]).eax;
    const first = create(11);
    const second = create(12);
    callShim(shim, 'USER32.DLL!DestroyWindow', [first]);
    // RA2 keeps stale handles, so a destroyed HWND must never come back.
    expect(create(13)).not.toBe(first);
    // Keep `second` alive and collect the later windows that wrap onto its entry.
    const sharing: number[] = [];
    for (let i = 0; i < GUEST_WINDOW_TABLE_MAX * 3 && sharing.length < 2; i++) {
      const hwnd = create(14);
      if ((hwnd - second) % GUEST_WINDOW_TABLE_MAX === 0) sharing.push(hwnd);
    }
    expect(sharing).toHaveLength(2);
    const [colliding, newest] = sharing as [number, number];
    // The newest window owns the shared entry, so the older ones' stubs fall back instead of reading its geometry.
    expect(mirror(memory, newest, GUEST_WINDOW_OWNER)).toBe(newest);
    // Destroying an evicted older window must leave the live claimant's entry intact.
    expect(callShim(shim, 'USER32.DLL!DestroyWindow', [second]).eax).toBe(1);
    expect(mirror(memory, newest, GUEST_WINDOW_OWNER)).toBe(newest);
    expect(mirror(memory, newest, GUEST_WINDOW_VALID)).toBe(1);
    // Once the claimant goes away the slot returns to a window still alive instead of staying unusable.
    expect(callShim(shim, 'USER32.DLL!DestroyWindow', [newest]).eax).toBe(1);
    expect(mirror(memory, colliding, GUEST_WINDOW_OWNER)).toBe(colliding);
    expect(mirror(memory, colliding, GUEST_WINDOW_VALID)).toBe(1);
  });
});
