import { expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

it('clips a page scrollbar under an overlapping dialog and restores it when the dialog closes', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory);
  const create = (name: string, parent: number, x: number, y: number, width: number, height: number) => {
    writeAsciiZ(memory, 0x300000, name);
    return callShim(shim, 'USER32.DLL!CreateWindowExA', [
      0,
      0x300000,
      0,
      0x10000000 | (parent ? 0x40000000 : 0) | (name === 'ScrollBar' ? 1 : 0),
      x,
      y,
      width,
      height,
      parent,
      0,
      0,
      0,
    ]).eax;
  };
  const root = create('Static', 0, 0, 0, 100, 100);
  const page = create('Static', root, 0, 0, 100, 100);
  create('ScrollBar', page, 60, 0, 16, 90);
  const modal = create('Static', root, 30, 20, 60, 50);
  const draw = () => {
    const pixels = new Uint8Array(100 * 100 * 4).fill(99);
    (shim as unknown as { compositeWindowControls(p: Uint8Array, w: number, h: number): void }).compositeWindowControls(
      pixels,
      100,
      100,
    );
    return pixels;
  };
  const shown = draw();
  expect(shown[(40 * 100 + 60) * 4]).toBe(99);
  expect(shown[(10 * 100 + 60) * 4]).toBe(180);
  callShim(shim, 'USER32.DLL!ShowWindow', [modal, 0]);
  expect(draw()[(40 * 100 + 60) * 4]).toBe(180);
});
